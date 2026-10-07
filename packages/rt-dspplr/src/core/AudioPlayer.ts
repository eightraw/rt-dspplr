import { AudioEngine, type LoopRange } from './engine';
import { EffectChain } from './effects/EffectChain';
import { dynamicsPlugin, highPassPlugin } from './effects/builtins';
import { previewCoverage } from './effects/preview';
import { dbToGain } from './dsp/compression';
import { resolveParams, validateParam, type DspPlugin, type EffectState, type PluginParams, type PreviewCoverage } from './effects/types';
import {
    DEFAULT_PROCESSING,
    DEFAULT_SPEEDS,
    LIMITER_CEILING_DB,
    SPEED_MIN,
    SPEED_MAX,
    clamp01,
    normalizeHighPassHz,
    normalizeInputGainDb,
    normalizeOutputGainDb,
    normalizeSpeed,
    outputGainDbToGain,
    type MixLaw,
    type ProcessingState,
} from './controls';
import { StretchService } from './stretch/StretchService';
import type { StretchStrategy } from './stretch/strategies';
import { setAudioCacheBudget } from './cache/pcmCache';
import { bindAttribution, type InfoButtonMode } from '../attribution';
import { BufferSource } from './sources/BufferSource';
import {
    SegmentedSource,
    type PreparedOverview,
    type SegmentedOptions,
    type StreamStats,
    type WindowAudio,
} from './sources/SegmentedSource';
import type { PlaybackSource, SourceCapabilities, SourceHost, SourceKind, SourceOutput } from './sources/types';
import type { AudioManifest } from './stream/manifest';
import type { WaveformPeakPyramid } from './waveform/pyramid';

// ---------------------------------------------------------------------------
// AudioPlayer — the headless player: one clip on stem A, an optional stem B
// mixed with it, pitch-preserving speed, loop, and a DSP chain on the master bus.
// ---------------------------------------------------------------------------
//
// Graph (per player, on the page-wide AudioContext):
//
//   source ─ input ─ high-pass ─ dynamics ─ analyser ─ destination
//                     (24 dB/oct)  (comp + gain + ceiling)
//
// The source is pluggable (see sources/types.ts):
//   BufferSource     the whole clip decoded (Track A + stem B, pitch-preserving
//                    speed variants, zero-crossing loops) — `play({ src })`
//   SegmentedSource  a prepared manifest, segments around the playhead —
//                    `play({ manifest })`
// What a source cannot do is reported in `state.capabilities`.
//
// All audio resources are created lazily on the first load/play, which keeps
// construction free (SSR, React StrictMode double-render).

/** Anything that can be played: a URL, encoded bytes, a Blob, or decoded PCM. */
export type AudioInput = string | ArrayBuffer | AudioBuffer | Blob;

export interface ClipSource {
    src: AudioInput;
    manifest?: undefined;
    /** Stem B: a second recording, sample-aligned with `src` (stem A). */
    srcB?: AudioInput | null;
    /** Stable identity. Defaults to `src` when it is a string, otherwise an auto id. */
    id?: string;
}

/** A prepared long recording (made with `@saitdigital/rt-dspplr-prepare`). */
export interface ManifestClip {
    /** URL of manifest.json; segment, peaks, bands and spectrogram URLs are relative to it. */
    manifest: string;
    /**
     * Key of the manifest stem the A/B knob blends with. Default: `b` when the
     * manifest has it ready, else its first ready stem. See `player.setStem()`.
     */
    stem?: string;
    id?: string;
    src?: undefined;
}

export type ClipInput = AudioInput | ClipSource | ManifestClip;

export interface ClipInfo {
    id: string;
    /** The URL or data of stem A; for a manifest clip, the manifest's URL. */
    src: AudioInput;
    srcB: AudioInput | null;
    /** Set for a prepared clip: it plays through the segmented source. */
    manifest: string | null;
    /** A prepared clip's requested blend stem (ManifestClip.stem). */
    stem?: string | null;
}

/**
 * Produces stem B on demand (e.g. fetches it from your server).
 * Called at most once per clip, only when the mix goes above 0 (or
 * right after load with `prefetchB`). Return null when there is none.
 */
export type LoaderB = (
    clip: ClipInfo,
    signal: AbortSignal,
) => Promise<AudioInput | null | undefined>;

/**
 * 'pause' — pause keeps the position.
 * 'reset' — pause returns to where playback last started, so the same
 *           passage plays again from the same point.
 */
export type PauseMode = 'pause' | 'reset';

