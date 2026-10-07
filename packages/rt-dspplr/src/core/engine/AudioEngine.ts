// Resolved at build time into a function that returns a Blob URL of the
// bundled worklet source (see build/inline-plugin.ts), so consumers need no
// bundler configuration for the AudioWorklet.
import getDynamicsWorkletUrl from '../dsp/dynamics.worklet.ts?inline-worklet';

// ---------------------------------------------------------------------------
// AudioEngine — singleton managing the shared AudioContext lifecycle.
// One context per page is the norm: browsers cap the number of live contexts,
// and every player instance mixes into the same destination anyway.
// ---------------------------------------------------------------------------

export type EngineStatus = 'uninitialized' | 'initializing' | 'ready' | 'error';

export interface AudioEngineOptions {
    sampleRate?: number;
    /**
     * Output buffering. Default 'playback': a player is listened to, not played
     * like an instrument, and the larger buffer keeps the sound clean while the
     * page is busy (a zoom, a scroll, another tab).
     */
    latencyHint?: AudioContextLatencyCategory | number;
}

/** The rate used when the device's is neither 44.1 nor 48 kHz (and before a context exists). */
const DEFAULT_SAMPLE_RATE = 48000;
/** Device rates the context keeps: the output then needs no resampling. */
const DEVICE_RATES = [44100, 48000];

class AudioEngine {
    private static instance: AudioEngine | null = null;

    private _context: AudioContext | null = null;
    private _status: EngineStatus = 'uninitialized';
    private _workletAvailable = false;
    private _initPromise: Promise<boolean> | null = null;
    private _listeners = new Set<() => void>();

    // -----------------------------------------------------------------------
    // Singleton
    // -----------------------------------------------------------------------

    static getInstance(): AudioEngine {
        if (!AudioEngine.instance) {
            AudioEngine.instance = new AudioEngine();
        }
        return AudioEngine.instance;
    }

    /** Only for tests — destroys the singleton so a fresh one can be created. */
    static resetInstance(): void {
        if (AudioEngine.instance) {
            AudioEngine.instance.destroy();
            AudioEngine.instance = null;
        }
    }

    private constructor() {}

    // -----------------------------------------------------------------------
    // Public getters
    // -----------------------------------------------------------------------

    get context(): AudioContext | null {
        return this._context;
    }

    get status(): EngineStatus {
        return this._status;
    }

    get workletAvailable(): boolean {
        return this._workletAvailable;
    }

    get sampleRate(): number {
        return this._context?.sampleRate ?? DEFAULT_SAMPLE_RATE;
    }

    get currentTime(): number {
        return this._context?.currentTime ?? 0;
    }

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    /**
     * Initialize the AudioContext and register worklet modules.
     * Safe to call multiple times — returns cached promise if already initializing.
     */
    async initialize(options?: AudioEngineOptions): Promise<boolean> {
        if (this._status === 'ready' && this._context) return true;
        if (this._initPromise) return this._initPromise;

        this._status = 'initializing';
        this._notify();

        this._initPromise = this._doInit(options).catch((error) => {
            console.error('[AudioEngine] Initialization failed', error);
            this._status = 'error';
            this._notify();
            this._initPromise = null;
            return false;
        });

        return this._initPromise;
    }

    /**
     * Resume a suspended context (required after user gesture in most browsers).
     */
    async resume(): Promise<boolean> {
        if (!this._context) return false;
        if (this._context.state === 'running') return true;

        try {
            await this._context.resume();
            return (this._context.state as string) === 'running';
        } catch (error) {
            console.warn('[AudioEngine] Failed to resume context', error);
            return false;
        }
    }

    /**
     * Tear down the context and release all resources.
     */
    destroy(): void {
        if (this._context) {
            // Rejects when it is already closed.
            void this._context.close().catch(() => undefined);
            this._context = null;
        }
        this._status = 'uninitialized';
        this._workletAvailable = false;
        this._initPromise = null;
        this._listeners.clear();
    }

    // -----------------------------------------------------------------------
    // Notifications (lightweight pub/sub for status changes)
    // -----------------------------------------------------------------------

    /** Called on every status change and every change of the context's `state`. */
    subscribe(listener: () => void): () => void {
        this._listeners.add(listener);
        return () => {
            this._listeners.delete(listener);
        };
    }

    private _notify(): void {
        for (const listener of this._listeners) {
            listener();
        }
    }

    // -----------------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------------

    private async _doInit(options?: AudioEngineOptions): Promise<boolean> {
        // No webkitAudioContext fallback: the WebKit that lacks AudioContext
        // (before Safari 14.1) has no promise-based decodeAudioData and no
        // AudioWorklet either, so the player could not work there anyway.
        const AudioContextCtor = typeof window === 'undefined' ? undefined : window.AudioContext;

        if (!AudioContextCtor) {
            console.error('[AudioEngine] AudioContext not supported');
            this._status = 'error';
            this._notify();
            return false;
        }

        // The device's own rate when it is 44.1 or 48 kHz (no resampling at the output);
        // otherwise (a 96 kHz interface, a 16 kHz headset) 48 kHz, which bounds the work
        // per second. A clip at another rate is converted by the player (see StreamEngine).
        const latencyHint = options?.latencyHint ?? 'playback';
        let context = options?.sampleRate ? new AudioContextCtor({ sampleRate: options.sampleRate, latencyHint }) : new AudioContextCtor({ latencyHint });
        if (!options?.sampleRate && !DEVICE_RATES.includes(context.sampleRate)) {
            void context.close().catch(() => undefined);
            context = new AudioContextCtor({ sampleRate: DEFAULT_SAMPLE_RATE, latencyHint });
        }
        this._context = context;
        // Subscribers hear when the output stops under them: 'interrupted' (a call or
        // Siri on iOS) or 'suspended' by the system, and 'running' again.
        context.addEventListener('statechange', () => {
            if (this._context === context) this._notify();
        });

        // Register dynamics worklet
        this._workletAvailable = await this._loadWorklet();

        this._status = 'ready';
        this._notify();
        return true;
    }

    private async _loadWorklet(): Promise<boolean> {
        const ctx = this._context;
        if (!ctx?.audioWorklet) return false;

        try {
            await ctx.audioWorklet.addModule(getDynamicsWorkletUrl());
            return true;
        } catch (error) {
            // Typical cause: a Content-Security-Policy without `blob:` in script-src.
            console.warn('[AudioEngine] AudioWorklet unavailable, will use native fallback', error);
            return false;
        }
    }
}

export default AudioEngine;
