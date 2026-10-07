import getStreamEngineUrl from './streamEngine.worklet.ts?inline-worklet';

// ---------------------------------------------------------------------------
// StreamEngine — main-thread handle of the stream engine worklet
// (streamEngine.worklet.ts). It feeds segments in (transferred over the
// port), sends transport, mix and volume, and turns the engine's reports into
// a live position: the frame the engine has rendered, extrapolated by the
// context clock between two reports (every ~5 ms).
// ---------------------------------------------------------------------------

export type EngineStem = 'a' | 'b';

export interface EngineReport {
    position: number;
    /** Context frame the report was made at (end of the block). */
    frame: number;
    playing: boolean;
    stalled: boolean;
    underruns: number;
    underrunFrames: number;
    stretching: boolean;
    /** The last transport message (play / pause / seek) the engine has landed. */
    seq: number;
}

export interface StreamEngineOptions {
    channels: number;
    /** Start frame of each segment, then the total frames (length n + 1). */
    starts: number[];
    /** Load the realtime stretcher (Signalsmith Stretch). Default true. */
    stretch?: boolean;
    /**
     * The clip's rate. Default: the context's. When it differs, the engine
     * renders at the clip's rate and resamples its output to the context's.
     */
    sampleRate?: number;
}

const enginesLoaded = new WeakMap<BaseAudioContext, Promise<boolean>>();
const stretchLoaded = new WeakMap<BaseAudioContext, Promise<boolean>>();

/** Add the engine (and, lazily, the stretcher) to a context's AudioWorklet scope. */
export function loadStreamEngine(ctx: BaseAudioContext, stretch = true): Promise<boolean> {
    let engine = enginesLoaded.get(ctx);
    if (!engine) {
        engine = ctx.audioWorklet ? ctx.audioWorklet.addModule(getStreamEngineUrl()).then(() => true, (error) => {
            console.warn('[StreamEngine] worklet unavailable', error);
            return false;
        }) : Promise.resolve(false);
        enginesLoaded.set(ctx, engine);
    }
    if (stretch && !stretchLoaded.has(ctx) && ctx.audioWorklet) {
        // Its own chunk (~100 KB of WASM): fetched only when a prepared clip plays.
        const loading = import('../../vendor/signalsmithStretch').then(async ({ default: code }) => {
            const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
            try {
                await ctx.audioWorklet.addModule(url);
                return true;
            } finally {
                URL.revokeObjectURL(url);
            }
        }).catch((error: unknown) => {
            console.warn('[StreamEngine] realtime stretch unavailable; speed falls back to resampling', error);
            return false;
        });
        stretchLoaded.set(ctx, loading);
    }
    return engine;
}

/** Whether the stretcher module made it into the context (resolves once known). */
export function stretchAvailable(ctx: BaseAudioContext): Promise<boolean> {
    return stretchLoaded.get(ctx) ?? Promise.resolve(false);
}

export class StreamEngine {
    readonly node: AudioWorkletNode;
    private readonly _ctx: BaseAudioContext;
    private _report: EngineReport = { position: 0, frame: 0, playing: false, stalled: false, underruns: 0, underrunFrames: 0, stretching: false, seq: 0 };
    private _seq = 0;
    /** The speed. */
    private _rate = 1;
    /** Clip frames per context frame at 1x. */
    private readonly _scale: number;
    private _loop: { start: number; end: number } | null = null;
    private readonly _sent: Record<EngineStem, Set<number>> = { a: new Set(), b: new Set() };
    private _stretchState: { ready: boolean; latencyFrames: number; error?: string } = { ready: false, latencyFrames: 0 };
    onReport: ((report: EngineReport) => void) | null = null;
    onEnded: (() => void) | null = null;
    onStretch: ((state: { ready: boolean; latencyFrames: number; error?: string }) => void) | null = null;
    /** The processor threw: it is silent for good (the source falls back to the scheduler). */
    onError: ((error: Error) => void) | null = null;

