import AudioEngine from './AudioEngine';
import { BufferLoader, type BufferLoaderOptions, type LoadProgress } from '../loader/BufferLoader';
import { findZeroCrossing } from './zeroCrossing';
import type { StretchService } from '../stretch/StretchService';

// ---------------------------------------------------------------------------
// Track — a single audio source with playback, loop, gain, and speed variants
// ---------------------------------------------------------------------------

export type TrackPlayState = 'stopped' | 'playing' | 'paused';

export interface LoopRange {
    start: number;
    end: number;
}

export interface TrackState {
    playState: TrackPlayState;
    currentTime: number;
    duration: number;
    loopRange: LoopRange | null;
    gain: number;
    muted: boolean;
    bufferStatus: LoadProgress['status'];
    ended: boolean;
}

export interface TrackOptions {
    /** Renders pitch-preserving speed variants. null = always native playbackRate. */
    stretch?: StretchService | null;
    loader?: BufferLoaderOptions;
}

export interface PlaybackTarget {
    buffer: AudioBuffer;
    nativePlaybackRate: number;
    usesStretchedBuffer: boolean;
}

export class Track {
    readonly id: string;

    private _engine: AudioEngine;
    private _loader: BufferLoader;
    private _stretch: StretchService | null;
    private _buffer: AudioBuffer | null = null;
    private _source: AudioBufferSourceNode | null = null;
    private _retiringSources = new Set<AudioBufferSourceNode>();
    private _gainNode: GainNode | null = null;

    /** AudioContext.currentTime when playback started. */
    private _startedAt = 0;
    /** Source-domain offset where the current playback segment started. */
    private _playbackAnchorOffset = 0;
    /** Source-domain paused position. */
    private _pausedAt = 0;
    /** UI playback speed multiplier (source-domain seconds per rendered second). */
    private _playbackRate = 1;
    private _activePlaybackRate = 1;
    private _playId = 0;
    private _loadId = 0;
    /** Whether the currently active source uses a pre-stretched render buffer. */
    private _activeUsesStretchedBuffer = false;

    private _playState: TrackPlayState = 'stopped';
    private _loopRange: LoopRange | null = null;
    private _gain = 1;
    private _muted = false;
    private _ended = false;

    private _rafId: number | null = null;
    private _timerId: ReturnType<typeof setTimeout> | null = null;
    private _onVisibility: (() => void) | null = null;
    /**
     * The variant playing (or prepared) for the current buffer and rate. Kept
     * here so a seek or a restart at the same speed never asks the stretch
     * service again: a variant too large for the cache budget, or evicted by
     * other players' prewarms, would otherwise be rendered anew every time.
     */
    private _activeTarget: { buffer: AudioBuffer; rate: number; target: PlaybackTarget } | null = null;
    private _listeners = new Set<(state: TrackState) => void>();

    constructor(id: string, engine?: AudioEngine, options?: TrackOptions) {
        this.id = id;
        this._engine = engine ?? AudioEngine.getInstance();
        this._loader = new BufferLoader(options?.loader);
        this._stretch = options?.stretch ?? null;

        const ctx = this._engine.context;
        if (ctx) {
            this._gainNode = ctx.createGain();
            this._gainNode.gain.value = 1;
        }
    }

    get buffer(): AudioBuffer | null {
        return this._buffer;
    }

    get duration(): number {
        return this._buffer?.duration ?? 0;
    }

    get output(): GainNode | null {
        return this._gainNode;
    }

    get state(): TrackState {
        return {
            playState: this._playState,
            currentTime: this.currentTime,
            duration: this.duration,
            loopRange: this._loopRange,
            gain: this._gain,
            muted: this._muted,
            bufferStatus: this._loader.status === 'idle' && this._buffer ? 'ready' : this._loader.status,
            ended: this._ended,
        };
    }

    get currentTime(): number {
        if (this._playState !== 'playing') {
            return this._pausedAt;
        }
        return this._computeCurrentTime();
    }

    get startedAt(): number {
        return this._startedAt;
    }

    get playbackRate(): number {
        return this._playbackRate;
    }

    /** Error of the last failed load(), if any. */
    get loadError(): Error | null {
        return this._loader.lastError;
    }

    async load(url: string, onProgress?: (p: LoadProgress) => void): Promise<boolean> {
        const ctx = this._engine.context;
        if (!ctx) {
            console.error('[Track] AudioEngine not initialized');
            return false;
        }

        this.unload();

        const loadId = this._loadId;
        const result = await this._loader.load(url, ctx, onProgress);
        if (!result || loadId !== this._loadId) {
            return false;
        }

        this._setBuffer(result.buffer);
        return true;
    }

