import { AudioEngine, Mixer, Track, type LoopRange, type TrackState } from './engine';
import type { PlaybackTarget } from './engine/Track';
import {
    DSPChain,
    createCompressor,
    createDynamicsWorklet,
    createHighPass,
    createLimiter,
    createOutputGain,
    type CompressorNode,
    type DynamicsWorkletNode,
    type HighPassNode,
    type OutputGainNode,
} from './dsp';
import { dbToGain } from './dsp/compression';
import {
    DEFAULT_PROCESSING,
    DEFAULT_SPEEDS,
    SPEED_MIN,
    SPEED_MAX,
    LIMITER_CEILING_DB,
    clamp01,
    mixGains,
    normalizeHighPassHz,
    normalizeOutputGainDb,
    normalizeSpeed,
    outputGainDbToGain,
    type MixLaw,
    type ProcessingState,
} from './controls';
import { BufferLoader } from './loader/BufferLoader';
import { StretchService } from './stretch/StretchService';
import { vocoderStretcher, type StretchStrategy } from './stretch/strategies';
import { setAudioCacheBudget } from './cache/pcmCache';
import { bindAttribution, type InfoButtonMode } from '../attribution';

// ---------------------------------------------------------------------------
// AudioPlayer — the headless player: one clip on stem A, an optional stem B
// mixed with it, pitch-preserving speed, loop, and a DSP chain on the master bus.
// ---------------------------------------------------------------------------
//
// Graph (per player, on the page-wide AudioContext):
//
//   Track "A" ────────┐
//                     ├─ sum ─ master ─ high-pass ─ dynamics ─ analyser ─ destination
//   Track "B" ────────┘                 (24 dB/oct)  (comp + gain + ceiling)
//
// Stem B is any second recording, sample-aligned with A and started on the
// same AudioContext clock. A linear crossfade avoids a +3 dB midpoint boost for
// identical, aligned tracks. It does not loudness-match different recordings.
//
// All audio resources are created lazily on the first load/play, which keeps
// construction free (SSR, React StrictMode double-render).

/** Anything that can be played: a URL, encoded bytes, a Blob, or decoded PCM. */
export type AudioInput = string | ArrayBuffer | AudioBuffer | Blob;

export interface ClipSource {
    src: AudioInput;
    /** Stem B: a second recording, sample-aligned with `src` (stem A). */
    srcB?: AudioInput | null;
    /** Stable identity. Defaults to `src` when it is a string, otherwise an auto id. */
    id?: string;
}

export type ClipInput = AudioInput | ClipSource;

export interface ClipInfo {
    id: string;
    src: AudioInput;
    srcB: AudioInput | null;
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
     * Time-stretch backend. Default: the built-in phase vocoder in a worker.
     * 'native' (or `nativeStretcher`) uses playbackRate, which changes pitch.
     * For Rubber Band, pass `rubberbandStretcher()` from the optional `./stretch-rubberband` entry.
     */
    stretcher?: StretchStrategy | 'native';
    /** Speeds offered by UIs; also the default prewarm set. Default [1, 1.25, 1.5, 2]. */
    speeds?: readonly number[];
    /**
     * Render speed variants in the background right after a clip loads, so a
     * speed changes usually avoid preparation waits. true = `speeds` except 1.
     * The selected speed is always rendered first. Default true.
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
    /** Extra fetch() options for URL sources (credentials, headers...). */
    fetchOptions?: RequestInit;
    /**
     * Shared byte budget for decoded audio and speed variants (all players on
     * the page share one cache). Default 150 MiB. Not a total memory cap.
     */
    cacheBudgetBytes?: number;
    /** Sample rate of the shared AudioContext; only the first player to start decides. Default 48000. */
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
     * devices without right-click only. Right-click on the player opens the menu either way.
     * Mark an element inside your interface with `data-rtd-credit` to put the button there;
     * otherwise it sits over the interface element's top-right corner.
     */
    infoButton?: InfoButtonMode;
}

export type PlayerStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * 'unavailable' — the clip has no stem B source and there is no loader;
 * 'idle' — available but not fetched yet; then 'loading' / 'ready' / 'error'.
 */
export type StatusB = 'unavailable' | 'idle' | 'loading' | 'ready' | 'error';

export interface AudioPlayerState {
    clipId: string | null;
    /** The clip's URL when it was loaded from one. */
    src: string | null;
    status: PlayerStatus;
    /** Download progress 0..1 while loading (NaN without Content-Length). */
    progress: number;
    error: Error | null;
    isPlaying: boolean;
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
}

export interface AudioPlayerEventMap {
    statechange: AudioPlayerState;
    timeupdate: number;
    ended: { clipId: string | null };
    load: { clipId: string; duration: number };
    error: Error;
    bload: { clipId: string };
    berror: Error;
}

export type AudioPlayerEvent = keyof AudioPlayerEventMap;

export interface LoadOptions {
    /** Start position in seconds. Default 0. */
    startAt?: number;
    /** Start playing as soon as the clip is decoded. Default false for load(), true for play(). */
    autoplay?: boolean;
}

