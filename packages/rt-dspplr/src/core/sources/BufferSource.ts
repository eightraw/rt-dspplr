import type { AudioInput, ClipInfo } from '../AudioPlayer';
import { mixGains } from '../controls';
import { Mixer, Track, type LoopRange, type TrackState } from '../engine';
import type { PlaybackTarget } from '../engine/Track';
import type AudioEngine from '../engine/AudioEngine';
import { BufferLoader } from '../loader/BufferLoader';
import type { StretchService } from '../stretch/StretchService';
import type { PlaybackSource, SourceCapabilities, SourceHost } from './types';

// ---------------------------------------------------------------------------
// BufferSource — the whole clip decoded into an AudioBuffer (the player's
// original behaviour, moved out of AudioPlayerCore unchanged):
//
//   Track "A" ──┐
//               ├─ Mixer sum ─▶ the core's output chain
//   Track "B" ──┘
//
// Stem B is any second recording, sample-aligned with A and started on the
// same AudioContext clock. Speed variants are rendered off the main thread
// (pitch preserved) and switched at the live position.
// ---------------------------------------------------------------------------

const SYNC_LOOKAHEAD_SECONDS = 0.015;
const RETRY_B_MS = 3000;

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
    stretch: StretchService | null;
    prewarmSpeeds: readonly number[];
}

export class BufferSource implements PlaybackSource {
    readonly kind = 'buffer' as const;
    private readonly _host: SourceHost;
    private readonly _stretch: StretchService | null;
    private readonly _prewarmSpeeds: readonly number[];
    private readonly _loaderB: BufferLoader;

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
        this._loaderB = new BufferLoader({ fetchOptions: host.options.fetchOptions });
    }

    get capabilities(): SourceCapabilities {
        return {
            kind: 'buffer',
            canPreservePitch: !!this._stretch?.available,
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
        this._playRequestId += 1;
        this._speedRequestId += 1;
        this._trackA?.setPlaybackRate(this._state.processing.speed);
        this._trackB?.setPlaybackRate(this._state.processing.speed);
        this._trackA?.stop();
        this._trackB?.stop();
        this._update({ isPlaying: false, currentTime: 0, startedAt: null, pendingSpeed: null, ended: false });
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

    setLoop = (range: LoopRange | null): void => {
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
        this._loadRequestId += 1;
        this._playRequestId += 1;
        this._speedRequestId += 1;
        this._requestIdB += 1;
        this._abortB();
        this._readyA?.settle(false);
        this._trackA?.unload();
        this._trackB?.unload();
        this._clip = null;
        this._loadedBFor = null;
    }

    dispose(): void {
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
        const trackOptions = { stretch: this._stretch, loader: { fetchOptions: this._host.options.fetchOptions } };
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
        if (track !== this._trackA || !this._clip) return;

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
            if (failure) {
                this._update({ status: 'error', error: failure });
                this._host.emit('error', failure);
            }
            return false;
        }

        const startPoint = clampTime(requestedStart, trackA.duration);
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

    async restart(startAt: number): Promise<boolean> {
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

    async resume(): Promise<void> {
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
    // Stem B
    // -----------------------------------------------------------------------

    private _hasSourceB(clip: ClipInfo): boolean {
        return clip.srcB !== null || typeof this._host.options.loadB === 'function';
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

        await this._syncBToA();
        if (this._disposed || requestId !== this._requestIdB || this._clip?.id !== clipId) return false;
        this._applyMix(this._state.processing.mix);
        this._host.emit('bload', { clipId });
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
}
