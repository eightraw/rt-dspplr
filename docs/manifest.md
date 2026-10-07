# Prepared-audio manifest

Normative description of `manifest.json`, the file that `@saitdigital/rt-dspplr` writes
(its `./prepare` entry and `rtd-prepare` CLI) and reads with `player.play({ manifest })`. The key
words MUST, SHOULD and MAY are used as in RFC 2119.

- JSON Schema (draft 2020-12): `packages/rt-dspplr/schema/manifest.schema.json`,
  shipped as `@saitdigital/rt-dspplr/manifest.schema.json`.
- Runtime validation: `assertManifest()` / `manifestProblem()` from
  `@saitdigital/rt-dspplr/format`. Its rules are the schema's, plus the rules a
  schema cannot express: stem keys differ case-insensitively, segments tile the
  timeline, a ready stem's segments sit on A's grid, byte ranges lie within
  their source, no segment is longer than 60 s of the timeline
  (`MAX_SEGMENT_SECONDS`), and a source decodes to the timeline's rate and
  channels (a ready stem's: A's rate, A's channels or 1). A test checks that both
  agree on every fixture and on a set of broken manifests.
- Limits (`MIN_SAMPLE_RATE`, `MAX_SAMPLE_RATE`, `MAX_CHANNELS`, `MAX_SEGMENT_SECONDS`
  from `@saitdigital/rt-dspplr/format`): rates 8000–384000 Hz, 1–32 channels,
  segments of at most 60 s. The player allocates from these numbers, so a manifest
  outside them is refused; prepare refuses inputs outside them.
- Current version: **formatVersion 4** (`MANIFEST_FORMAT_VERSION`), analyzer `2.0.0`.

## Versions and compatibility

`formatVersion` is an integer, the manifest's **major** version. It changes only when
a reader that ignores the change would play the file wrongly.

| Version | Adds |
|---|---|
| 1 | Segments, peaks, loudness, source and resample information. |
| 2 | Optional `bands` (high-pass preview) and `spectrogram` (overview spectrogram). |
| 3 | Optional `revision` and `stems` (named stems on the source's grid). |
| 4 | The audio is the original file itself (`segments.source`) and the segments are an index into it: byte ranges the player fetches and decodes. Nothing is cut up or saved again; the timeline is the source's own rate (no `resample`). |

The policy:

1. Before 1.0 a player reads one version, its own: player 0.4 reads 4. Versions 1–3
   (16-bit WAV segment files) are refused with `Unsupported manifest version … prepare
   the recording again`: a host re-runs prepare on the original.
2. A manifest with another `formatVersion` is refused with an error
   (`Unsupported manifest version …`). A player never guesses at an unknown major.
3. Unknown **optional** fields are ignored, at every level (top level, segments,
   stems, blocks). Writers MAY add fields without a new version as long as old
   readers can ignore them. The schema therefore allows additional properties.
4. A new required field, a changed meaning, a new segment codec that old players
   cannot decode, or a changed binary layout needs a new `formatVersion` (or, for a
   binary file, a new version of that file, see [Binary files](#binary-files)).
5. Writers write the current version (prepare writes 4).
6. `analyzerVersion` is not a compatibility signal for players. It tells a host that
   the analysis changed (for example a new peak level layout) and that it MAY re-run
   prepare to benefit.

## Conventions

- Times on the playback timeline are **frames** at `sampleRate` (integers). Seconds
  appear only in `duration` (`frames / sampleRate`).
- Sizes are bytes. Levels are dBFS unless stated. Frequencies are Hz.
- URLs are **relative to the manifest's URL** (resolved with `new URL(url, manifestUrl)`).
  Absolute URLs MAY be used (a CDN); prepare writes relative ones. Every URL MUST
  resolve to `http:` or `https:` (a manifest the player gets as a `blob:` URL MAY
  also name `blob:` files); the player refuses a manifest that names anything else.
  It sends the host's `fetchOptions` headers and credentials only to the manifest's
  own origin and to the origins in its `fetchOptionsOrigins` option: files on other
  origins are fetched without them.
- The manifest is written **last** and atomically: when it exists, every file it
  lists is in place. Every other file is immutable: writers MUST NOT change the
  bytes behind a URL that a published manifest lists, so files can be cached for
  as long as any manifest that lists them. A new version of a stem is written
  under new URLs (prepare: `<key>/r<revision>/`, see [Stems](#stems)) before the
  manifest that lists it, and the files of the version it replaces are left in
  place for readers that still hold the older manifest. Hosts MAY delete those
  once no cached manifest can list them.
- Servers MUST support HTTP Range requests on the source files (every segment is a
  Range request of its source). From a server that ignores the header, the player
  reads a source of up to 64 MB whole, once, and cuts every segment from that copy;
  a bigger one fails with `The server ignores HTTP Range requests: <url>`. Where
  `Content-Range` is readable (same origin, or exposed with
  `Access-Control-Expose-Headers`), it must start at the byte asked for and give
  the source's `bytes`; otherwise the file changed and the clip fails. They SHOULD
  support them on `peaks.bin` and `spectrogram.bin` too (the player fetches their
  coarse levels with one Range request; it falls back to a full GET).

## Top level

| Field | Type | Req. | Since | Meaning |
|---|---|---|---|---|
| `format` | `"rtd-audio-manifest"` | yes | 1 | Identifies the file. |
| `formatVersion` | integer ≥ 1 | yes | 1 | See [Versions](#versions-and-compatibility). |
| `analyzerVersion` | string (semver) | yes | 1 | Version of the analysis that made the index, peaks, loudness. |
| `revision` | integer ≥ 1 | no | 3 | Bumped on every rewrite of the manifest (a stem attached). `refreshManifest()` applies only a higher revision of the same recording (the same `id`, rate, channels and segment grid), and takes from it only stems made from that recording (`aSourceId`, when given). Absent = 1. |
| `id` | string | yes | 1 | `sha256:<hex>` of the source file's bytes: a content id, stable across hosts. |
| `createdAt` | string (ISO 8601) | yes | 1 | |
| `duration` | number ≥ 0, seconds | yes | 1 | `frames / sampleRate`. |
| `sampleRate` | integer 8000–384000, Hz | yes | 1 | Rate of the timeline: of the source, the peaks and analyses. The player converts to its context's rate. |
| `sourceSampleRate` | integer 8000–384000, Hz | yes | 1 | Rate of the original: `sampleRate` (nothing is resampled). |
| `channels` | integer 1–32 | yes | 1 | |
| `frames` | integer ≥ 0 | yes | 1 | Frames on the playback timeline. |
| `source` | object | yes | 1 | `{ name: string \| null, bytes, encoding, bitsPerSample, frames }`: the original as read. `name` is a file name, never a path. |
| `segments` | [Segments](#segments) | yes | 4 | The source and its index. |
| `peaks` | [Peaks](#peaks) | yes | 1 | |
| `loudness` | [Loudness](#loudness) | yes | 1 | |
| `bands` | [Bands](#bands) | no | 2 | Without it the overview skips the high-pass approximation. |
| `spectrogram` | [Spectrogram](#spectrogram) | no | 2 | Without it there is no overview spectrogram (the close-up still works). |
| `stems` | object: key → [Stem](#stems) | no | 3 | Named stems. |

### Segments

`segments`: `{ framesPerSegment, source, list }`. The audio is one file, `source`;
each segment says which bytes of it hold its frames.

| Field | Type | Req. | Meaning |
|---|---|---|---|
| `framesPerSegment` | integer ≥ 1, at most 60 s | yes | The grid; the last segment MAY be shorter. |
| `source` | object | yes | The file: `{ url, bytes, codec, sampleRate, channels, pcm?, header? }`, below. |
| `list[]` | array | yes | In timeline order: `{ index, startFrame, frames, range, tail, lead?, trail? }`, below. |

`source`:

| Field | Type | Req. | Meaning |
|---|---|---|---|
| `url` | string | yes | The file, relative to the manifest. Prepare writes `source.<codec>`: the original byte for byte, or, for a format the player does not decode (or a file whose index does not read back right), a 16-bit WAV of the decoded audio. |
| `bytes` | integer ≥ 0 | yes | Its size; every `range` lies within it. |
| `codec` | `"wav"` \| `"mp3"` \| `"opus"` \| `"flac"` | yes | How a run of it decodes, see [Sources](#sources). |
| `sampleRate`, `channels` | integers, 8000–384000 Hz and 1–32 | yes | What it decodes to. For A: the timeline's. For a stem: A's rate, and A's channels or 1 (played on all of them). An `opus` source is 48000 Hz. The player refuses a run that decodes to anything else. |
| `pcm` | object | wav | `{ encoding: "int" \| "float", bitsPerSample, blockAlign }` of its samples. |
| `header` | string, base64 | flac, opus | Put before a run to decode it: FLAC's `fLaC` and STREAMINFO (marked as the last metadata block, its total samples and MD5 0, unknown: a run is not the whole stream), Opus's OpusHead packet. |

A segment:

| Field | Type | Req. | Meaning |
|---|---|---|---|
| `index`, `startFrame`, `frames` | integers | yes | Its place on the timeline; `frames` at most 60 s of it. |
| `range` | `[start, end)` \| null | yes | The bytes of the source to fetch and decode as one **run**; null: the segment is silence (a stem that does not reach it). |
| `tail` | integer ≥ 0 | yes | How many of the run's decoded samples, counted back from the run's **end**, belong to the segment and after it: the segment's first sample is the run's sample `length − tail`. |
| `lead` | integer ≥ 0 | no | Frames of silence before the source's samples (a stem that starts after A). Absent = 0. |
| `trail` | integer ≥ 0 | no | Frames of silence after them (a stem that ends before A). Absent = 0. |

A reader makes a segment's frames so: `lead` zeros; then `count = min(frames − lead − trail, tail)`
samples of the decoded run from index `length − tail`; zeros to `frames`. A run starts
before the segment (a decoder's warm-up, see [Sources](#sources)) and is counted from its
end because a decoder may give nothing for the first frame of a run.

Segments tile the timeline exactly: `list[0].startFrame` is 0, each `startFrame` is
the previous `startFrame + frames`, and the sum of `frames` is `frames`. Their frames
read back sample-exact (WAV, MP3) or within float rounding (Opus).

### Peaks

`peaks`: `{ url, bytes, format: "rtd-peaks", version, encoding?: "int16-min-max-rms", levels[] }`,
each level `{ framesPerPeak, peaks, byteOffset, byteLength }` (byte range inside the file,
all channels). See [peaks.bin](#peaksbin).

### Loudness

`{ peak, peakDb, rmsDb, gatedRmsDb, perChannel: [{ peakDb, rmsDb }] }`: the highest
absolute sample (linear and dBFS), the plain RMS over the file, and the RMS of
400 ms blocks gated at −70 dBFS absolute and 10 dB below relative (a K-weighting-free
cousin of integrated loudness; **not** LUFS).

### Bands

`bands` (v2): `{ url, bytes, format: "rtd-bands", version, framesPerBin, bins, cutoffsHz[] }`.
See [bands.bin](#bandsbin).

### Spectrogram

`spectrogram` (v2): `{ url, bytes, format: "rtd-spectrogram", version, rows, minHz, maxHz, topDb, rangeDb, levels[] }`,
each level `{ framesPerColumn, columns, byteOffset, byteLength }`. See [spectrogram.bin](#spectrogrambin).

## Stems

`stems` (v3) maps a **key** to a stem. A stem is a **time-aligned derivative of A** (the
source): the same recording on the same timeline after some processing, which the
player blends with A sample by sample under its A⇄B knob. The format attaches no
meaning to what the processing is.

**Keys.** A key is an opaque id chosen by the host. It MUST match
`^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$`, MUST NOT be `a` or `A` (reserved for the source),
and keys of one manifest MUST differ case-insensitively (a stem's files live under
`<key>/`, and file systems may ignore case). Readers MUST NOT interpret a key. `b` is
the default key: it is what a host gets when it names none, and what every manifest
written before named stems used. Players choose `b` when it is ready, else the first
ready stem.

**What is not a stem.** Output whose events are not at A's times (stretched, re-timed,
re-synthesised or translated audio) MUST NOT be published as a stem: it cannot be
blended with A. Prepare's alignment refuses it (low confidence). Publish it as a
separate clip with its own manifest.

| Field | Type | Req. | Meaning |
|---|---|---|---|
| `status` | `"processing"` \| `"ready"` \| `"failed"` | yes | Only `ready` stems play. `processing` is shown only by players that opted into polling. |
| `updatedAt` | string (ISO 8601) | yes | |
| `label` | string, 1–120 characters | no | A human name for interfaces (the card shows `label ?? key`). Never interpreted. |
| `error` | string | no | Why a `failed` stem was not attached: a short reason for people (prepare writes generic ones such as `processor failed: exit code 3`, `processor failed: HTTP 503`, `processor timed out`). The manifest is public: writers SHOULD NOT put server details here (stderr, URLs, response bodies). |
| `aSourceId` | string | no | The `id` of the A it was made from: a host compares it to spot a stale stem. |
| `processor` | object | no | `{ id, version, params?, durationMs? }` of the processor that made it (absent for a ready-made input). `params` holds only what the host chose to publish. |
| `id` | string | no | `sha256:<hex>` of the stem's source bytes. |
| `source` | object | no | `{ name, bytes, sampleRate, channels, frames, bandwidthHz }` of the stem as given (before adaptation). `bandwidthHz` is the highest frequency it carries. |
| `alignment` | object | no | `{ offsetFrames, offsetMs, confidence (0..1), windows, agreeing }`: where the stem sat against A; it was shifted by `-offsetFrames`. `windows` were measured (A and the stem both sound there), `agreeing` of them put the correlation peak at the offset; `confidence` is their share. |
| `correlation` | object | no | `{ global, perSegment[] }`: zero-lag correlation with A after alignment. |
| `mixLaw` | `"crossfade"` \| `"equal-power"` | no | The law for this pair (crossfade for a correlated pair). A player's own `mixLaw` option wins. |
| `loudnessDeltaDb` | number, dB | no | Stem minus A (gated RMS). **Information only**: players never apply it. |
| `gainDb` | number, dB, -60 to +12 | no | An explicit trim the player applies to the stem. Absent = 0. |
| `loudness` | [Loudness](#loudness) | no | The stem's own. |
| `segments`, `peaks` | as at the top level | when `ready` | On A's grid: the same `startFrame`/`frames` per segment. Its own `source`: the stem's file as given, when it is at A's rate with A's channels or one, its index shifted by the alignment (`lead`, `trail`); else a 16-bit WAV of it on A's grid. |
| `bands`, `spectrogram` | as at the top level | no | The stem's own overview files. |

A stem's URLs SHOULD be under `<key>/`. Prepare writes each version of a stem under
`<key>/r<revision>/` (`b/r1/source.mp3`, `v1/r3/peaks.bin`), where `revision` is the
manifest revision that publishes it, so a replaced stem never reuses a URL. A `ready`
stem's peaks SHOULD start at A's finest `framesPerPeak` (players draw A and the stem
from the same levels).

## Binary files

Little-endian. Each starts with a 4-byte magic and a `u16` version; readers MUST refuse
a version above the one they know. The layouts below are version 1 of each. The
reference implementation is `@saitdigital/rt-dspplr/format` (`encode*`/`decode*`).

### peaks.bin

```
 0 "RTDP" · 4 u16 version (1) · 6 u16 header bytes (32 + 16 × levels, rounded up to 8)
 8 u32 sample rate · 12 u16 channels · 14 u16 levels · 16 f64 frames
24 u32 flags (bit 0: RMS present) · 28 u32 reserved
32 level table, finest first, 16 bytes each: u32 framesPerPeak, u32 peaks, f64 byteOffset
data, COARSEST FIRST; per level, per channel: Int16 min[peaks], max[peaks], rms[peaks]
     (sample × 32768, rounded and clamped; rms ≥ 0)
```

Finest level 256 frames per peak by default, ×8 per level, down to at most 2048 peaks.
Coarsest-first lets one Range request bring the header and every level but the finest.

### bands.bin

```
 0 "RTDB" · 4 u16 version (1) · 6 u16 header bytes · 8 u32 sample rate · 12 u32 framesPerBin (2048)
16 u32 bins · 20 u16 K cutoffs · 22 reserved · 24 f32[K] cutoffs (Hz)
data: bins × (1 + K) u16, bin-major: [E_total, E_hp(c0) … E_hp(cK-1)]
      q = round((10·log10(meanSquare) + 160) × 400), 0 = silence (0.0025 dB steps)
```

`E_hp(c)` is the mean square left after the player's own high-pass (4th-order
Butterworth, the same coefficients) at cutoff `c`; default cutoffs are half-octave
steps from 25 to 566 Hz.

### spectrogram.bin

```
 0 "RTDS" · 4 u16 version (1) · 6 u16 header bytes (48 + 16 × levels, rounded up to 8)
 8 u32 sample rate · 12 u16 rows · 14 u16 levels · 16 f64 frames
24 f32 minHz · 28 f32 maxHz · 32 f32 topDb · 36 f32 rangeDb · 40 f32 referenceMax · 44 reserved
48 level table, finest first: u32 framesPerColumn, u32 columns, f64 byteOffset
data, COARSEST FIRST; per level: columns × rows u8, column-major, row 0 = the highest frequency
     255 = topDb, 0 = topDb − rangeDb and below
```

The mono downmix every 4096 frames, through the player's spectrogram analysis (Hann
FFTs of 4096/2048/1024 points blended on a logarithmic axis of `rows` rows from `minHz`
to `maxHz`); coarser levels take the louder of 8 columns, row by row.

## Sources

The file behind `segments.source`, and how a run of it (the bytes of a segment's `range`)
decodes. The player decodes MP3, FLAC and Opus with WebAssembly builds of dr_mp3,
dr_flac and libopus (one lazily loaded chunk per codec, in a worker); prepare uses the
same code, so what it indexes is what plays.

| `codec` | The file | A run | Warm-up (prepare) |
|---|---|---|---|
| `wav` | RIFF/WAVE, PCM integer 8–32 bits or float 32/64 (`pcm`), any chunks around `data` | Whole frames of `data`: `(end − start) / blockAlign` frames, `tail` = the segment's frames. | none |
| `mp3` | MPEG-1/2 Layer III; an ID3v2 tag and a Xing/Info frame may come first | Whole frames from the middle of the stream, decoded raw: no tag, no gapless trimming (the decoder's delay is in `tail`). | from where the bit reservoir (511 bytes of main data, 255 for MPEG-2/2.5) is full two frames before the segment's first (their overlap and filterbank state), and at least 6 frames before it: the samples are the continuous decode's, exactly |
| `opus` | Ogg Opus, one logical stream, channel mapping family 0 (mono or stereo) | Whole Ogg pages. A packet continued from before the run is dropped, as is one that runs past it; each packet is decoded in order by a fresh decoder (48 kHz, the header's output gain applied). | from the first packet that begins on a page at least 500 ms before the segment: within float rounding of the continuous decode (80 ms left errors up to −35 dBFS) |
| `flac` | native FLAC (an ID3v2 tag may come first, an ID3v1 tag last) | `header` (`fLaC`, STREAMINFO) then whole frames. | none: a run starts at the frame of its first sample (frames are independent); the samples are the continuous decode's, exactly |