const SYNC_LOOKAHEAD_SECONDS = 0.015;
const RETRY_B_MS = 3000;

let autoClipId = 0;

function clampTime(time: number, duration: number): number {
    const normalized = Number.isFinite(time) ? Math.max(0, time) : 0;
    if (duration <= 0) return normalized;
    return Math.min(normalized, Math.max(0, duration - 0.001));
}

function isClipSource(input: ClipInput): input is ClipSource {
    return typeof input === 'object'
        && input !== null
        && !(input instanceof ArrayBuffer)
        && !(typeof AudioBuffer !== 'undefined' && input instanceof AudioBuffer)
        && !(typeof Blob !== 'undefined' && input instanceof Blob)
        && 'src' in input;
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
    if (isClipSource(input)) {
        return {
            id: input.id ?? defaultClipId(input.src),
            src: input.src,
            srcB: input.srcB ?? null,
        };
    }
    return { id: defaultClipId(input), src: input, srcB: null };
}

function normalizeProcessing(partial?: Partial<ProcessingState>): ProcessingState {
    const merged = { ...DEFAULT_PROCESSING, ...partial };
    return {
        highPassHz: normalizeHighPassHz(merged.highPassHz),
        compression: clamp01(merged.compression),
        outputGainDb: normalizeOutputGainDb(merged.outputGainDb),
        speed: normalizeSpeed(merged.speed),
        mix: clamp01(merged.mix),
    };
}

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

function isAbort(error: unknown): boolean {
    return (error as { name?: string } | null)?.name === 'AbortError';
}

type Listener<T> = (payload: T) => void;

export class AudioPlayerCore {
    private readonly _options: AudioPlayerOptions;
    private readonly _speeds: readonly number[];
    private readonly _prewarmSpeeds: readonly number[];
    private readonly _stretch: StretchService | null;
    private readonly _loaderB: BufferLoader;

    private _state: AudioPlayerState;
    private _storeListeners = new Set<() => void>();
    private _eventListeners = new Map<AudioPlayerEvent, Set<Listener<never>>>();

    private _generation = 0;
    private _loadRequestId = 0;
    private _speedRequestId = 0;
    private _playIntent = false;
    private _pendingPlaybackOffset: number | null = null;
    private _disposed = false;
    private _initPromise: Promise<boolean> | null = null;

    private _engine: AudioEngine | null = null;
    private _mixer: Mixer | null = null;
    private _trackA: Track | null = null;
    private _trackB: Track | null = null;
    private _dsp: DSPChain | null = null;
    private _highPass: HighPassNode | null = null;
    private _compressor: Pick<CompressorNode | DynamicsWorkletNode, 'setAmount'> | null = null;
    private _outputGain: Pick<OutputGainNode | DynamicsWorkletNode, 'setGain'> | null = null;
    private _unsubscribeTrack: (() => void) | null = null;

    private _clip: ClipInfo | null = null;
    private _playRequestId = 0;
    private _requestIdB = 0;
    private _loadedBFor: string | null = null;
    private _retryBAt = 0;
    private _abortControllerB: AbortController | null = null;
    /** Settles once stem A of the clip being loaded is in place (true) or never will be (false). */
    private _readyA: { clipId: string; done: Promise<boolean>; settle: (ok: boolean) => void } | null = null;
    private _interfaces = new Map<HTMLElement, number>();

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

        const strategy = options.stretcher === 'native' ? null : options.stretcher ?? vocoderStretcher;
        this._stretch = strategy ? StretchService.forStrategy(strategy) : null;
        this._loaderB = new BufferLoader({ fetchOptions: options.fetchOptions });

        if (typeof options.cacheBudgetBytes === 'number') {
            setAudioCacheBudget(options.cacheBudgetBytes);
        }

        this._state = this._initialState(normalizeProcessing(options.processing), options.pauseMode ?? 'pause');
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

    /** Whether pitch-preserving stretch is available (false for the native strategy or when workers are blocked). */
    get stretchAvailable(): boolean {
        return !!this._stretch?.available;
    }

    /** Live playback position in seconds, computed from the AudioContext clock. */
    getCurrentTime = (): number => this._trackA?.currentTime ?? this._state.currentTime;

    /** Post-DSP analyser node for custom visualisations (null until the first load). */
    get analyser(): AnalyserNode | null {
        return this._mixer?.analyser ?? null;
    }

    get audioContext(): AudioContext | null {
        return this._engine?.context ?? null;
    }

    // -----------------------------------------------------------------------
    // Transport
    // -----------------------------------------------------------------------

    /**
     * Load a clip without playing it (unless `autoplay`). Resolves true once
     * decoded, false on failure or when superseded by another load.
     */
    load = async (clip: ClipInput, options: LoadOptions = {}): Promise<boolean> => {
        if (options.autoplay) this._requireInterface();
        return this._loadClip(normalizeClip(clip), options.startAt, options.autoplay ?? false);
    };

