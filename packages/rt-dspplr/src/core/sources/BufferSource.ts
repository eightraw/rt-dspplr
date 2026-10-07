import type { AudioInput, ClipInfo } from '../AudioPlayer';
import { mixGains } from '../controls';
import { Mixer, Track, type LoopRange, type TrackState } from '../engine';
import type { PlaybackTarget } from '../engine/Track';
import type AudioEngine from '../engine/AudioEngine';
import { engineWindow } from '../engine/engineWindow';
import { loadStreamEngine, StreamEngine, type EngineStem } from '../engine/StreamEngine';
import { findZeroCrossing } from '../engine/zeroCrossing';
import { BufferLoader, checkClipLimits, type ClipLimits } from '../loader/BufferLoader';
import type { StretchService } from '../stretch/StretchService';
import type { PlaybackSource, SourceCapabilities, SourceHost } from './types';

// ---------------------------------------------------------------------------
// BufferSource — the whole clip decoded into an AudioBuffer.
//
// It plays through the stream engine, as prepared clips do: the decoded
// buffers are cut into segments and handed to the engine around the playhead,
// stem B beside stem A, and speed changes at once in the engine's realtime
// stretch (pitch kept).
//
//   decoded A ──┐ segments around the playhead
//   decoded B ──┴──────────────────────────────▶ stream engine ─▶ the core's output chain
//
// With an offline stretch strategy (Rubber Band), or where the engine cannot
// run (no AudioWorklet), it plays on two tracks instead, the player's
// original path: speed variants rendered off the main thread and switched at
// the live position.
//
//   Track "A" ──┐
//               ├─ Mixer sum ─▶ the core's output chain
//   Track "B" ──┘
//
// The tracks hold the decoded buffers on either path.
// ---------------------------------------------------------------------------

const SYNC_LOOKAHEAD_SECONDS = 0.015;
const RETRY_B_MS = 3000;
/** The engine path: segment length, segments held ahead of the playhead, and how often the window moves on. */
const SEGMENT_SECONDS = 5;
const AHEAD_SEGMENTS = 2;
const PUMP_MS = 40;

function clampTime(time: number, duration: number): number {
    const normalized = Number.isFinite(time) ? Math.max(0, time) : 0;
    if (duration <= 0) return normalized;
    return Math.min(normalized, Math.max(0, duration - 0.001));
}

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

function isAbort(error: unknown): boolean {
    return (error as { name?: string } | null)?.name === 'AbortError';
}

export interface BufferSourceSettings {
    /** An offline stretch strategy: the clip plays on tracks, its speeds rendered by it. */
    stretch: StretchService | null;
    prewarmSpeeds: readonly number[];
    /** The stream engine (when there is no offline strategy); `stretch` false: the pitch follows the speed. */
    engine: { stretch: boolean } | null;
}

/** A stream engine playing the current clip. */
interface EnginePath {
    engine: StreamEngine;
    /** The clip's rate (the engine runs at it). */
    rate: number;
    /** Segment starts and the total (length n + 1). */
    starts: number[];
    a: AudioBuffer;
    /** Stem B at the clip's rate, once installed. */
    b: AudioBuffer | null;
    playing: boolean;
    /** Where playback rests while not playing (frames). */
    pausedFrame: number;
    startedAt: number;
    loop: { start: number; end: number } | null;
}

export class BufferSource implements PlaybackSource {
    readonly kind = 'buffer' as const;
    private readonly _host: SourceHost;
    private readonly _stretch: StretchService | null;
    private readonly _prewarmSpeeds: readonly number[];
    private readonly _engineMode: { stretch: boolean } | null;
    private readonly _limits: ClipLimits;
    private readonly _loaderB: BufferLoader;
    private _eng: EnginePath | null = null;
    private _pumpTimer: ReturnType<typeof setInterval> | null = null;

    private _generation = 0;
    private _loadRequestId = 0;
    private _speedRequestId = 0;
    private _playIntent = false;
    private _pendingPlaybackOffset: number | null = null;
    /**
     * A clip is loading (from load() until its buffer is in place). Meanwhile
     * the transport records what the listener wants, and load() applies it:
     * `_playIntent` (play/pause) and `_pendingStart` (seek/stop).
     */
    private _loading = false;
    private _pendingStart: number | null = null;
    private _disposed = false;
    private _initPromise: Promise<boolean> | null = null;