    setBuffer(buffer: AudioBuffer): void {
        this.unload();
        this._setBuffer(buffer);
    }

    unload(): void {
        this._loadId += 1;
        this._loader.abort();
        this.stop();
        // Background renders of the clip we are leaving are no longer useful.
        if (this._buffer) {
            this._stretch?.cancelPrewarm(this._buffer);
        }
        this._buffer = null;
        this._activeTarget = null;
        this._loopRange = null;
        this._playbackAnchorOffset = 0;
        this._pausedAt = 0;
        this._ended = false;
        this._notify();
    }

    async play(offset?: number, when?: number, prepared?: PlaybackTarget): Promise<boolean> {
        const playId = ++this._playId;
        const buffer = this._buffer;
        const rate = this._playbackRate;
        const isCurrent = () => playId === this._playId && buffer === this._buffer && rate === this._playbackRate;
        const ctx = this._engine.context;
        if (!ctx || !this._buffer) {
            return false;
        }

        const ready = await this._engine.resume();
        if (!ready || !isCurrent()) {
            return false;
        }

        const startOffset = Math.max(0, Math.min(offset ?? this._pausedAt, this.duration));
        const gainNode = this._ensureGainNode(ctx);
        const playbackTarget = prepared ?? await this._resolvePlaybackTarget(ctx, rate);

        if (!isCurrent() || (ctx.state as AudioContextState) === 'closed') {
            return false;
        }

        const startWhen = typeof when === 'number' ? Math.max(ctx.currentTime, when) : ctx.currentTime;
        this._destroySource(startWhen);
        const source = ctx.createBufferSource();
        source.buffer = playbackTarget.buffer;
        source.playbackRate.value = playbackTarget.nativePlaybackRate;
        source.connect(gainNode);

        if (this._loopRange) {
            source.loop = true;
            source.loopStart = this._mapSourceTimeToPlaybackTime(this._loopRange.start, playbackTarget.buffer.duration, playbackTarget.usesStretchedBuffer);
            source.loopEnd = this._mapSourceTimeToPlaybackTime(this._loopRange.end, playbackTarget.buffer.duration, playbackTarget.usesStretchedBuffer);
        }

        source.onended = () => {
            if (this._source !== source) {
                return;
            }
            this._onPlaybackEnded();
        };

        this._source = source;
        this._startedAt = startWhen;
        this._activePlaybackRate = rate;
        this._playbackAnchorOffset = startOffset;
        this._pausedAt = startOffset;
        this._playState = 'playing';
        this._ended = false;
        this._activeUsesStretchedBuffer = playbackTarget.usesStretchedBuffer;

        source.start(
            startWhen,
            this._mapSourceTimeToPlaybackTime(startOffset, playbackTarget.buffer.duration, playbackTarget.usesStretchedBuffer),
        );

        this._startPositionReporting();
        this._notify();
        return true;
    }

    pause(): void {
        this._playId += 1;
        if (this._playState !== 'playing') {
            return;
        }

        this._pausedAt = this._computeCurrentTime();
        this._destroySource();
        this._playState = 'paused';
        this._ended = false;
        this._stopPositionReporting();
        this._notify();
    }

    async togglePlayPause(): Promise<boolean> {
        if (this._playState === 'playing') {
            this.pause();
            return true;
        }

        return this.play();
    }

    stop(): void {
        this._playId += 1;
        this._destroySource();
        this._playState = 'stopped';
        this._playbackAnchorOffset = 0;
        this._pausedAt = 0;
        this._ended = false;
        this._stopPositionReporting();
        this._notify();
    }

    async seek(time: number): Promise<void> {
        this._playId += 1;
        const clamped = Math.max(0, Math.min(time, this.duration));
        const wasPlaying = this._playState === 'playing';

        if (wasPlaying) {
            this._destroySource();
        }

        this._pausedAt = clamped;
        this._ended = false;

        if (wasPlaying) {
            await this.play(clamped);
        } else {
            this._notify();
        }
    }