    /**
     * Without arguments: resume the current clip.
     * With a clip: play it from `startAt` (default 0). Passing the clip that is
     * already loaded restarts it without reloading.
     * Must be called from a user gesture the first time (browser autoplay policy).
     * Rejects when no interface element is mounted (see `mount()`).
     */
    play = async (clip?: ClipInput, options: Omit<LoadOptions, 'autoplay'> = {}): Promise<boolean> => {
        this._requireInterface();
        if (clip === undefined) {
            await this._resume();
            return this._state.isPlaying;
        }

        const info = normalizeClip(clip);
        if (this._clip && info.id === this._clip.id && this._trackA?.buffer) {
            return this._restart(options.startAt ?? 0);
        }
        return this._loadClip(info, options.startAt, true);
    };

    pause = async (): Promise<void> => {
        this._playIntent = false;
        this._pendingPlaybackOffset = null;
        this._playRequestId += 1;
        this._speedRequestId += 1;
        this._update({ pendingSpeed: null });
        const trackA = this._trackA;
        const trackB = this._trackB;
        if (!trackA) return;
        trackA.setPlaybackRate(this._state.processing.speed);
        trackB?.setPlaybackRate(this._state.processing.speed);

        if (this._state.pauseMode === 'reset') {
            const resetTime = clampTime(this._state.playbackStartPoint, trackA.duration);
            trackA.stop();
            trackB?.stop();
            await trackA.seek(resetTime);
            if (trackB?.buffer) {
                await trackB.seek(resetTime);
            }
            this._update({
                isPlaying: false,
                currentTime: resetTime,
                startedAt: null,
                ended: false,
            });
            return;
        }

        trackA.pause();
        trackB?.pause();
        this._update({
            isPlaying: false,
            currentTime: trackA.currentTime,
            startedAt: null,
            ended: false,
        });
    };

    toggle = async (): Promise<void> => {
        if (this._state.isPlaying) {
            await this.pause();
            return;
        }
        this._requireInterface();
        await this._resume();
    };

    stop = (): void => {
        this._playIntent = false;
        this._pendingPlaybackOffset = null;
        this._playRequestId += 1;
        this._speedRequestId += 1;
        this._trackA?.setPlaybackRate(this._state.processing.speed);
        this._trackB?.setPlaybackRate(this._state.processing.speed);
        this._trackA?.stop();
        this._trackB?.stop();
        this._update({
            isPlaying: false,
            currentTime: 0,
            startedAt: null,
            pendingSpeed: null,
            ended: false,
        });
    };

    seek = async (time: number): Promise<void> => {
        const requestId = ++this._playRequestId;
        this._speedRequestId += 1;
        this._update({ pendingSpeed: null });
        const trackA = this._trackA;
        const trackB = this._trackB;
        if (!trackA?.buffer) return;
        this._playIntent = trackA.state.playState === 'playing';
        this._pendingPlaybackOffset = null;
        trackA.setPlaybackRate(this._state.processing.speed);
        trackB?.setPlaybackRate(this._state.processing.speed);

        const clamped = clampTime(time, trackA.duration);

        if (trackA.state.playState === 'playing' && trackB?.buffer) {
            await this._startSynchronized(clamped);
        } else {
            await trackA.seek(clamped);
            if (trackB?.buffer) {
                await trackB.seek(clampTime(clamped, trackB.duration || trackA.duration));
            }
        }

        if (requestId !== this._playRequestId) return;
        this._update({
            currentTime: clamped,
            playbackStartPoint: clamped,
            startedAt: trackA.state.playState === 'playing' ? trackA.startedAt : null,
            ended: false,
        });
    };

    /**
     * Loop a range (seconds) or clear the loop with null. Boundaries are
     * snapped to zero crossings of stem A to avoid clicks; stem B reuses
     * the same boundaries so both stay in lockstep.
     */
    setLoop = (range: LoopRange | null): void => {
        const trackA = this._trackA;
        const trackB = this._trackB;
        const valid = range && Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start
            ? range
            : null;

        if (!trackA) {
            this._update({ loop: valid });
            return;
        }

        trackA.setLoopRangeSnapped(valid);
        const snapped = trackA.state.loopRange;
        trackB?.setLoopRange(snapped);

        this._update({ loop: snapped });

        // A loop set behind the playhead: browsers differ on what a source does when
        // its loop ends before the playhead, so jump to its start ourselves, both
        // stems together. A loop ahead plays up to its end and loops from there.
        if (snapped && trackA.state.playState === 'playing' && trackA.currentTime >= snapped.end) {
            void this.seek(snapped.start);
        }
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
        this._highPass?.setFrequency(value);
        this._updateProcessing({ highPassHz: value });
    };

    /** Compressor amount 0..1. */
    setCompression = (amount: number): void => {
        const value = clamp01(amount);
        this._compressor?.setAmount(value);
        this._updateProcessing({ compression: value });
    };

    /** Output gain in dB (-24..+24); -Infinity mutes. */
    setOutputGain = (db: number): void => {
        const value = normalizeOutputGainDb(db);
        this._outputGain?.setGain(outputGainDbToGain(value));
        this._updateProcessing({ outputGainDb: value });
    };