export interface AudioPlayerOptions {
    /**
     * How speed keeps the pitch. Default 'realtime': the stream engine's realtime
     * stretch, for whole and prepared clips alike (a speed change is heard at once).
     * 'native': no stretch, the pitch follows the speed. An offline strategy such as
     * `rubberbandStretcher()` (the optional `./stretch-rubberband` entry) renders each
     * speed of a whole clip in a worker instead; prepared clips keep the realtime stretch.
     */
    stretcher?: 'realtime' | 'native' | StretchStrategy;
    /** Speeds offered by UIs; also the default prewarm set. Default [1, 1.25, 1.5, 2]. */
    speeds?: readonly number[];
    /**
     * With an offline `stretcher`: render speed variants in the background right
     * after a clip loads, so speed changes usually avoid preparation waits.
     * true = `speeds` except 1. The selected speed is always rendered first. Default true.
     */
    prewarmSpeeds?: boolean | readonly number[];
    /** Initial processing values. */
    processing?: Partial<ProcessingState>;
    /**
     * How `mix` sets the stems' gains. Default 'crossfade' (A at 1 - mix, B at mix).
     * 'separation' is for stems that add up to the original: both play at full in
     * the middle, so 0.5 is the original and the ends are each stem alone.
     */
    mixLaw?: MixLaw;
    /** Default 'pause'. */
    pauseMode?: PauseMode;
    /** On-demand source of stem B, used when a clip has no `srcB`. */
    loadB?: LoaderB;
    /** Fetch stem B right after load instead of waiting for mix > 0. Default false. */
    prefetchB?: boolean;
    /**
     * Extra fetch() options for URL sources (credentials, headers...). For a
     * prepared clip, its headers and credentials go to the manifest's own origin
     * only, and to the origins in `fetchOptionsOrigins`.
     */
    fetchOptions?: RequestInit;
    /**
     * Further origins (e.g. 'https://cdn.example.com') that get the headers and
     * credentials of `fetchOptions` when a manifest names files there. Files on
     * other origins are still fetched, without them. Default none.
     */
    fetchOptionsOrigins?: readonly string[];
    /**
     * Shared byte budget for decoded audio and speed variants (all players on
     * the page share one cache). Default 150 MiB. Not a total memory cap.
     */
    cacheBudgetBytes?: number;
    /**
     * Whole clips (`src`, decoded in full, stem B too): the largest file, in
     * bytes. A URL is checked against its Content-Length before the download
     * and against the bytes read while it runs; bytes and Blobs by their size.
     * A larger file fails at once with an error named 'ClipTooLargeError'.
     * Default: no limit. Long recordings play prepared: `play({ manifest })`.
     */
    maxClipBytes?: number;
    /**
     * Whole clips: the longest clip, in seconds, checked once decoded (before
     * any speed variant is rendered). Fails like `maxClipBytes`. Default: no limit.
     */
    maxClipSeconds?: number;
    /**
     * Sample rate of the shared AudioContext; only the first player to start
     * decides. Default: the device's rate when it is 44100 or 48000, else 48000.
     * Clips at other rates are converted by the player.
     */
    sampleRate?: number;
    /**
     * Output buffering of the shared AudioContext; only the first player to start
     * decides. Default 'playback', which keeps the sound clean while the page is busy.
     */
    latencyHint?: AudioContextLatencyCategory | number;
    /**
     * The element your player interface lives in; same as calling `mount()`.
     * The player puts its author menu there. Playback needs one.
     */
    element?: HTMLElement;
    /**
     * When the ⓘ button of the author menu shows: 'always' (default), or 'touch' for
     * devices with a touch screen only. Right-click on the player opens the menu either way.
     * Mark an element inside your interface with `data-rtd-credit` to put the button there;
     * otherwise it sits over the interface element's top-right corner.
     */
    infoButton?: InfoButtonMode;
    /** Prepared (manifest) clips: segment cache, prefetch, decoding. */
    segmented?: SegmentedOptions;
}

export type PlayerStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * 'unavailable' — the clip has no stem B source and there is no loader;
 * 'idle' — available but not fetched yet; then 'loading' / 'ready' / 'error'.
 */
export type StatusB = 'unavailable' | 'processing' | 'idle' | 'loading' | 'ready' | 'error';

export interface AudioPlayerState {
    clipId: string | null;
    /** The clip's URL when it was loaded from one. */
    src: string | null;
    status: PlayerStatus;
    /** Download progress 0..1 while loading (NaN when the size is unknown: no Content-Length, or a Content-Encoding). */
    progress: number;
    error: Error | null;
    isPlaying: boolean;
    /**
     * Why the audio output is held, or null. 'interrupted': the system took it
     * while playing (a call or Siri on iOS, another app) and the player paused;
     * 'blocked': play() could not start it (not from a user gesture, or during
     * an interruption). The next play() from a user gesture resumes; a UI can
     * say "tap to resume". Clears when playback starts or the output runs again.
     */
    suspended: 'interrupted' | 'blocked' | null;
    /** Position in seconds. Updated ~30 times per second while playing; use getCurrentTime() for a live value. */
    currentTime: number;
    duration: number;
    /** True after the clip played to its end (not after stop/pause). */
    ended: boolean;
    loop: LoopRange | null;
    pauseMode: PauseMode;
    /** Where the current playback segment started (used by 'reset' pause mode and for smooth playheads). */
    playbackStartPoint: number;
    /** AudioContext time at which the current segment started, null when not playing. */
    startedAt: number | null;
    /** Increments on every new clip and every restart. */
    playRequestId: number;
    processing: ProcessingState;
    /** How `processing.mix` maps to the stems' gains (from the options). */
    mixLaw: MixLaw;
    /** Requested speed being prepared; processing.speed remains the applied speed. */
    pendingSpeed: number | null;
    statusB: StatusB;
    buffer: AudioBuffer | null;
    bufferB: AudioBuffer | null;
    audioContext: AudioContext | null;
    /** Which source plays the current clip (null before the first clip). */
    sourceKind: SourceKind | null;
    /** What the current source can do; UIs degrade on what it cannot. */
    capabilities: SourceCapabilities;
    /** The manifest of a prepared clip. */
    manifest: AudioManifest | null;
    /** Key of the manifest stem the knob blends with (prepared clips), or null. See `setStem()`. */
    stem: string | null;
    /** Waiting for a segment while playing (start, seek, or a stall). */
    buffering: boolean;
    /** Peaks, bands and spectrogram of a prepared clip, as they arrive. */
    prepared: PreparedOverview | null;
    /** The effect chain, in order (built-ins included). See `player.effects`. */
    effects: EffectState[];
    /** Sum of the active effects' declared latencies, in frames. */
    effectsLatencyFrames: number;
    /** Which previews leave an active effect out (the UI notes it). */
    previewCoverage: PreviewCoverage;
}