    /** The context must have loaded the engine (loadStreamEngine). */
    constructor(ctx: BaseAudioContext, options: StreamEngineOptions) {
        this._ctx = ctx;
        const clipRate = options.sampleRate && options.sampleRate > 0 ? options.sampleRate : ctx.sampleRate;
        this._scale = clipRate / ctx.sampleRate;
        this.node = new AudioWorkletNode(ctx, 'rtd-stream-engine', {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [options.channels],
            processorOptions: { channels: options.channels, starts: options.starts, sampleRate: clipRate },
        });
        this.node.onprocessorerror = () => this.onError?.(new Error('stream engine: the audio processor failed'));
        this.node.port.onmessage = (event: MessageEvent<{ type: string } & Record<string, unknown>>) => {
            const m = event.data;
            if (m.type === 'pos') {
                const report = m as unknown as EngineReport;
                // A report from before the last transport message describes the old position.
                if (report.seq < this._seq) {
                    this._report = { ...report, position: this._report.position, frame: this._report.frame, playing: this._report.playing, stalled: true, seq: report.seq };
                } else {
                    this._report = report;
                }
                this.onReport?.(this._report);
            } else if (m.type === 'ended') {
                // An end from before the last transport message (a play sent meanwhile) is stale.
                if (Number(m.seq ?? 0) >= this._seq) this.onEnded?.();
            } else if (m.type === 'stretch') {
                this._stretchState = { ready: !!m.ready, latencyFrames: Number(m.latencyFrames ?? 0), error: m.error as string | undefined };
                this.onStretch?.(this._stretchState);
            }
        };
        if (options.stretch === false) this.post({ type: 'stretch', enabled: false });
    }

    /** Whether the engine has landed every transport message sent so far. */
    get current(): boolean {
        return this._report.seq >= this._seq;
    }

    get report(): EngineReport {
        return this._report;
    }

    get stretch(): { ready: boolean; latencyFrames: number; error?: string } {
        return this._stretchState;
    }

    /** Segments the engine holds, per stem. */
    holds(stem: EngineStem, index: number): boolean {
        return this._sent[stem].has(index);
    }

    held(stem: EngineStem): number[] {
        return [...this._sent[stem]];
    }

    /** Hand a decoded segment to the engine (the arrays are transferred). */
    feed(stem: EngineStem, index: number, channels: Float32Array[]): void {
        this._sent[stem].add(index);
        this.post({ type: 'seg', stem, index, data: channels }, channels.map((c) => c.buffer as ArrayBuffer));
    }

    /** Stem B is another stem now (or none): A plays on until the new B's segments arrive. */
    resetB(): void {
        for (const i of this._sent.b) this.post({ type: 'drop', stem: 'b', index: i });
        this._sent.b.clear();
        this.post({ type: 'resetB' });
    }

    drop(stem: EngineStem, index: number): void {
        if (!this._sent[stem].delete(index)) return;
        this.post({ type: 'drop', stem, index });
    }

    play(position: number): void {
        this._report = { ...this._report, position, frame: this._nowFrame(), playing: true, stalled: true };
        this.post({ type: 'play', position, seq: ++this._seq });
    }

    pause(): void {
        this._report = { ...this._report, playing: false };
        this.post({ type: 'pause', seq: ++this._seq });
    }

    seek(position: number): void {
        this._report = { ...this._report, position, frame: this._nowFrame(), stalled: true };
        this.post({ type: 'seek', position, seq: ++this._seq });
    }

    setLoop(loop: { start: number; end: number } | null): void {
        this._loop = loop;
        this.post(loop ? { type: 'loop', start: loop.start, end: loop.end } : { type: 'loop', start: null, end: null });
    }

    /** The speed (1 = as recorded). */
    setRate(rate: number): void {
        this._rate = rate;
        this.post({ type: 'rate', rate });
    }

    setVolume(value: number): void {
        this.post({ type: 'volume', value });
    }

    setMix(a: number, b: number): void {
        this.post({ type: 'mix', a, b });
    }

    /** Live position in timeline frames: the engine's report, moved on by the context clock. */
    position(): number {
        const r = this._report;
        if (!r.playing || r.stalled) return r.position;
        const elapsed = Math.max(0, this._nowFrame() - r.frame);
        let p = r.position + elapsed * this._rate * this._scale;
        const loop = this._loop;
        if (loop && r.position < loop.end && p >= loop.end && loop.end > loop.start) {
            p = loop.start + ((p - loop.start) % (loop.end - loop.start));
        }
        return p;
    }

    /**
     * Fade out (if sounding), then the processor lets go of its audio and stops
     * running; the node is disconnected once the fade has played. A silent
     * processor lets go as the message arrives, rendering or not (a suspended context).
     */
    dispose(): void {
        this.post({ type: 'dispose' });
        this.node.port.onmessage = null;
        this.node.onprocessorerror = null;
        this.onReport = null;
        this.onEnded = null;
        this.onStretch = null;
        this.onError = null;
        const node = this.node;
        setTimeout(() => {
            try {
                node.disconnect();
            } catch {
                // no-op
            }
        }, 50);
    }

    private _nowFrame(): number {
        return Math.round(this._ctx.currentTime * this._ctx.sampleRate);
    }

    private post(message: unknown, transfer: Transferable[] = []): void {
        this.node.port.postMessage(message, transfer);
    }
}