    /** Linear crossfade between stem A (0) and stem B (1). Fetches stem B on first use. */
    setMix = (mix: number): void => {
        const value = clamp01(mix);
        this._applyMix(value);
        this._updateProcessing({ mix: value });
        if (value > 0) {
            void this._maybeLoadB();
        }
    };

    /** Prepare a speed in the background, then switch at the live position. Latest request wins. */
    setSpeed = async (speed: number): Promise<void> => {
        const normalized = normalizeSpeed(speed);
        const requestId = ++this._speedRequestId;
        const transportId = this._playRequestId;
        const generation = this._generation;
        const trackA = this._trackA;
        const trackB = this._trackB;
        const buffer = trackA?.buffer;
        const isCurrent = () => requestId === this._speedRequestId
            && transportId === this._playRequestId && generation === this._generation
            && !this._disposed && trackA === this._trackA && buffer === trackA?.buffer;

        if (!trackA || !buffer) {
            trackA?.setPlaybackRate(normalized);
            trackB?.setPlaybackRate(normalized);
            this._updateProcessing({ speed: normalized });
            this._update({ pendingSpeed: null });
            return;
        }

        this._update({ pendingSpeed: normalized });
        const bufferB = trackB?.buffer;
        const targets = await Promise.all([
            trackA.preparePlaybackTarget(normalized),
            trackB?.buffer ? trackB.preparePlaybackTarget(normalized) : Promise.resolve(null),
        ]);
        if (!isCurrent()) return;
        if (trackB?.buffer && trackB.buffer !== bufferB) {
            targets[1] = await trackB.preparePlaybackTarget(normalized);
            if (!isCurrent()) return;
        }
        if (!targets[0]) {
            this._update({ pendingSpeed: null });
            return;
        }
        const wasPlaying = trackA.state.playState === 'playing';
        const resumePoint = this._pendingPlaybackOffset ?? trackA.currentTime;
        const oldRate = trackA.playbackRate;
        trackA.setPlaybackRate(normalized);
        trackB?.setPlaybackRate(normalized);
        if (wasPlaying || this._playIntent) {
            const started = await this._startSynchronized(resumePoint, targets, wasPlaying ? oldRate : undefined);
            if (!isCurrent()) return;
            if (!started) {
                trackA.setPlaybackRate(this._state.processing.speed);
                trackB?.setPlaybackRate(this._state.processing.speed);
                this._update({ pendingSpeed: null });
                return;
            }
        }
        if (!isCurrent()) return;
        this._update({
            pendingSpeed: null,
            processing: { ...this._state.processing, speed: normalized },
            currentTime: trackA.currentTime,
            startedAt: trackA.state.playState === 'playing' ? trackA.startedAt : null,
        });
    };

    /** Set several processing values at once. */
    setProcessing = (patch: Partial<ProcessingState>): void => {
        if (patch.highPassHz !== undefined) this.setHighPass(patch.highPassHz);
        if (patch.compression !== undefined) this.setCompression(patch.compression);
        if (patch.outputGainDb !== undefined) this.setOutputGain(patch.outputGainDb);
        if (patch.mix !== undefined) this.setMix(patch.mix);
        if (patch.speed !== undefined) void this.setSpeed(patch.speed);
    };

    /**
     * Install stem B for the current clip (overrides `srcB`
     * and `loadB`). Pass null to remove it. Resolves true when installed.
     */
    setSourceB = async (input: AudioInput | null): Promise<boolean> => {
        const clip = this._clip;
        if (!clip) return false;

        this._abortB();
        const requestId = ++this._requestIdB;

        if (input === null) {
            this._trackB?.unload();
            this._loadedBFor = clip.id;
            this._applyMix(this._state.processing.mix);
            this._update({ bufferB: null, statusB: 'unavailable' });
            return true;
        }

        const ready = await this._ensureInitialized();
        if (!ready || requestId !== this._requestIdB) return false;

        this._loadedBFor = clip.id;
        const controller = new AbortController();
        this._abortControllerB = controller;
        this._update({ statusB: 'loading' });
        try {
            const buffer = await this._decodeB(input, controller.signal);
            if (!buffer) return false;
            return await this._installB(clip.id, requestId, buffer);
        } catch (error) {
            if (isAbort(error) || controller.signal.aborted) return false;
            this._onErrorB(clip.id, error);
            return false;
        }
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
        this._playIntent = false;
        this._pendingPlaybackOffset = null;
        this._generation += 1;
        this._loadRequestId += 1;
        this._speedRequestId += 1;
        this._requestIdB += 1;
        this._disposed = true;
        this._playRequestId += 1;
        this._abortB();
        this._loaderB.abort();

        this._unsubscribeTrack?.();
        this._unsubscribeTrack = null;
        this._trackA?.dispose();
        this._trackB?.dispose();
        this._dsp?.dispose();
        this._mixer?.dispose();

        this._engine = null;
        this._mixer = null;
        this._trackA = null;
        this._trackB = null;
        this._dsp = null;
        this._highPass = null;
        this._compressor = null;
        this._outputGain = null;
        this._initPromise = null;
        this._clip = null;
        this._loadedBFor = null;

        this._setState(this._initialState(this._state.processing, this._state.pauseMode));
    };

