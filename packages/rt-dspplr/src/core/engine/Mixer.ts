import AudioEngine from './AudioEngine';
import { Track, type TrackOptions, type TrackState } from './Track';

// ---------------------------------------------------------------------------
// Mixer — multi-track summing with master output
// ---------------------------------------------------------------------------

export interface MixerState {
    tracks: Map<string, TrackState>;
    masterGain: number;
    masterMuted: boolean;
}

export class Mixer {
    private _engine: AudioEngine;
    private _tracks = new Map<string, Track>();

    /** Sum bus — all track outputs connect here. */
    private _sumBus: GainNode | null = null;
    /** Master gain applied after sum bus. */
    private _masterGainNode: GainNode | null = null;
    /** Analyser for visualizations (post-master). */
    private _analyser: AnalyserNode | null = null;

    private _masterGain = 1;
    private _masterMuted = false;
    private _connected = false;

    private _listeners = new Set<(state: MixerState) => void>();
    private _trackUnsubs = new Map<string, () => void>();

    constructor(engine?: AudioEngine) {
        this._engine = engine ?? AudioEngine.getInstance();
    }

    // -----------------------------------------------------------------------
    // Public getters
    // -----------------------------------------------------------------------

    get analyser(): AnalyserNode | null {
        return this._analyser;
    }

    get masterGainNode(): GainNode | null {
        return this._masterGainNode;
    }

    get state(): MixerState {
        const tracks = new Map<string, TrackState>();
        for (const [id, track] of this._tracks) {
            tracks.set(id, track.state);
        }
        return {
            tracks,
            masterGain: this._masterGain,
            masterMuted: this._masterMuted,
        };
    }

    // -----------------------------------------------------------------------
    // Track management
    // -----------------------------------------------------------------------

    /**
     * Add a track to the mixer. Creates the audio graph if not yet created.
     * Returns the track for chaining.
     */
    addTrack(track: Track): Track {
        if (this._tracks.has(track.id)) {
            console.warn(`[Mixer] Track "${track.id}" already exists`);
            return track;
        }

        this._ensureGraph();
        this._tracks.set(track.id, track);

        // Connect track output to sum bus
        if (track.output && this._sumBus) {
            track.output.connect(this._sumBus);
        }

        // Subscribe to track state changes
        const unsub = track.subscribe(() => this._notify());
        this._trackUnsubs.set(track.id, unsub);

        this._notify();
        return track;
    }

    /**
     * Remove a track from the mixer and disconnect it.
     */
    removeTrack(trackId: string): void {
        const track = this._tracks.get(trackId);
        if (!track) return;

        // Disconnect from sum bus
        if (track.output && this._sumBus) {
            try { track.output.disconnect(this._sumBus); } catch { /* noop */ }
        }

        // Unsubscribe
        this._trackUnsubs.get(trackId)?.();
        this._trackUnsubs.delete(trackId);

        this._tracks.delete(trackId);
        this._notify();
    }

    /**
     * Get a track by ID.
     */
    getTrack(trackId: string): Track | undefined {
        return this._tracks.get(trackId);
    }

    /**
     * Create a new track, add it to the mixer, and return it.
     */
    createTrack(id: string, options?: TrackOptions): Track {
        const track = new Track(id, this._engine, options);
        return this.addTrack(track);
    }

    // -----------------------------------------------------------------------
    // Master controls
    // -----------------------------------------------------------------------

    setMasterGain(value: number): void {
        this._masterGain = Math.max(0, value);
        this._applyMasterGain();
        this._notify();
    }

    setMasterMuted(muted: boolean): void {
        this._masterMuted = muted;
        this._applyMasterGain();
        this._notify();
    }

    // -----------------------------------------------------------------------
    // Synchronized playback
    // -----------------------------------------------------------------------

    /**
     * Start all tracks simultaneously from the given offset.
     * Useful for synchronized two-track playback.
     */
    async playAll(offset?: number): Promise<void> {
        const promises: Promise<boolean>[] = [];
        for (const track of this._tracks.values()) {
            if (track.buffer) {
                promises.push(track.play(offset));
            }
        }
        await Promise.all(promises);
    }

    /**
     * Pause all tracks.
     */
    pauseAll(): void {
        for (const track of this._tracks.values()) {
            track.pause();
        }
    }

    /**
     * Stop all tracks and reset to 0.
     */
    stopAll(): void {
        for (const track of this._tracks.values()) {
            track.stop();
        }
    }

    /**
     * Seek all tracks to the same position.
     */
    async seekAll(time: number): Promise<void> {
        const promises: Promise<void>[] = [];
        for (const track of this._tracks.values()) {
            promises.push(track.seek(time));
        }
        await Promise.all(promises);
    }

    // -----------------------------------------------------------------------
    // Subscriptions
    // -----------------------------------------------------------------------

    subscribe(listener: (state: MixerState) => void): () => void {
        this._listeners.add(listener);
        return () => {
            this._listeners.delete(listener);
        };
    }

    // -----------------------------------------------------------------------
    // Cleanup
    // -----------------------------------------------------------------------

    dispose(): void {
        for (const [id] of this._tracks) {
            this.removeTrack(id);
        }

        if (this._analyser) {
            try { this._analyser.disconnect(); } catch { /* noop */ }
            this._analyser = null;
        }
        if (this._masterGainNode) {
            try { this._masterGainNode.disconnect(); } catch { /* noop */ }
            this._masterGainNode = null;
        }
        if (this._sumBus) {
            try { this._sumBus.disconnect(); } catch { /* noop */ }
            this._sumBus = null;
        }

        this._connected = false;
        this._listeners.clear();
    }

    // -----------------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------------

    /**
     * Build the sum bus → master gain → analyser → destination graph.
     */
    private _ensureGraph(): void {
        if (this._connected) return;

        const ctx = this._engine.context;
        if (!ctx) {
            console.error('[Mixer] AudioEngine not initialized');
            return;
        }

        this._sumBus = ctx.createGain();
        this._masterGainNode = ctx.createGain();
        this._analyser = ctx.createAnalyser();
        this._analyser.fftSize = 2048;

        this._sumBus.connect(this._masterGainNode);
        this._masterGainNode.connect(this._analyser);
        this._analyser.connect(ctx.destination);

        this._applyMasterGain();
        this._connected = true;
    }

    private _applyMasterGain(): void {
        if (!this._masterGainNode) return;
        const ctx = this._engine.context;
        if (!ctx) return;

        const now = ctx.currentTime;
        const target = this._masterMuted ? 0 : this._masterGain;
        this._masterGainNode.gain.cancelScheduledValues(now);
        this._masterGainNode.gain.setValueAtTime(this._masterGainNode.gain.value, now);
        this._masterGainNode.gain.linearRampToValueAtTime(target, now + 0.02);
    }

    private _notify(): void {
        const state = this.state;
        for (const listener of this._listeners) {
            listener(state);
        }
    }
}
