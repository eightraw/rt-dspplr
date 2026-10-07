# RT-DSPPLR prepare

**Server-side preparation of long recordings for the [RT-DSPPLR](https://github.com/eightraw/rt-dspplr) web audio player.**

Documentation and API reference: [sait.digital/research/rt-dspplr](https://sait.digital/research/rt-dspplr).

The player decodes ordinary files in full. That is instant for a voice note and
heavy for an hour-long recording: the whole file is downloaded and decoded
before anything plays. This package does the heavy part once, at ingest time,
in Node. It reads a recording as a stream and writes a folder the player opens
in milliseconds and plays segment by segment:

```text
<out>/manifest.json      what the player reads first (format: docs/manifest.md), with the index
<out>/source.mp3         the original, byte for byte (.wav, .mp3, .opus; other formats: a 16-bit .wav)
<out>/peaks.bin          waveform overview, min/max/RMS, 256 frames per peak, x8 per level
<out>/bands.bin          energies for the high-pass preview (2048 frames per bin)
<out>/spectrogram.bin    overview spectrogram, 128 log rows, 85 ms columns
<out>/<key>/r1/...       the same layout for each named stem, one folder per version (see Stems)
```

Nothing is cut up or encoded again. The manifest holds an index of the original:
for each segment (10 s by default), the byte range that holds it. The player
fetches those bytes with an HTTP Range request and decodes them (WAV itself,
MP3 and Opus in WebAssembly, in a worker), and gets the samples prepare decoded:
WAV and MP3 exactly, Opus within float rounding. An hour of MP3 stays the size of
the MP3 (about 1 MB a minute at 128 kbit/s) instead of 600 MB of WAV segments.

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
| `--segment <seconds>` | `10` | Segment length: what the player fetches at a time. 0.1 to 60. |
| `--peak <frames>` | `256` | Finest peak level, frames per peak: a power of two from 16 to 65536. |
| `--concurrency <threads>` | cores − 1 | Analysis threads, 1 to 64. The output is byte-identical for any value. |
| `--stem <key>=<file>` | none | A ready-made stem (repeatable). See [Stems](#stems). |
| `--label <key>=<text>` | none | A human label for that stem (shown by the player's card). |
| `--decoder ffmpeg \| docker:<image>` | built-in | Formats the built-in decoder does not read, through ffmpeg (local, or in a container without network). Experimental. |
| `--demuxers <name,...> \| any` | `AUDIO_DEMUXERS` | With `--decoder`: the input formats ffmpeg may open (see [ffmpeg](#ffmpeg)). `any` lets it probe everything. |
| `--quiet` | | No progress on stderr. |

It prints a JSON summary on stdout (duration, segments, sizes, time, peak
memory, stems) and exits non-zero on failure: 2 for a bad command line (a
number out of range or not a plain number, a Docker image name that is not one),
before anything is read.

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
| `storage` | | `{ putObject(key, bytes, contentType), putFile?, getObject?, getRange? }`: see [Storage](#storage). |
| `segmentSeconds` | `10` | What the player fetches at a time: 0.1 to 60 (the player refuses longer segments). |
| `framesPerPeak` | `256` | A power of two from 16 to 65536. |
| `bands`, `spectrogram` | `true` | Write bands.bin / spectrogram.bin. |
| `resampler` | | The converter of a stem at another rate than A. |
| `pool` | | Threads kept between calls (`createPreparePool()`): what a service should pass. |
| `concurrency` | cores − 1, none below ~24 MB | Worker threads made for this call when there is no `pool`: an integer from 1 to 64. A short input runs on the calling thread: a pool made for one call starts cold and costs more than it saves. |
| `decoder` | built-in | WAV, MP3, Ogg Opus and FLAC are read in process; `ffmpegDecoder()` or your own `AudioDecoder` for anything else. |
| `sizeHint`, `name` | | Progress for streams; the name recorded in the manifest (its last path part only: no file is ever named after it). |
| `stems` | | Named stems in the same manifest. See below. |
| `tmpDir` | OS temp | Scratch folder: a stream input's copy, a WAV being written, processors' output. |
| `workerUrl` | `dist/prepare-worker.mjs` | Where the worker file is, if you move it. |
| `signal`, `onProgress` | | Cancellation; progress callback. |

Without a `decoder`, prepare reads WAV, MP3, Opus and FLAC itself, in
WebAssembly, with no ffmpeg and no process per file. It tells them apart by their
first bytes, not by the file name. MP3 (MPEG-1/2, layers I-III, by dr_mp3) is
gapless when the file has a LAME header, as encoders write it. Opus in Ogg
(`.opus`, by libopus and opusfile) comes out at 48 kHz, trimmed by its pre-skip
and its last granule position, so it is as long as what was encoded. FLAC (by
dr_flac) gives the exact samples. On a desktop CPU a 20 s stereo file decodes in
about 50 ms (Opus), 30 ms (MP3) and 20 ms (FLAC). Anything else (AAC/M4A, Ogg
Vorbis, Opus in WebM) needs a decoder: `ffmpegDecoder()` or your own.

The WAV reader takes 8/16/24/32-bit integer and 32/64-bit float PCM, including
WAVE_FORMAT_EXTENSIBLE, odd chunks, and streams with an "unknown" data size.
The timeline is the source's own rate, whatever it is: the player converts to its
context's. Non-finite samples, which a float WAV or a custom decoder may hold,
are replaced (NaN by 0, ±Infinity by ±1) and counted in `job.stats.warnings`;
the file that holds them is then kept as a 16-bit WAV of the clean samples.
Before the manifest is written it is checked with the player's own
`assertManifest()`: one the player would refuse fails the job instead. What the
player cannot play is refused up front: A at a rate outside 8 to 384 kHz, A or
a stem with more than 32 channels (a stem at any other rate is converted to A's).
`checkSegmentSeconds()`, `checkConcurrency()` and `checkFramesPerPeak()` are
exported for hosts that check their options first.

A source that fails while it is read (a network stream cut, a disk error) fails
the job with that error, whatever the decoder makes of it: the recording is never
published shorter than it is.

### The source and its index

WAV, MP3, Ogg Opus (mono or stereo) and FLAC are kept as they are. The index is
checked before it is published: the first segment, one past the middle and the
last are read back the player's way and compared with what was decoded, and for
an MP3 also the segment whose run reaches back furthest, against the same
segment from a run that starts much earlier. A file whose index does not read
back right (a damaged or unusual stream) is kept as a 16-bit WAV of what was
decoded instead, with a warning in `job.stats.warnings`; so is anything read
through `ffmpegDecoder()` or a decoder of your own.

| Source | A segment's run | Read back |
|---|---|---|
| WAV | its frames of the `data` chunk | exact |
| MP3 | whole frames, from where the bit reservoir (511 bytes of main data, 255 for MPEG-2) is full two frames before the segment's: 6 frames from about 80 kbit/s (MPEG-1 stereo), 12 at 32 kbit/s and 48 kHz, around 50 in the silence of a VBR -V9 file | exact |
| Opus | whole Ogg pages, from a packet at least 500 ms before the segment (the decoder converges) | within float rounding (about −140 dB) |
| FLAC | whole frames, from the frame of the segment's first sample (frames decode on their own), after the stream's `fLaC` and STREAMINFO | exact |

The fetch overhead is that warm-up and the page or frame granularity: about 2 %
for MP3 and for FLAC (4096-sample frames), 10–20 % for Opus with 1 s pages at
10 s segments. Indexing a FLAC reads it once for its frame headers: 50 ms for
46 MB.

### ffmpeg

`ffmpegDecoder()` reads what the built-in decoder does not (AAC/M4A, Ogg Vorbis,
Opus in WebM, WMA, AIFF...) by piping the source through ffmpeg. Experimental.

```ts
import { AUDIO_DEMUXERS, ffmpegDecoder, prepareAudio } from '@saitdigital/rt-dspplr-prepare';

prepareAudio(upload, { outDir, decoder: ffmpegDecoder({ demuxers: AUDIO_DEMUXERS }) });
// ffmpeg in a container without network:
ffmpegDecoder({ command: ['docker', 'run', '--rm', '-i', '--network', 'none', 'my-ffmpeg-image', 'ffmpeg'] });
```

| Option | Default | |
|---|---|---|
| `command` | `['ffmpeg']` | What runs ffmpeg; its arguments are appended. |
| `demuxers` | any | The demuxers ffmpeg may pick for the input (its `-format_whitelist`): one that probes as anything else fails with "Format not on whitelist". |
| `inputArgs` | | Arguments before `-i`: `['-f', 'mp3']` reads the input as that one format, without probing. |

ffmpeg picks its demuxer from the bytes, among every one it has. For untrusted
uploads pass `demuxers`, or pin one format with `inputArgs`. `AUDIO_DEMUXERS`
lists the usual audio containers: MP4/M4A/3GP, raw AAC, Ogg, Matroska/WebM, WMA,
AIFF, CAF, WAV/W64, FLAC, MP3, WavPack, Monkey's Audio, TTA, AC-3, E-AC-3, DTS,
AMR, AU and Musepack. It leaves out video containers such as MPEG-TS, MPEG-PS,
AVI and FLV. With ffmpeg 4.3, M4A (AAC and ALAC), raw AAC, Ogg Vorbis, Opus in
WebM and Ogg, WMA, AIFF, Matroska, WavPack, AC-3, FLAC, MP3, W64, AU and an MP4
with video decode the same with the list as without it; MPEG-TS and MPEG-PS are
refused. The API leaves it off by default; the CLI's `--decoder` uses it unless
`--demuxers` names others (`--demuxers any`: no list).

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
2. **Adapts** it once for the analyses: downmixed when A is mono, resampled to
   A's rate on the worker pool, mapped onto A's channels, padded or trimmed to A's length.
3. **Writes** it on A's segment grid under `<key>/r<revision>/`: the stem's own
   file with an index shifted by the offset when the player reads it as it is
   (WAV, MP3, Opus or FLAC at A's rate, with A's channels or one), else a 16-bit WAV
   of the adapted stem; its own
   peaks (at A's finest level), bands and spectrogram; and records the correlation with A, the mix law
   (`crossfade` for a correlated pair, else `equal-power`), and its loudness
   against A (information only: a stem is never loudness-matched; `gainDb` is an
   explicit, opt-in trim).

**What is not a stem.** Output that changes timing (stretched, re-timed,
re-synthesised or translated speech, anything whose events no longer sit at A's
times) cannot be blended with A. Alignment refuses it by design: the job fails
with a message that says so, or with `onLowConfidence: 'warn'` the manifest is
published without it and the refusal is recorded (`status: 'failed'`). Publish
such output as a separate clip with its own manifest.

Alignment measures up to 8 windows where A and the stem both sound and takes the
offset most of them agree on; it does not test how strongly the stem correlates
with A, since a quiet part (a vocal's breaths) correlates weakly however well it
is aligned, while unrelated or re-timed audio peaks at a different lag in every window.

Stem options: `label`, `maxOffsetSeconds`, `minConfidence` (share of the measured windows that must agree, default 0.5),
`onLowConfidence` (`'fail'` | `'warn'`), `offsetFrames`, `gainDb`, `name`,
`decoder`, and for processors `timeoutMs` and `onProcessorError` (`'fail'` |
`'skip'`: `'skip'` also covers output that cannot be decoded; a cancel always
fails the job). Progress reports `stage: 'a' | 'processor' | 'stem'` with the `stem`
key; `job.stats.timings.stems[key]` has `{ processorMs, processorWaitMs, stemMs }`.

`attachStem(dir, key, input, { label })` adds or replaces one stem on a folder
that is already prepared (same code path, manifest rewritten atomically with
`revision + 1`). Every version of a stem gets a folder of its own,
`<key>/r<revision>/`: a replaced stem's files stay where they are, unchanged, so
a player or cache that still holds the older manifest keeps working. Delete
them yourself once no cached manifest can list them. One writer per folder at a
time. `markStem(dir, key, 'processing')` is for hosts that publish before a
stem exists and turn on polling in the player (`segmented.pollStemsMs`);
`'ready'` is refused unless the stem already is ready with its files.

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
- Processors run **beside** A's own decode and analyses, all at once; the
  stems are then aligned and written side by side.
- Every processor gets a timeout (default 30 min), cancellation, and errors that
  name it. The job's end (success, failure or cancel) always stops it, with
  the processes it started (its process group on POSIX, `taskkill /T` on Windows).
- Provenance is recorded: `stems[key].processor = { id, version, params, durationMs }`
  and `stems[key].aSourceId` (A's sha256), so a host can spot a stale stem.
  `params` is published only when you pass it (the adapters default to `{}`).
  `id` and `version` are published too; the adapters default to `command`,
  `docker` or `http` and `0`, so nothing of your setup (paths, images, hosts)
  is published unless you name it.
- The manifest is public, so a failed stem's `error` is short and generic
  (`processor failed: exit code 3`, `processor failed: HTTP 503`,
  `processor timed out`, `processor failed: output could not be read`). The
  detail (stderr, the status and body, with URL credentials and query strings
  redacted) goes to `job.stats.warnings` and to the job's error, for your log.

Adapters:

- `commandProcessor({ command, args: ['{in}', '{out}'], id, version })`: any CLI,
  spawned without a shell; `{in}`, `{out}`, `{tmp}` placeholders. A failure
  reports the exit code and the end of stderr.
- `dockerProcessor({ image, args, entrypoint, network: 'none', runArgs, docker })`:
  the container sees A alone, read-only, at `/in/a.<ext>` (a hard link to A, or a
  copy across devices, in a folder of its own: never A's own folder), and a
  scratch folder at `/work` where `{out}` goes. No network by default, and
  `--security-opt no-new-privileges`. A mount path with a comma, a quote or a
  control character is refused (it would add `--mount` options), and so is an
  `image` that is not an image reference (`--privileged` would be a flag:
  `checkDockerImage()`, as the CLI's `docker:<image>` is checked). The container
  is killed on cancel. It runs as the image's user, often root, and gets neither
  `--cap-drop ALL` nor `--user` by default: it writes `{out}` into a scratch
  folder that belongs to the server's user (mode 0700), and a container user
  that is not that uid needs root's capabilities to do so. To tighten it, pass
  both through `runArgs` with the server's own uid, e.g.
  `['--user', '1000:1000', '--cap-drop', 'ALL']` (Linux; the image must run as
  any user).
- `httpProcessor({ url, method, headers, field, timeoutMs, maxResponseBytes })`:
  POSTs A as the raw body or as multipart under `field` (streamed, never held in
  memory) and reads the stem from the response, up to `maxResponseBytes`
  (default 4 GiB, the largest WAV the reader takes). Non-2xx reports the status
  and the start of the body.
- `functionProcessor(fn, { id, version })`: a function.

## Storage

`outDir` writes files (`fsStorage(dir)`); the manifest is written to a
temporary name and renamed. Anything else is an object with `putObject`:

```ts
const storage = {
    async putObject(key, bytes, contentType) { /* S3, MinIO, a database... */ },
    // Optional: store the source from its local file (streamed); without it the file is read whole.
    async putFile(key, file, contentType) { /* e.g. an S3 multipart upload of the file */ },
    // Optional, for attachStem: A is read back from its source, in ranges when it can.
    async getObject(key) { return null; },
    async getRange(key, start, end) { return null; },
};
await prepareAudio(stream, { storage, sizeHint }).done;
```

Keys are relative paths (`source.mp3`, `peaks.bin`, `v1/r1/source.wav`,
`manifest.json`); `manifest.json` comes last. `memoryStorage()` keeps everything
in a Map (tests, or upload it yourself). Serve the folder **with HTTP Range
support**: every segment is a Range request of its source (a server that ignores
the header sends the whole file each time), and the overview files' coarse levels
come with one Range request too. Every file but the manifest is immutable: long
cache lifetimes.

## Memory and concurrency

One decode pass feeds a `worker_threads` pool. The timeline is cut into fixed
jobs (12.8 s at 48 kHz) that do not depend on `concurrency`, so 1 and N threads
write byte-identical files.

A service should make one pool at start-up and pass it to every call: its
workers stay warm (no start-up per call, code already optimised), idle ones do
not keep the process alive, and calls may share it.

```js
import { createPreparePool, prepareAudio } from '@saitdigital/rt-dspplr-prepare';

const pool = createPreparePool(); // every core but one, at least two
// for each upload:
const job = prepareAudio(file, { outDir, pool });
await job.done;
// at shutdown:
await pool.close();
```

After a worker fails (`pool.failed` is set) every call through it fails: make a
new one. Measured, 20 s stereo with two stems: 349 ms with no pool, 192 ms with
a kept pool of 11 threads (desktop); 1.2–1.5 s and 0.9–1.3 s on a 2-vCPU VPS.

- Peak memory at the default concurrency (cores − 1) is about 0.5 GB RSS for an
  hour or so; `concurrency: 4` keeps it under 300 MB, `concurrency: 1` near
  150 MB. The overview files' data adds about 40 MB per hour of 48 kHz stereo
  (half for mono): 24 h of stereo peaked at 1.2 GB with `concurrency: 4`.
- Measured on 11 threads: 60 min mono 48 kHz in about 4 s; a 30 min stereo MP3
  in 3.7 s; a stem adds 2–6 s (decoding it twice, its analyses, reading A back
  for the pairing).
- The worker file is `dist/prepare-worker.mjs`, next to the bundle. If it cannot
  start (another bundler, a sandbox), the jobs run inline; pass `workerUrl` when
  you move it.

## Output and the manifest

The manifest format (fields, units, the source and its index, version 4, compatibility policy) is
specified in [docs/manifest.md](https://github.com/eightraw/rt-dspplr/blob/main/docs/manifest.md),
with a JSON Schema shipped as `@saitdigital/rt-dspplr/manifest.schema.json`.
Validation and the binary formats are in `@saitdigital/rt-dspplr/format`
(`assertManifest`, `decodePeaksFile`, `parseWavFile`, ...).

## Limitations

- A source kept as a WAV (formats read through a decoder of yours, a file
  whose index did not read back) is rounded to 16 bits without dither.
- RF64 (WAV over 4 GB) is not supported.
- Opus with more than two channels (mapping family 1) is kept as a WAV.
- Opus in WebM or Matroska (what browsers record with MediaRecorder) is not
  read in process: it needs `ffmpegDecoder()`.
- `ffmpegDecoder` is experimental and does not trim MP3 encoder delay. It runs
  ffmpeg with `-protocol_whitelist pipe` (the input cannot make it open a file
  or a URL), with `-format_whitelist` when given `demuxers` (see [ffmpeg](#ffmpeg)),
  and stops it on cancel, when the reader stops early, or when the source fails
  (ffmpeg would end the recording there).
- `attachStem` reads A back from its source: `outDir`, or a storage with `getRange` or `getObject`.
- An HTTP processor receives A as it was given (not resampled).