    /** Undo dispose(): the next load/play rebuilds the audio graph. */
    reactivate = (): void => {
        this._disposed = false;
    };

    get disposed(): boolean {
        return this._disposed;
    }

    // -----------------------------------------------------------------------
    // Internal: graph
    // -----------------------------------------------------------------------

    private _ensureInitialized(): Promise<boolean> {
        if (this._disposed) return Promise.resolve(false);
        if (this._trackA && this._trackB && this._mixer) return Promise.resolve(true);
        if (!this._initPromise) {
            const generation = this._generation;
            this._initPromise = this._buildGraph(generation).finally(() => {
                if (generation === this._generation) this._initPromise = null;
            });
        }
        return this._initPromise;
    }

    private async _buildGraph(generation: number): Promise<boolean> {
        const engine = AudioEngine.getInstance();
        const initialized = await engine.initialize({ sampleRate: this._options.sampleRate, latencyHint: this._options.latencyHint });
        if (!initialized || generation !== this._generation || this._disposed) return false;

        const ctx = engine.context;
        if (!ctx) return false;

        const processing = this._state.processing;
        const trackOptions = { stretch: this._stretch, loader: { fetchOptions: this._options.fetchOptions } };
        const mixer = new Mixer(engine);
        const trackA = mixer.createTrack('A', trackOptions);
        const trackB = mixer.createTrack('B', trackOptions);
        trackA.setPlaybackRate(processing.speed);
        trackB.setPlaybackRate(processing.speed);
        trackB.setGain(0);

        const dspChain = new DSPChain(ctx);
        const highPass = createHighPass(ctx, processing.highPassHz);
        dspChain.add(highPass);

        let compressorControl: Pick<CompressorNode | DynamicsWorkletNode, 'setAmount'>;
        let outputGainControl: Pick<OutputGainNode | DynamicsWorkletNode, 'setGain'>;

        const buildNativeDynamics = () => {
            // Same signal path out of three native nodes: compressor, gain, and a
            // hard limiter at the ceiling.
            const compressor = createCompressor(ctx, processing.compression);
            const outputGain = createOutputGain(ctx, outputGainDbToGain(processing.outputGainDb));
            const limiter = createLimiter(ctx);
            dspChain.add(compressor);
            dspChain.add(outputGain);
            dspChain.add(limiter);
            compressorControl = compressor;
            outputGainControl = outputGain;
        };

        if (engine.workletAvailable) {
            try {
                // One worklet does compressor + gain + ceiling per sample, with
                // a detector that reacts faster than the applied gain.
                const dynamics = createDynamicsWorklet(ctx, {
                    amount: processing.compression,
                    outputGain: outputGainDbToGain(processing.outputGainDb),
                    ceilingGain: dbToGain(LIMITER_CEILING_DB),
                });
                dspChain.add(dynamics);
                compressorControl = dynamics;
                outputGainControl = dynamics;
            } catch (error) {
                console.warn('[AudioPlayer] Failed to create dynamics worklet, using native fallback', error);
                buildNativeDynamics();
            }
        } else {
            buildNativeDynamics();
        }

        if (mixer.masterGainNode && mixer.analyser) {
            mixer.masterGainNode.disconnect();
            mixer.masterGainNode.connect(dspChain.input);
            dspChain.output.connect(mixer.analyser);
        }

        this._engine = engine;
        this._mixer = mixer;
        this._trackA = trackA;
        this._trackB = trackB;
        this._dsp = dspChain;
        this._highPass = highPass;
        this._compressor = compressorControl!;
        this._outputGain = outputGainControl!;
        this._unsubscribeTrack = trackA.subscribe((trackState) => this._onTrackA(trackA, trackState));

        if (this._state.loop) {
            trackA.setLoopRangeSnapped(this._state.loop);
        }

        this._update({ audioContext: ctx });
        return true;
    }

    private _onTrackA(track: Track, trackState: TrackState): void {
        if (track !== this._trackA) return;

        if (trackState.ended) {
            this._playIntent = false;
            this._trackB?.stop();
        }

        const wasEnded = this._state.ended;
        const playing = trackState.playState === 'playing';
        this._update({
            isPlaying: playing,
            currentTime: trackState.currentTime,
            duration: trackState.duration,
            startedAt: playing ? track.startedAt : null,
            ended: trackState.ended,
        });
        this._emit('timeupdate', trackState.currentTime);
        if (!wasEnded && trackState.ended) {
            this._emit('ended', { clipId: this._state.clipId });
        }
    }

    // -----------------------------------------------------------------------
    // Internal: transport
    // -----------------------------------------------------------------------

