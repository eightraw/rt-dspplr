# RT-DSPPLR

**Web audio player by SAIT Digital.**

Documentation, live demo and API reference: [sait.digital/research/rt-dspplr](https://sait.digital/research/rt-dspplr).
Source: [github.com/eightraw/rt-dspplr](https://github.com/eightraw/rt-dspplr).
Free to use under a one-page [license](./LICENSE.md), see [Licensing](#licensing).

A web audio player with real-time DSP, pitch-preserving speed controls,
looping and an interactive waveform. Available as a headless engine and a
ready React component. Audio files are decoded in full; memory use scales
with their length. Long recordings can instead be prepared once on the server
and played segment by segment with `play({ manifest })`, see
[Long recordings](#long-recordings-prepared-files).

- **Pitch-preserving speed** (1.25x, 1.5x, 2x...). Variants are rendered
  off the main thread. Playback continues at the applied speed while a new
  variant is prepared, then switches at the live position.
- **Loop** any range, with boundaries snapped to zero crossings (no clicks).
- **Real-time DSP chain** on the output: input gain, a 24 dB/oct high-pass,
  a peak compressor, your own effects, output gain, and a -0.01 dBFS ceiling
  as the last stage. Everything but the ceiling is off by default. It runs in an AudioWorklet, with native nodes
  as the fallback.
- **Two-track mixer**: stem B, any second recording on the clip's timeline,
  plays in sync with stem A under one slider: a unity-sum crossfade, or a
  separation law for stems that add up to the original (both at full in the
  middle). Stem B is fetched only when the listener asks for it.
- **Live spectrogram** of both stems, computed in a worker on a logarithmic
  frequency axis and repainted as the mix moves, in one colour or with each
  stem in its own.
- **Waveform scrubber** that previews the DSP settings: a peak/RMS pyramid
  computed in a worker, drawn as a peak envelope with an RMS layer at
  device-pixel resolution. Click or tap to seek, drag to loop, wheel to zoom,
  with a time ruler and an overview of the zoomed window.
- **Zero bundler configuration** for the core and React entries. Workers and
  the worklet ship inside the JavaScript and start from Blob URLs.
- Optional **Rubber Band** stretcher in a separate entry point, for higher
  quality at the cost of a GPL dependency (see [Licensing](#licensing)).

## Install

```bash
npm install @saitdigital/rt-dspplr
# React component (optional): react >= 18
# Rubber Band strategy (optional): npm install rubberband-wasm
```

ESM only. TypeScript types included.

## Contents

- [React quick start](#react-quick-start)
- [Headless quick start](#headless-quick-start)
- [API: core](#api-core)
- [API: React](#api-react)
- [Two-track mixer](#two-track-mixer)
- [Long recordings (prepared files)](#long-recordings-prepared-files)
- [DSP plugins (effects)](#dsp-plugins-effects)
- [Timeline](#timeline)
- [Spectrogram](#spectrogram)
- [Time-stretch strategies](#time-stretch-strategies)
- [Bundlers, workers, CSP](#bundlers-workers-csp)
- [Styling and themes](#styling-and-themes)
- [Memory](#memory)
- [SSR and Next.js](#ssr-and-nextjs)
- [Browser support](#browser-support)
- [Sizes](#sizes)
- [Validation](#validation)
- [Licensing](#licensing)

## React quick start

Self-managed: give it a URL.

```tsx
import { AudioPlayer } from '@saitdigital/rt-dspplr/react';
import '@saitdigital/rt-dspplr/styles.css';

export function Track() {
    return (
        <AudioPlayer
            src="/audio/take-1.flac"
            srcB="/audio/take-2.flac"
            title="Session take"
            meta="A: take 1 · B: take 2"
        />
    );
}
```

Controlled: own the player with `useAudioPlayer()`, render it with
`<AudioPlayer player={...} />`, and drive it from your UI (lists, shortcuts,
auto-advance).

```tsx
import { AudioPlayer, useAudioPlayer } from '@saitdigital/rt-dspplr/react';
import '@saitdigital/rt-dspplr/styles.css';

export function PlaylistExample({ clips }: { clips: { id: string; url: string; urlB?: string }[] }) {
    const player = useAudioPlayer();

    return (
        <>
            <ul>
                {clips.map((clip) => (
                    <li key={clip.id}>
                        <button onClick={() => player.play({ id: clip.id, src: clip.url, srcB: clip.urlB })}>
                            {clip.id} {player.state.clipId === clip.id && player.state.isPlaying ? '▶' : ''}
                        </button>
                    </li>
                ))}
            </ul>
            <AudioPlayer player={player} onEnded={() => console.log('ended')} />
        </>
    );
}
```

The first `play()` must come from a user gesture (a click or key press). This
is the browser's autoplay policy for `AudioContext`. `play()`, `toggle()` and
`load(…, { autoplay: true })` resume the audio output at once, inside the
gesture, not after the download. When the system takes the output away while
playing (a call or Siri on iOS), the player pauses and `state.suspended` is
`'interrupted'`; when `play()` cannot start the output, it is `'blocked'`. Either
way the next `play()` from a gesture goes on, so a UI can show "tap to resume".

## Headless quick start

```ts
import { createAudioPlayer } from '@saitdigital/rt-dspplr';

const player = createAudioPlayer({ element: document.querySelector<HTMLElement>('#player')! });

player.on('timeupdate', (t) => progress.value = t);
player.on('ended', () => console.log('done'));

button.onclick = () => player.play({ src: '/audio/take-1.flac', srcB: '/audio/take-2.flac' });
speed.onchange = () => player.setSpeed(Number(speed.value));
loop.onclick = () => player.setLoop({ start: 1.2, end: 2.8 });
mix.oninput = () => player.setMix(Number(mix.value)); // 0 = A … 1 = B

// later
player.dispose();
```

## API: core

### `createAudioPlayer(options?)` / `new AudioPlayerCore(options?)`

Construction is free. No AudioContext, node, or worker exists until the first
`load()`/`play()`, so creating players during render or on the server is safe.

| Option | Type | Default | |
|---|---|---|---|
| `stretcher` | `StretchStrategy \| 'native'` | `vocoderStretcher` | Time-stretch backend, see [strategies](#time-stretch-strategies). |
| `speeds` | `number[]` | `[1, 1.25, 1.5, 2]` | Speeds offered by UIs and the default prewarm set, within 0.25–4x (`SPEED_MIN`, `SPEED_MAX`); others are dropped with a warning. |
| `prewarmSpeeds` | `boolean \| number[]` | `true` | Render speed variants in the background after load. The selected speed always goes first. |
| `processing` | `Partial<ProcessingState>` | see below | Initial DSP values. |
| `mixLaw` | `'crossfade' \| 'separation'` | `'crossfade'` | How `mix` sets the stems' gains, see [Two-track mixer](#two-track-mixer). |
| `pauseMode` | `'pause' \| 'reset'` | `'pause'` | `'reset'`: pausing returns to where playback last started, so the same passage plays again from there. |
| `loadB` | `(clip, signal) => Promise<AudioInput \| null>` | none | On-demand source of stem B, see [Two-track mixer](#two-track-mixer). |
| `prefetchB` | `boolean` | `false` | Fetch stem B right after load instead of waiting for mix > 0. |
| `fetchOptions` | `RequestInit` | none | Extra `fetch()` options for URL sources (credentials, headers). For a prepared clip, its headers and credentials go only to the manifest's origin and to `fetchOptionsOrigins`. |
| `fetchOptionsOrigins` | `string[]` | none | Further origins (`'https://cdn.example.com'`) that get the headers and credentials of `fetchOptions` when a manifest names files there. Files on other origins are fetched without them. |
| `cacheBudgetBytes` | `number` | 150 MiB | Shared PCM budget for every player on the page, see [Memory](#memory). |
| `maxClipBytes` | `number` | no limit | Whole clips (stem B too): the largest file. A URL is checked by its `Content-Length` before the download and by the bytes read while it runs. Over it, the load fails at once with an `Error` named `'ClipTooLargeError'` that points to prepared playback. |
| `maxClipSeconds` | `number` | no limit | Whole clips: the longest clip, checked once decoded (before any speed variant). Fails the same way. |
| `sampleRate` | `number` | the device's (44100 or 48000), else 48000 | Sample rate of the shared AudioContext (the first player to start decides). Clips at other rates are converted by the player. |
| `latencyHint` | `'playback' \| 'interactive' \| 'balanced' \| number` | `'playback'` | Output buffering of the shared AudioContext (the first player to start decides). `'playback'` keeps the sound clean while the page is busy. |
| `element` | `HTMLElement` | none | The element your interface lives in; same as `mount(element)`. |
| `infoButton` | `'always' \| 'touch'` | `'always'` | The ⓘ button of the author menu: on every device, or only on devices with a touch screen. See [The author credit](#the-author-credit). |

`AudioInput` is `string` (URL) `| ArrayBuffer` (encoded bytes) `| Blob | AudioBuffer`.
A clip is an `AudioInput` or `{ src, srcB?, id? }`. `id` defaults to the URL.
`{ manifest, stem?, id? }` (or a URL ending in `.json`) plays a prepared recording
segment by segment, see [Long recordings](#long-recordings-prepared-files); what a
source can do is reported in `state.capabilities`.

### Methods

| Method | |
|---|---|
| `mount(element)` | Puts the author menu on your interface element and returns a function that releases it. Playback needs at least one mounted element on the page: without it `play()`, `toggle()` and `load(…, { autoplay: true })` reject. |
| `load(clip, { startAt?, autoplay? })` | Fetch and decode. Resolves `true` when ready, `false` on failure or when superseded by a newer load. |
| `play(clip?, { startAt? })` | With no argument, resume. With a clip, play it from `startAt` (default 0). Passing the clip that is already loaded restarts it without reloading. |
| `pause()`, `toggle()`, `stop()` | `pause()` follows `pauseMode`. While a whole clip is still loading they set what happens once it is in: it plays or not, and `stop()` puts it at 0. |
| `seek(seconds)` | Keeps playing if it was playing. While a whole clip is still loading, it is where the clip starts. |
| `setSpeed(speed)` | Keeps the position. Clamped to 0.25–4x. Pitch is preserved when the strategy has a worker. |
| `setLoop({ start, end } \| null)` | In seconds. Snapped to zero crossings. Changing or dropping the loop while playing keeps the position; a loop set behind the playhead starts from its beginning. |
| `setHighPass(hz)` | `0` bypasses. UI range 0–500 Hz. |
| `setCompression(amount)` | 0–1. |
| `setInputGain(db)` | Before all processing: it drives the compressor and the effects. -24…+24 dB; `-Infinity` mutes. Smoothed, previewed. |
| `setOutputGain(db)` | After all processing, before the -0.01 dBFS ceiling. -24…+24 dB; `-Infinity` mutes. Smoothed, previewed. |
| `setMix(mix)` | 0 = stem A … 1 = stem B; the gains follow `mixLaw`. Fetches stem B on first use. |
| `setProcessing(patch)` | Any subset of `ProcessingState`. |
| `setSourceB(input \| null)` | Install (or remove) stem B for the current clip directly (whole clips). |
| `setStem(key \| null)` | Prepared clips: which of the manifest's stems the A⇄B knob blends with (`null`: the default). Returns `false` when there is no such stem. |
| `refreshManifest()` | Prepared clips: re-read the manifest; a newer `revision` (a stem attached later) applies without a reload. |
| `setPauseMode(mode)` | |
| `getState()` | Immutable snapshot; the same object until something changes. |
| `subscribe(listener)` | Called on every change; returns an unsubscribe function (`useSyncExternalStore`-compatible). |
| `on(event, listener)` / `off(...)` | Events below. `on` returns an unsubscribe function. |
| `getCurrentTime()` | Live position computed from the AudioContext clock. The state is updated about 30 times per second while the page shows, about four times a second in a background tab. |
| `analyser`, `audioContext` | Post-DSP `AnalyserNode` for custom meters, and the shared context. |
| `dispose()` | Stops playback and releases this player's nodes. The shared AudioContext stays open. A disposed player ignores `load`/`play` until `reactivate()` (the React hook does this for StrictMode). Mounted elements stay mounted. |

`ProcessingState`: `{ inputGainDb: 0, highPassHz: 0, compression: 0, outputGainDb: 0, speed: 1, mix: 0 }`
(defaults shown).

With these defaults the DSP leaves the audio as decoded: the high-pass is
bypassed, the compressor and the two gains do nothing, and only samples
above the -0.01 dBFS ceiling are clipped to it. Where the AudioWorklet cannot
start (a CSP that blocks `blob:`), a native `DynamicsCompressorNode` takes
over the compressor. Its automatic makeup gain is cancelled, so it stays within
about 1 dB of the worklet's levels, and it adds a few milliseconds of
look-ahead delay. The ceiling is the same clip either way.

### State (`getState()`)

| Field | |
|---|---|
| `clipId`, `src` | Current clip, and its URL if it was loaded from one. |
| `status` | `'idle' \| 'loading' \| 'ready' \| 'error'`; `progress` 0–1 while loading; `error`. |
| `isPlaying`, `currentTime`, `duration`, `ended` | `ended` is true after the clip plays to its end (not after `stop()`). |
| `suspended` | `null`, or why the audio output is held: `'interrupted'` (the system took it while playing, the player paused) or `'blocked'` (`play()` could not start it). The next `play()` from a user gesture resumes. |
| `loop` | Active loop range (snapped) or `null`. |
| `processing` | Applied `ProcessingState`; speed stays at the audible rate during preparation. |
| `pendingSpeed` | Requested speed being prepared, or `null`. Stop/pause/seek/new clip cancel the pending switch. |
| `statusB` | `'unavailable' \| 'idle' \| 'loading' \| 'ready' \| 'error'` (and `'processing'` for prepared clips with polling). |
| `sourceKind`, `capabilities` | `'buffer'` (whole clip) or `'segmented'` (prepared); what the source can do: `canPreservePitch`, `canMixStemB`, `stems` (a prepared clip's ready stems: `{ key, label }[]`), `exactWaveformPreview`, `spectrogram`, `loopSnapping`. |
| `manifest`, `stem`, `prepared`, `buffering` | Prepared clips: the manifest, the active blend stem's key, the overview data as it arrives, waiting for a segment. |
| `mixLaw` | The `mixLaw` option. |
| `buffer`, `bufferB`, `audioContext` | Decoded audio, for custom visualisations. |
| `startedAt`, `playbackStartPoint`, `playRequestId`, `pauseMode` | For smooth playheads and "restart" detection. |

### Events

| Event | Payload |
|---|---|
| `statechange` | the new state |
| `timeupdate` | position in seconds, about 30 times per second (about four in a background tab) |
| `ended` | `{ clipId }`; `clipId` is `null` when the clip was unloaded meanwhile |
| `load` | `{ clipId, duration }` |
| `error` | `Error` (the clip failed to load or decode) |
| `bload` | `{ clipId }` |
| `berror` | `Error` (stem A is unaffected) |

The main entry also exports processing defaults and control mappings,
`StretchStrategy` and its worker protocol, and the shared cache controls.

Low-level classes and analysis helpers are available only through
`@saitdigital/rt-dspplr/advanced`: `Track`, `Mixer`, `AudioEngine`, `BufferLoader`,
`StretchService`, `WaveformAnalyzer`, `TimelineCore` / `mountTimeline`, peak-pyramid
helpers, spectrogram analysis and painting, and DSP building blocks. This advanced
surface may change between minor releases before 1.0. The playback internals of
prepared clips (segment store, scheduler, stream engine) are not exported.

`@saitdigital/rt-dspplr/format` holds the prepared-file formats as pure code that
runs in browsers, workers and Node: the manifest types, `assertManifest()`, stem key
rules (`isStemKey`, `STEM_KEY_PATTERN`), the readers and writers of peaks.bin,
bands.bin, spectrogram.bin and WAV, and the source runs (a segment's bytes of the
original, decoded and cut out). The JSON Schema of the manifest is
`@saitdigital/rt-dspplr/manifest.schema.json`.

## API: React

```ts
import { AudioPlayer, Timeline, Spectrogram, useAudioPlayer, useAudioPlayerState } from '@saitdigital/rt-dspplr/react';
import '@saitdigital/rt-dspplr/styles.css'; // once, anywhere
```

`react` is an optional peer dependency (>= 18). It is needed only for this entry.

### `useAudioPlayer(options?)`

Returns `{ state, player, ref, load, play, pause, toggle, stop, seek, setLoop,
setSpeed, setHighPass, setCompression, setOutputGain, setMix,
setProcessing, setPauseMode, setSourceB, getCurrentTime, on }`.
The functions are stable. `state` re-renders the component on change (about
30 times per second while playing). `options` are read once; to switch
strategy, remount with a different `key`. The player is disposed on unmount,
and StrictMode's mount/unmount/mount cycle is handled. For your own interface, put
`ref={player.ref}` on its root element; `<AudioPlayer player={player} />` mounts itself.

`useAudioPlayerState(player)` subscribes any component to an existing player.

### `<AudioPlayer />`

An inline card that sits in the page flow and fills its container's width:

- a heading row: title, meta, an Auto-next icon button when enabled, and the
  ⓘ button of the author menu;
- the main row: "back to start" and −/+ step buttons around a round
  play/pause button; the waveform as the scrubber (min/max peak envelope
  plus an inner RMS layer, played part in the accent colour, time tooltip
  on hover, the loop as a shaded band with two draggable handles); under it
  a time ruler whose ticks adapt to the zoom, and an overview strip of the
  visible window while zoomed; elapsed / total time on the right;
- a tool row: speed as a segmented control, a **Loop** toggle, the
  **Stem A ⇄ Stem B** mix slider, and a **Post FX** popover with
  Input gain, High-pass, Compression, your effects' parameters and Output gain
  (in chain order) plus Reset.

Below `compactBreakpoint` (default 420 px of the component's own width, not
the viewport) it folds into a single row (play, waveform, time, settings
button) and the tools, including the step buttons, open in a drawer
below it. The ruler is hidden in this layout.

| Prop | Default | |
|---|---|---|
| `player` | none | Controlled mode: the result of `useAudioPlayer()` or a `AudioPlayerCore`. |
| `src`, `srcB`, `clipId`, `autoPlay`, `options` | none | Self-managed mode. A new `src`/`clipId` loads; `autoPlay` starts it (subject to the autoplay policy). |
| `title`, `meta` | file name, none | Heading row. |
| `emptyText` | `'No audio loaded'` | Shown in the waveform area when nothing is loaded. |
| `onTitleClick` | none | Makes the title a button. |
| `autoPlayNext`, `onAutoPlayNextChange` | none | Shows an "Auto-play next" toggle. The behaviour (what plays next) is yours. |
| `onEnded` | none | |
| `speeds` | player's speeds | Segments of the speed control. |
| `skipSeconds` | `0.5` | Step of the −/+ buttons. |
| `navButtons` | `true` | "Back to start" and −/+ `skipSeconds` buttons next to play. |
| `display` | `'waveform'` | What the seek bar draws: `'waveform'`, `'spectrogram'` (see [Spectrogram](#spectrogram)), or `'both'`: the waveform as an outline over the spectrogram. |
| `spectrogram` | none | Options of the spectrogram, see [Spectrogram](#spectrogram). |
| `waveformStyle` | `'envelope'` | `'envelope'`: min/max peak envelope with an inner RMS layer, one column per device pixel. `'bars'`: rounded bars. |
| `wheelZoom` | `'plain'` | `'plain'`: the wheel over the waveform zooms (at 1x, scrolling down still scrolls the page). `'modifier'`: only Ctrl/Cmd + wheel zooms, the wheel alone scrolls the page. |
| `zoom` | `true` | `false`: no zoom or pan by any means (wheel, keys, overview strip). The waveform always shows the whole clip and the wheel scrolls the page; seeking and loops stay. |
| `ruler` | `true` | Time ruler and zoom overview under the waveform (full layout only). |
| `layout` | `'auto'` | `'full' \| 'compact' \| 'auto'`. |
| `compactBreakpoint` | `420` | Width (px) under which `'auto'` is compact. |
| `theme` | `'light'` | `'dark' \| 'auto'` (follows `prefers-color-scheme`). |
| `className`, `style` | none | |

**Mouse.** Click the waveform to seek; a click outside an active loop also
clears it. Drag across the waveform to select a loop, then drag its handles to
adjust it. The wheel over the waveform (or the ruler) zooms around the
pointer, in proportion to the wheel's travel, down to a 0.5 s visible window;
at the whole clip, scrolling down still scrolls the page (`wheelZoom="modifier"`:
only Ctrl/Cmd + wheel zooms and the wheel alone scrolls the page; `zoom={false}`:
no zoom at all). A trackpad pinch arrives as Ctrl + wheel and zooms too.
Shift + wheel or a horizontal wheel pans while zoomed; so does dragging or
clicking the overview strip under the ruler. While playing zoomed
in, the view follows the playhead. The "× · reset" chip (or `0`) shows the
whole clip again. Double-click any slider to reset it. The mix slider is
disabled (with a tooltip) when the clip has no stem B; it stays movable
downwards if a value from the previous clip is left over. A spinner shows while
stem B loads.

**Touch.** A tap seeks. A finger that swipes up or down scrolls the page, as
anywhere else; a finger that moves sideways across the waveform selects a loop,
and the handles move the same way. Pinch-to-zoom on a touch screen is not
supported; a trackpad pinch is.

**Keyboard.** Every control is a native button, choice group or range input,
or an ARIA slider, with a visible focus ring.

| Focus | Keys |
|---|---|
| Waveform | Left/Right (or Down/Up) ±1 s, PageDown/PageUp ±5 s, Home/End, `+`/`-` (or `=`/`_`) zoom ×1.5, `0` resets zoom, `[`/`]` set the loop's start/end at the playhead (without a loop, the other edge is the clip's end/start), Esc clears the loop |
| Loop handle | Left/Right ±0.1 s (Shift ±1 s), PageDown/PageUp ±1 s, Home/End, Esc/Delete/Backspace clears the loop |
| Post FX popover | Esc closes it and returns focus to the Post FX button |

Transitions and animations are switched off under
`prefers-reduced-motion: reduce`.

## Two-track mixer

Stem B is any second recording on the clip's timeline: a processed version,
another mix, a stem. What you put there is up to you. The player starts B on
the same AudioContext tick as A and mixes them with `setMix`. The waveform
preview and the spectrogram follow the same gains.

- `mixLaw: 'crossfade'` (default): gains `1 - mix` and `mix`, so identical
  aligned tracks keep their level, 50% included. For two versions of one
  recording. Different recordings are not loudness-matched; misaligned or
  phase-inverted tracks can still cancel.
- `mixLaw: 'equal-power'`: gains `cos` / `sin` of the knob. Keeps the level of
  two *uncorrelated* tracks; on a correlated pair it bumps the middle by 3 dB.
- `mixLaw: 'separation'`: for stems that add up to the original, such as the
  two parts of a separation. Both play at full in the middle, so 0.5 is the
  original, and each fades out towards the far end: 0 is stem A alone, 1 is
  stem B alone. Start at `processing: { mix: 0.5 }` to open on the original.

- `srcB` on the clip: a URL, bytes, a Blob, or an AudioBuffer.
- or `loadB(clip, signal)` in the options: for tracks rendered on
  demand. It is called at most once per clip, only when the mix goes above 0.
  The request is aborted if the listener switches clips. Return `null` when
  there is no stem B.
- or `player.setSourceB(input)` at any time.

Stem B never gets in the way of stem A. Until B arrives, and if it fails,
A plays at full gain. The failure is reported
only through `state.statusB = 'error'` and the `berror` event.

```ts
createAudioPlayer({
    loadB: async (clip, signal) => {
        const res = await fetch(`/stems/${encodeURIComponent(clip.id)}.b.flac`, { signal });
        return res.ok ? res.arrayBuffer() : null;
    },
});
```

## Long recordings (prepared files)

A whole file is decoded before it plays, which is instant for a voice note and
heavy for an hour. For long recordings, prepare them once on the server with
**[@saitdigital/rt-dspplr-prepare](https://github.com/eightraw/rt-dspplr/tree/main/packages/rt-dspplr-prepare#readme)** (Node, CLI and
API). It writes a folder: the original file as it is, a manifest with an index of
it (the byte range of every segment) and overview files (peaks, high-pass bands,
spectrogram). The player opens it in milliseconds and fetches audio around the
playhead only, as HTTP Range requests of the original (decoded audio stays near 60 s):

```bash
npx rtd-prepare talk.wav public/media/talk --stem b=talk.b.wav --label b="Noise reduction"
```

```ts
await player.play({ manifest: '/media/talk/manifest.json' });
// React: the same card, on a manifest
const p = useAudioPlayer();
useEffect(() => { void p.load({ manifest }); }, [manifest]);
<AudioPlayer player={p} display="both" />
```

- The waveform, the DSP preview and the spectrogram cover the whole recording at
  once (approximate in the overview, exact in a decoded window of up to 20 s).
- Segments decode as the codec needs: WAV on the spot; MP3, Opus and FLAC with
  WebAssembly (dr_mp3, libopus, dr_flac), one chunk per codec fetched the first
  time a clip of that codec plays (30, 113 and 21 KB gzipped), in a worker. The
  server must answer Range requests: from one that ignores them, a source of up
  to 64 MB is read once and cut up in memory; a bigger one fails with
  `The server ignores HTTP Range requests: <url>`.
- A manifest's files must be `http(s)` URLs, relative to it or absolute (a CDN).
  `fetchOptions` headers and credentials go only to the manifest's origin and to
  those in `fetchOptionsOrigins`; files elsewhere are fetched without them.
- Speed keeps the pitch through a realtime stretcher in the stream engine
  (AudioWorklet), which runs at the clip's rate and converts to the context's.
  Without it pitch follows speed and `capabilities.canPreservePitch` says so (the
  card shows it).
- Options under `segmented`: `cacheSeconds`, `prefetchSegments`, `engine`,
  `realtimeStretch`, `pollStemsMs`. `player.getStreamStats()` reports cache,
  fetches and latencies.

**Named stems.** A manifest can carry several stems, each a time-aligned derivative
of A (the same timeline) made on the server: `stems: { b, v1, … }`. Keys are opaque
ids the host chooses (`b` is the default); a stem may carry a `label` for interfaces.
The knob blends A with **one stem at a time**: `play({ manifest, stem: 'v1' })`, or
`player.setStem('v1')` while playing; `state.stem` is the active one and
`capabilities.stems` lists the ready ones. The React card shows a stem selector
(`label ?? key`) only when there is more than one. A stem's segments are fetched only
while the knob is above 0. Output that changes timing (re-timed or re-synthesised
audio) is not a stem: publish it as a clip of its own.

The manifest format, its versions and its compatibility policy are specified in
[docs/manifest.md](https://github.com/eightraw/rt-dspplr/blob/main/docs/manifest.md).

## DSP plugins (effects)

> **Experimental.** The plugin API (`player.effects`, `DspPlugin` and its
> helpers) may change in minor releases before 1.0.

Every sound effect is a plugin in one chain per player, the built-ins included:
`rtd.highpass` (the high-pass) and `rtd.dynamics` (the compressor);
`setHighPass` and `setCompression` drive them. The two gains and the ceiling
are the chain's own first and last stages, not plugins.

Signal chain: **source (A/B mix → realtime stretch) → input gain → effects → output gain → ceiling (-0.01 dBFS) → analyser → output.**

- The mix is first because the effects process what you hear: one compressor on the
  blend, not two compressors that are summed.
- The stretch comes before the effects so that a compressor's or a filter's time
  constants stay in real time at any speed. The stretcher also sees the dry signal,
  without a limiter's pumping. The engine mixes A and B before it stretches them, so
  there is one stretcher, not two that drift apart.
- The input gain drives everything after it (+6 dB in compresses harder); the
  output gain only sets the level of the result. Both show on the waveform and
  the spectrogram, like every effect with a preview.
- The ceiling is last, so neither a boost nor a third-party effect can send the
  output over full scale. The analyser and the meters sit after it.

```ts
import { threeBandEq } from './three-band-eq.js';   // examples/plugins/three-band-eq.js

const id = player.effects.add(threeBandEq, { params: { high: -12 } });
player.effects.setParam(id, 'low', 6);       // validated against the schema (clamped; unknown id throws)
player.effects.bypass(id, true);             // wet/dry crossfade, click-free
player.effects.move(id, 0);
player.effects.remove(id);
player.getState().effects;                   // [{ id, plugin, params, bypassed, error }]
player.getState().previewCoverage;           // { waveform, spectrogram, overview, missing: [names] }
```

A plugin (`DspPlugin`) is plain data plus functions:

- `id`, `name`, `version`, and `params`: `[{ id, label, unit, min, max, default,
  scale: 'linear' | 'log', step, format }]`. The card's Post FX panel renders sliders
  from this schema.
- `realtime`: either `{ kind: 'nodes', create(ctx, params) → { input, output,
  setParam(id, value, timeConstant), dispose } }` with any Web Audio nodes, or
  `{ kind: 'worklet', processorName, moduleUrl | moduleCode }`, where every param
  becomes an AudioParam.
- `preview` (optional; what you hear is what the waveform and the spectrogram show):
  - `magnitudeResponse(params, freqs, sampleRate) → dB[]` for linear effects (EQ,
    filters). The spectrogram applies it per row at paint time, and the prepared overview
    of the waveform approximates from it.
  - `process(channels, sampleRate, params, state)` is a self-contained function, run in
    the preview workers on the clip's audio, for the waveform (exact in the decoded
    window). A function, an arrow or a method; it must process the channels before it
    returns, so an async function or a generator is left out of the previews.
  - An effect without a preview still plays. `previewCoverage.missing` names it, and
    the card says "Not in the preview: …".
- `latencyFrames`: reported in `state.effectsLatencyFrames`.

**Crash isolation**: a plugin that throws in `create()`, or whose worklet processor
throws, is bypassed. The `effecterror` event and `effects[i].error` report it, and
playback goes on. It stays out, also when the output is rebuilt:
`effects.bypass(id, false)` is ignored with a warning; remove it and add it again to
retry. A plugin whose `dispose()` throws is reported the same way and
still taken out of the graph. A preview function that throws, or does not compile,
is left out of the preview. The isolation stops at exceptions: worklet plugins run
in the one `AudioWorkletGlobalScope` the player's own processors use, so a processor
that hangs, or that patches globals, affects all audio of the page.

## Timeline

The card's seek bar on its own, for an interface of your own: click or tap to
seek, drag to loop (with handles), wheel to zoom, Shift + wheel or the overview
strip to pan, the keyboard for all of it, and a time ruler. It draws the
waveform, the spectrogram, or both, and fills the box it is given. It is the same
timeline with React or without: `<Timeline>`, or `createTimeline()` from the
main entry for any framework or none.

```tsx
import { Timeline } from '@saitdigital/rt-dspplr/react';
import '@saitdigital/rt-dspplr/styles.css';

<div style={{ height: 220 }}>
    <Timeline player={player} display="spectrogram" spectrogram={{ colorMode: 'dual' }} theme="dark" />
</div>
```

| Prop | Default | |
|---|---|---|
| `player` | required | The result of `useAudioPlayer()` or a `AudioPlayerCore`. |
| `display` | `'waveform'` | `'waveform'`, `'spectrogram'` or `'both'`. |
| `waveformStyle` | `'envelope'` | `'envelope'` or `'bars'`. |
| `spectrogram` | none | Options of the spectrogram, see below. |
| `wheelZoom` | `'plain'` | `'plain'`: the wheel zooms. `'modifier'`: only Ctrl/Cmd + wheel zooms, the wheel alone scrolls the page. |
| `zoom` | `true` | `false`: no zoom or pan; the wheel scrolls the page, clicks still seek. |
| `ruler` | `true` | Time ruler and zoom overview under the track. |
| `theme` | `'light'` | `'light'`, `'dark'` or `'auto'`. The `--rtd-*` tokens restyle it. |
| `onSeek` | none | Called when the listener moves the playhead. |
| `label`, `emptyText` | `'Seek'`, `'No audio loaded'` | Accessible name, and the text shown before a clip. |

Without React, `createTimeline(container, player, options)` builds the same
timeline inside `container` and keeps it in step with the player: it computes
the waveform in a worker, follows the DSP, the mix and the loop, and moves the
playhead. The options are the props above, except `player`, `className` and
`style`.

```ts
import { createAudioPlayer, createTimeline } from '@saitdigital/rt-dspplr';
import '@saitdigital/rt-dspplr/styles.css';

const root = document.querySelector<HTMLElement>('#player')!;
const player = createAudioPlayer({ element: root });
const timeline = createTimeline(root.querySelector<HTMLElement>('.seek')!, player, {
    display: 'both',
    theme: 'dark',
    onSeek: (t) => console.log('seek', t),
});

timeline.setOptions({ zoom: false });   // any option, at any time
timeline.dispose();                     // removes it
```

## Spectrogram

A canvas that draws the player's clip on a logarithmic frequency axis and
follows the mix as it moves. Playhead and seeking are left to your interface
(or use `<Timeline display="spectrogram">`).

Like the waveform, it is computed once per clip: a quick picture of the whole
clip first (about 0.1 s for 20 s of two stems), then, in the background, the
clip's spectral pyramid (about 0.6 s, about 3 MB). After that every zoom, pan,
resize and mix move is drawn from the pyramid on the main thread in a few
milliseconds, and the worker holds nothing for the clip. One worker serves all
spectrograms on the page; one off screen computes nothing until it is about to
show.

```tsx
import { Spectrogram } from '@saitdigital/rt-dspplr/react';

<div style={{ height: 180 }}>
    <Spectrogram player={player} colorMode="dual" />
</div>
```

```ts
import { createSpectrogram } from '@saitdigital/rt-dspplr';

const view = createSpectrogram(canvas, player, { colorMode: 'single' });
view.setRange({ start: 2, end: 6 });   // part of the clip; null for all of it
view.dispose();
```

| Option | Default | |
|---|---|---|
| `colorMode` | `'single'` | `'single'`: one colour, taken from the mix position (stem A's, the mix colour, stem B's). `'dual'`: each cell coloured by the stem it comes from. |
| `palette` | the theme's | `colormap`: a scientific colormap for the level, by name (`'magma'`, `'inferno'`, `'plasma'`, `'viridis'`, `'grey'`; `'_r'` reverses it, e.g. `'magma_r'`) or as its colours from quiet to loud (`['#fff', '#f97316', '#111']`); its first colour is the background. Or three colours per stem, `{ background, colorA, colorB, colorMix, peak }`, a ramp from the background through the stem's colour to the peak (used by `colorMode: 'dual'`, and by any palette given without a `colormap`). Default: the `--rtd-spectrogram-*` tokens, `magma_r` in the light theme and `magma` in the dark one. `COLORMAPS` holds the named maps. |
| `floorDb` | `66` | How far below the clip's loudest bin is drawn as background. |
| `minHz`, `maxHz` | `30`, `16000` | Frequency axis. |
| `fftSize` | `'auto'` | `'auto'`: 2048 points for the harmonics; zoomed in, 4096 below 300 Hz and 1024 above 3 kHz (512 when very close), blended at the edges; a whole long clip uses 4096. Or one power of two from 256 to 16384. |

Levels are relative to the clip's loudest bin, so a quiet stem looks quiet.
With `mixLaw: 'separation'` the reference is both stems together.

## Time-stretch strategies

| Strategy | Import | Quality / cost |
|---|---|---|
| `vocoderStretcher` (default) | `@saitdigital/rt-dspplr` | Built-in phase vocoder with transient-aware phase reset. Pure TS, ~5 KB worker, no dependencies. Call it to choose its memory use: `vocoderStretcher({ memory })`, see below. |
| `'native'` / `nativeStretcher` | `@saitdigital/rt-dspplr` | `playbackRate` only: no stretch rendering, pitch follows speed. |
| `rubberbandStretcher(options?)` | `@saitdigital/rt-dspplr/stretch-rubberband` | Rubber Band R3 ("finer") in a module worker. Best quality, ~265 KB WASM loaded on first use, GPL (see below). |
| custom | `serveStretchWorker` | Any algorithm. Write a worker with `serveStretchWorker(self, (channels, sampleRate, speed, sensitivity, options) => …)` and return `{ id, createWorker, options? }`. `options` are plain, cloneable data handed to the worker with every request. |

The built-in vocoder can hold the whole clip's analysis in memory or go
through it frame by frame. Both give the same samples, bit for bit:

| `memory` | Memory while rendering | Time |
|---|---|---|
| `'auto'` (default) | `'lean'` above 15 s of audio, `'fast'` below | that of the mode it picks |
| `'lean'` | the output plus a few FFT-sized buffers: +78 MB for 10 min mono | about 5–10% more than `'fast'` |
| `'fast'` | about 20x the clip's PCM: +2.3 GB for 10 min mono | the baseline: 19 s for 10 min mono |

```ts
createAudioPlayer({ stretcher: vocoderStretcher({ memory: 'lean' }) });
```

Measured in Node 20, mono 48 kHz at 1.5x. Each mode is its own strategy with
its own cache.

Variants are rendered once per (clip, speed, strategy) and cached. The
selected speed is rendered before the others, and a playback request jumps
ahead of queued prewarm jobs. Prewarm jobs of a clip are cancelled when the
player moves to another clip. The variant of the current clip at the current
speed is also held by the player itself, so seeking and restarting at that
speed never render again, even when the variant is too large for the cache.
If no worker can start (strategy `native`, CSP, four crashes in a row), speed
changes fall back to `playbackRate`; a job that a worker never answers is
abandoned after a watchdog (at least 10 s) and its worker replaced.

Speed preparation is offline, over the whole clip, not a streaming realtime
stretcher. On `setSpeed`, the old rate keeps playing until the requested
variant is ready; `state.pendingSpeed` exposes this wait. The latest request
wins. This avoids an intentional pause but does not promise click-free
phase continuity between independently stretched buffers. The built-in
vocoder keeps the level of tonal material within half a decibel at every
speed, and its output lands within a few milliseconds of the source
time scaled by the speed; noise-like material comes out a few decibels quieter,
as from any phase vocoder.

### Rubber Band entry

```ts
import { rubberbandStretcher } from '@saitdigital/rt-dspplr/stretch-rubberband';

const player = createAudioPlayer({ stretcher: rubberbandStretcher() });
// or <AudioPlayer src={url} options={{ stretcher: rubberbandStretcher() }} />
```

`rubberband-wasm` is an optional peer dependency. A normal `npm install
@saitdigital/rt-dspplr` does not install it. The built-in vocoder needs no Rubber Band.
To opt in, install it yourself:

```bash
npm install rubberband-wasm
```

Import the adapter only when you choose this backend. Development and demo
workspaces install Rubber Band for testing; those dependencies are not bundled
with the published player. `npm run test:package` verifies a clean consumer
installation without it. The
package ships no Rubber Band code or binary: `dist/stretch-rubberband.js`
contains `new Worker(new URL('./rubberband-worker.js', import.meta.url), { type: 'module' })`,
and the worker contains `import … from 'rubberband-wasm'` plus
`new URL('rubberband-wasm/dist/rubberband.wasm', import.meta.url)`. Your
bundler resolves all three from your own `node_modules`.

| Bundler | Configuration |
|---|---|
| webpack 5 (incl. Next.js) | none. The worker becomes a chunk and the `.wasm` an asset. |
| Vite, `vite build` | none |
| Vite, `vite dev` | Pre-bundling breaks `new URL()` inside dependencies, so exclude this entry. Including `rubberband-wasm` avoids a one-time page reload on first use. |
| Other / CDN | Pass `rubberbandStretcher({ wasmUrl })` if you host `rubberband.wasm` yourself. |

```ts
// vite.config.ts (only when you use the Rubber Band entry)
export default defineConfig({
    optimizeDeps: {
        exclude: ['@saitdigital/rt-dspplr/stretch-rubberband'],
        include: ['rubberband-wasm'],
    },
});
```

Without that line, `vite dev` prints one warning that explains it and uses
`playbackRate` for speed changes. Production builds are unaffected. If the
WASM fails to load at runtime, each job falls back to the built-in vocoder.

## Bundlers, workers, CSP

The core and React entries contain six small scripts as strings: the
dynamics AudioWorklet (~2 KB), the vocoder worker (~5 KB), the waveform
peaks worker (~8 KB), the spectrogram worker (~7 KB), the overview
preview worker of prepared clips (~6 KB) and the stream engine AudioWorklet
of prepared clips (~10 KB). The realtime stretcher of prepared clips
(Signalsmith Stretch, MIT, ~100 KB of WASM; its notice is in the chunk and in
THIRD_PARTY_NOTICES.md) is a separate chunk, loaded by a
dynamic `import()` only when a prepared clip plays. Each is started from
a `blob:` URL the first time it is needed. No extra files, loaders, or `new URL()` patterns are involved. The
same build is verified in Vite (dev and build) and webpack 5. Nothing in it is
bundler-specific, so other ESM bundlers should behave the same.

With a Content-Security-Policy, allow `blob:` in `worker-src` (workers) and
`script-src` (the AudioWorklet modules), and `'wasm-unsafe-eval'` in `script-src`
for the realtime stretcher of prepared clips (it compiles its WASM in the
AudioWorklet). If they are blocked, the player still works: DSP falls back to
native nodes, speed to `playbackRate` (prepared clips: resampling, the pitch
follows), and the waveform and the spectrogram stay empty. A warning is logged, also when a
worker fails after it started.

The Rubber Band entry compiles `rubberband.wasm` in its own module worker, loaded
from a URL: a worker like that takes its policy from the CSP of the worker
script's own response, not from the page's, and that response needs
`'wasm-unsafe-eval'` in `script-src`. Refused, each job falls back to the built-in
vocoder, and the worker does not try again. `connect-src` must allow what the
player loads with `fetch()`: the clip URLs, manifests, the source files of prepared
clips (Range requests), their peaks, bands and spectrogram files, and
`rubberband.wasm`.

## Styling and themes

`@saitdigital/rt-dspplr/styles.css` styles the component. The root element is
`.rtd` with `data-theme="light|dark|auto"` and `data-layout="full|compact"`;
inner parts use flat `rtd-*` class names. All colours and the main metrics
are `--rtd-*` custom properties, so a theme is a few overrides. Light is
the default look; `theme="dark"` and `theme="auto"` switch the token set.

```css
.my-player {
    --rtd-accent: #7c3aed;          /* play button, played waveform, active states */
    --rtd-accent-hover: #6d28d9;
    --rtd-accent-soft: rgba(124, 58, 237, 0.1);
    --rtd-loop-fill: rgba(124, 58, 237, 0.14);
    --rtd-radius: 6px;
    --rtd-font: 'IBM Plex Sans', sans-serif;
}
```

| Token | Light default | |
|---|---|---|
| `--rtd-font` | system UI stack | No web font is loaded. |
| `--rtd-bg`, `--rtd-surface`, `--rtd-surface-hover` | `#ffffff`, `#f3f4f6`, `#e8eaee` | Card, segmented-control track, hover. |
| `--rtd-border` | `#e0e3e8` | |
| `--rtd-text`, `--rtd-text-muted` | `#1b1f24`, `#5c6570` | |
| `--rtd-accent`, `--rtd-accent-hover`, `--rtd-accent-contrast`, `--rtd-accent-soft` | teal `#0f766e`, `#115e59`, `#ffffff`, 10% teal | The one accent colour. |
| `--rtd-wave`, `--rtd-wave-rms` | `#cdd2d9`, `#a3aab4` | Envelope and RMS layer before the playhead (bars use `--rtd-wave`). |
| `--rtd-wave-played`, `--rtd-wave-played-rms` | `#8ec9c1`, accent | The same after the playhead. |
| `--rtd-ruler`, `--rtd-ruler-text` | `#b4bac3`, `#6b737d` | Ruler line/minor ticks, major ticks and labels. |
| `--rtd-loop-fill`, `--rtd-loop-edge` | 13% teal, accent | Loop band and handles. |
| `--rtd-track` | `#d8dce2` | Empty part of the sliders. |
| `--rtd-focus` | accent | Focus ring. |
| `--rtd-danger` | `#c2410c` | Load errors. |
| `--rtd-tooltip-bg`, `--rtd-tooltip-text` | `#1b1f24`, `#ffffff` | Hover time. |
| `--rtd-shadow`, `--rtd-popover-shadow` | soft | |
| `--rtd-radius`, `--rtd-control-radius` | `14px`, `8px` | |
| `--rtd-wave-height`, `--rtd-play-size`, `--rtd-padding` | `56px`, `48px`, `16px` | Compact: `36px`, `40px`, `10px`. |
| `--rtd-spectrogram-colormap` | `magma_r` (dark: `magma`) | The colormap of the level (`none` or empty: the three-colour ramp). |
| `--rtd-spectrogram-bg`, `-a`, `-b`, `-mix`, `-peak` | `#f3f4f6`, orange, blue, purple, `#1b1f24` | The three-colour ramp: `colorMode: 'dual'`, or without a colormap. Any CSS colour (`var()` too); the alpha is ignored. |
| `--rtd-overlay-wave`, `-wave-rms`, `-played`, `-played-rms` | translucent ink / accent | The waveform outline drawn over the spectrogram (`display: 'both'`). |

The dark set (`theme="dark"`, or `"auto"` with a dark OS setting) uses a
`#17191c` card and a `#2dd4bf` accent. The waveform canvases read the
`--rtd-wave*`, `--rtd-spectrogram-*` and `--rtd-overlay-*` tokens when they draw
and redraw on theme changes. Before a clip is loaded the spectrogram paints
nothing, so the empty state looks the same in every display.

The card is not positioned; place it anywhere. It is a size container
(`container: rtd / inline-size`), so its own `@container rtd` rules react
to the width it is given rather than to the viewport.

## Memory

Decoded audio is raw Float32 PCM in the browser's native memory, about
22 MiB per minute of 48 kHz stereo. One byte-bounded LRU (default 150 MiB,
shared by all players) holds both decoded clips and rendered speed variants.
The default three variants can add about 2x the clip's size. Speculative
prewarming only schedules variants whose estimated size fits beside what the
cache already holds. Explicitly requested variants may exceed the budget; they
are played without caching, and the player keeps the one it is playing until
the clip or the speed changes.

**This is a cache limit, not a cap on total tab memory.** `usedBytes` reports
cache references only. Active tracks can retain evicted buffers; decode,
download, waveform workers, stretch workers and their scratch/output buffers
consume additional memory. Stems A and B each require PCM.
Eviction never interrupts playback. Rendering a speed variant needs little
beyond the variant itself: the built-in vocoder goes through clips longer than
15 s frame by frame (see [Time-stretch strategies](#time-stretch-strategies)).
For large files or constrained devices, set `prewarmSpeeds: false`, avoid
unnecessary stem B prefetch, and dispose unused players. Whole clips are
decoded in full: an hour of 48 kHz stereo is about 1.4 GB of PCM, and each speed
variant adds to it. Where users can pass any file, set `maxClipBytes` and
`maxClipSeconds` so a file too large fails early with a clear error instead of
taking the tab down. For long recordings, the prepared (manifest)
source keeps only about a minute of decoded audio around the playhead; see
[Long recordings](#long-recordings-prepared-files).

```ts
import { setAudioCacheBudget, getAudioCacheStats, clearAudioCache } from '@saitdigital/rt-dspplr';
setAudioCacheBudget(64 * 1024 * 1024);
```

## SSR and Next.js

Importing either entry on the server is safe: there is no `window` access at
module scope, and players do nothing until `load`/`play`. `react.js` starts
with `'use client'`, so `<AudioPlayer />` can be imported from a Server
Component file and renders as a client component. Import the stylesheet from
your root layout. (Next.js itself is not part of this repository's test
matrix; its client bundles use webpack 5, which is tested.)

## Browser support

Current Chrome, Edge, Firefox and Safari (14.1 or later: older Safari has only
the prefixed `webkitAudioContext`, which the player does not use). Requirements:
Web Audio with AudioWorklet (Chrome 66, Firefox 76, Safari 14.1; native nodes
take over where a CSP blocks it),
Web Workers, CSS container queries (2023+ browsers; older ones just skip the
narrow-width tweaks). The Rubber Band entry needs module workers (Firefox
114+). Formats: whatever the browser's `decodeAudioData` supports (WAV, MP3,
AAC/M4A, FLAC everywhere; Ogg/Opus and WebM depend on the browser). The shared
AudioContext runs at the device's rate when it is 44.1 or 48 kHz (else at
48 kHz) unless the first player asks for another `sampleRate`. Whole clips at
another rate are resampled by the browser's decoder; prepared clips by the
stream engine, which plays them at their own rate (mix, realtime stretch) and
converts its output with a windowed-sinc resampler (residual below −90 dB,
about 1 % of a core for stereo), so realtime speed works at any rate.

## Sizes

Builds are readable ESM, not minified. `npm run build` prints each entry's
size including its static chunks, both raw and gzip. The same measurements
are shipped in `dist/bundle-sizes.json` with every build. Applications may
further tree-shake and minify them. Core, React and advanced share chunks;
do not add their reported sizes together.

Rubber Band is external: its separately installed package and WASM are not
included in these sizes or in the npm artifact.

## Validation

```bash
npm test                  # stretch lengths, level and timing, shared cache, scheduling, worker failures, the ruler, untouched audio at the defaults, the manifest schema against assertManifest()
npm run typecheck
npm run test:browser      # build + Chromium AudioContext/worker/React tests (workspace root)
npm run test:package      # build + npm artifact installed in an isolated consumer (workspace root)
```

Install Chromium once with `npx playwright install chromium`. The automated
browser suite covers transport cancellation, racing clip/speed requests,
late stem B responses, loops changed while playing, multiple players,
StrictMode cleanup, real output levels, the built-in vocoder, and the wheel,
touch and right-click behaviour. It runs with the browser's autoplay policy
switched off, so the first play from a click is checked by hand. It is not a
listening-quality benchmark or a claim that Safari, Firefox, mobile devices and
all bundlers were tested.

## Licensing

### The author credit

Right-clicking the player (or the context-menu key / Shift+F10) opens a menu with
**RT-DSPPLR by SAIT Digital** linking to the project; the ⓘ button opens it too.
The player places this for you, styled and ready, in every element it is mounted
in: the React `<AudioPlayer />` root, `ref={player.ref}` from `useAudioPlayer()`,
or `createAudioPlayer({ element })` / `player.mount(element)` in any framework, so
you never have to build a credit of your own. Right-click anywhere on the
player opens it, whatever is under the pointer; it is caught on the player's
element only, so the rest of your page keeps its own menus. The
[license](./LICENSE.md) is what requires the credit to stay.

The ⓘ button lives inside the player's element. Mark an element inside your
interface with `data-rtd-credit` and the button goes there, in your layout.
Without one it sits over the element's top-right corner, offset by the
`--rtd-credit-top` and `--rtd-credit-right` custom properties and stacked by
`--rtd-credit-z` (default 3). For that the element is made `position: relative`
while mounted if it was static, which moves anything inside it that is
positioned against an outer box; give such an interface a `data-rtd-credit`
slot. `<AudioPlayer />` has its own place for it in the heading row. With `infoButton: 'touch'` the
button shows only on devices with a touch screen (phones, tablets, touch laptops),
and a mouse alone uses right-click.

```html
<section id="player">
    <header>My player <span data-rtd-credit></span></header>
    <button data-play>Play</button>
</section>
```

Mount the element that holds all your player controls. In browsers with the
Popover API the menu uses the top layer; older browsers get a fixed-position
overlay, which native top-layer dialogs may cover. Mount a container, not a canvas
or an input element.

### License terms

Free to use, including in commercial, closed-source apps and hosted services. If
you ship a modified player, or serve it to people outside your organization,
publish its source under the same license; your own application code stays closed.
The terms fit on one page: [LICENSE.md](./LICENSE.md). The code samples in this
README are under MIT No Attribution: copy and change them freely; the player
they use keeps this license.

The build checks exclude Rubber Band implementation code and WASM from the core,
React and advanced entries. The optional `./stretch-rubberband` entry makes your
application load `rubberband-wasm`, which is GPL-2.0-or-later. The GPL wants the
whole combined program under the GPL, and this player's license adds conditions
(the credit, open changes) that the GPL does not allow. In practice that means:
do not ship the Rubber Band entry in an application other people get, a web page
included, unless you hold a commercial Rubber Band licence. Without one, use the
built-in vocoder. See
[Rubber Band's licensing terms](https://breakfastquay.com/rubberband/license.html).