export interface AudioPlayerEventMap {
    statechange: AudioPlayerState;
    timeupdate: number;
    ended: { clipId: string | null };
    load: { clipId: string; duration: number };
    error: Error;
    bload: { clipId: string };
    berror: Error;
    /** A prepared clip's overview data or on-screen segments arrived. */
    sourceupdate: { clipId: string | null; what: 'peaks' | 'bands' | 'spectrogram' | 'segment' };
    /** An effect failed (it is bypassed; playback goes on). */
    effecterror: { id: string; message: string };
}

export type AudioPlayerEvent = keyof AudioPlayerEventMap;

export interface LoadOptions {
    /** Start position in seconds. Default 0. */
    startAt?: number;
    /** Start playing as soon as the clip is decoded. Default false for load(), true for play(). */
    autoplay?: boolean;
}

let autoClipId = 0;

/** How long a play request may wait for the output to resume before `suspended` says 'blocked'. */
const START_WATCH_MS = 3000;

/** Before any clip: what the buffer source offers (the default). */
const DEFAULT_CAPABILITIES: SourceCapabilities = {
    kind: 'buffer',
    canPreservePitch: true,
    canMixStemB: true,
    stems: [],
    exactWaveformPreview: true,
    spectrogram: true,
    loopSnapping: true,
};

function isClipObject(input: ClipInput): input is ClipSource | ManifestClip {
    return typeof input === 'object'
        && input !== null
        && !(input instanceof ArrayBuffer)
        && !(typeof AudioBuffer !== 'undefined' && input instanceof AudioBuffer)
        && !(typeof Blob !== 'undefined' && input instanceof Blob)
        && ('src' in input || 'manifest' in input);
}

const inputIds = new WeakMap<object, string>();

function defaultClipId(src: AudioInput): string {
    if (typeof src === 'string') return src;
    let id = inputIds.get(src);
    if (!id) {
        id = `clip-${++autoClipId}`;
        inputIds.set(src, id);
    }
    return id;
}

function normalizeClip(input: ClipInput): ClipInfo {
    if (isClipObject(input)) {
        if (typeof input.manifest === 'string') {
            return { id: input.id ?? input.manifest, src: input.manifest, srcB: null, manifest: input.manifest, stem: input.stem ?? null };
        }
        const clip = input as ClipSource;
        return {
            id: clip.id ?? defaultClipId(clip.src),
            src: clip.src,
            srcB: clip.srcB ?? null,
            manifest: null,
        };
    }
    // A URL to a .json file can only be a manifest (no browser decodes JSON as audio).
    const manifest = typeof input === 'string' && isManifestUrl(input) ? input : null;
    return { id: defaultClipId(input), src: input, srcB: null, manifest };
}