    private _engine: AudioEngine | null = null;
    private _mixer: Mixer | null = null;
    private _trackA: Track | null = null;
    private _trackB: Track | null = null;
    private _unsubscribeTrack: (() => void) | null = null;

    private _clip: ClipInfo | null = null;
    private _playRequestId = 0;
    private _requestIdB = 0;
    private _loadedBFor: string | null = null;
    private _retryBAt = 0;
    private _abortControllerB: AbortController | null = null;
    /** Settles once stem A of the clip being loaded is in place (true) or never will be (false). */
    private _readyA: { clipId: string; done: Promise<boolean>; settle: (ok: boolean) => void } | null = null;

    constructor(host: SourceHost, settings: BufferSourceSettings) {
        this._host = host;
        this._stretch = settings.stretch;
        this._prewarmSpeeds = settings.prewarmSpeeds;
        this._engineMode = settings.engine;
        this._limits = { maxBytes: host.options.maxClipBytes, maxSeconds: host.options.maxClipSeconds };
        this._loaderB = new BufferLoader({ fetchOptions: host.options.fetchOptions, ...this._limits });
    }

    get capabilities(): SourceCapabilities {
        return {
            kind: 'buffer',
            canPreservePitch: this._eng ? this._eng.engine.stretch.ready : !!this._stretch?.available,
            canMixStemB: true,
            stems: [],
            exactWaveformPreview: true,
            spectrogram: true,
            loopSnapping: true,
        };
    }

    private get _state() {
        return this._host.getState();
    }

    private _update(patch: Parameters<SourceHost['update']>[0]): void {
        this._host.update(patch);
    }

    getCurrentTime(): number | null {
        const eng = this._eng;
        if (eng) return (eng.playing ? eng.engine.position() : eng.pausedFrame) / eng.rate;
        return this._trackA ? this._trackA.currentTime : null;
    }

    isLoaded(clip: ClipInfo): boolean {
        return !!this._clip && clip.id === this._clip.id && !!this._trackA?.buffer;
    }

    // -----------------------------------------------------------------------
    // Transport
    // -----------------------------------------------------------------------

    pause = async (): Promise<void> => {
        this._playIntent = false;
        this._pendingPlaybackOffset = null;
        // Still loading: the clip will not start once decoded (a resume asks again).
        if (this._loading) return;
        this._playRequestId += 1;
        this._speedRequestId += 1;
        this._update({ pendingSpeed: null });
        const eng = this._eng;
        if (eng) {
            let frame = Math.floor(eng.playing ? eng.engine.position() : eng.pausedFrame);
            if (this._state.pauseMode === 'reset') frame = this._frameOf(eng, this._state.playbackStartPoint);
            this._halt(eng);
            eng.engine.pause();
            if (this._state.pauseMode === 'reset') eng.engine.seek(frame);
            eng.pausedFrame = frame;
            this._update({ isPlaying: false, currentTime: frame / eng.rate, startedAt: null, ended: false });
            return;
        }
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
            this._update({ isPlaying: false, currentTime: resetTime, startedAt: null, ended: false });
            return;
        }

