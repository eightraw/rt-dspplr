# Changelog

Two packages are released from this repository: `@saitdigital/rt-dspplr` (the
player) and `@saitdigital/rt-dspplr-prepare` (the Node prepare step, from 0.1.0).

## @saitdigital/rt-dspplr 0.4.0

### Long recordings (prepared files)

- `play({ manifest })` (or a URL ending in `.json`) plays a recording prepared with
  `@saitdigital/rt-dspplr-prepare` segment by segment, on the same player core as
  whole clips: one `createAudioPlayer()`, one state, the same React card,
  `<Timeline>` and `createTimeline()`. Switching between a whole clip and a
  prepared one on one player stops and unloads the other source.
- The audio of a prepared recording is the original file itself, kept by prepare
  byte for byte (WAV, MP3, Ogg Opus; other formats as a 16-bit WAV). The manifest
  holds an index of it: for each segment, the byte range that holds it. The
  player fetches a segment with an HTTP Range request and decodes it: WAV on the
  spot, MP3, Opus and FLAC with WebAssembly builds of dr_mp3, libopus and dr_flac,
  one lazy chunk per codec (30, 113 and 21 KB gzipped) fetched the first time a
  clip of that codec plays, decoding in a worker (on the main thread when a
  Content-Security-Policy forbids blob: workers). Segments read back the samples
  prepare analysed: WAV and MP3 exactly, Opus within float rounding. An hour of
  MP3 is stored as the MP3 (our hour-long test file: 102 MB instead of 651 MB of WAV
  segments), and on a 4G connection the first sound comes in 1.1–2.2 s and a seek
  in 0.3–0.9 s (WAV segments: 2–6 s).
- The manifest, the peaks and the coarse spectrogram (a few hundred KB to about
  1.5 MB) make the timeline, ruler, zoom, pan, waveform, DSP preview and
  spectrogram usable over the whole duration at once. Audio is fetched around the
  playhead; decoded audio stays near 60 s (`segmented.cacheSeconds`). A 60-minute
  file: UI and first audio in about 130 ms locally, 360 MB of browser memory
  (whole-file mode: 3.9 s and 2.8 GB).
- Playback runs in an AudioWorklet stream engine: sample-exact across segments and
  loop wraps, a held playhead on underruns (silence, then the same sample), smoothed
  volume and A/B mix. Speed keeps the pitch through a realtime stretcher
  (Signalsmith Stretch, MIT, a lazy chunk of about 100 KB, 44 KB gzipped). The
  engine runs at the clip's own rate and converts its output to the context's
  with a streaming windowed-sinc resampler when they differ, so a 44.1 or 16 kHz
  recording keeps realtime speed too. Without the stretcher the pitch follows
  speed and the card says so. The AudioBufferSourceNode scheduler remains the
  fallback (`segmented: { engine: false }`).
- The waveform previews the DSP everywhere: approximated in the overview from the
  stored peaks and bands, exact in a decoded window for views up to 20 s. The
  spectrogram draws the stored overview and refines from decoded segments when
  zoomed in. Both apply the high-pass, the dynamics and plugins at paint time.
- `state.sourceKind`, `state.capabilities` (`canPreservePitch`, `canMixStemB`,
  `stems`, `exactWaveformPreview`, `spectrogram`, `loopSnapping`),
  `state.manifest`, `state.stem`, `state.prepared`, `state.buffering`; the
  `sourceupdate` event; `getManifest()`, `getPeakPyramid()`, `getStreamStats()`,
  `setView()` (the timeline calls it), `getWindowAudio()`, `refreshManifest()`.
- **Named stems.** A manifest's `stems` is a map of host-chosen keys (1–32 of
  `[A-Za-z0-9_-]`, `a` reserved, `b` the default) to time-aligned derivatives of
  the recording, each with an optional `label`. The knob blends A with one stem at a
  time: `play({ manifest, stem })`, `player.setStem(key)`; `capabilities.stems`
  lists the ready ones (`{ key, label }`). The card shows a stem selector
  (`label ?? key`) only when there is more than one. A stem's segments are fetched
  only while the knob is above 0 and let go about 10 s after it is back at 0.
  Manifests with only `stems.b` play as before. The library never interprets keys
  or labels.
- Stems are read as published: no polling unless `segmented.pollStemsMs` is set;
  `refreshManifest()` applies a newer `revision`.