function isManifestUrl(url: string): boolean {
    return /\.json$/i.test(url.split(/[?#]/)[0]);
}

function normalizeProcessing(partial?: Partial<ProcessingState>): ProcessingState {
    const merged = { ...DEFAULT_PROCESSING, ...partial };
    return {
        inputGainDb: normalizeInputGainDb(merged.inputGainDb),
        highPassHz: normalizeHighPassHz(merged.highPassHz),
        compression: clamp01(merged.compression),
        outputGainDb: normalizeOutputGainDb(merged.outputGainDb),
        speed: normalizeSpeed(merged.speed),
        mix: clamp01(merged.mix),
    };
}

type Listener<T> = (payload: T) => void;

export class AudioPlayerCore {
    private readonly _options: AudioPlayerOptions;
    private readonly _speeds: readonly number[];
    private readonly _prewarmSpeeds: readonly number[];
    private readonly _stretch: StretchService | null;

    private _state: AudioPlayerState;
    private _storeListeners = new Set<() => void>();
    private _eventListeners = new Map<AudioPlayerEvent, Set<Listener<never>>>();
    private _interfaces = new Map<HTMLElement, number>();
    private _disposed = false;

    private _engine: AudioEngine | null = null;
    private _output: EffectChain | null = null;
    private _effectSeq = 0;

    /**
     * The effect chain ("bring your own effect"): plugins after the mix and the
     * stretcher, before the volume. The built-in high-pass ('highpass') and
     * dynamics ('dynamics') are plugins in it too. Parameters are validated
     * against each plugin's schema and smoothed in the audio graph.
     *
     * @experimental The plugin API may change in minor releases before 1.0.
     */
    readonly effects = {
        list: (): EffectState[] => this._state.effects,
        /** Insert a plugin (at the end by default). Returns its instance id. */
        add: (plugin: DspPlugin, options: { position?: number; params?: PluginParams; id?: string; bypassed?: boolean } = {}): string => {
            if (!plugin || typeof plugin.id !== 'string' || !Array.isArray(plugin.params) || !plugin.realtime) {
                throw new TypeError('effects.add: not a DspPlugin');
            }
            const id = options.id ?? `${plugin.id}#${++this._effectSeq}`;
            if (this._state.effects.some((e) => e.id === id)) throw new Error(`effects.add: id "${id}" is taken`);
            const effect: EffectState = { id, plugin, params: resolveParams(plugin, options.params), bypassed: !!options.bypassed, error: null };
            const list = [...this._state.effects];
            const position = Math.max(0, Math.min(list.length, options.position ?? list.length));
            list.splice(position, 0, effect);
            this._setEffects(list);
            this._output?.add(id, plugin, effect.params, effect.bypassed, position);
            return id;
        },
        remove: (id: string): void => {
            const effect = this._state.effects.find((e) => e.id === id);
            if (!effect) return;
            if (effect.plugin.builtin) {
                // The card's high-pass and dynamics controls drive these (and dynamics holds the ceiling).
                console.warn(`[AudioPlayer] the built-in ${JSON.stringify(id)} effect cannot be removed; bypass it instead`);
                return;
            }
            this._setEffects(this._state.effects.filter((e) => e.id !== id));
            this._output?.remove(id);
        },
        move: (id: string, position: number): void => {
            const effect = this._state.effects.find((e) => e.id === id);
            if (!effect) return;
            const list = this._state.effects.filter((e) => e !== effect);
            list.splice(Math.max(0, Math.min(list.length, position)), 0, effect);
            this._setEffects(list);
            this._output?.move(id, position);
        },
        setParam: (id: string, param: string, value: number): void => {
            const effect = this._state.effects.find((e) => e.id === id);
            if (!effect) throw new Error(`effects.setParam: no effect "${id}"`);
            this._setEffectParam(effect, param, validateParam(effect.plugin, param, value));
        },
        /**
         * Take an effect out of the signal (true) or put it back (false). A failed
         * effect (its `error` is set) stays out: putting it back is ignored, with
         * a warning. Remove it and add it again to retry it.
         */
        bypass: (id: string, bypassed: boolean): void => {
            const effect = this._state.effects.find((e) => e.id === id);
            if (!effect || effect.bypassed === bypassed) return;
            if (!bypassed && effect.error) {
                console.warn(`[AudioPlayer] the ${JSON.stringify(id)} effect failed (${effect.error}); remove it and add it again to retry`);
                return;
            }
            this._setEffects(this._state.effects.map((e) => (e === effect ? { ...e, bypassed } : e)));
            this._output?.bypass(id, bypassed);
        },
    };

    /** @internal A preview worker could not compile a plugin's process() (preview.ts then leaves it out): count that in previewCoverage. */
    refreshPreviewCoverage = (): void => {
        this._setEffects(this._state.effects);
    };

    private _setEffects(effects: EffectState[]): void {
        this._update({
            effects,
            effectsLatencyFrames: effects.filter((e) => !e.bypassed && !e.error).reduce((n, e) => n + (e.plugin.latencyFrames ?? 0), 0),
            previewCoverage: previewCoverage(effects, true),
        });
    }

    /** Set an effect's (already validated) param; built-ins keep `processing` in step. */
    private _setEffectParam(effect: EffectState, param: string, value: number): void {
        this._setEffects(this._state.effects.map((e) => (e === effect ? { ...e, params: { ...e.params, [param]: value } } : e)));
        this._output?.setParam(effect.id, param, value);
        if (effect.plugin.builtin === 'highpass' && param === 'hz') this._updateProcessing({ highPassHz: value });
        if (effect.plugin.builtin === 'dynamics' && param === 'amount') this._updateProcessing({ compression: value });
    }

    private _builtin(kind: 'highpass' | 'dynamics'): EffectState | undefined {
        return this._state.effects.find((e) => e.plugin.builtin === kind);
    }

    private _onEffectError(id: string, message: string): void {
        console.warn('[AudioPlayer] effect failed and is bypassed:', message);
        this._setEffects(this._state.effects.map((e) => (e.id === id ? { ...e, error: message } : e)));
        this._emit('effecterror', { id, message });
    }
    private _outputPromise: Promise<SourceOutput | null> | null = null;
    private _outputGeneration = 0;
    private _unsubscribeEngine: (() => void) | null = null;
    /** The latest play request whose outcome `_watchStart` reports. */
    private _startId = 0;

    private readonly _host: SourceHost;
    private readonly _bufferSource: BufferSource;
    private _segmentedSource: SegmentedSource | null = null;
    /** The source of the current clip. */
    private _source: PlaybackSource;

    constructor(options: AudioPlayerOptions = {}) {
        this._options = options;
        const offered = options.speeds && options.speeds.length > 0 ? options.speeds : DEFAULT_SPEEDS;
        const outOfRange = offered.filter((speed) => !(speed >= SPEED_MIN && speed <= SPEED_MAX));
        if (outOfRange.length > 0) {
            console.warn(`[AudioPlayer] speeds outside ${SPEED_MIN}–${SPEED_MAX}x are not offered:`, outOfRange);
        }
        const inRange = offered.filter((speed) => speed >= SPEED_MIN && speed <= SPEED_MAX);
        this._speeds = (inRange.length > 0 ? inRange : DEFAULT_SPEEDS).map(normalizeSpeed);
        const prewarm = options.prewarmSpeeds ?? true;
        this._prewarmSpeeds = prewarm === true
            ? this._speeds
            : prewarm === false ? [] : prewarm.map(normalizeSpeed);
        this._prewarmSpeeds = this._prewarmSpeeds.filter((speed) => Math.abs(speed - 1) >= 0.001);

        const strategy = typeof options.stretcher === 'object' && options.stretcher ? options.stretcher : null;
        this._stretch = strategy ? StretchService.forStrategy(strategy) : null;

        if (typeof options.cacheBudgetBytes === 'number') {
            setAudioCacheBudget(options.cacheBudgetBytes);
        }

        this._state = this._initialState(normalizeProcessing(options.processing), options.pauseMode ?? 'pause');
        this._host = {
            options,
            getState: () => this._state,
            update: (patch) => this._update(patch),
            emit: (event, payload) => this._emit(event, payload),
            ensureOutput: () => this._ensureOutput(),
        };
        this._bufferSource = new BufferSource(this._host, {
            stretch: this._stretch,
            prewarmSpeeds: this._prewarmSpeeds,
            engine: strategy ? null : { stretch: options.stretcher !== 'native' },
        });
        this._source = this._bufferSource;
        if (options.element) this.mount(options.element);
    }

    // -----------------------------------------------------------------------
    // Interface
    // -----------------------------------------------------------------------

    /**
     * Tell the player which element its interface lives in. The player puts
     * its author menu there: right-click, the context-menu key / Shift+F10 and
     * a tappable About button. Playback needs at least one mounted element that
     * is on the page. Returns a function that releases the element; dispose()
     * leaves mounted elements alone, so a reactivated player keeps them.
     */
    mount = (element: HTMLElement): (() => void) => {
        const release = bindAttribution(element, { button: this._options.infoButton });
        this._interfaces.set(element, (this._interfaces.get(element) ?? 0) + 1);
        let released = false;
        return () => {
            if (released) return;
            released = true;
            release();
            const count = (this._interfaces.get(element) ?? 1) - 1;
            if (count > 0) this._interfaces.set(element, count);
            else this._interfaces.delete(element);
        };
    };

    private _requireInterface(): void {
        for (const element of this._interfaces.keys()) {
            if (element.isConnected) return;
        }
        throw new Error('RT-DSPPLR plays only inside its interface: pass the element your player UI '
            + 'lives in as createAudioPlayer({ element }) or player.mount(element). '
            + 'The player puts its author menu there.');
    }

    // -----------------------------------------------------------------------
    // Store + events
    // -----------------------------------------------------------------------

    /** Current state snapshot. Same object until the next change (useSyncExternalStore-friendly). */
    getState = (): AudioPlayerState => this._state;

    /** Subscribe to any state change. Returns an unsubscribe function. */
    subscribe = (listener: () => void): (() => void) => {
        this._storeListeners.add(listener);
        return () => {
            this._storeListeners.delete(listener);
        };
    };

    on = <E extends AudioPlayerEvent>(event: E, listener: Listener<AudioPlayerEventMap[E]>): (() => void) => {
        let set = this._eventListeners.get(event);
        if (!set) {
            set = new Set();
            this._eventListeners.set(event, set);
        }
        set.add(listener as Listener<never>);
        return () => this.off(event, listener);
    };

    off = <E extends AudioPlayerEvent>(event: E, listener: Listener<AudioPlayerEventMap[E]>): void => {
        this._eventListeners.get(event)?.delete(listener as Listener<never>);
    };

    /** Speeds this player offers (from options). */
    get speeds(): readonly number[] {
        return this._speeds;
    }

    /**
     * Whether speed changes keep the pitch for the current clip: whether the
     * engine's realtime stretch is running (or, with an offline strategy, its
     * worker is available). False with `stretcher: 'native'`. See also
     * `state.capabilities`.
     */
    get stretchAvailable(): boolean {
        return this._source.capabilities.canPreservePitch;
    }

    /** Live playback position in seconds, computed from the AudioContext clock. */
    getCurrentTime = (): number => this._source.getCurrentTime() ?? this._state.currentTime;

    /** Post-DSP analyser node for custom visualisations (null until the first load). */
    get analyser(): AnalyserNode | null {
        return this._output?.analyser ?? null;
    }

    get audioContext(): AudioContext | null {
        return this._engine?.context ?? null;
    }

    // ---- prepared (segmented) clips ------------------------------------------

    /** The manifest of the current prepared clip, or null. */
    getManifest = (): AudioManifest | null => this._state.manifest;

    /** Stored peaks of the current prepared clip (unprocessed), or null. */
    getPeakPyramid = (): WaveformPeakPyramid | null => this._state.prepared?.peaks ?? null;

    /** Segment cache, fetch and latency figures of the current prepared clip, or null. */
    getStreamStats = (): StreamStats | null => (this._source.kind === 'segmented' ? this._segmentedSource?.stats() ?? null : null);

    /**
     * The timeline's visible range (TimelineCore calls this). For a prepared
     * clip, short views get their segments decoded for exact previews.
     */
    setView = (startSeconds: number, endSeconds: number): void => {
        if (this._source.kind === 'segmented') this._segmentedSource?.setView(startSeconds, endSeconds);
    };

    /** Decoded audio around the view of a prepared clip (null until its segments are in, and for whole clips). */
    getWindowAudio = (): WindowAudio | null => (this._source.kind === 'segmented' ? this._segmentedSource?.getWindowAudio() ?? null : null);

    // -----------------------------------------------------------------------
    // Transport
    // -----------------------------------------------------------------------

    /**
     * Load a clip without playing it (unless `autoplay`). Resolves true once
     * decoded (a prepared clip: once its manifest is read), false on failure or
     * when superseded by another load.
     */
    load = async (clip: ClipInput, options: LoadOptions = {}): Promise<boolean> => {
        if (options.autoplay) this._requireInterface();
        if (this._disposed) return false;
        const info = normalizeClip(clip);
        if (!options.autoplay) return this._sourceFor(info).load(info, options.startAt, false);
        const woke = this._wake(true);
        const started = this._sourceFor(info).load(info, options.startAt, true);
        this._watchStart(woke, started);
        return started;
    };

    /**
     * Without arguments: resume the current clip (while it is still loading:
     * play it once it is in).
     * With a clip: play it from `startAt` (default 0). Passing the clip that is
     * already loaded restarts it without reloading.
     * `{ manifest: url }` plays a prepared long recording segment by segment.
     * Must be called from a user gesture the first time (browser autoplay policy):
     * the audio output is resumed at once, inside the gesture. When it will not
     * start, `state.suspended` says so (see there).
     * Rejects when no interface element is mounted (see `mount()`).
     */
    play = async (clip?: ClipInput, options: Omit<LoadOptions, 'autoplay'> = {}): Promise<boolean> => {
        this._requireInterface();
        if (clip === undefined) {
            const woke = this._wake(false);
            const resumed = this._source.resume();
            this._watchStart(woke, resumed);
            await resumed;
            return this._state.isPlaying;
        }
        if (this._disposed) return false;
        const info = normalizeClip(clip);
        const woke = this._wake(true);
        const started = this._source.isLoaded(info) && (info.manifest !== null) === (this._source.kind === 'segmented')
            ? this._source.restart(options.startAt ?? 0)
            : this._sourceFor(info).load(info, options.startAt, true);
        this._watchStart(woke, started);
        return started;
    };

    pause = async (): Promise<void> => this._source.pause();

    toggle = async (): Promise<void> => {
        if (this._state.isPlaying) {
            await this.pause();
            return;
        }
        await this.play();
    };

    stop = (): void => this._source.stop();

    seek = async (time: number): Promise<void> => this._source.seek(time);

    /**
     * Loop a range (seconds) or clear the loop with null. A whole clip snaps
     * the boundaries to zero crossings of stem A (stem B reuses them); a
     * prepared clip snaps them where the audio is in memory.
     */
    setLoop = (range: LoopRange | null): void => {
        const valid = range && Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start
            ? range
            : null;
        this._source.setLoop(valid);
    };

    setPauseMode = (mode: PauseMode): void => {
        this._update({ pauseMode: mode });
    };

    // -----------------------------------------------------------------------
    // Processing
    // -----------------------------------------------------------------------

    /** High-pass cutoff in Hz; 0 bypasses the filter. */
    setHighPass = (hz: number): void => {
        const value = normalizeHighPassHz(hz);
        const effect = this._builtin('highpass');
        if (effect) this._setEffectParam(effect, 'hz', value);
        else this._updateProcessing({ highPassHz: value });
    };

    /** Compressor amount 0..1. */
    setCompression = (amount: number): void => {
        const value = clamp01(amount);
        const effect = this._builtin('dynamics');
        if (effect) this._setEffectParam(effect, 'amount', value);
        else this._updateProcessing({ compression: value });
    };

    /** Output gain in dB (-24..+24); -Infinity mutes. */
    /**
     * Gain after all processing, before the -0.01 dBFS ceiling, in dB
     * (-24..+24; -Infinity mutes), ramped over 20 ms. A boost meets the
     * ceiling, the last stage; the previews show it.
     */
    setOutputGain = (db: number): void => {
        const value = normalizeOutputGainDb(db); // may be -Infinity (mute)
        this._output?.setOutputGain(outputGainDbToGain(value));
        this._updateProcessing({ outputGainDb: value });
    };

    /**
     * Gain before all processing (high-pass, compressor, plugins), in dB
     * (-24..+24; -Infinity mutes), ramped over 20 ms. It drives the compressor
     * and the effects: +6 dB in compresses harder. The previews show it.
     */
    setInputGain = (db: number): void => {
        const value = normalizeInputGainDb(db);
        this._output?.setInputGain(outputGainDbToGain(value));
        this._updateProcessing({ inputGainDb: value });
    };

    /** Linear crossfade between stem A (0) and stem B (1). Fetches stem B on first use. */
    setMix = (mix: number): void => {
        const value = clamp01(mix);
        this._updateProcessing({ mix: value });
        this._source.setMix(value);
    };

    /**
     * Change the speed, keeping the position. It changes at once in the engine's
     * realtime stretch, keeping the pitch (where the stretch is not available,
     * `state.capabilities.canPreservePitch` is false and the pitch follows). With
     * an offline strategy a whole clip prepares the variant in the background and
     * switches at the live position (latest request wins).
     */
    setSpeed = async (speed: number): Promise<void> => this._source.setSpeed(normalizeSpeed(speed));

    /** Set several processing values at once. */
    setProcessing = (patch: Partial<ProcessingState>): void => {
        if (patch.inputGainDb !== undefined) this.setInputGain(patch.inputGainDb);
        if (patch.highPassHz !== undefined) this.setHighPass(patch.highPassHz);
        if (patch.compression !== undefined) this.setCompression(patch.compression);
        if (patch.outputGainDb !== undefined) this.setOutputGain(patch.outputGainDb);
        if (patch.mix !== undefined) this.setMix(patch.mix);
        if (patch.speed !== undefined) void this.setSpeed(patch.speed);
    };

    /**
     * Install (or remove) stem B for the current clip (overrides `srcB` and
     * `loadB`). Resolves true when installed; false for prepared clips, whose
     * stems come from the manifest (see `setStem()`).
     */
    setSourceB = async (input: AudioInput | null): Promise<boolean> => this._source.setSourceB(input);

    /**
     * Re-read a prepared clip's manifest, for hosts that replace a published
     * manifest (a newer revision). A stem B that is ready in it becomes
     * mixable at once, without a reload. Manifests are normally read once, as
     * published (B is made with A by prepareAudio). Nothing polls unless the
     * host opts in with segmented.pollStemsMs.
     */
    refreshManifest = async (): Promise<void> => {
        if (this._source.kind === 'segmented') await this._segmentedSource?.refreshManifest();
    };

    /**
     * Choose which stem of a prepared clip the A/B knob blends with (its key
     * in the manifest's `stems`; null for the default: `b`, else the first
     * ready stem). One stem is active at a time; the mix position is kept.
     * Returns false when no prepared clip is loaded or its manifest has no
     * such stem. To choose before loading, pass it with the clip:
     * `play({ manifest, stem })`.
     */
    setStem = (key: string | null): boolean => {
        if (this._source.kind !== 'segmented' || !this._segmentedSource) return false;
        return this._segmentedSource.setStem(key);
    };

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    /**
     * Stop playback and release every audio node this player created. The
     * shared AudioContext stays open for other players. A disposed player
     * ignores load/play until `reactivate()` is called (useAudioPlayer does
     * that on mount, which keeps React StrictMode's mount/unmount/mount cycle
     * working).
     */
    dispose = (): void => {
        this._disposed = true;
        this._bufferSource.dispose();
        this._segmentedSource?.dispose();
        this._source = this._bufferSource;
        this._outputGeneration += 1;
        this._output?.dispose();
        this._output = null;
        this._outputPromise = null;
        this._unsubscribeEngine?.();
        this._unsubscribeEngine = null;
        this._engine = null;
        this._startId += 1;
        this._setState(this._initialState(this._state.processing, this._state.pauseMode));
    };

    /** Undo dispose(): the next load/play rebuilds the audio graph. */
    reactivate = (): void => {
        this._disposed = false;
        this._bufferSource.reactivate();
        this._segmentedSource?.reactivate();
    };

    get disposed(): boolean {
        return this._disposed;
    }

    // -----------------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------------

    /** The source for `clip`; switching sources stops and unloads the other one. */
    private _sourceFor(clip: ClipInfo): PlaybackSource {
        let next: PlaybackSource;
        if (clip.manifest !== null) {
            this._segmentedSource ??= new SegmentedSource(this._host, this._options.segmented);
            next = this._segmentedSource;
        } else {
            next = this._bufferSource;
        }
        if (next !== this._source) {
            this._source.unload();
            this._source = next;
        }
        if (this._state.sourceKind !== next.kind || this._state.capabilities !== next.capabilities) {
            this._update({
                sourceKind: next.kind,
                capabilities: next.capabilities,
                ...(next.kind === 'buffer' ? { manifest: null, stem: null, prepared: null, buffering: false } : {}),
            });
        }
        return next;
    }

    /** The shared engine and the output chain, built once (and again after dispose). */
    private _ensureOutput(): Promise<SourceOutput | null> {
        if (this._disposed) return Promise.resolve(null);
        if (this._output && this._engine?.context) {
            return Promise.resolve({ engine: this._engine, ctx: this._engine.context, input: this._output.input });
        }
        if (!this._outputPromise) {
            const generation = this._outputGeneration;
            this._outputPromise = (async () => {
                const engine = AudioEngine.getInstance();
                const ok = await engine.initialize({ sampleRate: this._options.sampleRate, latencyHint: this._options.latencyHint });
                const ctx = engine.context;
                if (!ok || !ctx || generation !== this._outputGeneration || this._disposed) return null;
                const chain = new EffectChain(ctx, (id, message) => this._onEffectError(id, message), dbToGain(LIMITER_CEILING_DB));
                // A failed effect comes back failed: not instantiated again, kept out of the signal.
                this._state.effects.forEach((e, i) => chain.add(e.id, e.plugin, e.params, e.bypassed || !!e.error, i, !!e.error));
                chain.setInputGain(outputGainDbToGain(this._state.processing.inputGainDb));
                chain.setOutputGain(outputGainDbToGain(this._state.processing.outputGainDb));
                this._engine = engine;
                this._output = chain;
                this._unsubscribeEngine?.();
                this._unsubscribeEngine = engine.subscribe(() => this._onEngineChange());
                this._update({ audioContext: ctx });
                return { engine, ctx, input: chain.input };
            })().finally(() => {
                if (generation === this._outputGeneration) this._outputPromise = null;
            });
        }
        return this._outputPromise;
    }

    /**
     * Resume the shared AudioContext now, inside the caller's user gesture
     * (`create`: make it first when there is none yet). The sources resume it
     * again before they start, but after a download or a decode, which can fall
     * outside the gesture's activation (iOS Safari): the context then stays
     * suspended and nothing plays.
     */
    private _wake(create: boolean): Promise<boolean> {
        if (this._disposed) return Promise.resolve(false);
        // Builds the context synchronously; the rest of the output follows.
        if (create) void this._ensureOutput().catch(() => null);
        const engine = AudioEngine.getInstance();
        return engine.context ? engine.resume() : Promise.resolve(false);
    }

    /**
     * Once a play request and the resume made for it have settled: when nothing
     * plays because the output would not start, say so in `state.suspended`
     * instead of failing silently. A resume that never settles (a browser that
     * holds it until a gesture) is caught after a while.
     */
    private _watchStart(woke: Promise<boolean>, started: Promise<unknown>): void {
        const id = ++this._startId;
        const settled = Promise.all([woke, started]).catch(() => undefined);
        const timeout = new Promise<void>((resolve) => setTimeout(resolve, START_WATCH_MS));
        void Promise.race([settled, timeout]).then(() => {
            if (id !== this._startId || this._disposed || this._state.isPlaying) return;
            const state = AudioEngine.getInstance().context?.state as string | undefined;
            if (state === 'suspended' || state === 'interrupted') this._update({ suspended: 'blocked' });
        });
    }

    /**
     * The shared context changed state. While playing, 'interrupted' (a call or
     * Siri on iOS) or a 'suspended' nobody asked for (the player never suspends
     * it) stopped the sound and froze the clock: pause through the source,
     * which keeps the position (as any pause does in its pause mode), and say
     * so. Running again, the note clears; playback waits for play().
     */
    private _onEngineChange(): void {
        const state = this._engine?.context?.state as string | undefined;
        if (state === 'running') {
            if (this._state.suspended) this._update({ suspended: null });
            return;
        }
        if ((state === 'interrupted' || state === 'suspended') && this._state.isPlaying) {
            void this._source.pause();
            this._update({ suspended: 'interrupted' });
        }
    }

    private _initialState(processing: ProcessingState, pauseMode: PauseMode): AudioPlayerState {
        return {
            clipId: null,
            src: null,
            status: 'idle',
            progress: 0,
            error: null,
            isPlaying: false,
            suspended: null,
            currentTime: 0,
            duration: 0,
            ended: false,
            loop: null,
            pauseMode,
            playbackStartPoint: 0,
            startedAt: null,
            playRequestId: this._state?.playRequestId ?? 0,
            processing,
            mixLaw: this._options.mixLaw ?? 'crossfade',
            pendingSpeed: null,
            statusB: 'unavailable',
            buffer: null,
            bufferB: null,
            audioContext: null,
            sourceKind: null,
            capabilities: DEFAULT_CAPABILITIES,
            manifest: null,
            stem: null,
            buffering: false,
            prepared: null,
            effects: this._state?.effects ?? defaultEffects(processing),
            effectsLatencyFrames: this._state?.effectsLatencyFrames ?? 0,
            previewCoverage: this._state?.previewCoverage ?? { waveform: true, spectrogram: true, overview: true, missing: [] },
        };
    }

    private _updateProcessing(patch: Partial<ProcessingState>): void {
        this._update({ processing: { ...this._state.processing, ...patch } });
    }

    private _update(patch: Partial<AudioPlayerState>): void {
        // Playing again ends a hold of the output.
        const resumed = patch.isPlaying === true && this._state.suspended !== null && patch.suspended === undefined;
        this._setState({ ...this._state, ...patch, ...(resumed ? { suspended: null } : {}) });
    }

    private _setState(next: AudioPlayerState): void {
        this._state = next;
        for (const listener of [...this._storeListeners]) listener();
        this._emit('statechange', next);
    }

    private _emit<E extends AudioPlayerEvent>(event: E, payload: AudioPlayerEventMap[E]): void {
        const listeners = this._eventListeners.get(event);
        if (!listeners || listeners.size === 0) return;
        for (const listener of [...listeners]) {
            try {
                (listener as Listener<AudioPlayerEventMap[E]>)(payload);
            } catch (error) {
                console.error(`[AudioPlayer] "${event}" listener threw`, error);
            }
        }
    }
}

/** The built-in effects, from the initial processing values. */
function defaultEffects(processing: ProcessingState): EffectState[] {
    return [
        { id: 'highpass', plugin: highPassPlugin, params: { hz: processing.highPassHz }, bypassed: false, error: null },
        { id: 'dynamics', plugin: dynamicsPlugin, params: { amount: processing.compression }, bypassed: false, error: null },
    ];
}

/** Create a headless player. Equivalent to `new AudioPlayerCore(options)`. */
export function createAudioPlayer(options?: AudioPlayerOptions): AudioPlayerCore {
    return new AudioPlayerCore(options);
}
