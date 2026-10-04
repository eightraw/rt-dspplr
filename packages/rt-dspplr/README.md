# RT-DSPPLR

**Web audio player by SAIT Digital.**

Source and the demo: [github.com/eightraw/rt-dspplr](https://github.com/eightraw/rt-dspplr).
Free to use under a one-page [license](./LICENSE.md), see [Licensing](#licensing).

A web audio player with real-time DSP, pitch-preserving speed controls,
looping and an interactive waveform. Available as a headless engine and a
ready React component. Audio files are decoded in full; memory use scales
with their length.

- **Pitch-preserving speed** (1.25x, 1.5x, 2x...). Variants are rendered
  off the main thread. Playback continues at the applied speed while a new
  variant is prepared, then switches at the live position.
- **Loop** any range, with boundaries snapped to zero crossings (no clicks).
- **Real-time DSP chain** on the output: 24 dB/oct high-pass, a peak
  compressor, output gain, and a -0.01 dBFS ceiling. Everything but the
  ceiling is off by default. It runs in an AudioWorklet, with native nodes
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
is the browser's autoplay policy for `AudioContext`.

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
| `fetchOptions` | `RequestInit` | none | Extra `fetch()` options for URL sources (credentials, headers). |
| `cacheBudgetBytes` | `number` | 150 MiB | Shared PCM budget for every player on the page, see [Memory](#memory). |
| `sampleRate` | `number` | `48000` | Sample rate of the shared AudioContext (the first player to start decides). |
| `latencyHint` | `'playback' \| 'interactive' \| 'balanced' \| number` | `'playback'` | Output buffering of the shared AudioContext (the first player to start decides). `'playback'` keeps the sound clean while the page is busy. |
| `element` | `HTMLElement` | none | The element your interface lives in; same as `mount(element)`. |
| `infoButton` | `'always' \| 'touch'` | `'always'` | The ⓘ button of the author menu: on every device, or only on devices with a touch screen. See [The author credit](#the-author-credit). |

`AudioInput` is `string` (URL) `| ArrayBuffer` (encoded bytes) `| Blob | AudioBuffer`.
A clip is an `AudioInput` or `{ src, srcB?, id? }`. `id` defaults to the URL.

### Methods

| Method | |
|---|---|
| `mount(element)` | Puts the author menu on your interface element and returns a function that releases it. Playback needs at least one mounted element on the page: without it `play()`, `toggle()` and `load(…, { autoplay: true })` reject. |
| `load(clip, { startAt?, autoplay? })` | Fetch and decode. Resolves `true` when ready, `false` on failure or when superseded by a newer load. |
| `play(clip?, { startAt? })` | With no argument, resume. With a clip, play it from `startAt` (default 0). Passing the clip that is already loaded restarts it without reloading. |
| `pause()`, `toggle()`, `stop()` | `pause()` follows `pauseMode`. |
| `seek(seconds)` | Keeps playing if it was playing. |
| `setSpeed(speed)` | Keeps the position. Clamped to 0.25–4x. Pitch is preserved when the strategy has a worker. |
| `setLoop({ start, end } \| null)` | In seconds. Snapped to zero crossings. Changing or dropping the loop while playing keeps the position; a loop set behind the playhead starts from its beginning. |
| `setHighPass(hz)` | `0` bypasses. UI range 0–500 Hz. |
| `setCompression(amount)` | 0–1. |
| `setOutputGain(db)` | -24…+24 dB; `-Infinity` mutes. |
| `setMix(mix)` | 0 = stem A … 1 = stem B; the gains follow `mixLaw`. Fetches stem B on first use. |
| `setProcessing(patch)` | Any subset of `ProcessingState`. |
| `setSourceB(input \| null)` | Install (or remove) stem B for the current clip directly. |
| `setPauseMode(mode)` | |
| `getState()` | Immutable snapshot; the same object until something changes. |
| `subscribe(listener)` | Called on every change; returns an unsubscribe function (`useSyncExternalStore`-compatible). |
| `on(event, listener)` / `off(...)` | Events below. `on` returns an unsubscribe function. |
| `getCurrentTime()` | Live position computed from the AudioContext clock. The state is updated about 30 times per second while the page shows, about four times a second in a background tab. |
| `analyser`, `audioContext` | Post-DSP `AnalyserNode` for custom meters, and the shared context. |
| `dispose()` | Stops playback and releases this player's nodes. The shared AudioContext stays open. A disposed player ignores `load`/`play` until `reactivate()` (the React hook does this for StrictMode). Mounted elements stay mounted. |

`ProcessingState`: `{ highPassHz: 0, compression: 0, outputGainDb: 0, speed: 1, mix: 0 }`
(defaults shown).

With these defaults the DSP leaves the audio as decoded: the high-pass is
bypassed, the compressor and the output gain do nothing, and only samples
above the -0.01 dBFS ceiling are clipped to it. Where the AudioWorklet cannot
start (a CSP that blocks `blob:`, a browser without it), native nodes take
over: they add a few milliseconds of look-ahead delay and limit softly near
0 dBFS instead of clipping.

### State (`getState()`)

| Field | |
|---|---|
| `clipId`, `src` | Current clip, and its URL if it was loaded from one. |
| `status` | `'idle' \| 'loading' \| 'ready' \| 'error'`; `progress` 0–1 while loading; `error`. |
| `isPlaying`, `currentTime`, `duration`, `ended` | `ended` is true after the clip plays to its end (not after `stop()`). |
| `loop` | Active loop range (snapped) or `null`. |
| `processing` | Applied `ProcessingState`; speed stays at the audible rate during preparation. |
| `pendingSpeed` | Requested speed being prepared, or `null`. Stop/pause/seek/new clip cancel the pending switch. |
| `statusB` | `'unavailable' \| 'idle' \| 'loading' \| 'ready' \| 'error'`. |
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
`StretchService`, `WaveformAnalyzer`, peak-pyramid helpers and DSP building
blocks. This advanced surface may change between minor releases before 1.0.

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
  High-pass, Compression and Output gain sliders plus Reset.

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
| Waveform | Left/Right (or Down/Up) ±1 s, PageDown/PageUp ±5 s, Home/End, `+`/`-` (or `=`/`_`) zoom ×1.5, `0` resets zoom, Esc clears the loop |
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
| `palette` | `DEFAULT_SPECTROGRAM_PALETTE` | `{ background, colorA, colorB, colorMix, peak }` as hex colours. The default is a dark panel with orange A, blue B and purple for both. |
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

The core and React entries contain four small scripts as strings: the
dynamics AudioWorklet (~2 KB), the vocoder worker (~5 KB), the waveform
peaks worker (~5 KB) and the spectrogram worker (~7 KB). Each is started from
a `blob:` URL the first time it is needed. No extra files, loaders, or `new URL()` patterns are involved. The
same build is verified in Vite (dev and build) and webpack 5. Nothing in it is
bundler-specific, so other ESM bundlers should behave the same.

With a Content-Security-Policy, allow `blob:` in `worker-src` (workers) and
`script-src` (the AudioWorklet module). If they are blocked, the player still
works: DSP falls back to native nodes, speed to `playbackRate`, and the
waveform and the spectrogram stay empty. A warning is logged, also when a
worker fails after it started.

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

The dark set (`theme="dark"`, or `"auto"` with a dark OS setting) uses a
`#17191c` card and a `#2dd4bf` accent. The waveform canvases read the
`--rtd-wave*` tokens when they draw and redraw on theme changes.

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
unnecessary stem B prefetch, and dispose unused players. Full-file decoding
remains required; this is not a streaming player or a solution for arbitrarily
long recordings.

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

Current Chrome, Edge, Firefox and Safari. Requirements: Web Audio with
AudioWorklet (Chrome 66, Firefox 76, Safari 14.1; native fallback otherwise),
Web Workers, CSS container queries (2023+ browsers; older ones just skip the
narrow-width tweaks). The Rubber Band entry needs module workers (Firefox
114+). Formats: whatever the browser's `decodeAudioData` supports (WAV, MP3,
AAC/M4A, FLAC everywhere; Ogg/Opus and WebM depend on the browser). The shared
AudioContext runs at 48 kHz unless the first player asks for another
`sampleRate`; material at another rate is resampled by the browser's decoder.

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
npm test                  # stretch lengths, level and timing, shared cache, scheduling, worker failures, the ruler, untouched audio at the defaults
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