    setLoopRange(range: LoopRange | null): void {
        // The position is anchor + elapsed·rate, folded into the loop while one
        // is set. Re-anchor at the current position before the loop changes, or
        // dropping or moving it would unfold the time spent looping into a jump
        // towards the end of the clip.
        if (this._playState === 'playing' && this._loopRange) {
            const ctx = this._engine.context;
            if (ctx) {
                this._playbackAnchorOffset = this._computeCurrentTime();
                this._startedAt = Math.max(this._startedAt, ctx.currentTime);
            }
        }
        this._loopRange = range;

        if (this._source) {
            if (range) {
                const playbackDuration = this._source.buffer?.duration ?? this.duration;
                this._source.loop = true;
                this._source.loopStart = this._mapSourceTimeToPlaybackTime(range.start, playbackDuration, this._activeUsesStretchedBuffer);
                this._source.loopEnd = this._mapSourceTimeToPlaybackTime(range.end, playbackDuration, this._activeUsesStretchedBuffer);
            } else {
                this._source.loop = false;
            }
        }

        this._notify();
    }

    setLoopRangeSnapped(range: LoopRange | null): void {
        if (!range || !this._buffer) {
            this.setLoopRange(range);
            return;
        }

        const snappedStart = findZeroCrossing(this._buffer, range.start);
        const snappedEnd = findZeroCrossing(this._buffer, range.end);
        if (snappedStart >= snappedEnd) {
            this.setLoopRange(range);
            return;
        }

        this.setLoopRange({ start: snappedStart, end: snappedEnd });
    }

    setGain(value: number): void {
        this._gain = Math.max(0, value);
        this._applyGain();
        this._notify();
    }

    setMuted(muted: boolean): void {
        this._muted = muted;
        this._applyGain();
        this._notify();
    }

    setPlaybackRate(rate: number): void {
        this._playbackRate = Number.isFinite(rate) && rate > 0 ? rate : 1;
    }

    async preparePlaybackTarget(rate = this._playbackRate): Promise<PlaybackTarget | null> {
        const ctx = this._engine.context;
        const buffer = this._buffer;
        if (!ctx || !buffer) return null;
        const target = await this._resolvePlaybackTarget(ctx, rate);
        return buffer === this._buffer ? target : null;
    }

    async prepareForPlayback(): Promise<boolean> {
        return (await this.preparePlaybackTarget()) !== null;
    }

    /**
     * Render speed variants in the background. The currently selected speed
     * goes first, so a listener who keeps one speed never waits behind others.
     */
    primeSpeedVariants(speeds: readonly number[]): void {
        const ctx = this._engine.context;
        if (!ctx || !this._buffer || !this._stretch) {
            return;
        }

        this._stretch.prewarm(ctx, this._buffer, speeds, this._playbackRate);
    }

    subscribe(listener: (state: TrackState) => void): () => void {
        this._listeners.add(listener);
        return () => {
            this._listeners.delete(listener);
        };
    }

    dispose(): void {
        this._loadId += 1;
        this.stop();
        if (this._buffer) {
            this._stretch?.cancelPrewarm(this._buffer);
        }
        this._loader.dispose();
        if (this._gainNode) {
            try {
                this._gainNode.disconnect();
            } catch {
                // no-op
            }
            this._gainNode = null;
        }
        this._buffer = null;
        this._activeTarget = null;
        this._listeners.clear();
    }

    private _setBuffer(buffer: AudioBuffer): void {
        this._buffer = buffer;
        this._pausedAt = 0;
        this._ended = false;
        this._notify();
    }

    private _computeCurrentTime(): number {
        const ctx = this._engine.context;
        if (!ctx || !this._buffer) {
            return this._pausedAt;
        }

        const elapsed = Math.max(0, ctx.currentTime - this._startedAt);
        const sourceTime = this._playbackAnchorOffset + (elapsed * this._activePlaybackRate);

        if (this._loopRange) {
            const loopLength = this._loopRange.end - this._loopRange.start;
            if (loopLength > 0 && sourceTime >= this._loopRange.start) {
                return this._loopRange.start + ((sourceTime - this._loopRange.start) % loopLength);
            }
        }

        return Math.min(sourceTime, this._buffer.duration);
    }

    private _destroySource(atTime?: number): void {
        if (atTime === undefined) {
            for (const source of this._retiringSources) {
                source.onended = null;
                try { source.stop(); source.disconnect(); } catch { /* already stopped */ }
            }
            this._retiringSources.clear();
        } else if (this._source && atTime > (this._engine.context?.currentTime ?? 0)) {
            const old = this._source;
            this._retiringSources.add(old);
            old.onended = () => {
                old.disconnect();
                this._retiringSources.delete(old);
            };
            old.stop(atTime);
            this._source = null;
            return;
        }
        if (!this._source) {
            return;
        }

        this._source.onended = null;
        try {
            this._source.stop();
        } catch {
            // already stopped
        }
        try {
            this._source.disconnect();
        } catch {
            // closed context
        }
        this._source = null;
        this._activeUsesStretchedBuffer = false;
    }

