# Long audio experiment: prepared manifest + segments

Status: experiment on branch `experiment/long-audio`, round 4 (see [Round 4](#round-4): the DSP plugin
API, and stem B as server-processed dry/wet on prepared files). Round 3 (parallel prepare, DSP on the
spectrogram, the AudioWorklet stream engine with realtime stretch, the zoom fix) and round 2 follow it. In round 1 the work was a separate
`createStreamPlayer`. In round 2 it is **one player core with pluggable sources**: `createAudioPlayer()`
plays `{ src }` (the whole clip, decoded) and `{ manifest }` (a prepared recording, segment by
segment). The React card and `<Timeline>` work with both. Every pre-existing test passes unchanged.

## Round 4

### R5: DSP plugins

One effect chain per player (`core/effects/EffectChain.ts`). Every slot has a wet/dry pair of
gains, so bypassing an effect is a click-free crossfade. The built-ins are plugins in it:
`rtd.highpass` and `rtd.dynamics`. The dynamics plugin is compressor + output gain + ceiling in
one, because the gain sits between the compressor and the limiter. Splitting them would let a user
put a gain after the ceiling. `OutputChain.ts` is gone. The contract (`core/effects/types.ts`) and
the usage are in the README, "DSP plugins". In short:

- **Schema** `params[]` (id, label, unit, min/max/default, linear/log, step, format). Values are
  validated: they are clamped, and an unknown id or NaN throws. The card's Post FX panel renders
  third-party plugins from the schema (sliders, bypass, error, a "Not in the preview" note).
- **Realtime**: `nodes` (any Web Audio graph) or `worklet` (module URL or code; params become
  AudioParams).
- **Previews**, so plugins show up in the waveform **and** the spectrogram (the owner's principle):
  - `magnitudeResponse()` for LTI effects. The spectrogram applies it per row at paint time, for both
    sources and the overview. The prepared waveform overview gets a per-85 ms-column level change from
    it, weighted by the prepared spectrogram's energy per row.
  - `process()`, a self-contained function compiled into the peaks worker
    (`waveform/previewStages.ts`). It runs in chain order with the built-ins, so the waveform is
    exact for whole clips and in a prepared clip's decoded window.
  - Without a preview, `state.previewCoverage` lists the effect as missing and the card says so.
- **Crash isolation**: an exception in `create()`, or `onprocessorerror` from a worklet, bypasses
  that slot, sets `effects[i].error` and emits `effecterror`. Playback goes on. A preview that throws
  is skipped.
- Example third-party plugin: `examples/plugins/three-band-eq.js` (low shelf / peak / high shelf,
  native biquads, with both previews). The demo's "EQ plugin" checkbox adds it with the highs at
  −12 dB.

**Chain order: source (A/B mix → realtime stretch) → plugins → volume → analyser.** The reasons:

1. **Mix first.** The effects process what is heard. A compressor on the blend reacts to the blend.
   Per-stem chains would double the cost and make the knob change the compressor's input twice.
2. **Stretch before the plugins.** Filters and compressors keep their real-time constants at any
   speed, and the stretcher sees the dry signal (a limiter's pumping, time-stretched, smears
   audibly). The engine stretches the *mixed* signal, so there is one stretcher, not an A and a B
   that could drift apart.
3. **Volume last (post-insert fader).** The listening level never changes how hard the dynamics work
   (tested: volume 0.5 gives exactly a 0.5 ratio with compression at 1). The analyser and the meters
   are after it.

Tests: `test/browser/plugins.spec.mjs` (8). They cover: the EQ heard (+12 dB low shelf on a 120 Hz
tone), bypass/move/remove; the EQ drawn on the waveform and spectrogram (whole and prepared); the
coverage flag in the state and the card; the schema UI; validation; a crashing worklet bypassed while
playback continues; the volume after the effects.

### R4: stem B as server-processed dry/wet

**The flow (owner's clarification).** B is made on the server **before the file is published**, as
part of manifest creation:

> external processing configured? → B is needed → run the processor → align and adapt → stems.b in
> the **one** manifest → publish.

The player reads manifests as published: B is in the manifest or it is not. There is no "B arrives
later" case in the default flow.

**One call** (`prepare/prepareAudio.ts` + `prepare/stem.ts`):

- `prepareAudio(a, { stems: { b: { input } } })` takes a ready-made B: a path, a byte-stream factory,
  or `{ channels, sampleRate }`.
- `prepareAudio(a, { stems: { b: { processor } } })` takes a processor that makes B. Exactly one of
  the two is allowed.
- A's segments and analyses run first. The processor (if any) runs **beside them**: it starts as soon
  as A's format is known, from A's file, or from a scratch copy when A is a stream.
- Then `buildStem()` aligns and adapts B. The single manifest (revision 1, `stems.b`) is written
  last, atomically.
- Progress carries `stage: 'a' | 'processor' | 'b'`. `job.stats.timings = { aMs, processorMs,
  processorWaitMs, stemMs }` and `job.stats.warnings`.
- `attachStem()` (a secondary utility for folders that are already prepared) calls the same
  `buildStem()`. A test checks that it writes **the same B bytes** as the one-call prepare.

`buildStem()`:

1. **Alignment.** B is decoded at its own rate. Only the native input under the 8 alignment windows
   (2 s each, ±1 s search, plus the filter's half-length) is kept and resampled (`resampleRange`).
   These windows are bit-identical to what a full resample gives there. FFT normalised
   cross-correlation runs against A's windows, which are read back from A's written segments.
   - The offset is the median lag of the windows that agree within ±2 frames. `confidence` is
     their median peak.
   - When the confidence is low, the job fails (nothing is published). With
     `onLowConfidence: 'warn'`, A is published alone, with `stems.b = { status: 'failed', error,
     alignment }` and a warning.
2. **Conversion, once.** B is downmixed first when A is mono, which avoids resampling channels
   that are thrown away. It is resampled to A's rate **on the worker pool** (`parallelResample.ts`),
   mono B is mapped to every channel of A, and B is shifted, padded or trimmed to A's frames.
   Resampling is cut into 512 K-frame output chunks. Each chunk is computed from its input slice
   plus the filter's half-length on each side, with the streaming resampler's exact taps and
   accumulation order. The output is **bit-identical to `StreamingResampler` for any chunking and
   thread count** (tested at 16→48, 96→48 and 44.1→48 kHz). A's own resampling (96 kHz sources)
   uses the same path now, so it no longer runs on one thread.
3. **Grid and pairing.** B goes through the same `writeTimeline()` as A, sharing one pool: segments
   on A's grid, peaks, bands and spectrogram under `b/`. Correlation with A is accumulated per
   segment and globally. The mixLaw is `crossfade` when ρ ≥ 0.5, else `equal-power`.
   `loudnessDeltaDb` is **information only**, `gainDb` defaults to 0, and `source.bandwidthHz` is
   recorded.

**Stem processors** (`prepare/processors.ts`) play the server-side part of the player's plugins.

- Contract: `StemProcessor { id, version, params?, timeoutMs?, run({ path, stream(), sampleRate,
  channels, frames, tmpDir, signal, onProgress }) → { path } | { stream } | { channels, sampleRate } }`.
- `runProcessor()` enforces the timeout (default 30 min), forwards cancellation, and wraps every
  failure in `StemProcessorError`, which names the processor.
- Adapters:
  - `commandProcessor` spawns without a shell, using `{in}` / `{out}` / `{tmp}` placeholders. On
    failure it reports the exit code and the end of stderr.
  - `httpProcessor` sends a raw or multipart body (streamed, never held in memory) and reports
    non-2xx with the status and the body.
  - `dockerProcessor` uses `--network none` by default, mounts A read-only at `/in` and `/work` for
    the output, and runs `docker kill` on cancel.
  - `functionProcessor` wraps a function.
- A stream output is spooled to the scratch folder, because B is read twice.
- Provenance: `stems.b.processor = { id, version, params, durationMs }` and `stems.b.aSourceId`.
- When the processor fails, the job fails. With `onProcessorError: 'skip'`, A is published alone,
  with the error and the provenance recorded.
- The job's end (success, failure or cancel) always stops the processor.

**Player side** (`SegmentedSource`):

- **Default.** `stems.b` ready → a second segment store, knob enabled. Anything else → no stem B, knob
  disabled, and no "processing" note or spinner.
- **Opt-in polling.** `segmented.pollStemsMs` defaults to 0. A host that publishes a manifest before
  its B exists can set it, and `markStem(…, 'processing')`; only then do `statusB 'processing'` and
  the card's note appear.
- **`player.refreshManifest()`** stays as an explicit call for hosts that replace manifests: a newer
  `revision` is applied without a reload.
- **Fetching B.** The engine's B voice is fed only while the knob is above 0, or was moved in the
  last 10 s. Moving the knob prefetches the playhead's segments first. Back at 0, B is dropped from
  the engine and the cache about 10 s later.
- **Gains.** `mixGains(mix, law)` with B × 10^(gainDb/20). The law is `options.mixLaw`, else the
  manifest's, else 'crossfade'.
- **Previews.** B's peaks, bands and spectrogram load when the knob first leaves 0. The waveform
  overview blends A and B per bin (coherent for a correlated pair, RMS in quadrature otherwise),
  then applies the HP, the plugins and the dynamics. The decoded window hands B's buffer to the exact
  waveform and spectrogram analysers, and both spectrograms paint with the engine's gains.

Also fixed: `play()` during a prepared clip's set-up (the card's first click, before the engine
existed) used to start a transport that the engine then discarded: silence with `isPlaying` true. It
now waits for the set-up. A failed or cancelled prepare also releases its decoder and source file.

**Tests.**

`test/prepare.test.ts`:

- Parallel resampling is bit-identical to the streaming resampler.
- One-call A+B with B at 16 kHz mono, 37 ms late, −6 dB: offset, grid identity, level, one manifest,
  all files byte-identical for 1 vs 4 threads, and `attachStem` writing the same B bytes.
- Refusals: the job fails, or with 'warn' A is published alone.
- Function processor (high-shelf + expander, 23 ms late): ran beside A, provenance recorded.
- Command processor (a node CLI): exit code and stderr reported, 'skip', the 400 ms timeout kills a
  hung CLI, cancellation.
- HTTP processor (a local server): raw body, multipart, and a 503.

`test/browser/stems.spec.mjs` (6):

- level laws;
- B at its own level;
- lazy B fetch;
- the card with B present → knob on, B absent → knob off with no "processing";
- no polling by default, then explicit `refreshManifest()` attaching B while A plays;
- the blend drawn in the waveform and the spectrogram.

| check | result |
|---|---|
| offset of a 37 ms delay (node / browser fixture) | 1776 frames = 37.00 ms, confidence 0.999 / 1.0, ρ 0.999 |
| 23 ms processors (function / CLI / HTTP) | 1104–1105 frames, confidence ≥ 0.998, ρ ≥ 0.997 |
| level, equal-level pair, crossfade: knob 0 / 0.5 / 1 | −20.03 / −19.84 / −20.08 dBFS (limit ±0.5 dB) |
| same pair with equal-power forced, knob 0.5 | +3.20 dB |
| B at −6 dB, knob 1 / 0.5 | −5.84 dB / −2.54 dB vs A (own level; linear 0.75 → −2.50) |
| refreshManifest() while playing | ready, knob on, A kept playing, 0 underruns, B at −6.16 dB; 0 manifest requests before it |

**Timings** (11 threads; `scripts/long/stems-bench.mjs`; peak RSS of the process, workers included).
The "before" column is round 4a: A prepared, then `attachStem` (which resampled on one thread,
twice).

| recording | B | A only | A + B, one call | B part | before: attach alone |
|---|---|---|---|---|---|
| espeak 30 min mono | ready-made, 16 kHz mono | 2.0 s, 509 MB | 7.4 s, 507 MB | 5.5 s | 24.2 s, 394 MB |
| synthetic 60 min mono | ready-made, 48 kHz mono | 3.7 s, 462 MB | 8.8 s, 492 MB | 5.3 s | 6.6 s, 478 MB |
| synthetic 30 min stereo | ready-made, 48 kHz mono → stereo | 2.6 s, 478 MB | 7.2 s, 472 MB | 4.5 s | 4.8 s, 494 MB |
| synthetic 10 min 96 kHz stereo | ready-made, 48 kHz mono → stereo | 3.5 s, 553 MB | 5.5 s, 540 MB | 2.2 s | 2.3 s, 461 MB |
| espeak 30 min mono | **docker processor** (ffmpeg afftdn, network none) | 2.0 s | 14.7 s, 487 MB | 3.0 s | — |

With the Docker processor, the processor took 11.6 s beside A and the job waited 9.5 s for it after
A was done. It found an offset of 24.98 ms (confidence 0.959, ρ 0.956): afftdn's own latency,
measured and compensated. The B part that remains for a 48 kHz B is mostly `writeTimeline` (segments
and analyses, as for A) plus reading A back for the correlation.

## Round 3

The owner's principle: **every place where the user can see or hear the signal reflects the
current DSP state, live, for both sources.** The waveform, the spectrogram, the card and every
timeline therefore draw from one shared DSP preview per player. Meters read the analyser that sits
after the DSP chain. The overview strip draws no signal (only the view window and the playhead), so
it has nothing to follow.

Round 3 covered R2 (parallel prepare), R1 (DSP on the spectrogram), R3 (AudioWorklet stream engine
with realtime Signalsmith stretch) and the transport/zoom bug. **R5 (the plugin API) and R4 (stem
B / dry–wet for prepared files) were not started this round.**

### Bug fix: transport no longer resets zoom and pan

- **Cause:** the timeline view was keyed on `${clipId}:${playRequestId}`, and `playRequestId` grows
  on every play and resume. Pressing play therefore reset the zoom and pan.
- **Fix:** `clipIdentity(state)` = `clipId | src | sourceKind` is now the key, in `createTimeline`
  and in the card's `resetKey`. `playRequestId` keeps its meaning (nothing else read it for the view).
- **What resets the view now:** only another clip. Play, pause, resume, stop, seek, speed, loop and
  `play(sameClip)` keep the zoom, the pan and any draft loop. While playing, the existing "follow"
  pan still keeps the playhead in sight.
- **Tests:** `test/browser/view.spec.mjs`, with both sources, for `createTimeline` and the card.
  They fail against the old key and pass with the fix.

### R2: prepare in parallel

One decode pass now feeds a `worker_threads` pool (`prepare/jobs.ts`, `pool.ts`, `worker.ts`
→ `dist/prepare-worker.mjs`).

- **Jobs:** fixed cuts of the timeline (12.8 s at 48 kHz), aligned to every bin size (256-frame
  peaks, 2048-frame bands, 4096-frame spectrogram hop).
- **Overlap:**
  - Peaks need none.
  - A spectrogram frame never reads outside its job.
  - The band IIRs get 49 152 frames (about 1 s) of warm-up audio before each job, far longer than
    their decay time.
- **Determinism:** the cut does not depend on `concurrency`. 1 thread and N threads therefore write
  **byte-identical files** (node test). Loudness blocks are now whole 256-frame bins (400 ms at
  48 kHz).
- **Option:** `concurrency` (default cores − 1, minimum 1), plus the CLI flag `--concurrency`. If the
  worker file cannot be found (another bundler, a sandbox), the jobs run inline.
- **FFT:** it already used precomputed twiddles and reused buffers, with no per-frame allocation.
- **Deriving bands from the STFT (considered, not adopted):** a 4096-point FFT at 48 kHz has
  11.7 Hz bins, too coarse for the 25–71 Hz cutoffs. The IIR bands stayed within 0.18 dB of brute
  force, and in parallel they cost about 0.6 s per hour.

| 60 min mono 48 kHz | round 2 | **round 3** (11 threads) | 4 threads | 1 thread |
|---|---|---|---|---|
| time | 18.1 s | **3.9–4.2 s** | 5.5 s | 17.4 s |
| peak RSS | 149 MB | 466–489 MB | 272 MB | 161 MB |

Other files at 11 threads: 30 min stereo 3.1 s; espeak 30 min 2.4 s; 10 min 96 kHz 13.2 s, where the
resampler is still single-threaded.

- **Memory:** about 10 MB per idle worker isolate, plus about 30 MB per busy one. Pass
  `concurrency: 4` for under 300 MB.
- **Heaps:** workers run with small heaps (young generation 4 MB, old generation 48 MB) so finished
  jobs' garbage is collected quickly.

### R1: the spectrogram shows the DSP (both sources)

The processed spectrogram is applied **at paint time** (`core/spectrogram/dspPaint.ts`). A knob move
only repaints; no STFT is computed again.

- **Per row:** |H(f)| of the high-pass, from the **same coefficients** as the DSP chain and the
  waveform preview (`computeHighPassCoefficients`, two Butterworth sections). This is exact for the
  LTI filter, up to each row's width.
- **Per column:** the dynamics gain over the column's time span. This is the compressor, output gain
  and ceiling together, as RMS out / RMS in, from the **same envelope code** as the waveform
  preview (`dynamicsPreview.ts`, which now also emits the per-bin gain). Where it comes from:
  - **Whole clip:** the peaks worker sends a gain track (per 256 frames) with the processed
    pyramid. Exact.
  - **Prepared overview:** the approximation worker sends one. Approximate.
  - **Prepared, zoomed in (≤ 20 s):** the exact window's worker sends one. Exact.
- **One shared preview per player:** `subscribeDspPreview(player)` (in `followWaveform.ts`) is
  shared by every waveform, spectrogram and card view of a player. A spectrogram on its own also
  starts it. The "one spectrogram worker" test now counts 2 workers: one spectrogram worker plus the
  shared peaks worker. That is a deliberate change.
- **Responsiveness:**
  - Output gain rescales the gain track at once.
  - High-pass is per row, so it is instant too.
  - Compression waits for the worker's recompute: tens of ms for a whole clip, about 0.25 s for an
    hour's overview.
- **Paint cost per knob move** (1600×320 px): 0.7 ms for the DSP pass plus 3.6 ms for colouring.
  The repaint lands **12 ms** after a high-pass or gain move, in both sources.
- **Tests** (`dsp-spectrogram.spec.mjs`, both sources):
  - HP 500 Hz darkens the low rows to below 75 % of their brightness;
  - compression changes 63–64 % of the columns;
  - −24 dB of output gain repaints within 200 ms;
  - the paint cost above.

### R3: the stream engine (AudioWorklet) with realtime stretch

`core/engine/streamEngine.worklet.ts` (inline worklet) and `StreamEngine.ts` (main-thread handle)
replace AudioBufferSourceNode scheduling for prepared clips. The old scheduler remains the fallback
when there is no AudioWorklet, and with `segmented: { engine: false }`.

```
segments (Float32, transferred over the port; no SharedArrayBuffer, no COOP/COEP)
   └─ voices A, B read the same timeline position (lockstep)
        └─ mix gainA·A + gainB·B (smoothed 20 ms)
             ├─ 1x: direct, sample-exact
             └─ ≠1x: Signalsmith Stretch (pitch kept) — engaged via an energy-normalised
                20 ms crossfade, then kept (1x included) until the next start or jump
        └─ volume (smoothed 20 ms) · declick (4 ms fade around seek / pause / play-while-playing)
             └─ the player's post-FX chain (high-pass, dynamics worklet, ceiling, analyser)
```

**Timing.** Messages land at the next render quantum, or at their own `frame`, in which case the
128-frame block is split there. Loop wraps happen inside the render loop at the exact sample.

**Position.** It comes from the engine: the frame it has rendered, reported every 2 quanta
(5.3 ms) and moved on by the context clock in between. Transport messages carry a sequence number,
so a report from before a seek is never taken as the new position.

**Underruns.** When the audio at the playhead (or the stretcher's look-ahead) is missing, the engine
plays silence and **holds the playhead**, then resumes from the same sample. Content is never
skipped. Stats count `underruns` and `underrunFrames`. A wait right after a start or a seek, or
during the fade-out before a jump, is a fetch, not an underrun.

**Feeding.** The main thread hands the engine the playhead's segment (alone first, so a seek does
not share bandwidth), the segment before it (the stretcher's history), the prefetch path through
loops, the loop edges and the segments on screen. It drops the rest. The decoded LRU (60 s) stays
for the window and loop snapping.

**Volume and mix.**
- New `player.setVolume(linear)`, also in `state.volume`. For prepared clips it is smoothed inside
  the engine; for whole clips it is a 5 ms time constant on the mixer.
- The post-FX output gain stays where it was, after the compressor. Folding the compressor into the
  engine would have moved the gain before it and changed what "Output gain" means.
- The A/B mix gains are in the engine, smoothed 20 ms. Stem B voices are wired in; preparing B is
  R4.

**Signalsmith Stretch** (npm `signalsmith-stretch` 1.3.2, MIT). Only its Emscripten factory (the
WASM) is vendored, with its notice, by `build/vendor-signalsmith.mjs` into `src/vendor/`. It is a
lazy 100 KB chunk (44 KB gzip), added to the worklet scope only when a prepared clip plays. It runs
**inside our engine worklet**; its own processor and node are not used. The reasons:
- one place owns timing, underruns, loops and mixing;
- no extra node per voice;
- the A/B lockstep is free.

The engine drives the stretcher the way upstream's web release does, "seek every block". Each block
hands the stretcher the input window around the playhead and takes the block's output. The window
is 5760 frames (120 ms) and is read `outputLatency × rate` ahead, so the output lands on the playhead
(voice lag 0 ms). This has three consequences:
1. There is no start-up pre-roll gap.
2. A seek is just another window.
3. **Loop wraps are seamless.** The window is read through the loop: after a wrap, the samples
   before the loop start are the end of the loop. Measured on a seamless 1 s tone loop at 1.5x,
   then moving to 1x, 2x and 1.5x: every 10 ms window stays within **0.60 dB**, and the maximum
   sample step is 0.026 against 0.025 for the tone itself.

**Hand-over between the direct path and the stretcher.** The stretcher's output is not
phase-aligned with its input: a phase vocoder smears time by tens of frames. Crossfading the two
paths can therefore cancel.
- A start or a jump picks the path outright, behind the declick.
- Once stretching, the engine stays in the stretcher, 1x included, until the next start or jump.
  Speed changes while playing are then smooth (test above).
- The first move away from 1x while playing blends over 20 ms with energy normalisation. On a pure
  tone that still leaves a short dip of up to about 8 dB; on speech it is not apparent.

**Capabilities.** `canPreservePitch` is true for prepared clips once the stretcher is ready, and the
card's "pitch ±" note disappears. Without it (`segmented: { realtimeStretch: false }`, no WASM, or a
manifest rate ≠ context rate) speed falls back to resampling, and the note shows.

**Quality** (`long-audio-bench.mjs --stretch-quality`). The table compares the realtime engine
(Signalsmith) with the offline vocoder and Rubber Band R3. WAVs are in `scratch\longaudio\listen\`.

| Signal | Speed | Level realtime / vocoder / Rubber Band (dB) | Voice spectral distance to time-scaled source (dB) | Realtime CPU (% of a core, mono) |
|---|---|---|---|---|
| tone 440 Hz | 0.75–2 | −0.01 / −0.01 / 0.00 | — | 6.4–7.3 |
| noise | 0.75 / 1.25 / 1.5 / 2 | −0.84 / −0.92 / −1.38 / −1.74; vocoder −3.0…−3.4; RB −1.1…−3.2 | — | 7.1–8.0 |
| voice (espeak) | 0.75 | −0.28 / −1.14 / −0.15 | 3.39 / 4.38 / 3.52 | 7.6 |
| voice | 1.25 | −0.27 / −1.39 / −0.25 | 2.64 / 4.21 / 2.81 | 7.0 |
| voice | 1.5 | −0.58 / −1.83 / −0.37 | 3.62 / 4.63 / 3.90 | 7.5 |
| voice | 2 | −1.15 / −2.20 / −0.64 | 5.67 / 6.09 / 6.48 | 7.6 |

- **1x** is the direct path: about 0.5 % CPU, sample-exact.
- **Timing:** the voice envelope's lag is 0 ms at every speed for all three. Tone and noise lags
  are meaningless, because their envelopes are flat.
- **Level:** ±0.5 dB holds for tone at every speed and for voice at 0.75–1.5x. It does **not** hold
  for voice at 2x (−1.15 dB) or for noise (−0.8…−1.7 dB). The other stretchers lose more on noise,
  which is typical of phase vocoders. This is reported, not compensated.

**Whole clips on the engine? Evaluated, not switched yet.** Realtime stretch costs about 7 % of a
core per stretched voice. It removes the offline variants (up to 2× the clip's PCM per speed in the
cache), the prewarm work and the "preparing 1.5x" wait. Its quality is at least the offline
vocoder's: closer level and smaller spectral distance on voice. It is near Rubber Band on voice
level and better on spectral distance at 1.25–2x.

Decision: **keep the offline variants for whole clips in this round.** The whole-clip transport
tests are built on their semantics (`pendingSpeed`, variant cache), and Rubber Band remains the
highest-level-fidelity option. Next step: run `BufferSource` through the engine, feeding the decoded
clip as segments, with offline variants as a fallback strategy.

**Engine tests** (`engine.spec.mjs`, offline and realtime):
- sample-exact across segment boundaries and three loop wraps (max error < 1e-6);
- click-free volume, A/B mix and seek (max sample step < 1.15 × the tone's own);
- underrun: silence, then the same sample resumes, with 1 underrun counted;
- seek latency: cached 9–20 ms, uncached 29–44 ms locally;
- the stretch loop and speed-change continuity above.

**60 min mono, round 3 (engine):**
- Local: UI 131 ms, spectrogram 110 ms, first audio 131 ms, seek 34–58 ms (17–35 ms until audio
  plays), 361 MB, 0 underruns.
- 100 Mbit/s: UI 347 ms, first audio 450 ms, seek 133–157 ms (128–151 ms), 394 MB, 0 underruns.
  Round 2 was 157–189 ms; the playhead's segment is now fetched alone first.
- Normal mode, for reference: 4.1 s to UI and audio, 2.9 GB peak.

## Problem

The player decodes a whole file into Float32 PCM before anything happens: the waveform worker gets a
copy, and speed variants are rendered over the whole clip. For a 60-minute file that means
downloading 345 MB, holding about 691 MB of PCM plus a second copy for analysis, and using about
1.8–2.8 GB of browser memory. Nothing plays until the download finishes. Short clips feel instant;
long ones do not.

## Design

The heavy work moves to ingest time. A Node **prepare** step reads the recording once, as a stream,
and writes:

```
<out>/manifest.json     versioned description (format 2, analyzer 1.1.0)
<out>/peaks.bin         min/max/RMS peaks, finest 256 frames/peak, ×8 per level
<out>/bands.bin         high-passed energies per 2048 frames (high-pass preview)      v2
<out>/spectrogram.bin   overview spectrogram, 128 log rows, 85 ms columns, ×8 levels  v2
<out>/seg/000000.wav    fixed-length 16-bit PCM segments (10 s default), sample-exact
```

In the browser, the manifest, peaks, bands and the coarse spectrogram total a few hundred KB to
about 1.5 MB in their first requests. They make the timeline, ruler, zoom, pan, waveform, processed
preview and spectrogram usable for the whole duration at once. Audio arrives one segment at a time
around the playhead, and decoded audio stays capped at about 60 s.

### One core, pluggable sources

```
                      ┌ BufferSource     whole clip: Track A + stem B, stretch variants,
createAudioPlayer() ──┤                  zero-crossing loops            play({ src })
 state · events ·     └ SegmentedSource  manifest: SegmentStore (fetch/decode/LRU) +
 transport · mount                       SegmentScheduler              play({ manifest })
        │
        └── OutputChain (one, shared): input ─ high-pass ─ dynamics worklet / native ─ analyser
```

- `AudioPlayerCore` (`core/AudioPlayer.ts`) now holds only what every clip shares:
  - the state store and events, and `mount` (the author menu);
  - the public API, which routes transport to the current source;
  - the output chain (`core/engine/OutputChain.ts`). This is now the only copy; the round-1
    duplicate is gone.
- `PlaybackSource` (`core/sources/types.ts`) defines `load / isLoaded / restart / resume / pause /
  stop / seek / setLoop / setSpeed / setMix / setSourceB / getCurrentTime / unload / dispose`. A
  source writes its part of the state through a small `SourceHost`.
- `BufferSource` is the original Track/Mixer/stretch/stem-B logic, moved out of `AudioPlayerCore`.
  The only behavioural change is that its mixer feeds the shared output chain.
- `SegmentedSource` is the round-1 stream player without its own store, events or DSP.
- Switching between a whole clip and a prepared clip on the same player stops and unloads the other
  source.
- `createStreamPlayer` and `StreamPlayerCore` remain only as **deprecated thin aliases**.
- A URL ending in `.json` is treated as a manifest, because no browser decodes JSON as audio.

**Capabilities.** `state.capabilities` reports what the current source can do:
`{ kind, canPreservePitch, canMixStemB, exactWaveformPreview, spectrogram, loopSnapping }`.

| | buffer | segmented |
|---|---|---|
| canPreservePitch | true when the strategy has a worker | true once the engine's realtime stretcher is ready (round 3); else false: resampling, pitch follows speed |
| canMixStemB | true | **false**: no stem B / enhanced yet |
| exactWaveformPreview | true | **false**: exact only in the decoded window |
| spectrogram | true | true (prepared overview + live close-up) |
| loopSnapping | always | only where the audio is in memory |

UIs degrade visibly rather than silently:
- In the React card, the speed control on a segmented clip gets the label "pitch follows speed" and
  a tooltip. When speed ≠ 1 it shows a red **"pitch ±"** note (`data-pitch-shift="on"`).
- The Stem A ⇄ B slider is disabled, as it is for any clip without stem B.
- `player.stretchAvailable` is false for segmented clips.

### Waveform with the DSP preview (`core/waveform/followWaveform.ts`)

`createTimeline`, the React card and `<Timeline>` all draw through one follower, which follows the
player across sources:

- **Whole clip:** unchanged. The peaks worker builds the source pyramid, then the processed preview.
- **Prepared clip, overview / not-yet-decoded regions: APPROXIMATE** (`approxPreview.ts`), computed
  in its own inline worker (`approx.worker.ts`) and debounced like normal mode. It uses the stored
  256-frame peaks.
  - **High-pass:** each bin is scaled by √(E_hp(fc) / E_total) from `bands.bin`.
  - **Dynamics:** the peaks worker's own compressor + output gain + ceiling code. It was moved, not
    copied, into the shared `dynamicsPreview.ts`. It runs at the worker's 32-frame rate: each stored
    bin becomes 8 sub-steps, with the peak in the first and RMS·√2 in the rest. Run at the stored
    bins' rate instead, it compressed 1–2 dB too much.
  - **Levels:** rebuilt by doubling (`buildPeakPyramid`), exactly as the worker does, so both modes
    draw from the same bin sizes (identical pictures with no processing).
- **Prepared clip, visible window: EXACT.** For views up to 20 s, the timeline reports its range
  (`player.setView`). The source decodes the segments on screen plus a quarter-view margin (at most
  4 segments). The **same peaks worker** (`WaveformAnalyzer`) then runs on that window's audio. Its
  levels are offset to the window's place on the timeline (partial levels, `startBin`), and the
  drawing prefers them wherever they cover the view.
- A v1 manifest has no `bands.bin`. The overview then skips the high-pass approximation; the exact
  window is unaffected.

### Spectrogram (`core/spectrogram/PreparedSpectrogramView.ts`)

The spectral analysis of the spectrogram worker (Hann FFT, logarithmic row plan, 4096/2048/1024
bands blended at the edges, 8-bit frames) moved into the pure module `core/spectrogram/spectral.ts`.
The worker imports it unchanged, and **prepare uses the same code**.

`createSpectrogram` follows the player's source:
- **Overview:** the `spectrogram.bin` levels are drawn for any window as soon as they load, with the
  same sampling and colouring (`sampleSpectralPyramid`, `paintSpectrogram`) as a decoded clip's
  pyramid.
- **Zoomed in** past the overview's resolution (fewer than 2 columns per 85 ms frame): the window's
  decoded segments go through the existing `SpectrogramAnalyzer` worker, and the close-up replaces
  the overview where it covers the view.
- Both use the file's loudest bin as the reference, so the close-up keeps the levels of the overview
  around it.
- The palette, `floorDb`, `minHz`/`maxHz` and `fftSize` options are the same as in normal mode.

## Formats

### manifest.json (formatVersion 3)

v3 adds `revision` (bumped on every rewrite) and `stems.b`: `{ status, error?, updatedAt, aSourceId (A's id),
processor? { id, version, params, durationMs }, id (sha256 of
B's bytes), source { name, bytes, sampleRate, channels, frames, bandwidthHz }, alignment { offsetFrames,
offsetMs, confidence, windows, agreeing }, correlation { global, perSegment[] }, mixLaw,
loudnessDeltaDb, gainDb, loudness, segments, peaks, bands, spectrogram }`. B's files are under `b/` with
A's layout. v1 and v2 manifests still play.

#### formatVersion 2 (unchanged in v3)

Version 1 fields are unchanged; see the round-1 notes in git history. Version 2 adds two optional
blocks:

```jsonc
"bands": { "url": "bands.bin", "bytes": 1856314, "format": "rtd-bands", "version": 1,
           "framesPerBin": 2048, "bins": 84375, "cutoffsHz": [25,35,50,71,100,141,200,283,400,566] },
"spectrogram": { "url": "spectrogram.bin", "bytes": 6170352, "format": "rtd-spectrogram", "version": 1,
           "rows": 128, "minHz": 30, "maxHz": 16000, "topDb": 60, "rangeDb": 120,
           "levels": [ { "framesPerColumn": 4096, "columns": 42188, "byteOffset": 770288, "byteLength": 5400064 }, … ] }
```

- `formatVersion` is 2 and `analyzerVersion` is 1.1.0.
- The player reads v1 and v2. Without the new blocks it falls back to no high-pass approximation and
  no spectrogram overview.
- The manifest is still written last, so its presence means every file it lists is in place.

### peaks.bin

Unchanged (v1): magic `RTDP`, finest 256 frames/peak, ×8 levels, coarsest first, Int16 min/max/RMS.
Rationale, kept from round 1: two Int16 per min/max pair take the same 4 bytes as two packed
float16, decode through a plain `Int16Array` view in every browser, and 1/32768 steps are finer
than a pixel.

### bands.bin (v1)

```
 0 "RTDB" · 4 u16 version · 6 u16 header bytes · 8 u32 sample rate · 12 u32 frames/bin (2048)
16 u32 bins · 20 u16 K cutoffs · 22 reserved · 24 f32[K] cutoffs (Hz)
data: bins × (1+K) u16, bin-major [E_total, E_hp(c0) … E_hp(cK-1)]
      q = round((10·log10(meanSquare) + 160) × 400)  → 0.0025 dB steps, 0 = silence
```

**Why high-passed energies at half-octave cutoffs.** The player's high-pass is a 4th-order
Butterworth, and prepare applies *that same filter*
(`computeHighPassCoefficients`, `HIGH_PASS_SECTION_Q`) at each cutoff. The energy left at any fc is
interpolated in dB over log-frequency between the stored cutoffs.

Two designs were tried first and dropped:
1. Low-passed energies with `E_hp = E_total − E_lp`. The difference cancels catastrophically where
   the high-pass removes nearly everything (hum, rumble): errors went to ±∞ dB.
2. Octave cutoffs. A strong tone between two cutoffs (60 Hz hum with HP at 80 Hz) was off by up to
   3.4 dB; half-octave steps bring that down to 0.9 dB.

Cost: the signal is split at about 4.8 kHz. The low band is decimated to about 12 kHz, where the 10
high-passes run; only the high band's energy is measured at the full rate. The pair is
power-complementary, so `E_hp(fc) ≈ E[HP_fc(low)] + E[high]`.

Size: 22 bytes per 43 ms, 1.9 MB per hour.

### spectrogram.bin (v1)

```
 0 "RTDS" · 4 u16 version · 6 u16 header bytes · 8 u32 sample rate · 12 u16 rows · 14 u16 levels
16 f64 frames · 24 f32 minHz · 28 f32 maxHz · 32 f32 topDb · 36 f32 rangeDb · 40 f32 referenceMax
48 level table (finest first): u32 framesPerColumn, u32 columns, f64 byteOffset
data, COARSEST FIRST: per level columns × rows u8 (column-major, row 0 = highest frequency)
```

- **Frames:** the mono downmix (the worker's own: mean of channels, 16-bit) every 4096 frames
  (85 ms), through the shared spectral code, with 128 rows from 30 Hz to 16 kHz.
- **Quantisation:** absolute, `255 = +60 dB`, `0 = −60 dB`, 0.47 dB per step. A fixed `topDb` lets
  the file be written in one streaming pass; `referenceMax` (the loudest 2048-point bin) is stored
  for colouring.
- **Levels:** ×8 levels pool the louder of 8 columns, down to ≤ 512 columns.
- **Loading:** one Range request brings the header and every level except the finest: 770 KB for an
  hour, then 5.4 MB more.
- Size: 6.2 MB per hour (mono or stereo, since the downmix is analysed).
- **Why one finest level plus ×8, not map-style tiles:** at 85 ms the finest level is only 5.4 MB per
  hour. A tiled layout would add an index for no gain at this size. Deeper zoom is live (above)
  anyway.

## API

```ts
import { prepareAudio, ffmpegDecoder } from '@saitdigital/rt-dspplr/prepare';     // Node
const job = prepareAudio('talk.wav', { outDir: 'prepared/talk' });              // bands/spectrogram: true by default
await job.done;  // job.status: 'queued' → 'processing' → 'ready' | 'failed'

import { createAudioPlayer, createTimeline } from '@saitdigital/rt-dspplr';   // browser
const player = createAudioPlayer({ element, segmented: { cacheSeconds: 60, prefetchSegments: 2 } });
createTimeline(seekEl, player);                                   // waveform, DSP preview
createTimeline(specEl, player, { display: 'spectrogram' });       // prepared overview + live close-up
await player.play({ manifest: '/prepared/talk/manifest.json' }); // or play({ src: '/talk.wav' })
player.getState().capabilities;      // { kind: 'segmented', canPreservePitch: false, … }
player.getStreamStats();             // cache, fetches, latencies, peaks/bands/spectrogram bytes
```

```tsx
// React: the normal card, on a manifest
const p = useAudioPlayer();
useEffect(() => { void p.load({ manifest }); }, [manifest]);
<AudioPlayer player={p} display="both" />
```

- **New on the core:** `getManifest()`, `getPeakPyramid()`, `getStreamStats()`, `setView()` (called
  by the timeline) and `getWindowAudio()`.
- **New state fields:** `sourceKind`, `capabilities`, `manifest`, `buffering`, and `prepared`
  (`{ peaks, bands, spectrogram }`).
- **New event:** `sourceupdate`.
- **CLI:** `rtd-prepare <in> <out> [--segment 10] [--rate auto|keep|N] [--peak 256] [--decoder
  ffmpeg|docker:<image>]`.

## Numbers

Windows 11, Chromium (Playwright), local HTTP server and Node 24, measured with
`packages/rt-dspplr/bench/long-audio-bench.mjs`. Each run uses a fresh browser. Memory is the summed
private bytes of every browser process (an idle browser is about 110 MB).

Both modes now draw a waveform timeline **and** a spectrogram timeline. The normal mode's
spectrogram is its quick whole-clip picture.

### 60 min mono 48 kHz (345 MB), round 2

| | Mode | UI ready (waveform) | Spectrogram drawn | First audio | Seek | Peak / steady memory |
|---|---|---|---|---|---|---|
| local | normal (baseline) | 3.9 s | 4.4 s | 3.9 s | 6–27 ms | 2.8 / 1.9 GB |
| local | **manifest** | **148 ms** | **102 ms** | **148 ms** | 54–65 ms (7–12 to scheduled) | **360 / 360 MB** |
| 100 Mbit/s, 20 ms RTT | normal (baseline) | 31.9 s | 32.4 s | 31.9 s | 9–19 ms | 2.6 / 1.8 GB |
| 100 Mbit/s, 20 ms RTT | **manifest** | **337 ms** | **375 ms** | **455 ms** | 157–189 ms (109–130) | **395 / 377 MB** |

| 30 min espeak speech + noise, mono, local | UI | Spectrogram | Audio | Seek | Memory |
|---|---|---|---|---|---|
| normal | 2.2 s | 2.4 s | 1.9 s | 10–20 ms | 1.4 / 1.1 GB |
| **manifest** | **137 ms** | **90 ms** | **137 ms** | 53–64 ms | **279 / 271 MB** |

- Compared with round 1, manifest mode costs about 100 MB more and about 90 ms more to the first
  waveform locally. The extra time and memory come from starting the overview-preview worker and the
  spectrogram worker, and from the spectrogram itself.
- The overview spectrogram file's first levels arrived 87 ms (local) and 365 ms (100 Mbit/s) after
  `load()`.
- There were no underruns, and decoded audio stayed at or below 60 s.

### Prepare, round 2 (bands + spectrogram added)

| File | Time (r1 → r2) | Peak RSS | Output | of which new |
|---|---|---|---|---|
| 60 min mono 48 k | 4.7 → **18.1 s** | 149 MB | 358 MB | bands 1.9 MB + spectrogram 6.2 MB |
| 30 min stereo 48 k | 4.1 → 11.0 s | 148 MB | 354 MB | 0.9 + 3.1 MB |
| 10 min stereo 96 k → 48 k | 15.3 → 16.2 s | 145 MB | 118 MB | 0.3 + 1.0 MB |
| 30 min espeak mono | 1.8 → 8.7 s | 139 MB | 179 MB | 0.9 + 3.1 MB |

For the 60-minute file the added time is split as bands +6.4 s (10 high-passes on the decimated
band) and spectrogram +7.2 s (three FFTs per 85 ms frame). Running them in `worker_threads` beside
the main pass would bring the total back to about 8 s (next steps).

### Approximation error (overview preview vs exact peaks-worker output)

The bench's `--approx-error` mode decodes the source in the browser and builds the exact processed
pyramid with the normal mode's worker. It builds the approximate one from the prepared files and
compares them where the exact RMS is above −50 dBFS. Errors are given as **mean / p95 in dB**:

- **per 256-frame bin:** every stored bin;
- **drawn:** the 1000 columns of the whole-file view, as drawn (each column shows its loudest bin's
  RMS).

| Setting | espeak 30 min: RMS per bin | espeak: peak per bin | espeak: drawn RMS / peak | synthetic 60 min: RMS per bin | synthetic: drawn RMS / peak |
|---|---|---|---|---|---|
| none / gain −12 dB | 0.00 / 0.01 | 0.00 / 0.00 | 0.00 / 0.00 | 0.00 / 0.01 | 0.00 / 0.00 |
| HP 100 Hz | 0.95 / 3.9 | 1.4 / 4.2 | 0.02 / 0.48 | (HP 200) 0.60 / 2.7 | 0.01 / 2.6 |
| HP 400 Hz | 1.7 / 6.0 | 2.1 / 6.5 | 0.00 / 0.68 | 0.63 / 2.8 | 0.00 / 2.4 |
| comp 0.5 | 0.25 / 0.81 | 0.26 / 0.89 | 0.26 / 0.75 | — | — |
| comp 1.0 | 0.41 / 1.2 | 0.49 / 1.5 | 0.26 / 1.28 | 0.33 / 0.88 | 0.35 / 1.56 |
| HP 200 + comp 1 + gain +6 | 1.5 / 4.7 | 1.7 / 5.1 | 0.30 / 1.26 | 1.8 / 3.3 | 1.5 / 0.66 |

How to read it:
- **Gain** and **no processing** are exact.
- **Compression** stays within about 0.3–0.5 dB on average.
- **High-pass:**
  - The *drawn RMS body* stays within 0.05 dB on speech, because each column shows its loudest bins
    and their energy is tracked well.
  - Individual 256-frame bins can be off by several dB. The band track's 43 ms resolution is applied
    uniformly to 8 bins.
  - *Peaks* are 0.5–2.6 dB off, because a high-pass also changes a waveform's crest factor through
    its phase, which energy cannot model. On the synthetic material exact peaks come out about
    1.8 dB *higher* than the scaled ones.
- **All of these are overview-only.** Inside the decoded window (views of 20 s or less) the preview
  is exact.

### Segment codecs (from round 1, unchanged)

WAV 16-bit decodes in 0.9–2.0 ms per 10 s. FLAC is about 50 % of the size at 5.6–12 ms. Opus 32 kb/s
is 2–4 % of the size at 15–27 ms. The tables are in round 1's notes in git history.

## Running it

```bash
npm ci && npm run build:lib
npm run long:gen -w examples/demo         # synthetic WAVs → examples/demo/storage/long (or LONG_STORAGE_DIR)
npm run long:stems -w examples/demo       # ready-made processed B files → <dir>/stems/<name>.b.wav (synthetic ones)
STEM_ONLY=1 bash examples/demo/scripts/long/make-speech-docker.sh <dir> 30   # the espeak recording's ready-made B
npm run long:prepare -w examples/demo -- <dir> --force --docker vcp-samples:local --docker-for espeak
                                          # manifest v3, A + B in one call each (espeak: B by a Docker afftdn processor)
node examples/demo/scripts/long/stems-bench.mjs <dir> [--docker <image>]   # A only vs A + B timings
npm run dev -w examples/demo              # http://localhost:5173/long.html
bash examples/demo/scripts/long/make-speech-docker.sh <dir> 30   # optional realistic speech (Docker, no network)
node packages/rt-dspplr/bench/long-audio-bench.mjs --dir <dir> --mode both [--only 60min] [--mbps 100 --rtt 20]
node packages/rt-dspplr/bench/long-audio-bench.mjs --dir <dir> --approx-error
```

`long.html` shows each recording in **Normal** and **Manifest** panels, each with a waveform timeline
(with the DSP preview) and a spectrogram timeline, HP/compression/gain/speed/loop controls and live
metrics. The checkbox at the top replaces the manifest panel with the React `<AudioPlayer>` card
(`display="both"`) on the same manifest. Every recording is published with its stem B, so the A/B knob
(panel and card) works as soon as a recording opens. The list and the panel metrics show what was
measured: offset, confidence, correlation, law, loudness delta, B's rate and bandwidth, and, for the
espeak recording, the processor (`demo.ffmpeg-afftdn@1`) and its time. The panel's "EQ plugin" box
adds the example third-party plugin.

## Limitations

- **Speed:** prepared clips stretch in realtime (Signalsmith) when the WASM loads and the manifest
  rate equals the context rate; otherwise they resample (pitch follows, shown in the card). The first
  move away from 1x while playing can dip briefly (≤ 8 dB on a pure tone). Noise loses 0.8–1.7 dB
  when stretched.
- **Stem B on prepared clips** needs the engine (AudioWorklet). The scheduler fallback plays A only.
  The waveform worker does not apply B's `gainDb` (default 0); the engine and the spectrogram do.
- **Stem B needs A read back** (correlation per segment): `outDir` or a storage with `getObject`.
  A custom upload-only storage is refused when `stems` is set.
- **Processors:** a stream A is copied to the scratch folder for the processor. An HTTP processor
  is POSTed A as it was given (not resampled); converting is the service's job.
- **Plugins** in a prepared clip's *overview* (before segments are decoded) are previewed only when
  they have a `magnitudeResponse`. A `process()`-only plugin is exact in the decoded window and
  flagged (`previewCoverage.overview`) outside it.
- **Whole-file playback** still uses the scheduler with offline stretch variants. Moving it onto the
  engine was not cheap: BufferSource's variants, loop and stem B paths would all change, and its tests
  depend on them. Not done.
- **Overview preview:** see the error table. The exact window is limited to views of 20 s or less
  and at most 4 segments. Only the last view wins when two timelines share one player.
- **Decoded-window edges:** the exact preview starts its filters from silence at the window's first
  sample. The quarter-view margin keeps that transient off screen.
- **Seeking** to an unfetched segment costs one segment fetch (1–2 MB per 10 s) of silence.
- **Prepare memory:** at the default concurrency (cores − 1) the analysis pool peaks near
  0.5 GB RSS; `concurrency: 4` keeps it under 300 MB.
- **Context rate:** sample-exact boundaries need the context rate to equal the manifest rate (both
  48 kHz by default). At speed ≠ 1, continuity is not verified offline.
- **Prepare:**
  - Non-16-bit sources are rounded without dither.
  - RF64 (WAV larger than 4 GB) is not supported.
  - `ffmpegDecoder` is experimental and does not trim MP3 encoder delay.
- **Browsers:** only Chromium was tested.

## Next steps

1. **Whole clips on the engine** (realtime stretch instead of offline variants), behind an option
   until BufferSource's tests move over.
2. **Compressed segments.** FLAC (lossless, about −50 %) or Opus (2–4 %), with `priming`/`padding`
   frames per segment in the manifest and exact trimming before scheduling. Opus encoded with
   80 ms of overlap into the previous segment. A smaller first fetch on seek.
3. **Safari / Firefox.** Run the browser suite on WebKit and Firefox (sub-sample `start()`, Range
   behaviour, AudioWorklet), and support 44.1 kHz contexts.
4. **Enhanced audio per segment** is now stem B (round 4): `prepareAudio(a, { stems: { b: { processor } } })`.
   Next: a stale-B check helper (compare `stems.b.aSourceId` / `processor.version`) for reprocessing jobs.
5. **Prepare:** smaller worker heaps; read A back once for B's correlation (or keep its segments' sums).
6. **Storage and CDN.** S3/MinIO `putObject` adapters, content-addressed paths, and
   `Cache-Control: immutable` on segments, peaks, bands and spectrogram.