    private async _loadClip(clip: ClipInfo, startAt: number | undefined, autoplay: boolean): Promise<boolean> {
        this._playIntent = autoplay;
        this._pendingPlaybackOffset = null;
        const generation = this._generation;
        const loadId = ++this._loadRequestId;
        const requestId = ++this._playRequestId;
        this._speedRequestId += 1;
        const isCurrent = () => loadId === this._loadRequestId && generation === this._generation && !this._disposed;
        const ready = await this._ensureInitialized();
        const trackA = this._trackA;
        const trackB = this._trackB;
        const ctx = this._engine?.context;
        if (!ready || !trackA || !trackB || !ctx || !isCurrent()) return false;
        trackA.unload();
        const requestedStart = Math.max(0, startAt ?? 0);

        this._abortB();
        this._requestIdB += 1;
        this._loadedBFor = null;
        this._retryBAt = 0;
        trackB.unload();
        this._clip = clip;

        this._update({
            clipId: clip.id,
            src: typeof clip.src === 'string' ? clip.src : null,
            status: 'loading',
            pendingSpeed: null,
            progress: 0,
            error: null,
            isPlaying: false,
            currentTime: requestedStart,
            duration: 0,
            ended: false,
            loop: null,
            playbackStartPoint: requestedStart,
            startedAt: null,
            playRequestId: requestId,
            statusB: this._hasSourceB(clip) ? 'idle' : 'unavailable',
            buffer: null,
            bufferB: null,
        });

        // Stem B is fetched beside stem A when it is wanted at once (a separation
        // mix, or prefetchB) rather than after it, so the two arrive in the time
        // of one. It is installed once A is in place.
        const readyA = this._expectA(clip.id);
        void this._maybeLoadB();

        let loaded = false;
        let failure: Error | null = null;
        if (typeof clip.src === 'string') {
            loaded = await trackA.load(clip.src, (progress) => {
                if (!isCurrent()) return;
                this._update({ progress: progress.progress });
            });
            if (!loaded) failure = trackA.loadError;
        } else {
            try {
                const decoded = await this._decode(clip.src, ctx);
                if (isCurrent()) {
                    trackA.setBuffer(decoded);
                    loaded = true;
                }
            } catch (error) {
                failure = toError(error);
            }
        }

        if (!isCurrent()) {
            readyA.settle(false);
            return false;
        }

        if (!loaded) {
            readyA.settle(false);
            if (failure) {
                this._update({ status: 'error', error: failure });
                this._emit('error', failure);
            }
            return false;
        }

        const startPoint = clampTime(requestedStart, trackA.duration);
        const transportCurrent = requestId === this._playRequestId;
        this._update({
            status: 'ready',
            progress: 1,
            duration: trackA.duration,
            buffer: trackA.buffer,
            bufferB: null,
            currentTime: transportCurrent ? startPoint : trackA.currentTime,
            playbackStartPoint: transportCurrent ? startPoint : this._state.playbackStartPoint,
        });
        readyA.settle(true);
        this._emit('load', { clipId: clip.id, duration: trackA.duration });
        this._prewarm(trackA);
        void this._maybeLoadB();

        if (requestId !== this._playRequestId) return true;
        if (!autoplay) {
            if (startPoint > 0) await trackA.seek(startPoint);
            return true;
        }

        const started = await this._startSynchronized(startPoint);
        if (!started || !isCurrent() || requestId !== this._playRequestId) return false;

        this._applyMix(this._state.processing.mix);
        this._update({
            isPlaying: true,
            currentTime: startPoint,
            playbackStartPoint: startPoint,
            startedAt: trackA.startedAt,
            ended: false,
        });
        return true;
    }

    private async _restart(startAt: number): Promise<boolean> {
        const trackA = this._trackA;
        const trackB = this._trackB;
        if (!trackA?.buffer || this._disposed) return false;
        this._playIntent = true;

        const target = clampTime(startAt, trackA.duration);
        const requestId = ++this._playRequestId;
        this._speedRequestId += 1;
        this._update({ pendingSpeed: null });
        trackA.setLoopRange(null);
        trackB?.setLoopRange(null);
        const started = await this._startSynchronized(target);
        if (!started || requestId !== this._playRequestId) return false;
        this._update({
            isPlaying: true,
            currentTime: target,
            loop: null,
            playbackStartPoint: target,
            playRequestId: this._playRequestId,
            startedAt: trackA.startedAt,
            ended: false,
        });
        return true;
    }

    private async _resume(): Promise<void> {
        const requestId = ++this._playRequestId;
        const trackA = this._trackA;
        if (!trackA?.buffer || this._disposed) return;
        this._playIntent = true;

        const startPoint = clampTime(trackA.currentTime, trackA.duration);
        const started = await this._startSynchronized(startPoint);
        if (!started || requestId !== this._playRequestId) return;

        this._update({
            isPlaying: true,
            currentTime: startPoint,
            playbackStartPoint: startPoint,
            startedAt: trackA.startedAt,
            ended: false,
        });
    }

