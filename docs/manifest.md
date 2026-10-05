# Prepared-audio manifest

Normative description of `manifest.json`, the file that `@saitdigital/rt-dspplr-prepare`
writes and `@saitdigital/rt-dspplr` reads with `player.play({ manifest })`. The key
words MUST, SHOULD and MAY are used as in RFC 2119.

- JSON Schema (draft 2020-12): `packages/rt-dspplr/schema/manifest.schema.json`,
  shipped as `@saitdigital/rt-dspplr/manifest.schema.json`.
- Runtime validation: `assertManifest()` / `manifestProblem()` from
  `@saitdigital/rt-dspplr/format`. Its rules are the schema's, plus the one rule a
  schema cannot express (stem keys must differ case-insensitively). A test checks
  that both agree on every fixture and on a set of broken manifests.
- Current version: **formatVersion 3** (`MANIFEST_FORMAT_VERSION`), analyzer `1.2.0`.

## Versions and compatibility

`formatVersion` is an integer, the manifest's **major** version. It changes only when
a reader that ignores the change would play the file wrongly.

| Version | Adds |
|---|---|
| 1 | Segments, peaks, loudness, source and resample information. |
| 2 | Optional `bands` (high-pass preview) and `spectrogram` (overview spectrogram). |
| 3 | Optional `revision` and `stems` (named stems on the source's grid). |

The policy:

1. A player whose maximum is N reads every manifest with `formatVersion` ≤ N. Player
   0.4 reads 1, 2 and 3.
2. A manifest with `formatVersion` > N is refused with an error
   (`Unsupported manifest version …`). A player never guesses at an unknown major.
3. Unknown **optional** fields are ignored, at every level (top level, segments,
   stems, blocks). Writers MAY add fields without a new version as long as old
   readers can ignore them. The schema therefore allows additional properties.
4. A new required field, a changed meaning, a new segment codec that old players
   cannot decode, or a changed binary layout needs a new `formatVersion` (or, for a
   binary file, a new version of that file, see [Binary files](#binary-files)).
5. Writers SHOULD write the lowest version that describes the file (prepare writes 3
   and keeps a file's version when it rewrites it).
6. `analyzerVersion` is not a compatibility signal for players. It tells a host that
   the analysis changed (for example a new peak level layout) and that it MAY re-run
   prepare to benefit.

## Conventions

- Times on the playback timeline are **frames** at `sampleRate` (integers). Seconds
  appear only in `duration` (`frames / sampleRate`).
- Sizes are bytes. Levels are dBFS unless stated. Frequencies are Hz.
- URLs are **relative to the manifest's URL** (resolved with `new URL(url, manifestUrl)`).
  Absolute URLs MAY be used; prepare writes relative ones.
- The manifest is written **last** and atomically: when it exists, every file it
  lists is in place. Every other file is immutable for a given manifest `id` and
  `revision`, so it can be cached for as long as the manifest is.
- Servers SHOULD support HTTP Range requests on `peaks.bin` and `spectrogram.bin`
  (the player fetches their coarse levels with one Range request; it falls back to a
  full GET).

## Top level

| Field | Type | Req. | Since | Meaning |
|---|---|---|---|---|
| `format` | `"rtd-audio-manifest"` | yes | 1 | Identifies the file. |
| `formatVersion` | integer ≥ 1 | yes | 1 | See [Versions](#versions-and-compatibility). |
| `analyzerVersion` | string (semver) | yes | 1 | Version of the analysis that made segments, peaks, loudness. |
| `revision` | integer ≥ 1 | no | 3 | Bumped on every rewrite of the manifest (a stem attached). `refreshManifest()` applies only a higher revision. Absent = 1. |
| `id` | string | yes | 1 | `sha256:<hex>` of the source file's bytes: a content id, stable across hosts. |
| `createdAt` | string (ISO 8601) | yes | 1 | |
| `duration` | number ≥ 0, seconds | yes | 1 | `frames / sampleRate`. |
| `sampleRate` | integer ≥ 1, Hz | yes | 1 | Playback rate of segments, peaks and analyses. |
| `sourceSampleRate` | integer ≥ 1, Hz | yes | 1 | Rate of the original. |
| `channels` | integer ≥ 1 | yes | 1 | |
| `frames` | integer ≥ 0 | yes | 1 | Frames on the playback timeline. |
| `source` | object | yes | 1 | `{ name: string \| null, bytes, encoding, bitsPerSample, frames }`: the original as read. `name` is a file name, never a path. |
| `resample` | object \| null | yes | 1 | `null`, or `{ from, to, method?, passbandHz?, stopbandHz?, stopbandDb? }` when the playback rate differs from the source rate. |
| `segments` | [Segments](#segments) | yes | 1 | |
| `peaks` | [Peaks](#peaks) | yes | 1 | |
| `loudness` | [Loudness](#loudness) | yes | 1 | |
| `bands` | [Bands](#bands) | no | 2 | Without it the overview skips the high-pass approximation. |
| `spectrogram` | [Spectrogram](#spectrogram) | no | 2 | Without it there is no overview spectrogram (the close-up still works). |
| `stems` | object: key → [Stem](#stems) | no | 3 | Named stems. |

### Segments

`segments`: `{ codec, framesPerSegment, list }`.

| Field | Type | Req. | Meaning |
|---|---|---|---|
| `codec` | `"wav-pcm16"` | yes | Each segment is a RIFF/WAVE file, 16-bit integer PCM, `channels` channels at `sampleRate`. No other codec is defined in versions 1–3. |
| `framesPerSegment` | integer ≥ 1 | yes | The grid; the last segment MAY be shorter. |
| `list[]` | array | yes | In timeline order: `{ index, startFrame, frames, url, bytes, sha256? }`. |

Segments tile the timeline exactly: `list[0].startFrame` is 0, each `startFrame` is
the previous `startFrame + frames`, and the sum of `frames` is `frames`. Concatenated,
they are sample-exact: no padding, no overlap.

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
| `error` | string | no | Why a `failed` stem was not attached. |
| `aSourceId` | string | no | The `id` of the A it was made from: a host compares it to spot a stale stem. |
| `processor` | object | no | `{ id, version, params?, durationMs? }` of the processor that made it (absent for a ready-made input). |
| `id` | string | no | `sha256:<hex>` of the stem's source bytes. |
| `source` | object | no | `{ name, bytes, sampleRate, channels, frames, bandwidthHz }` of the stem as given (before adaptation). `bandwidthHz` is the highest frequency it carries. |
| `alignment` | object | no | `{ offsetFrames, offsetMs, confidence (0..1), windows, agreeing }`: where the stem sat against A; it was shifted by `-offsetFrames`. |
| `correlation` | object | no | `{ global, perSegment[] }`: zero-lag correlation with A after alignment. |
| `mixLaw` | `"crossfade"` \| `"equal-power"` | no | The law for this pair (crossfade for a correlated pair). A player's own `mixLaw` option wins. |
| `loudnessDeltaDb` | number, dB | no | Stem minus A (gated RMS). **Information only**: players never apply it. |
| `gainDb` | number, dB | no | An explicit trim the player applies to the stem. Absent = 0. |
| `loudness` | [Loudness](#loudness) | no | The stem's own. |
| `segments`, `peaks` | as at the top level | when `ready` | On A's grid: the same `startFrame`/`frames` per segment, `channels` and `sampleRate` of A. |
| `bands`, `spectrogram` | as at the top level | no | The stem's own overview files. |

A stem's URLs SHOULD be under `<key>/` (`b/seg/000000.wav`, `v1/peaks.bin`).

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

### Segments

RIFF/WAVE, `fmt ` chunk with format 1 (PCM), 16 bits, `channels` × `sampleRate`, then
`data`. Readers SHOULD accept other chunks before `data`.
