# RT-DSPPLR prepare

**Server-side preparation of long recordings for the [RT-DSPPLR](https://github.com/eightraw/rt-dspplr) web audio player.**

The player decodes ordinary files in full. That is instant for a voice note and
heavy for an hour-long recording: the whole file is downloaded and decoded
before anything plays. This package does the heavy part once, at ingest time,
in Node. It reads a recording as a stream and writes a folder the player opens
in milliseconds and plays segment by segment:

```text
<out>/manifest.json      what the player reads first (format: docs/manifest.md)
<out>/peaks.bin          waveform overview, min/max/RMS, 256 frames per peak, x8 per level
<out>/bands.bin          energies for the high-pass preview (2048 frames per bin)
<out>/spectrogram.bin    overview spectrogram, 128 log rows, 85 ms columns
<out>/seg/000000.wav     fixed-length 16-bit PCM segments (10 s by default), sample-exact
<out>/<key>/...          the same layout for each named stem (see Stems)
```

The manifest is written last, atomically: when it exists, everything it lists
is in place. In the browser:

```ts
import { createAudioPlayer } from '@saitdigital/rt-dspplr';
const player = createAudioPlayer({ element });
await player.play({ manifest: '/media/talk/manifest.json' });
```

Node only, ESM only, Node 20.19 or later. Free to use under a one-page
[license](./LICENSE.md), the same as the player's.

```bash
npm install @saitdigital/rt-dspplr-prepare
```

It depends on `@saitdigital/rt-dspplr` for the file formats (its
`@saitdigital/rt-dspplr/format` entry): the code that writes a manifest, a peaks
file or a spectrogram is the code the player reads them with, not a copy. Keep
the two on the same minor version (`0.4.x` with this `0.1.x`).

## CLI

```bash
npx rtd-prepare talk.wav prepared/talk
npx rtd-prepare talk.wav prepared/talk --segment 6 --concurrency 4
npx rtd-prepare talk.wav prepared/talk --stem b=talk.processed.wav --label b="Noise reduction"
```

| Option | Default | |
|---|---|---|
| `--segment <seconds>` | `10` | Segment length. |
| `--rate <hz> \| auto \| keep` | `auto` | Playback rate. `auto` keeps rates up to 48 kHz and takes higher ones down to 48 kHz. |
| `--peak <frames>` | `256` | Finest peak level, frames per peak. |
| `--concurrency <threads>` | cores − 1 | Analysis threads. The output is byte-identical for any value. |
| `--stem <key>=<file>` | none | A ready-made stem (repeatable). See [Stems](#stems). |
| `--label <key>=<text>` | none | A human label for that stem (shown by the player's card). |
| `--decoder ffmpeg \| docker:<image>` | WAV reader | Experimental: non-WAV input through ffmpeg (local, or in a container without network). |
| `--quiet` | | No progress on stderr. |

It prints a JSON summary on stdout (duration, segments, sizes, time, peak
memory, stems) and exits non-zero on failure.

## API

```ts
import { prepareAudio } from '@saitdigital/rt-dspplr-prepare';

const job = prepareAudio('talk.wav', { outDir: 'prepared/talk' });
job.on('progress', (p) => console.log(p.stage, p.fraction, p.segments));
const manifest = await job.done;            // job.status: 'queued' → 'processing' → 'ready' | 'failed'
console.log(job.stats);                     // elapsedMs, outputBytes, threads, timings, warnings
job.cancel();                               // stops decoding, workers and processors
```

The input is a path, a `ReadableStream<Uint8Array>` or an
`AsyncIterable<Uint8Array>` (an upload, an object-store read).

| Option | Default | |
|---|---|---|
| `outDir` | | Write into this folder. Either this or `storage`. |
| `storage` | | `{ putObject(key, bytes, contentType), getObject?(key) }`: see [Storage](#storage). |
| `segmentSeconds` | `10` | |
| `targetRate` | `'auto'` | A number forces that rate; `'keep'` never resamples. |
| `framesPerPeak` | `256` | |
| `bands`, `spectrogram` | `true` | Write bands.bin / spectrogram.bin. |
| `segmentHashes` | `true` | sha256 of each segment in the manifest. |
| `concurrency` | cores − 1 | Worker threads for the analyses and the resampler. |
| `decoder` | WAV reader | `ffmpegDecoder()` or your own `AudioDecoder`. |
| `sizeHint`, `name` | | Progress for streams; the name recorded in the manifest. |
| `stems` | | Named stems in the same manifest. See below. |
| `tmpDir` | OS temp | Scratch folder for processors. |
| `workerUrl` | `dist/prepare-worker.mjs` | Where the worker file is, if you move it. |
| `signal`, `onProgress` | | Cancellation; progress callback. |

The WAV reader takes 8/16/24/32-bit integer and 32/64-bit float PCM, including
WAVE_FORMAT_EXTENSIBLE, odd chunks, and streams with an "unknown" data size.
Rates above 48 kHz are resampled by default (a windowed-sinc resampler: passband
±0.01 dB, aliasing below −110 dB).

## Stems

A stem is **a time-aligned derivative of A**: the same recording on the same
timeline, after some processing of yours. The player's A⇄B knob blends A with
one stem, sample by sample. Keys are opaque ids you choose (1–32 of
`[A-Za-z0-9_-]`, starting with a letter or digit; `a` is reserved for the
source; keys must differ case-insensitively). The library never interprets a
key or a label: `b` is only the default key, and labels are for your interface.

```ts
await prepareAudio('call.wav', {
    outDir,
    stems: {
        b: { input: 'call.b.wav', label: 'Noise reduction' },                 // a ready-made file
        v1: { processor: myProcessor, label: 'Voice conversion' },           // made from A by a processor
    },
}).done;
```

Each stem takes exactly one of `input` (a path, a byte-stream factory, or
`{ channels, sampleRate }`) and `processor`. For each one, prepare:

1. **Aligns** it: FFT cross-correlation on 8 windows of 2 s, ±1 s around A
   (`maxOffsetSeconds`); the offset the windows agree on is compensated and
   recorded with its confidence. `offsetFrames` skips the measurement.
2. **Adapts** it once: downmixed when A is mono, resampled to A's rate on the
   worker pool, mapped onto A's channels, padded or trimmed to A's length.
3. **Writes** it on A's segment grid under `<key>/`, with its own peaks, bands
   and spectrogram, and records the correlation with A, the mix law
   (`crossfade` for a correlated pair, else `equal-power`), and its loudness
   against A (information only: a stem is never loudness-matched; `gainDb` is an
   explicit, opt-in trim).

**What is not a stem.** Output that changes timing (stretched, re-timed,
re-synthesised or translated speech, anything whose events no longer sit at A's
times) cannot be blended with A. Alignment refuses it by design: the job fails
with a message that says so, or with `onLowConfidence: 'warn'` the manifest is
published without it and the refusal is recorded (`status: 'failed'`). Publish
such output as a separate clip with its own manifest.

Stem options: `label`, `maxOffsetSeconds`, `minConfidence` (default 0.3),
`onLowConfidence` (`'fail'` | `'warn'`), `offsetFrames`, `gainDb`, `name`,
`decoder`, and for processors `timeoutMs` and `onProcessorError` (`'fail'` |
`'skip'`). Progress reports `stage: 'a' | 'processor' | 'stem'` with the `stem`
key; `job.stats.timings.stems[key]` has `{ processorMs, processorWaitMs, stemMs }`.

`attachStem(dir, key, input, { label })` adds or replaces one stem on a folder
that is already prepared (same code path, manifest rewritten atomically with
`revision + 1`). `markStem(dir, key, 'processing')` is for hosts that publish
before a stem exists and turn on polling in the player (`segmented.pollStemsMs`).

## Processors

> **Experimental.** The processor API may change in minor releases before 1.0.

A processor makes a stem from A on the server, the way the player's plugins
process audio in the browser:

```ts
interface StemProcessor {
    id: string; version: string; params?: Record<string, unknown>; timeoutMs?: number;
    run(input: { path, stream(), sampleRate, channels, frames, tmpDir, signal, onProgress? }):
        Promise<{ path } | { stream } | { channels: Float32Array[]; sampleRate }>;
}
```

- `path` is A's file (the input itself, or a scratch copy when A came as a
  stream); `tmpDir` is removed afterwards. The output may be at any rate,
  channel count and length, in any format the decoder reads.
- Processors run **beside** A's own segments and analyses, all at once; the
  stems are then aligned and written one after another.
- Every processor gets a timeout (default 30 min), cancellation, and errors that
  name it. The job's end (success, failure or cancel) always stops it.
- Provenance is recorded: `stems[key].processor = { id, version, params, durationMs }`
  and `stems[key].aSourceId` (A's sha256), so a host can spot a stale stem.

Adapters:

- `commandProcessor({ command, args: ['{in}', '{out}'], id, version })`: any CLI,
  spawned without a shell; `{in}`, `{out}`, `{tmp}` placeholders. A failure
  reports the exit code and the end of stderr.
- `dockerProcessor({ image, args, entrypoint, network: 'none', runArgs })`: A is
  mounted read-only at `/in`, `{out}` is under `/work`; no network by default;
  the container is killed on cancel.
- `httpProcessor({ url, method, headers, field, timeoutMs })`: POSTs A as the raw
  body or as multipart under `field` (streamed, never held in memory) and reads
  the stem from the response; non-2xx reports the status and the body.
- `functionProcessor(fn, { id, version })`: a function.

## Storage

`outDir` writes files (`fsStorage(dir)`); the manifest is written to a
temporary name and renamed. Anything else is a two-method object:

```ts
const storage = {
    async putObject(key, bytes, contentType) { /* S3, MinIO, a database... */ },
    async getObject(key) { /* needed for stems: A's segments are read back */ return null; },
};
await prepareAudio(stream, { storage, sizeHint }).done;
```

Keys are relative paths (`seg/000000.wav`, `v1/peaks.bin`, `manifest.json`);
`manifest.json` comes last. `memoryStorage()` keeps everything in a Map (tests,
or upload it yourself). Serve the folder with HTTP Range support (the player
reads the overview files' coarse levels with one Range request) and, since every
file but the manifest is immutable, long cache lifetimes.

## Memory and concurrency

One decode pass feeds a `worker_threads` pool. The timeline is cut into fixed
jobs (12.8 s at 48 kHz) that do not depend on `concurrency`, so 1 and N threads
write byte-identical files.

- Peak memory at the default concurrency (cores − 1) is about 0.5 GB RSS for any
  length; `concurrency: 4` keeps it under 300 MB, `concurrency: 1` near 150 MB.
- Measured on 11 threads: 60 min mono 48 kHz in about 4 s; 30 min stereo in 3 s;
  a stem adds 2–6 s (mostly writing its own segments and analyses).
- The worker file is `dist/prepare-worker.mjs`, next to the bundle. If it cannot
  start (another bundler, a sandbox), the jobs run inline; pass `workerUrl` when
  you move it.

## Output and the manifest

The manifest format (fields, units, versions 1–3, compatibility policy) is
specified in [docs/manifest.md](https://github.com/eightraw/rt-dspplr/blob/main/docs/manifest.md),
with a JSON Schema shipped as `@saitdigital/rt-dspplr/manifest.schema.json`.
Validation and the binary formats are in `@saitdigital/rt-dspplr/format`
(`assertManifest`, `decodePeaksFile`, `parseWavFile`, ...).

## Limitations

- Non-16-bit sources are rounded to 16-bit segments without dither.
- RF64 (WAV over 4 GB) is not supported.
- `ffmpegDecoder` is experimental and does not trim MP3 encoder delay.
- A stem needs A read back: `outDir`, or a storage with `getObject`.
- An HTTP processor receives A as it was given (not resampled).