    /**
     * Start both tracks at the same AudioContext time. Speed variants are
     * prepared first so neither track starts late while the other renders.
     */
    private async _startSynchronized(
        offset: number,
        prepared?: [PlaybackTarget | null, PlaybackTarget | null],
        followRate?: number,
    ): Promise<boolean> {
        const engine = this._engine;
        const trackA = this._trackA;
        const trackB = this._trackB;
        const ctx = engine?.context;
        const requestId = this._playRequestId;
        const speedId = this._speedRequestId;
        const generation = this._generation;
        const source = trackA?.buffer;
        const sourceB = trackB?.buffer;
        const isCurrent = () => !this._disposed && generation === this._generation
            && requestId === this._playRequestId && speedId === this._speedRequestId
            && source === trackA?.buffer;
        if (!engine || !trackA || !source || !ctx) return false;
        if (trackA.state.playState !== 'playing') this._pendingPlaybackOffset = offset;
        if (!await engine.resume() || !isCurrent()) return false;

        // Retain prepared buffers until start, even when the cache budget is zero.
        const targets = prepared ?? await Promise.all([
            trackA.preparePlaybackTarget(),
            sourceB ? trackB!.preparePlaybackTarget() : Promise.resolve(null),
        ]);
        if (!targets[0] || !isCurrent()) return false;
        // Stem B may arrive while stem A is preparing. Rebuild
        // the synchronized pair instead of losing the user's play request.
        if (sourceB !== trackB?.buffer) {
            return this._startSynchronized(offset, undefined, followRate);
        }
        if (sourceB && !targets[1]) return false;

        const startWhen = ctx.currentTime + SYNC_LOOKAHEAD_SECONDS;
        const liveOffset = followRate === undefined ? offset
            : trackA.currentTime + SYNC_LOOKAHEAD_SECONDS * followRate;
        const clampedOffset = clampTime(liveOffset, trackA.duration);
        const jobs = [trackA.play(clampedOffset, startWhen, targets[0])];
        if (sourceB && targets[1]) {
            jobs.push(trackB!.play(clampTime(clampedOffset, trackB!.duration), startWhen, targets[1]));
        }
        const results = await Promise.all(jobs);
        if (isCurrent()) this._pendingPlaybackOffset = null;
        return isCurrent() && results.every(Boolean);
    }

    /** Bring a freshly installed stem B to stem A's position. */
    private async _syncBToA(): Promise<boolean> {
        const engine = this._engine;
        const trackA = this._trackA;
        const trackB = this._trackB;
        const ctx = engine?.context;

        if (!engine || !ctx || !trackA || !trackB || !trackB.buffer) {
            return false;
        }

        const requestId = this._playRequestId;
        const idB = this._requestIdB;
        const speedId = this._speedRequestId;
        const ready = await engine.resume();
        if (!ready) return false;
        const target = await trackB.preparePlaybackTarget();
        if (!target || this._disposed || requestId !== this._playRequestId
            || idB !== this._requestIdB || speedId !== this._speedRequestId) return false;

        if (trackA.state.playState === 'playing') {
            const now = ctx.currentTime;
            const when = now + SYNC_LOOKAHEAD_SECONDS;
            const liveOffset = clampTime(
                trackA.currentTime + ((when - now) * trackA.playbackRate),
                trackA.duration,
            );
            return trackB.play(clampTime(liveOffset, trackB.duration || trackA.duration), when, target);
        }

        await trackB.seek(clampTime(trackA.currentTime, trackA.duration));
        return true;
    }

    private _prewarm(track: Track): void {
        if (this._prewarmSpeeds.length > 0) {
            track.primeSpeedVariants(this._prewarmSpeeds);
        }
    }

    // -----------------------------------------------------------------------
    // Internal: stem B
    // -----------------------------------------------------------------------

    private _hasSourceB(clip: ClipInfo): boolean {
        return clip.srcB !== null || typeof this._options.loadB === 'function';
    }

    private _applyMix(mix: number): void {
        const trackA = this._trackA;
        const trackB = this._trackB;
        if (!trackA || !trackB) {
            return;
        }

        if (!trackB.buffer) {
            trackA.setGain(1);
            trackB.setGain(0);
            return;
        }

        // Crossfade gains sum to one, which keeps identical aligned signals at
        // their level; separation plays both stems at full in the middle.
        const [gainA, gainB] = mixGains(mix, this._options.mixLaw);
        trackA.setGain(gainA);
        trackB.setGain(gainB);
    }

    private _abortB(): void {
        this._abortControllerB?.abort();
        this._abortControllerB = null;
    }

    /**
     * Fetch stem B for the current clip, at most once, and only when it is
     * wanted (mix > 0, or prefetch). Failures never touch stem A: it keeps
     * playing and the mix control simply has no effect.
     */
    private async _maybeLoadB(): Promise<void> {
        const clip = this._clip;
        if (!clip || this._disposed) return;
        if (this._state.processing.mix <= 0 && !this._options.prefetchB) return;
        if (this._loadedBFor === clip.id) return;
        if (Date.now() < this._retryBAt) return;
        if (!this._hasSourceB(clip)) return;

        this._loadedBFor = clip.id;
        const requestId = ++this._requestIdB;
        const controller = new AbortController();
        this._abortControllerB = controller;
        this._update({ statusB: 'loading' });

        try {
            let input: AudioInput | null | undefined = clip.srcB;
            if (input === null && this._options.loadB) {
                input = await this._options.loadB({ ...clip }, controller.signal);
            }
            if (controller.signal.aborted || requestId !== this._requestIdB) return;
            if (input === null || input === undefined) {
                this._update({ statusB: 'unavailable' });
                return;
            }

            const buffer = await this._decodeB(input, controller.signal);
            if (!buffer) return;
            if (!this._trackA?.buffer && !(await this._readyAFor(clip.id))) return;
            await this._installB(clip.id, requestId, buffer);
        } catch (error) {
            if (isAbort(error) || controller.signal.aborted) return;
            this._onErrorB(clip.id, error);
        }
    }