- **Gain stages.** `setInputGain(db)` (new, `processing.inputGainDb`) is the first stage, before the
  high-pass, the compressor and the effects; `setOutputGain(db)` is now the last one, after the
  effects; the -0.01 dBFS ceiling comes after it (it used to sit inside the dynamics, before
  third-party effects, which could then go over full scale). Both gains are smoothed and drawn on
  the waveform and the spectrogram. The card's Post FX panel lists the controls in chain order.
- The spectrogram follows the card's theme (`--rtd-spectrogram-*`, `--rtd-overlay-*`) and paints
  nothing before a clip. `palette.colormap` colours it with a scientific colormap (`magma`,
  `inferno`, `plasma`, `viridis`, `grey`, `_r` reversed, or your own stops; `COLORMAPS`):
  `magma_r` by default in the light theme, `magma` in the dark one.
- The shared AudioContext now runs at the device's rate when it is 44.1 or 48 kHz
  (else 48 kHz) instead of a fixed 48 kHz; `sampleRate` still sets it.

### File formats, manifest specification and schema

- New entry `@saitdigital/rt-dspplr/format`: the manifest types, `assertManifest()`,
  `manifestProblem()`, the stem key rules (`STEM_KEY_PATTERN`, `isStemKey`,
  `assertStemKey`, `DEFAULT_STEM_KEY`), the readers and writers of peaks.bin,
  bands.bin, spectrogram.bin and WAV, and the source runs (`segmentFromRun`,
  `decodePcmRun`, `decodeStreamRun`, `decodeOpusRun`: a segment's bytes decoded
  and cut out, given a codec's compiled WebAssembly). Pure code (no DOM, no Node APIs),
  in a chunk of its own; the prepare package imports it instead of carrying a copy.
  The analysis kernels shared with prepare (`frameRows`, `planBands`, `quantizeRows`,
  `computeHighPassCoefficients`) are exported there as experimental.
- `docs/manifest.md` specifies the manifest, now `formatVersion` 4 (fields, types,
  units, the source and its index, how a run of each codec decodes) and the
  compatibility policy: before 1.0 a player reads its own version only (versions
  1–3, with WAV segment files, are refused: prepare the recording again), and
  ignores unknown optional fields. The timeline is the source's own rate; the
  manifest has no `resample` any more.
- The JSON Schema (draft 2020-12) ships as `@saitdigital/rt-dspplr/manifest.schema.json`.
  `assertManifest()` now checks the same rules (it used to check only a few fields);
  a test keeps the two in agreement on fixtures, on prepared folders and on 72 broken
  manifests.

### DSP plugins (experimental)

- Every effect is a plugin in one chain per player, the built-ins included
  (`rtd.highpass`, `rtd.dynamics`): `player.effects.add / remove / move / bypass /
  setParam`, a parameter schema the card's Post FX panel renders, `nodes` or
  `worklet` realtime processing, `magnitudeResponse()` / `process()` previews in the
  waveform and the spectrogram, `state.previewCoverage`, crash isolation
  (`effecterror`). Chain order: source (A/B mix → stretch) → input gain → effects →
  output gain → ceiling → analyser. Example: `examples/plugins/three-band-eq.js`.
- **The plugin API is experimental** (`@experimental` in the types) and may change
  in minor releases before 1.0.

### Changed

- `./advanced` keeps the 0.3.0 surface (Track, Mixer, AudioEngine, BufferLoader,
  StretchService, WaveformAnalyzer, TimelineCore / mountTimeline, peak-pyramid and
  spectrogram helpers, DSP building blocks) and adds the types and plugin API of the
  main entry. The new streaming machinery stays internal; the file formats are in
  `./format`.
- The package contains no Node-only code (checked at build time). Preparing long
  recordings is a separate package, `@saitdigital/rt-dspplr-prepare`.
- Play and resume no longer reset the timeline's zoom and pan; only another clip does.
- `THIRD_PARTY_NOTICES.md` ships in the package with the notices of Signalsmith
  Stretch (MIT), dr_mp3 and dr_flac (public domain or MIT-0) and libopus
  (BSD-3-Clause), each also embedded in its chunk; the build checks both.

### Fixed

- A player that loaded an A/B pair already decoded in the cache (a page left and
  opened again, so a new player) could lose stem B from its state: B, installed
  while A's load was finishing, was cleared by A's "ready". The spectrogram then
  drew stem A alone in A's colour and stopped following the mix.
- **The high-pass was not the one drawn.** Web Audio reads a biquad's Q in dB for
  high-pass and low-pass filters; the player passed the linear Butterworth Q, so
  what played had +1.85 dB at the cutoff and a +3.8 dB bump just above it, where
  the waveform, the spectrogram and the plugin's response show −3 dB and no bump.
  The nodes now get the Q in dB (−5.33 and +2.32 dB) and match the previews.
- A seek, play or pause while a whole file is still loading is applied once it is
  decoded (the last call wins). Before, it cancelled the autoplay, lost the seek
  target, and could start playback from 0 at the next speed change.
- A prepared clip: `resume()` followed by `pause()` or `stop()` (in the same tick,
  or while the engine was being set up) no longer starts playing, and a seek in
  that window is where playback starts.
- **iOS and blocked audio.** `play()`, `toggle()` and an autoplaying `load()`
  resume the AudioContext synchronously, inside the user's gesture. When the
  context is interrupted (a call, Siri) or suspended while playing, the player
  pauses at the position it had and says why in the new `state.suspended`
  (`'interrupted'`); a play that cannot get the output running reports
  `'blocked'` instead of failing silently.
- The native compressor (the fallback without AudioWorklet, e.g. under a CSP
  without `blob:`) applied the spec's automatic makeup gain and was up to 12–15 dB
  louder than the worklet at full compression. It is compensated (and its knee
  centred as the worklet's), its parameters glide instead of stepping, and it
  stays within about 1 dB of the worklet.
- Whole files: new `maxClipBytes` and `maxClipSeconds` options fail a file that is
  too big early (from Content-Length, then while reading, then after decoding)
  with a `ClipTooLargeError` that points to prepared playback. A known length is
  read into one buffer instead of chunks plus a joined copy. A decode that finishes
  after its load was abandoned is kept in the cache.
- Speed renders belong to the players waiting for them: a player that leaves a
  clip drops its queued renders and stops a running one nobody else waits for, so
  the next clip's render no longer queues behind it, and one player no longer
  cancels another's prewarm of a shared clip.
- Manifests and the files they name: only http(s) URLs are fetched (blob: only for
  a blob: manifest); the host's `fetchOptions` headers and credentials go only to
  the manifest's own origin and to origins listed in the new `fetchOptionsOrigins`
  (other origins, a CDN say, are still fetched, without them). Manifest limits:
  8000–384000 Hz, 1–32 channels, segments of at most 60 s
  (`MIN_SAMPLE_RATE`, `MAX_SAMPLE_RATE`, `MAX_CHANNELS`, `MAX_SEGMENT_SECONDS` in
  `./format`), and a source's rate and channels must match the timeline (Opus:
  48 kHz); a decoded run that does not match fails its segment. bands.bin is
  length-checked before anything is allocated.
- A server that ignores Range requests: a source up to 64 MB is downloaded once and
  every segment cut from it; a larger one fails at once with "The server ignores
  HTTP Range requests" instead of downloading the whole file per segment. A 206
  whose length or Content-Range does not match, or a file whose size changed,
  fails with a clear error that is not retried.
- A new load aborts the previous one's manifest and overview downloads.
  `refreshManifest()` ignores a manifest of another recording or another grid and
  stems made from another A. A disposed stream engine frees its audio at once, even
  when its context never ran.
- Effects: a plugin whose `dispose()` throws is reported and the chain still tears
  down; a failed plugin stays out after the output is rebuilt and cannot be
  un-bypassed; removing or moving an effect crossfades instead of clicking; a
  module that failed to load is retried; two inline worklets with the same
  id@version no longer share code.
- Previews: `process()` written as an async function, a method with a quoted or
  computed name, or an arrow with parenthesised defaults compiled to broken code
  and was silently left out while `previewCoverage` counted it. Every plain form
  compiles now; async and generator functions are left out with a warning and
  counted as missing. Waveform rebuilds keep one request in flight and only the
  latest waiting, so dragging a control no longer queues seconds of work.
- React: `useAudioPlayer` re-arms its player in a layout effect, so a child that
  loads in its own effect works under StrictMode (and React 19 `<Activity>`).
- The credit menu opens inside the player (in the top layer), so it can be reached
  inside a modal `<dialog>` or a focus trap.
- Timeline and card: `[` and `]` set the loop at the playhead; the card keeps its
  seek bar (zoom, focus) across the compact breakpoint; canvases follow a change
  of pixel ratio; any CSS colour works in the spectrogram palette; 119.96 s is
  spoken as "2 minutes 0 seconds"; `aria-controls` only while the target exists.
- Smaller: the dynamics worklet stops when its player is disposed; Rubber Band
  caches a WASM failure that cannot recover and retries others with a backoff;
  status and stem B no longer stay stuck after a failed start; a caller's
  `fetchOptions.signal` is honoured. The `webkitAudioContext` fallback is gone:
  Safari 14.1 or later.

## @saitdigital/rt-dspplr-prepare 0.1.0

First release: the prepare step for long recordings. Node ≥ 20.19, ESM.

- `prepareAudio(input, options)` and the `rtd-prepare` CLI read a recording once,
  as a stream (a path, a ReadableStream or an async iterable), and write
  the original file as it is (`source.<codec>`) with an index of it in the
  manifest (each segment's byte range), multi-level peaks, loudness, bands.bin
  (high-pass preview energies) and spectrogram.bin (overview), and the manifest
  last, atomically. Nothing is resampled: the timeline is the source's rate.
- The index is checked before it is published: the first segment, one past the
  middle and the last are read back the player's way (the same decoders) and
  compared with what was analysed. MP3 runs start 6 frames early (exact), Opus
  runs 500 ms early on a page boundary (within float rounding; RFC 7845's 80 ms
  left errors up to −35 dBFS). A source that is not indexed (FLAC, formats read
  through `ffmpegDecoder()` or another decoder, Opus with more than two channels,
  a file whose index does not read back, a file with non-finite samples) is kept
  as a 16-bit WAV of what was decoded, with a warning when the index failed.
- Analyses run on a `worker_threads` pool (`concurrency`, default cores − 1; a
  short input with no `pool` runs on the calling thread); the output is
  byte-identical for any thread count. `createPreparePool()` makes a pool a
  service keeps and passes to every call (`pool`): warm workers, shared by calls. 60 min mono in about 4 s on 11
  threads, about 0.5 GB peak RSS (`concurrency: 4`: under 300 MB).
- **Named stems** in the same call and the same manifest:
  `stems: { [key]: { input | processor, label? } }`. Each stem is aligned to A by
  FFT cross-correlation in up to 8 windows where A and the stem both sound: the
  offset most of them agree on (to ±2 frames) is compensated and their share is
  the confidence. How strongly a stem correlates with A is not a test: a quiet
  part such as a vocal's breaths correlates weakly however well it is aligned,
  while unrelated or re-timed audio peaks at a different lag in every window. A
  stem silent for part of the file is measured where it sounds. A stem the player
  reads as it is (WAV, MP3 or Opus at A's rate, with A's channels or one) is kept
  byte for byte under `<key>/r<revision>/` with its index shifted by the offset
  (`lead`, `trail` silence where it does not reach); any other is downmixed,
  resampled on the pool (bit-identical to the streaming resampler) and written as
  a 16-bit WAV on A's grid. Each gets its own overview files and is paired with A (correlation,
  mix law, loudness delta as information only, opt-in `gainDb`). Keys are
  validated (pattern, `a` reserved, case-insensitive collisions). A stem that does
  not line up fails the job, or with `onLowConfidence: 'warn'` is recorded as
  failed; the message explains that output which changes timing is not a stem and
  belongs in a clip of its own. CLI: `--stem <key>=<file>`, `--label <key>=<text>`.
- **Stem processors (experimental)**: `commandProcessor`, `dockerProcessor`
  (network none by default), `httpProcessor` (streamed raw or multipart),
  `functionProcessor`; they run beside A's own work, with timeouts, cancellation,
  errors that name the processor, `onProcessorError: 'skip'`, and provenance in the
  manifest. The API may change in minor releases before 1.0.
- `attachStem(target, key, input, { label })` adds or replaces a stem on a prepared
  folder (same code, same bytes, `revision + 1`); `markStem()` for hosts that
  publish before a stem exists.
- **Input formats in process**: WAV, MP3, Ogg Opus and FLAC are decoded in
  WebAssembly (dr_mp3, libopus with opusfile, dr_flac; notices in
  THIRD_PARTY_NOTICES.md), told apart by their first bytes: no ffmpeg and no
  process per input. MP3 is gapless with a LAME header, Opus is trimmed by its
  pre-skip and end granule, FLAC is sample-exact. `builtinDecoder` is the
  default; `mp3Decoder`, `opusDecoder`, `flacDecoder` are exported, and
  `ffmpegDecoder()` stays for other formats.
- **MP3 runs at low bitrates.** A run starts early enough that the bit reservoir
  is full two frames before the segment (511 or 255 bytes of main data back, at
  least 6 frames), so 32 kbit/s, 8 kbit/s and VBR files index exactly too; the
  index check also reads the segment with the longest warm-up.
- A source that fails while it is read (an upload cut short) fails the job with
  its error, also through `ffmpegDecoder()` and for stems; it is never published
  as a shorter recording.
- Limits: `segmentSeconds` from 0.1 to 60, `concurrency` from 1 to 64 (the CLI
  parses its numbers strictly and exits 2 on a bad one); a recording outside
  8000–384000 Hz or 1–32 channels is refused with a clear message.
- About 40 % less memory for the analyses of long recordings (24 h stereo: 1.9 →
  1.2 GB), with byte-identical outputs.
- `ffmpegDecoder({ demuxers })` restricts ffmpeg's demuxers (`-format_whitelist`);
  `AUDIO_DEMUXERS` lists 21 audio containers, the CLI's default. `docker:<image>`
  and `dockerProcessor` accept only an image reference.
- Storage: `outDir`, or any `{ putObject, putFile?, getObject?, getRange? }`;
  `memoryStorage()`. A stream input is copied to the scratch folder on the way
  (it is stored as it is), and read to its end even when the decoder stops early,
  so the stored file and the content id are the whole input.
- Progress `stage: 'a' | 'processor' | 'stem'` with the stem key;
  `job.stats.timings.stems[key]`.
- The formats come from `@saitdigital/rt-dspplr/format` (a dependency, `^0.4.0`):
  one implementation for the writer and the reader.

## @saitdigital/rt-dspplr 0.3.0

- The wheel zooms in proportion to its travel, and the event is taken from the
  page only when the zoom changes: at the whole clip, scrolling down scrolls the
  page. `wheelZoom: 'modifier'` leaves the wheel to the page and zooms with
  Ctrl/Cmd + wheel (and a trackpad pinch) only.
- The built-in vocoder keeps the level at every speed. It was scaled by the
  speed: +6 dB at 2x, −6 dB at 0.5x, a jump on every speed change.
- The built-in vocoder's output lands on time. It was early or late by
  (fftSize/2)(1/speed − 1), about 20 ms of source time at 2x, and up to 0.1%
  slow or fast from a rounded synthesis hop: 0.6 s over ten minutes at 1.25x.
- Dropping or moving the loop while playing keeps the position. The position
  used to unfold the time spent looping into a jump towards the end of the clip,
  and pause/resume then ended the clip. A loop set behind the playhead now starts
  from its beginning, both stems together.
- Touch: a tap seeks, a vertical swipe scrolls the page instead of seeking, a
  sideways drag selects a loop.
- The variant of the current clip at the current speed is held by the player:
  a seek or a restart never renders it again, even when it is too large for the
  cache budget. Prewarming fits the budget beside what the cache already holds.
- Speeds are clamped to 0.25–4x (`SPEED_MIN`, `SPEED_MAX`); `speeds` outside
  the range are dropped with a warning.
- A stretch worker that never answers is replaced after a watchdog; crashes
  retire a slot only after four in a row, and a completed job resets the count.
  Transient detection runs in linear time.
- The waveform and spectrogram workers report a failure after they started
  (one warning) instead of leaving an empty picture and a request that never
  completes; the mixed waveform's RMS no longer reads a mono A with a stereo B
  3 dB too loud.
- The time ruler reaches the end of long clips: steps up to 30 min, labels
  with hours. The focus ring stays visible after a click followed by Tab.
  `<Timeline theme="auto">` redraws when the system scheme flips. The position
  and `timeupdate` keep moving in a background tab.
- `createTimeline(container, player, options)`: the card's seek bar (waveform,
  spectrogram, loops, zoom, pan, keys, ruler, overview) without React, for any
  framework. `<Timeline>` and `<AudioPlayer>` are now built on it. `TimelineCore`
  and `mountTimeline` are in `./advanced` for interfaces with their own clock.
- `vocoderStretcher({ memory: 'auto' | 'fast' | 'lean' })`. 'lean' renders a
  speed frame by frame: the same samples, bit for bit, in about 1/30 of the
  memory (10 min mono: +78 MB instead of +2.3 GB) for 5–10% more time. 'auto',
  the default, uses it for clips longer than 15 s.
- Stretch strategies can carry `options`, handed to their worker with every
  request.
- `emptyText` of `<AudioPlayer>` and `<Timeline>` is a string.
- `infoButton: 'always' | 'touch'`. With `'touch'` the ⓘ button of the author menu
  shows only on devices with a touch screen; with a mouse alone, right-click opens it.
- The ⓘ button lives inside the player and no longer takes a row of the host's
  layout. It goes into an element marked `data-rtd-credit`, or over the top-right
  corner of the player's element (`--rtd-credit-top`, `--rtd-credit-right`).
  `<AudioPlayer />` keeps it in its heading row, and in the compact row.
- No layout-effect warnings from the scrubber during server rendering.

## @saitdigital/rt-dspplr 0.2.0

- First release.