        trackA.pause();
        trackB?.pause();
        this._update({ isPlaying: false, currentTime: trackA.currentTime, startedAt: null, ended: false });
    };

    stop = (): void => {
        this._playIntent = false;
        this._pendingPlaybackOffset = null;
        if (this._loading) {
            // Once decoded, the clip waits at 0.
            this._pendingStart = 0;
            this._update({ isPlaying: false, currentTime: 0, playbackStartPoint: 0, startedAt: null, ended: false });
            return;
        }
        this._playRequestId += 1;
        this._speedRequestId += 1;
        const eng = this._eng;
        if (eng) {
            this._halt(eng);
            eng.engine.pause();
            eng.engine.seek(0);
            eng.pausedFrame = 0;
            this._update({ isPlaying: false, currentTime: 0, startedAt: null, pendingSpeed: null, ended: false });
            return;
        }
        this._trackA?.setPlaybackRate(this._state.processing.speed);
        this._trackB?.setPlaybackRate(this._state.processing.speed);
        this._trackA?.stop();
        this._trackB?.stop();
        this._update({ isPlaying: false, currentTime: 0, startedAt: null, pendingSpeed: null, ended: false });
    };

    seek = async (time: number): Promise<void> => {
        if (this._loading) {
            // Still loading: the clip starts here once decoded, and a pending
            // autoplay stands (taking a new request id would cancel it).
            const start = clampTime(time, 0);
            this._pendingStart = start;
            this._update({ currentTime: start, playbackStartPoint: start, ended: false });
            return;
        }
        const requestId = ++this._playRequestId;
        this._speedRequestId += 1;
        this._update({ pendingSpeed: null });
        const eng = this._eng;
        if (eng) {
            const target = clampTime(time, eng.a.duration);
            // Playing, or a start in flight: it plays on from the new point.
            if (eng.playing || this._playIntent) {
                await this._engStart(eng, target);
                if (requestId !== this._playRequestId) return;
            } else {
                eng.pausedFrame = this._frameOf(eng, target);
                eng.engine.seek(eng.pausedFrame);
            }
            this._update({ currentTime: target, playbackStartPoint: target, startedAt: eng.playing ? eng.startedAt : null, ended: false });
            return;
        }
        const trackA = this._trackA;
        const trackB = this._trackB;
        if (!trackA?.buffer) return;
        const playing = trackA.state.playState === 'playing';
        // A start still in flight (a speed variant rendering, the output resuming)
        // is not dropped by the seek: it starts again from the new point.
        const starting = !playing && this._playIntent;
        this._playIntent = playing || starting;
        this._pendingPlaybackOffset = null;
        trackA.setPlaybackRate(this._state.processing.speed);
        trackB?.setPlaybackRate(this._state.processing.speed);

        const clamped = clampTime(time, trackA.duration);

        if (starting || (playing && trackB?.buffer)) {
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

    setLoop = (range: LoopRange | null): void => {
        const eng = this._eng;
        if (eng) {
            const snapped = range ? BufferSource._snap(eng.a, range) : null;
            eng.loop = snapped ? { start: this._frameOf(eng, snapped.start), end: this._frameOf(eng, snapped.end) } : null;
            const position = this.getCurrentTime() ?? 0;
            eng.engine.setLoop(eng.loop);
            this._update({ loop: snapped });
            // A loop set behind the playhead: jump to its start (one ahead plays up to its end).
            if (snapped && eng.playing && position >= snapped.end) void this.seek(snapped.start);
            else this._feed(eng);
            return;
        }
        const trackA = this._trackA;
        const trackB = this._trackB;
        if (!trackA) {
            this._update({ loop: range });
            return;
        }

        trackA.setLoopRangeSnapped(range);
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

    setMix = (mix: number): void => {
        this._applyMix(mix);
        if (mix > 0) void this._maybeLoadB();
    };

    setSpeed = async (normalized: number): Promise<void> => {
        const requestId = ++this._speedRequestId;
        const transportId = this._playRequestId;
        const generation = this._generation;
        const trackA = this._trackA;
        const trackB = this._trackB;
        const buffer = trackA?.buffer;
        const isCurrent = () => requestId === this._speedRequestId
            && transportId === this._playRequestId && generation === this._generation
            && !this._disposed && trackA === this._trackA && buffer === trackA?.buffer;

        if (this._eng) {
            // Realtime in the engine: the stretch keeps the pitch; the change is smoothed.
            this._eng.engine.setRate(normalized);
            trackA?.setPlaybackRate(normalized);
            trackB?.setPlaybackRate(normalized);
            this._update({ processing: { ...this._state.processing, speed: normalized }, pendingSpeed: null });
            return;
        }
        if (!trackA || !buffer) {
            trackA?.setPlaybackRate(normalized);
            trackB?.setPlaybackRate(normalized);
            this._update({ processing: { ...this._state.processing, speed: normalized }, pendingSpeed: null });
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

    setSourceB = async (input: AudioInput | null): Promise<boolean> => {
        const clip = this._clip;
        if (!clip) return false;

        this._abortB();
        const requestId = ++this._requestIdB;

        if (input === null) {
            this._trackB?.unload();
            this._dropEngineB();
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


    /** Stop and drop the clip: another source plays the next one. */
    unload(): void {
        this._playIntent = false;
        this._pendingPlaybackOffset = null;
        this._loading = false;
        this._pendingStart = null;
        this._loadRequestId += 1;
        this._playRequestId += 1;
        this._speedRequestId += 1;
        this._requestIdB += 1;
        this._abortB();
        this._readyA?.settle(false);
        this._disposeEngine();
        this._trackA?.unload();
        this._trackB?.unload();
        this._clip = null;
        this._loadedBFor = null;
    }

    dispose(): void {
        this._playIntent = false;
        this._pendingPlaybackOffset = null;
        this._loading = false;
        this._pendingStart = null;
        this._generation += 1;
        this._loadRequestId += 1;
        this._speedRequestId += 1;
        this._requestIdB += 1;
        this._disposed = true;
        this._playRequestId += 1;
        this._abortB();
        this._loaderB.abort();
        this._disposeEngine();

        this._unsubscribeTrack?.();
        this._unsubscribeTrack = null;
        this._trackA?.dispose();
        this._trackB?.dispose();
        this._mixer?.dispose();

        this._engine = null;
        this._mixer = null;
        this._trackA = null;
        this._trackB = null;
        this._initPromise = null;
        this._clip = null;
        this._loadedBFor = null;
    }

    reactivate(): void {
        this._disposed = false;
    }

    // -----------------------------------------------------------------------
    // Graph
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
        const output = await this._host.ensureOutput();
        if (!output || generation !== this._generation || this._disposed) return false;
        const processing = this._state.processing;
        const trackOptions = { stretch: this._stretch, loader: { fetchOptions: this._host.options.fetchOptions, ...this._limits } };
        const mixer = new Mixer(output.engine);
        const trackA = mixer.createTrack('A', trackOptions);
        const trackB = mixer.createTrack('B', trackOptions);
        trackA.setPlaybackRate(processing.speed);
        trackB.setPlaybackRate(processing.speed);
        trackB.setGain(0);
        // The mixer's sum feeds the core's output chain (high-pass, dynamics, analyser).
        if (mixer.masterGainNode) {
            mixer.masterGainNode.disconnect();
            mixer.masterGainNode.connect(output.input);
        }

        this._engine = output.engine;
        this._mixer = mixer;
        this._trackA = trackA;
        this._trackB = trackB;
        this._unsubscribeTrack = trackA.subscribe((trackState) => this._onTrackA(trackA, trackState));

        if (this._state.loop) {
            trackA.setLoopRangeSnapped(this._state.loop);
        }
        return true;
    }

    private _onTrackA(track: Track, trackState: TrackState): void {
        // While a clip loads the track is empty: the state shows the load (a seek's target, say).
        // On the engine path the track only holds the buffer: the engine's reports move the state.
        if (track !== this._trackA || !this._clip || this._loading || this._eng) return;

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
        this._host.emit('timeupdate', trackState.currentTime);
        if (!wasEnded && trackState.ended) {
            this._host.emit('ended', { clipId: this._state.clipId });
        }
    }

    // -----------------------------------------------------------------------
    // Load / start
    // -----------------------------------------------------------------------

    async load(clip: ClipInfo, startAt: number | undefined, autoplay: boolean): Promise<boolean> {
        this._playIntent = autoplay;
        this._pendingPlaybackOffset = null;
        this._loading = true;
        this._pendingStart = null;
        const generation = this._generation;
        const loadId = ++this._loadRequestId;
        const requestId = ++this._playRequestId;
        this._speedRequestId += 1;
        const isCurrent = () => loadId === this._loadRequestId && generation === this._generation && !this._disposed;
        let initError: unknown = null;
        const ready = await this._ensureInitialized().catch((error: unknown) => {
            initError = error;
            return false;
        });
        const trackA = this._trackA;
        const trackB = this._trackB;
        const ctx = this._engine?.context;
        if (!ready || !trackA || !trackB || !ctx || !isCurrent()) {
            // Still current, the audio engine could not start: an error like a clip's.
            if (isCurrent()) {
                this._fail(clip, initError ? toError(initError) : new Error('The audio engine could not start (no Web Audio, or it failed)'));
            }
            return false;
        }
        this._disposeEngine();
        trackA.unload();
        // A seek made while the engine was starting is where the clip starts.
        const requestedStart = this._pendingStart ?? Math.max(0, startAt ?? 0);

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
            mixLaw: this._host.options.mixLaw ?? 'crossfade',
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
                const decoded = await this._decode(clip.src as Exclude<AudioInput, string>, ctx);
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
            this._fail(clip, failure ?? new Error('The clip could not be loaded'));
            return false;
        }

        // The engine for this clip (it plays it, unless there is an offline strategy or no AudioWorklet).
        await this._createEngine(ctx, trackA.buffer!, isCurrent);
        if (!isCurrent()) {
            readyA.settle(false);
            return false;
        }

        // What the transport asked for while the clip loaded: a seek moved the
        // start, a pause, stop or resume set the intent (see seek, pause, resume).
        const startPoint = clampTime(this._pendingStart ?? requestedStart, trackA.duration);
        this._pendingStart = null;
        this._loading = false;
        const transportCurrent = requestId === this._playRequestId;
        // bufferB is left as it is: cleared when this load began, it may already hold this clip's
        // stem B, installed while A's load was finishing (both decoded in the cache, say).
        this._update({
            status: 'ready',
            progress: 1,
            duration: trackA.duration,
            buffer: trackA.buffer,
            currentTime: transportCurrent ? startPoint : trackA.currentTime,
            playbackStartPoint: transportCurrent ? startPoint : this._state.playbackStartPoint,
        });
        readyA.settle(true);
        this._host.emit('load', { clipId: clip.id, duration: trackA.duration });
        this._prewarm(trackA);
        void this._maybeLoadB();

        if (requestId !== this._playRequestId) return true;
        if (!this._playIntent) {
            const eng = this._eng;
            if (eng) {
                eng.pausedFrame = this._frameOf(eng, startPoint);
                eng.engine.seek(eng.pausedFrame);
            } else if (startPoint > 0) {
                await trackA.seek(startPoint);
            }
            return true;
        }

        const started = await this._play(startPoint);
        if (!started || !isCurrent() || requestId !== this._playRequestId) return false;

        this._applyMix(this._state.processing.mix);
        this._update({
            isPlaying: true,
            currentTime: startPoint,
            playbackStartPoint: startPoint,
            startedAt: this._startedAt(),
            ended: false,
        });
        return true;
    }

    /** The current load failed: the error goes into the state and out as an event, and nothing plays. */
    private _fail(clip: ClipInfo, error: Error): void {
        this._loading = false;
        this._pendingStart = null;
        this._playIntent = false;
        this._update({
            clipId: clip.id,
            src: typeof clip.src === 'string' ? clip.src : null,
            status: 'error',
            error,
            isPlaying: false,
        });
        this._host.emit('error', error);
    }

    async restart(startAt: number): Promise<boolean> {
        const trackA = this._trackA;
        const trackB = this._trackB;
        if (!trackA?.buffer || this._disposed) return false;
        this._playIntent = true;

        const target = clampTime(startAt, trackA.duration);
        const requestId = ++this._playRequestId;
        this._speedRequestId += 1;
        this._update({ pendingSpeed: null });
        if (this._eng) {
            this._eng.loop = null;
            this._eng.engine.setLoop(null);
        } else {
            trackA.setLoopRange(null);
            trackB?.setLoopRange(null);
        }
        const started = await this._play(target);
        if (!started || requestId !== this._playRequestId) return false;
        this._update({
            isPlaying: true,
            currentTime: target,
            loop: null,
            playbackStartPoint: target,
            playRequestId: this._playRequestId,
            startedAt: this._startedAt(),
            ended: false,
        });
        return true;
    }

    async resume(): Promise<void> {
        if (this._loading) {
            // Still loading: it plays once decoded. A new request id would cancel that.
            this._playIntent = true;
            return;
        }
        const requestId = ++this._playRequestId;
        const trackA = this._trackA;
        if (!trackA?.buffer || this._disposed) return;
        this._playIntent = true;

        const startPoint = clampTime(this.getCurrentTime() ?? 0, trackA.duration);
        const started = await this._play(startPoint);
        if (!started || requestId !== this._playRequestId) return;

        this._update({
            isPlaying: true,
            currentTime: startPoint,
            playbackStartPoint: startPoint,
            startedAt: this._startedAt(),
            ended: false,
        });
    }

    /** Start playing at `offset` (seconds), on the engine or on the tracks. */
    private _play(offset: number): Promise<boolean> {
        return this._eng ? this._engStart(this._eng, offset) : this._startSynchronized(offset);
    }

    private _startedAt(): number | null {
        if (this._eng) return this._eng.playing ? this._eng.startedAt : null;
        return this._trackA?.startedAt ?? null;
    }

    // -----------------------------------------------------------------------
    // Engine path
    // -----------------------------------------------------------------------

    private _frameOf(eng: EnginePath, seconds: number): number {
        return Math.max(0, Math.min(eng.a.length, Math.round(seconds * eng.rate)));
    }

    /** A loop's edges on zero crossings of stem A (as the tracks snap them). */
    private static _snap(buffer: AudioBuffer, range: LoopRange): LoopRange {
        const start = findZeroCrossing(buffer, range.start);
        const end = findZeroCrossing(buffer, range.end);
        return start < end ? { start, end } : range;
    }

    /**
     * Make the clip's engine: its segments cut from the decoded buffer. Nothing
     * is made with an offline strategy, or where the engine cannot run (the
     * tracks play the clip then).
     */
    private async _createEngine(ctx: AudioContext, buffer: AudioBuffer, isCurrent: () => boolean): Promise<void> {
        this._disposeEngine();
        const mode = this._engineMode;
        const output = await this._host.ensureOutput();
        if (!mode || !output || !isCurrent()) return;
        const loaded = await loadStreamEngine(ctx, mode.stretch);
        if (!loaded || !isCurrent()) return;
        const rate = buffer.sampleRate;
        const step = Math.max(1, Math.round(SEGMENT_SECONDS * rate));
        const starts: number[] = [];
        for (let f = 0; f < buffer.length; f += step) starts.push(f);
        starts.push(buffer.length);
        let engine: StreamEngine;
        try {
            // At the clip's rate: the engine resamples to the context's when they differ.
            engine = new StreamEngine(ctx, { channels: buffer.numberOfChannels, starts, stretch: mode.stretch, sampleRate: rate });
        } catch (error) {
            console.warn('[AudioPlayer] stream engine unavailable; the clip plays on tracks', error);
            return;
        }
        engine.node.connect(output.input);
        engine.setRate(this._state.processing.speed);
        engine.setMix(1, 0);
        const eng: EnginePath = { engine, rate, starts, a: buffer, b: null, playing: false, pausedFrame: 0, startedAt: 0, loop: null };
        this._eng = eng;
        engine.onEnded = () => this._onEngineEnded(eng);
        engine.onStretch = () => {
            if (this._eng === eng) this._update({ capabilities: this.capabilities });
        };
        engine.onError = (error) => this._onEngineError(eng, error);
        // A stem B handed in (setSourceB) while A was loading.
        const bufferB = this._trackB?.buffer;
        if (bufferB) {
            const atRate = await BufferSource._atRate(bufferB, rate);
            if (this._eng === eng && this._trackB?.buffer === bufferB) eng.b = atRate;
        }
        this._applyMix(this._state.processing.mix);
        this._update({ capabilities: this.capabilities });
    }

    private _disposeEngine(): void {
        const eng = this._eng;
        if (!eng) return;
        this._halt(eng);
        this._eng = null;
        eng.engine.pause();
        eng.engine.dispose();
        this._update({ capabilities: this.capabilities });
    }

    /** Stop moving the window and the position (the engine keeps the audio it holds). */
    private _halt(eng: EnginePath): void {
        eng.playing = false;
        if (this._pumpTimer) clearInterval(this._pumpTimer);
        this._pumpTimer = null;
    }

    private async _engStart(eng: EnginePath, offset: number): Promise<boolean> {
        const requestId = this._playRequestId;
        const generation = this._generation;
        const isCurrent = () => !this._disposed && generation === this._generation && requestId === this._playRequestId && this._eng === eng;
        let frame = this._frameOf(eng, offset);
        if (eng.loop && frame >= eng.loop.end) frame = eng.loop.start;
        if (frame >= eng.a.length) frame = 0;
        if (!eng.playing) eng.pausedFrame = frame;
        if (!await this._engine!.resume()) {
            // The output would not start (no user activation, an interruption): the
            // request is over, or a later seek or speed change would start it unasked.
            if (isCurrent() && !eng.playing) this._playIntent = false;
            return false;
        }
        if (!isCurrent()) return false;
        // Transport goes at once; the engine holds the playhead until the audio is there.
        if (eng.playing) eng.engine.seek(frame);
        else eng.engine.play(frame);
        eng.playing = true;
        eng.startedAt = this._engine!.context!.currentTime;
        this._feed(eng, frame);
        this._pumpTimer ??= setInterval(() => this._pump(eng), PUMP_MS);
        return true;
    }

    /** Hand the engine the segments around `frame` (the playhead by default) and let go of the others. */
    private _feed(eng: EnginePath | null = this._eng, frame?: number): void {
        if (!eng || eng !== this._eng) return;
        const at = frame ?? (eng.playing ? eng.engine.position() : eng.pausedFrame);
        const wanted = engineWindow(eng.starts, at, {
            loop: eng.loop,
            ahead: AHEAD_SEGMENTS,
            historyFrames: Math.max(eng.engine.stretch.latencyFrames, 0.25 * eng.rate),
            speed: this._state.processing.speed,
        });
        const give = (stem: EngineStem, buffer: AudioBuffer | null) => {
            for (const i of eng.engine.held(stem)) if (!buffer || !wanted.includes(i)) eng.engine.drop(stem, i);
            if (!buffer) return;
            for (const i of wanted) {
                if (eng.engine.holds(stem, i)) continue;
                // A shorter stem B reads as silence past its end (the engine reads a missing sample as 0).
                const from = Math.min(eng.starts[i], buffer.length);
                const to = Math.min(eng.starts[i + 1], buffer.length);
                const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c).slice(from, to));
                eng.engine.feed(stem, i, channels);
            }
        };
        give('a', eng.a);
        give('b', eng.b);
    }

    private _pump(eng: EnginePath): void {
        if (eng !== this._eng || !eng.playing) return;
        const frame = eng.engine.position();
        this._feed(eng, frame);
        const t = frame / eng.rate;
        this._update({ currentTime: t });
        this._host.emit('timeupdate', t);
    }

    private _onEngineEnded(eng: EnginePath): void {
        if (eng !== this._eng || !eng.playing) return;
        this._halt(eng);
        this._playIntent = false;
        eng.pausedFrame = 0;
        eng.engine.seek(0);
        this._update({ isPlaying: false, ended: true, currentTime: eng.a.duration, startedAt: null });
        this._host.emit('timeupdate', eng.a.duration);
        this._host.emit('ended', { clipId: this._state.clipId });
    }

    /** The processor died (it is silent for good): the tracks play on from the same place. */
    private _onEngineError(eng: EnginePath, error: Error): void {
        if (eng !== this._eng) return;
        console.warn('[AudioPlayer] stream engine failed; the clip plays on tracks', error);
        const wasPlaying = eng.playing;
        const at = (wasPlaying ? eng.engine.position() : eng.pausedFrame) / eng.rate;
        this._disposeEngine();
        const speed = this._state.processing.speed;
        this._trackA?.setPlaybackRate(speed);
        this._trackB?.setPlaybackRate(speed);
        const loop = this._state.loop;
        this._trackA?.setLoopRange(loop);
        if (this._trackB?.buffer) this._trackB.setLoopRange(loop);
        this._applyMix(this._state.processing.mix);
        if (wasPlaying) {
            void this._startSynchronized(at);
        } else {
            void this._trackA?.seek(at);
            if (this._trackB?.buffer) void this._trackB.seek(at);
        }
    }

    /** Stem B is gone or replaced: the engine plays A alone until the new B's segments arrive. */
    private _dropEngineB(): void {
        const eng = this._eng;
        if (!eng || !eng.b) return;
        eng.b = null;
        eng.engine.resetB();
    }

    /** Stem B at the clip's rate (an AudioBuffer handed in may have another). */
    private static async _atRate(buffer: AudioBuffer, rate: number): Promise<AudioBuffer> {
        if (buffer.sampleRate === rate) return buffer;
        const length = Math.max(1, Math.round(buffer.duration * rate));
        const offline = new OfflineAudioContext(buffer.numberOfChannels, length, rate);
        const node = offline.createBufferSource();
        node.buffer = buffer;
        node.connect(offline.destination);
        node.start();
        return offline.startRendering();
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
        if (!await engine.resume()) {
            // The output would not start (no user activation, an interruption): the
            // request is over, or a later seek or speed change would start it unasked.
            if (isCurrent() && trackA.state.playState !== 'playing') this._playIntent = false;
            return false;
        }
        if (!isCurrent()) return false;

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
    // Stem B
    // -----------------------------------------------------------------------

    private _hasSourceB(clip: ClipInfo): boolean {
        return clip.srcB !== null || typeof this._host.options.loadB === 'function';
    }

    private _applyMix(mix: number): void {
        const eng = this._eng;
        if (eng) {
            // Smoothed in the engine.
            const [gainA, gainB] = eng.b ? mixGains(mix, this._host.options.mixLaw) : [1, 0];
            eng.engine.setMix(gainA, gainB);
            return;
        }
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
        const [gainA, gainB] = mixGains(mix, this._host.options.mixLaw);
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
        if (this._state.processing.mix <= 0 && !this._host.options.prefetchB) return;
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
            const loadB = this._host.options.loadB;
            if (input === null && loadB) {
                input = await loadB({ ...clip }, controller.signal);
            }
            if (controller.signal.aborted || requestId !== this._requestIdB) return;
            if (input === null || input === undefined) {
                this._update({ statusB: 'unavailable' });
                return;
            }

            const buffer = await this._decodeB(input, controller.signal);
            if (!buffer) return;
            if (!this._trackA?.buffer && !(await this._readyAFor(clip.id))) {
                // Stem A failed: B is not loading any more (loading the clip again fetches it).
                if (requestId === this._requestIdB && this._clip?.id === clip.id) this._update({ statusB: 'idle' });
                return;
            }
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
        this._dropEngineB();
        this._applyMix(this._state.processing.mix);
        this._update({ statusB: 'error', bufferB: null });
        this._host.emit('berror', err);
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

        const eng = this._eng;
        if (eng) {
            // The engine reads B beside A from the same position: nothing to synchronise.
            const atRate = await BufferSource._atRate(decoded, eng.rate);
            if (this._disposed || requestId !== this._requestIdB || this._clip?.id !== clipId || eng !== this._eng) return false;
            if (eng.b) eng.engine.resetB();
            eng.b = atRate;
            this._feed(eng);
        } else {
            await this._syncBToA();
        }
        if (this._disposed || requestId !== this._requestIdB || this._clip?.id !== clipId) return false;
        this._applyMix(this._state.processing.mix);
        this._host.emit('bload', { clipId });
        return true;
    }

    private async _decode(input: Exclude<AudioInput, string>, ctx: BaseAudioContext): Promise<AudioBuffer> {
        if (typeof AudioBuffer !== 'undefined' && input instanceof AudioBuffer) {
            checkClipLimits(this._limits, { seconds: input.duration });
            return input;
        }
        checkClipLimits(this._limits, { bytes: input instanceof ArrayBuffer ? input.byteLength : (input as Blob).size });
        const bytes = input instanceof ArrayBuffer ? input : await (input as Blob).arrayBuffer();
        // decodeAudioData detaches its argument; keep the caller's bytes intact.
        const decoded = await ctx.decodeAudioData(bytes.slice(0));
        checkClipLimits(this._limits, { seconds: decoded.duration });
        return decoded;
    }
}