    private _expectA(clipId: string) {
        this._readyA?.settle(false);
        let settle: (ok: boolean) => void = () => undefined;
        const done = new Promise<boolean>((resolve) => { settle = resolve; });
        const ready = { clipId, done, settle };
        this._readyA = ready;
        return ready;
    }

    /** Whether stem A of `clipId` is, or comes to be, in place. */
    private _readyAFor(clipId: string): Promise<boolean> {
        const ready = this._readyA;
        if (ready && ready.clipId === clipId) return ready.done;
        return Promise.resolve(!!this._trackA?.buffer && this._clip?.id === clipId);
    }

    private _onErrorB(clipId: string, error: unknown): void {
        const err = toError(error);
        console.warn('[AudioPlayer] Stem B unavailable; stem A keeps playing', err);
        if (this._clip?.id !== clipId) return;
        // Allow a retry on a later mix change, but not on every mouse move.
        this._loadedBFor = null;
        this._retryBAt = Date.now() + RETRY_B_MS;
        this._trackB?.unload();
        this._applyMix(this._state.processing.mix);
        this._update({ statusB: 'error', bufferB: null });
        this._emit('berror', err);
    }

    private async _decodeB(input: AudioInput, signal: AbortSignal): Promise<AudioBuffer | null> {
        const ctx = this._engine?.context;
        if (!ctx) return null;

        if (typeof input === 'string') {
            const onAbort = () => this._loaderB.abort();
            signal.addEventListener('abort', onAbort, { once: true });
            try {
                const result = await this._loaderB.load(input, ctx);
                if (!result) {
                    if (signal.aborted) return null;
                    throw this._loaderB.lastError ?? new Error('Stem B failed to load');
                }
                return result.buffer;
            } finally {
                signal.removeEventListener('abort', onAbort);
            }
        }

        return this._decode(input, ctx);
    }

    private async _installB(clipId: string, requestId: number, decoded: AudioBuffer): Promise<boolean> {
        const trackB = this._trackB;
        const trackA = this._trackA;
        if (
            !trackB
            || !trackA
            || requestId !== this._requestIdB
            || this._clip?.id !== clipId
            || this._disposed
        ) {
            return false;
        }

        trackB.setBuffer(decoded);
        // setBuffer() resets the track; carry over stem A's loop so the
        // two tracks keep looping together.
        const loop = trackA.state.loopRange;
        if (loop) trackB.setLoopRange(loop);

        this._update({ bufferB: decoded, statusB: 'ready' });
        this._prewarm(trackB);

        await this._syncBToA();
        if (this._disposed || requestId !== this._requestIdB || this._clip?.id !== clipId) return false;
        this._applyMix(this._state.processing.mix);
        this._emit('bload', { clipId });
        return true;
    }

    private async _decode(input: Exclude<AudioInput, string>, ctx: BaseAudioContext): Promise<AudioBuffer> {
        if (typeof AudioBuffer !== 'undefined' && input instanceof AudioBuffer) {
            return input;
        }
        const bytes = input instanceof ArrayBuffer ? input : await (input as Blob).arrayBuffer();
        // decodeAudioData detaches its argument; keep the caller's bytes intact.
        return ctx.decodeAudioData(bytes.slice(0));
    }

    // -----------------------------------------------------------------------
    // Internal: state
    // -----------------------------------------------------------------------

    private _initialState(processing: ProcessingState, pauseMode: PauseMode): AudioPlayerState {
        return {
            clipId: null,
            src: null,
            status: 'idle',
            progress: 0,
            error: null,
            isPlaying: false,
            currentTime: 0,
            duration: 0,
            ended: false,
            loop: null,
            pauseMode,
            playbackStartPoint: 0,
            startedAt: null,
            playRequestId: this._playRequestId,
            processing,
            mixLaw: this._options.mixLaw ?? 'crossfade',
            pendingSpeed: null,
            statusB: 'unavailable',
            buffer: null,
            bufferB: null,
            audioContext: null,
        };
    }

    private _updateProcessing(patch: Partial<ProcessingState>): void {
        this._update({ processing: { ...this._state.processing, ...patch } });
    }

    private _update(patch: Partial<AudioPlayerState>): void {
        this._setState({ ...this._state, ...patch });
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

/** Create a headless player. Equivalent to `new AudioPlayerCore(options)`. */
export function createAudioPlayer(options?: AudioPlayerOptions): AudioPlayerCore {
    return new AudioPlayerCore(options);
}