    private _onPlaybackEnded(): void {
        this._destroySource();
        this._playState = 'stopped';
        this._pausedAt = 0;
        this._ended = true;
        this._stopPositionReporting();
        this._notify();
    }

    private _applyGain(): void {
        if (!this._gainNode) {
            return;
        }

        const ctx = this._engine.context;
        if (!ctx) {
            return;
        }

        const now = ctx.currentTime;
        const target = this._muted ? 0 : this._gain;
        this._gainNode.gain.cancelScheduledValues(now);
        this._gainNode.gain.setValueAtTime(this._gainNode.gain.value, now);
        this._gainNode.gain.linearRampToValueAtTime(target, now + 0.02);
    }

    private _ensureGainNode(ctx: AudioContext): GainNode {
        if (!this._gainNode) {
            this._gainNode = ctx.createGain();
            this._gainNode.gain.value = this._muted ? 0 : this._gain;
        }

        return this._gainNode;
    }

    private _mapSourceTimeToPlaybackTime(
        sourceTime: number,
        playbackDuration: number,
        usesStretchedBuffer: boolean,
    ): number {
        const mappedTime = usesStretchedBuffer ? (sourceTime / this._playbackRate) : sourceTime;
        return Math.max(0, Math.min(mappedTime, playbackDuration));
    }

    private async _resolvePlaybackTarget(ctx: AudioContext, rate: number): Promise<PlaybackTarget> {
        if (!this._buffer || Math.abs(rate - 1) < 1e-6) {
            return {
                buffer: this._buffer as AudioBuffer,
                nativePlaybackRate: 1,
                usesStretchedBuffer: false,
            };
        }

        const held = this._activeTarget;
        if (held && held.buffer === this._buffer && held.rate === rate) {
            return held.target;
        }

        if (!this._stretch?.available) {
            // No worker (native strategy, blocked by CSP, crashed): change the
            // rate on the source node. Pitch follows speed, but position
            // tracking stays correct.
            return {
                buffer: this._buffer,
                nativePlaybackRate: rate,
                usesStretchedBuffer: false,
            };
        }

        try {
            const source = this._buffer;
            const stretchedBuffer = await this._stretch.ensureVariant(ctx, source, rate, 'playback');
            const target: PlaybackTarget = {
                buffer: stretchedBuffer,
                nativePlaybackRate: 1,
                usesStretchedBuffer: true,
            };
            if (source === this._buffer) this._activeTarget = { buffer: source, rate, target };
            return target;
        } catch (error) {
            console.warn('[Track] Stretch worker failed, falling back to native playbackRate', error);
            return {
                buffer: this._buffer,
                nativePlaybackRate: rate,
                usesStretchedBuffer: false,
            };
        }
    }

    private _startPositionReporting(): void {
        this._stopPositionReporting();
        let lastReported = -1;
        const doc = typeof document !== 'undefined' ? document : null;

        const report = () => {
            const time = this._computeCurrentTime();
            if (Math.abs(time - lastReported) >= 0.03) {
                lastReported = time;
                this._notify();
            }
        };
        // Every animation frame while the page shows; in a background tab the
        // frames stop, so a timer keeps the position and `timeupdate` moving
        // (browsers run it at least once a second while audio plays).
        const schedule = () => {
            if (this._playState !== 'playing') return;
            if (doc?.hidden) {
                this._timerId = setTimeout(() => {
                    this._timerId = null;
                    report();
                    schedule();
                }, 250);
            } else {
                this._rafId = requestAnimationFrame(() => {
                    this._rafId = null;
                    report();
                    schedule();
                });
            }
        };
        schedule();

        if (doc) {
            this._onVisibility = () => {
                this._cancelTicks();
                schedule();
            };
            doc.addEventListener('visibilitychange', this._onVisibility);
        }
    }

    private _cancelTicks(): void {
        if (this._rafId !== null) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }
        if (this._timerId !== null) {
            clearTimeout(this._timerId);
            this._timerId = null;
        }
    }

    private _stopPositionReporting(): void {
        this._cancelTicks();
        if (this._onVisibility && typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', this._onVisibility);
        }
        this._onVisibility = null;
    }

    private _notify(): void {
        const state = this.state;
        for (const listener of this._listeners) {
            listener(state);
        }
    }
}
