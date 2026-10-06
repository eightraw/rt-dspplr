/// <reference path="../dsp/audioworklet-env.d.ts" />

// ---------------------------------------------------------------------------
// The stream engine: block-based playback of segmented audio in the audio
// thread. Bundled into a self-contained string at build time.
//
//   segments (PCM, transferred over the port; no SharedArrayBuffer)
//        │   voices A and B read the same timeline position (lockstep)
//        ▼
//   mix (gainA·A + gainB·B, smoothed)  ── rate 1: direct, sample-exact
//        │                              └─ rate ≠ 1: Signalsmith Stretch (pitch kept)
//        ▼                                 blended in/out over 20 ms
//   volume (smoothed) · declick on jumps
//        │   all of the above at the clip's own rate
//        ▼
//   resampler to the context's rate (windowed sinc, streaming: it reads across
//   segment joins and loop wraps, so there is no seam) ─ only when the rates differ
//        ▼
//   output ─▶ the player's post-FX chain
//
// Timing (frames, not context-time math):
// - every message is applied at the start of the next render quantum, or at its
//   `frame` (context frame) when given: the 128-frame block is split there;
// - loop wraps happen inside the render loop at the exact sample;
// - the position reported back is the timeline frame the engine has rendered.
//
// Underrun: when the audio at the playhead (or the stretcher's look-ahead) is
// not here yet, the engine outputs silence and HOLDS the playhead (counting the
// event and the silent frames), and resumes from the same sample, faded in,
// when the segment arrives — content is never skipped. Once stem B is being
// heard, a missing B segment holds the playhead too (A is never passed off as B).
//
// Realtime stretch: Signalsmith Stretch (MIT) in its "seek every block" mode,
// as its own web release drives it: each block hands the stretcher the input
// window around the playhead (history + look-ahead, ≈ its input+output
// latency) and asks for the block's output, so there is no start-up pre-roll
// gap, a seek is just another window, and a loop wrap is seamless because the
// window is read through the loop (the samples before the loop start are the
// end of the loop). Stem mixing happens before the stretcher: one stretcher,
// A and B can never drift apart.
// ---------------------------------------------------------------------------

declare const currentFrame: number;
declare function registerProcessor(name: string, ctor: unknown): void;

type Stem = 'a' | 'b';

type Message =
    | { type: 'seg'; stem: Stem; index: number; data: Float32Array[] }
    | { type: 'drop'; stem: Stem; index: number }
    | { type: 'clear' }
    | { type: 'play'; position: number; frame?: number; seq: number }
    /** `position`: where the playhead rests once paused (a stop, or a seek behind a pause). */
    | { type: 'pause'; position?: number; frame?: number; seq: number }
    | { type: 'seek'; position: number; frame?: number; seq: number }
    | { type: 'loop'; start: number; end: number } | { type: 'loop'; start: null; end: null }
    | { type: 'rate'; rate: number }
    | { type: 'volume'; value: number }
    | { type: 'mix'; a: number; b: number }
    | { type: 'stretch'; enabled: boolean }
    /** Stem B is another stem now (or gone): play A until its segments arrive, without holding. */
    | { type: 'resetB' }
    /** Fade out if sounding, then stop processing for good. */
    | { type: 'dispose' };

type Jump = Extract<Message, { type: 'play' | 'pause' | 'seek' }>;

interface Options {
    channels: number;
    /** Start frame of every segment, and the total at the end (length n + 1). */
    starts: number[];
    /** The clip's rate (timeline frames per second). Default: the context's. */
    sampleRate?: number;
}

interface WasmStretch {
    _main(): void;
    _presetDefault(channels: number, sampleRate: number): void;
    _setBuffers(channels: number, length: number): number;
    _inputLatency(): number;
    _outputLatency(): number;
    _seek(length: number, rate: number): void;
    _process(inputs: number, outputs: number): void;
    HEAP8?: Int8Array;
    exports?: { memory: WebAssembly.Memory };
}

const RAMP_SECONDS = 0.02;
const DECLICK_SECONDS = 0.004;
const REPORT_EVERY = 2; // render quanta
/** Time constant of the crossfade's energy estimates. */
const XFADE_AVERAGE_SECONDS = 0.005;
/** Render at most this many clip frames at a time (the scratch buffers' size). */
const BLOCK = 128;

/** Zero crossings of the resampler's kernel on each side, at the lower of the two rates. */
const SINC_ZERO_CROSSINGS = 16;
/** Kernel table resolution: steps per input frame (linear interpolation between them). */
const SINC_PHASES = 512;
/** Passband edge as a fraction of the lower Nyquist frequency. */
const SINC_CUTOFF = 0.92;
const KAISER_BETA = 8;

function besselI0(x: number): number {
    let sum = 1;
    let term = 1;
    for (let k = 1; k < 40; k += 1) {
        term *= (x / (2 * k)) * (x / (2 * k));
        sum += term;
        if (term < sum * 1e-12) break;
    }
    return sum;
}

/**
 * A streaming, fixed-ratio windowed-sinc resampler (Kaiser window), for the
 * clip's rate to the context's. It keeps the input it still needs, so its
 * output is one continuous conversion of the input stream, whatever the
 * blocks: segment joins, loop wraps and jumps are just input. Its delay is
 * `half` input frames.
 */
class SincResampler {
    /** Input frames per output frame. */
    private readonly step: number;
    /** Kernel half-width, in input frames. */
    readonly half: number;
    /** The kernel sampled every 1/SINC_PHASES input frame, from -half to +half. */
    private readonly table: Float32Array;
    private buf: Float32Array[];
    /** Frames in buf. */
    private count: number;
    /** Where the next output sample is centred, in input frames from buf[0]. */
    private t: number;

    constructor(channels: number, inRate: number, outRate: number) {
        this.step = inRate / outRate;
        const cutoff = SINC_CUTOFF * Math.min(1, outRate / inRate);
        this.half = Math.ceil(SINC_ZERO_CROSSINGS / cutoff);
        const size = 2 * this.half * SINC_PHASES + 2;
        this.table = new Float32Array(size);
        const norm = besselI0(KAISER_BETA);
        for (let k = 0; k < size; k += 1) {
            const x = k / SINC_PHASES - this.half;
            const r = x / this.half;
            if (Math.abs(r) >= 1) continue;
            const u = Math.PI * cutoff * x;
            const sinc = u === 0 ? 1 : Math.sin(u) / u;
            this.table[k] = cutoff * sinc * (besselI0(KAISER_BETA * Math.sqrt(1 - r * r)) / norm);
        }
        // Silence before the start, so the first output is centred on the first input frame.
        this.buf = Array.from({ length: channels }, () => new Float32Array(4096));
        this.count = this.half;
        this.t = this.half;
    }

    /** Input frames to push before the next process(n). */
    need(n: number): number {
        const last = this.t + (n - 1) * this.step;
        return Math.max(0, Math.floor(last) + this.half + 1 - this.count);
    }

    push(input: Float32Array[], frames: number): void {
        if (this.count + frames > this.buf[0].length) {
            const size = Math.max(this.count + frames, this.buf[0].length * 2);
            this.buf = this.buf.map((old) => {
                const grown = new Float32Array(size);
                grown.set(old.subarray(0, this.count));
                return grown;
            });
        }
        for (let c = 0; c < this.buf.length; c += 1) {
            const src = input[c < input.length ? c : input.length - 1];
            this.buf[c].set(src.subarray(0, frames), this.count);
        }
        this.count += frames;
    }

    process(out: Float32Array[], n: number): void {
        const taps = 2 * this.half;
        const table = this.table;
        for (let k = 0; k < n; k += 1) {
            const centre = this.t;
            const first = Math.floor(centre) - this.half + 1;
            // Table position of the first tap (x = first - centre), stepping one input frame per tap.
            const p0 = (first - centre + this.half) * SINC_PHASES;
            for (let c = 0; c < out.length; c += 1) {
                const x = this.buf[c < this.buf.length ? c : this.buf.length - 1];
                let sum = 0;
                for (let j = 0; j < taps; j += 1) {
                    const p = p0 + j * SINC_PHASES;
                    const ip = p | 0;
                    const h = table[ip] + (table[ip + 1] - table[ip]) * (p - ip);
                    sum += x[first + j] * h;
                }
                out[c][k] = sum;
            }
            this.t += this.step;
        }
        // Let go of the input no longer under the kernel.
        const drop = Math.floor(this.t) - this.half + 1;
        if (drop > 0) {
            for (const ch of this.buf) ch.copyWithin(0, drop, this.count);
            this.count -= drop;
            this.t -= drop;
        }
    }
}

class Smoothed {
    value: number;
    private target: number;
    private step = 0;
    constructor(value: number) {
        this.value = value;
        this.target = value;
    }
    set(target: number, frames: number): void {
        if (target === this.target) return; // a running ramp keeps its slope
        this.target = target;
        this.step = (target - this.value) / Math.max(1, frames);
    }
    next(): number {
        if (this.value !== this.target) {
            this.value += this.step;
            if ((this.step > 0 && this.value > this.target) || (this.step < 0 && this.value < this.target)) this.value = this.target;
        }
        return this.value;
    }
    /** Jump to a value with no ramp. */
    snap(value: number): void {
        this.value = value;
        this.target = value;
        this.step = 0;
    }

    get settled(): boolean {
        return this.value === this.target;
    }
}

class StreamEngineProcessor extends AudioWorkletProcessor {
    private readonly channels: number;
    private readonly starts: Float64Array;
    private readonly total: number;
    private readonly stems: Record<Stem, Map<number, Float32Array[]>> = { a: new Map(), b: new Map() };
    private queue: Array<{ frame: number; message: Message }> = [];

    private playing = false;
    private pos = 0;
    private rate = 1;
    private loop: { start: number; end: number } | null = null;
    private wrapped = false;
    private ended = false;

    private readonly volume = new Smoothed(1);
    private readonly gainA = new Smoothed(1);
    private readonly gainB = new Smoothed(0);
    private targetA = 1;
    private targetB = 0;
    private readonly blend = new Smoothed(0);
    private readonly declick = new Smoothed(0);
    /** A jump waiting for the fade-out to finish. */
    private pendingJump: Jump | null = null;
    /** Set by 'dispose': process() returns false once the fade-out is done. */
    private disposing = false;
    /** Stem B has not been heard since it was (re)set: its absence does not hold the playhead. */
    private bFresh = true;

    private stalled = false;
    /** Sequence number of the last transport message landed (play / pause / seek). */
    private seq = 0;
    /** Set by a start or a seek until audio first plays: a wait then is not an underrun. */
    private starting = false;
    private underruns = 0;
    private underrunFrames = 0;
    private blocks = 0;
    /** In the stretcher until the next start or jump (see renderPlaying). */
    private stayStretched = false;
    /** Pick the path outright on the next block (a start or a jump, behind the declick). */
    private snapBlend = true;

    private stretchWanted = true;
    private stretch: { mod: WasmStretch; inPtr: number[]; outPtr: number[]; len: number; inLat: number; outLat: number } | null = null;
    private stretchLoading = false;
    private stretchError = '';
    private readonly mixScratch: Float32Array[];
    private readonly direct: Float32Array[];
    private readonly stretched: Float32Array[];
    /** The clip's rate: the timeline, the ramps and the stretcher all run at it. */
    private readonly clipRate: number;
    private readonly xfAverage: number;
    /** To the context's rate, when it differs from the clip's; null otherwise (output as rendered). */
    private readonly resampler: SincResampler | null;
    /** Clip-rate frames rendered for the resampler. */
    private clipOut: Float32Array[];

    constructor(options: { processorOptions: Options }) {
        super();
        const o = options.processorOptions;
        this.channels = o.channels;
        this.starts = Float64Array.from(o.starts);
        this.total = o.starts[o.starts.length - 1] ?? 0;
        this.clipRate = o.sampleRate && o.sampleRate > 0 ? o.sampleRate : sampleRate;
        this.xfAverage = 1 / Math.max(1, XFADE_AVERAGE_SECONDS * this.clipRate);
        this.resampler = this.clipRate === sampleRate ? null : new SincResampler(this.channels, this.clipRate, sampleRate);
        this.clipOut = Array.from({ length: this.channels }, () => new Float32Array(BLOCK));
        this.mixScratch = Array.from({ length: this.channels }, () => new Float32Array(1));
        this.direct = Array.from({ length: this.channels }, () => new Float32Array(BLOCK));
        this.stretched = Array.from({ length: this.channels }, () => new Float32Array(BLOCK));
        this.port.onmessage = (event: MessageEvent<Message>) => {
            const message = event.data;
            const frame = (message as { frame?: number }).frame;
            this.queue.push({ frame: typeof frame === 'number' ? frame : -1, message });
        };
    }

    // ---- segments ------------------------------------------------------------------------

    private segmentOf(frame: number): number {
        const s = this.starts;
        let lo = 0;
        let hi = s.length - 2;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (s[mid] <= frame) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    }

    /** Whether a stem has the timeline frames [from, to] (clipped to the clip) in memory. */
    private hasRange(stem: Stem, from: number, to: number): boolean {
        const a = Math.max(0, Math.floor(from));
        const b = Math.min(this.total - 1, Math.ceil(to));
        if (b < a) return true;
        for (let i = this.segmentOf(a); i < this.starts.length - 1 && this.starts[i] <= b; i += 1) {
            if (!this.stems[stem].has(i)) return false;
        }
        return true;
    }

    /**
     * Whether a stem has the frames the playhead reads from `from` to `to` (linear
     * offsets around it), read through the loop as through() reads them: ahead
     * past the loop end continues at the loop start, and after a wrap the history
     * behind the loop start is the end of the loop.
     */
    private hasSpan(stem: Stem, from: number, to: number): boolean {
        const loop = this.loop;
        const p = this.pos;
        if (!loop || loop.end <= loop.start || p < loop.start || p >= loop.end) return this.hasRange(stem, from, to);
        const len = loop.end - loop.start;
        // Ahead of the playhead.
        const aheadFrom = Math.max(from, p);
        if (to < loop.end) {
            if (!this.hasRange(stem, aheadFrom, to)) return false;
        } else {
            if (!this.hasRange(stem, aheadFrom, loop.end - 1)) return false;
            if (!this.hasRange(stem, loop.start, loop.start + Math.min(len, to - loop.end + 1) - 1)) return false;
        }
        // Behind it.
        if (from < p) {
            if (this.wrapped && from < loop.start) {
                if (!this.hasRange(stem, loop.start, p)) return false;
                if (!this.hasRange(stem, loop.end - Math.min(len, loop.start - from), loop.end - 1)) return false;
            } else if (!this.hasRange(stem, from, p)) {
                return false;
            }
        }
        return true;
    }

    private hasB(frame: number): boolean {
        return this.stems.b.has(this.segmentOf(Math.max(0, Math.min(this.total - 1, Math.floor(frame)))));
    }

    /** One channel's sample of a stem at an integer frame (0 outside the clip or when absent). */
    private sample(stem: Stem, frame: number, channel: number): number {
        if (frame < 0 || frame >= this.total) return 0;
        // The last segment read per stem: consecutive frames almost always hit it.
        const cache = this.cache[stem];
        if (!(frame >= cache.start && frame < cache.end)) {
            const index = this.segmentOf(frame);
            cache.start = this.starts[index];
            cache.end = this.starts[index + 1];
            cache.data = this.stems[stem].get(index) ?? null;
        }
        const data = cache.data;
        if (!data) return 0;
        return data[channel < data.length ? channel : data.length - 1][frame - cache.start] ?? 0;
    }

    private readonly cache: Record<Stem, { start: number; end: number; data: Float32Array[] | null }> = {
        a: { start: 0, end: 0, data: null },
        b: { start: 0, end: 0, data: null },
    };

    private invalidate(stem: Stem): void {
        this.cache[stem].start = 0;
        this.cache[stem].end = 0;
    }

    /** The timeline frame `offset` frames from `from`, read through the loop. */
    private through(from: number, offset: number): number {
        return this.mapFrame(from, from + offset);
    }

    /**
     * Timeline frame `f` as read from a playhead at `from`, through the loop. An
     * integer `f` stays an integer (the stretch window reads whole frames).
     */
    private mapFrame(from: number, frame: number): number {
        let f = frame;
        const loop = this.loop;
        if (loop) {
            const len = loop.end - loop.start;
            if (len > 0) {
                if (from >= loop.start && from < loop.end && f >= loop.end) f = loop.start + ((f - loop.start) % len);
                // Behind the loop start after a wrap: the end of the loop came just before.
                if (this.wrapped && from >= loop.start && from < loop.end && f < loop.start) f = loop.end - ((loop.start - f) % len || len);
            }
        }
        return f;
    }

    // ---- stretcher -------------------------------------------------------------------------

    private ensureStretch(): void {
        if (this.stretch || this.stretchLoading || this.stretchError) return;
        const factory = (globalThis as unknown as { __rtdSignalsmithFactory?: () => Promise<WasmStretch> }).__rtdSignalsmithFactory;
        if (!factory) return; // the module is still being added; try again next block
        this.stretchLoading = true;
        factory().then((mod) => {
            mod._main();
            mod._presetDefault(this.channels, this.clipRate);
            const inLat = mod._inputLatency();
            const outLat = mod._outputLatency();
            const len = inLat + outLat;
            const pointer = mod._setBuffers(this.channels, len);
            const bytes = len * 4;
            this.stretch = {
                mod,
                len,
                inLat,
                outLat,
                inPtr: Array.from({ length: this.channels }, (_, c) => pointer + bytes * c),
                outPtr: Array.from({ length: this.channels }, (_, c) => pointer + bytes * (c + this.channels)),
            };
            this.stretchLoading = false;
            this.port.postMessage({ type: 'stretch', ready: true, latencyFrames: len, inputLatency: inLat });
        }, (error: unknown) => {
            this.stretchLoading = false;
            this.stretchError = String(error);
            this.port.postMessage({ type: 'stretch', ready: false, error: this.stretchError });
        });
    }

    private memory(): ArrayBuffer {
        const mod = this.stretch!.mod;
        return (mod.exports ? mod.exports.memory.buffer : mod.HEAP8!.buffer) as ArrayBuffer;
    }

    // ---- messages --------------------------------------------------------------------------

    private apply(message: Message): void {
        switch (message.type) {
            case 'seg':
                this.stems[message.stem].set(message.index, message.data);
                this.invalidate(message.stem);
                break;
            case 'drop':
                this.stems[message.stem].delete(message.index);
                this.invalidate(message.stem);
                break;
            case 'clear':
                this.stems.a.clear();
                this.stems.b.clear();
                this.invalidate('a');
                this.invalidate('b');
                break;
            case 'play':
                if (this.playing) {
                    this.jump(message);
                } else {
                    this.seq = message.seq;
                    this.pendingJump = null;
                    this.pos = message.position;
                    this.wrapped = false;
                    this.playing = true;
                    this.ended = false;
                    this.stalled = false;
                    this.starting = true;
                    this.stayStretched = false;
                    this.snapBlend = true;
                    this.declick.snap(0);
                    this.declick.set(1, DECLICK_SECONDS * this.clipRate);
                }
                break;
            case 'pause':
                if (this.playing) this.jump(message);
                else this.seq = message.seq;
                break;
            case 'seek':
                if (this.playing) {
                    // Behind a pause still fading out (a stop, a pause in 'reset' mode): the
                    // pause lands at the new position instead of the seek restarting playback.
                    if (this.pendingJump?.type === 'pause') this.pendingJump = { type: 'pause', position: message.position, seq: message.seq };
                    else this.jump(message);
                } else {
                    this.pos = message.position;
                    this.wrapped = false;
                    this.seq = message.seq;
                }
                break;
            case 'loop':
                this.loop = message.start === null ? null : { start: message.start, end: message.end };
                if (!this.loop) this.wrapped = false;
                break;
            case 'rate':
                this.rate = message.rate > 0 ? message.rate : 1;
                break;
            case 'volume':
                // Ramps run while playing; a move while paused is in place at the next start.
                if (this.playing) this.volume.set(message.value, RAMP_SECONDS * this.clipRate);
                else this.volume.snap(message.value);
                break;
            case 'mix':
                this.targetA = message.a;
                this.targetB = message.b;
                if (!this.playing) {
                    this.gainA.snap(message.a);
                    this.gainB.snap(message.b);
                }
                break;
            case 'stretch':
                this.stretchWanted = message.enabled;
                break;
            case 'resetB':
                this.bFresh = true;
                break;
            case 'dispose':
                this.disposing = true;
                if (this.playing && this.pendingJump?.type !== 'pause') this.jump({ type: 'pause', seq: this.seq });
                break;
        }
    }

    /** Seek, pause or a new play while sounding: fade out, jump, fade in. */
    private jump(message: Jump): void {
        this.pendingJump = message;
        this.jumpFramesLeft = Math.round(DECLICK_SECONDS * this.clipRate);
        this.declick.set(0, this.jumpFramesLeft);
    }

    private jumpFramesLeft = 0;

    private land(message: Jump): void {
        this.seq = message.seq;
        if (message.type === 'pause') {
            this.playing = false;
            if (typeof message.position === 'number') {
                this.pos = message.position;
                this.wrapped = false;
            }
            return;
        }
        if (message.type === 'seek' || message.type === 'play') {
            this.pos = message.position;
            this.wrapped = false;
            this.ended = false;
            this.stalled = false;
            this.starting = true;
            this.stayStretched = false;
            this.snapBlend = true;
            this.playing = true;
            this.declick.set(1, DECLICK_SECONDS * this.clipRate);
        }
    }

    // ---- rendering ---------------------------------------------------------------------------

    /**
     * While fading from the direct path into the stretcher: where the direct path
     * reads, at the speed it had (1x), so the outgoing audio keeps its pitch (as in an
     * overlap-add crossfade) instead of being varispeeded for the fade. null otherwise.
     */
    private xfFrom: number | null = null;
    /** Smoothed energies of the two paths and their product, while crossfading. */
    private xf: { ed: number; es: number; eds: number } | null = null;

    private advance(by: number): void {
        let p = this.pos + by;
        const loop = this.loop;
        if (loop && this.pos < loop.end && p >= loop.end && loop.end > loop.start) {
            p = loop.start + ((p - loop.start) % (loop.end - loop.start));
            this.wrapped = true;
        }
        this.pos = p;
    }

    /** Mixed sample of every channel at a (fractional) frame, into mixScratch. */
    private mixAt(frame: number, ga: number, gb: number): void {
        const i0 = Math.floor(frame);
        const k = frame - i0;
        for (let c = 0; c < this.channels; c += 1) {
            let a = this.sample('a', i0, c);
            let b = gb !== 0 ? this.sample('b', i0, c) : 0;
            if (k > 0) {
                a += (this.sample('a', i0 + 1, c) - a) * k;
                if (gb !== 0) b += (this.sample('b', i0 + 1, c) - b) * k;
            }
            this.mixScratch[c][0] = a * ga + b * gb;
        }
    }

    /** n frames from the playhead: direct (rate 1 exact, else linear) and/or stretched. */
    private renderPlaying(out: Float32Array[], offset: number, n: number): void {
        // The stretcher's output is not phase-aligned with its input (a phase vocoder
        // smears time by tens of frames), so it is never crossfaded with the direct path
        // while the two would overlap audibly: a start or a jump (both behind a declick
        // fade) picks the path outright. A speed change while playing blends between
        // them over 20 ms, energy-normalised: away from 1x into the stretcher, and back
        // at 1x out of it, so 1x is the original samples again.
        const useStretch = this.stretchWanted && !!this.stretch;
        const unity = Math.abs(this.rate - 1) <= 1e-6;
        if (useStretch && !unity) this.stayStretched = true;
        else if (unity) this.stayStretched = false;
        // At 1x the direct path reads whole frames (exact, no interpolation). Rounding moves
        // the playhead by at most half a frame: a step no larger than the signal's own.
        if (unity && this.pos !== Math.floor(this.pos)) this.pos = Math.round(this.pos);
        const wantStretch = useStretch && this.stayStretched;
        if (this.snapBlend) {
            this.blend.snap(wantStretch ? 1 : 0);
            this.snapBlend = false;
            this.xfFrom = null;
        } else {
            if (!wantStretch) this.xfFrom = null;
            else if (this.xfFrom === null && this.blend.value === 0) this.xfFrom = this.pos;
            this.blend.set(wantStretch ? 1 : 0, RAMP_SECONDS * this.clipRate);
        }
        const rate = this.rate;
        const needStretch = !!this.stretch && useStretch && (this.blend.value > 0 || !this.blend.settled);
        // What must be in memory for this block, read through the loop.
        const ahead = n * rate + 2;
        const from = needStretch ? this.pos + this.stretch!.outLat * rate + this.stretch!.inLat - this.stretch!.len - 1 : this.pos;
        const to = needStretch ? this.pos + this.stretch!.outLat * rate + this.stretch!.inLat + ahead : this.pos + ahead;
        // Stem B once it is being heard (or at a start with the knob towards B): its gap
        // holds the playhead like A's, so A is never passed off as B.
        const needB = this.targetB > 0 && (this.starting || (!this.bFresh && this.gainB.value > 0));
        const ok = this.hasSpan('a', from, to) && (!needB || this.hasSpan('b', from, to));
        if (!ok) {
            // Waiting right after a start or a seek is the fetch, not an underrun.
            // (nor is a fade-out before a jump whose old audio was already let go).
            const waiting = this.starting || this.pendingJump !== null;
            if (!this.stalled && !waiting) this.underruns += 1;
            this.stalled = true;
            if (!waiting) this.underrunFrames += n;
            // A pending jump still lands; otherwise the audio fades back in when it arrives.
            if (this.pendingJump) for (let i = 0; i < n; i += 1) this.declick.next();
            else this.declick.snap(0);
            for (const ch of out) ch.fill(0, offset, offset + n);
            return;
        }
        if (this.stalled && !this.pendingJump) this.declick.set(1, DECLICK_SECONDS * this.clipRate);
        this.stalled = false;
        this.starting = false;
        const bHere = this.hasB(this.pos);
        if (bHere && this.targetB > 0) this.bFresh = false;
        // Stem B not in memory yet (the knob just moved towards it): stem A at full until it is.
        const ta = bHere ? this.targetA : 1;
        const tb = bHere ? this.targetB : 0;
        this.gainA.set(ta, RAMP_SECONDS * this.clipRate);
        this.gainB.set(tb, RAMP_SECONDS * this.clipRate);

        // Direct path (also while blending to or from the stretcher).
        const start = this.pos;
        const gaStart = this.gainA.value;
        const gbStart = this.gainB.value;
        const directFrom = this.xfFrom ?? start;
        const directRate = this.xfFrom !== null ? 1 : rate;
        for (let i = 0; i < n; i += 1) {
            const ga = this.gainA.next();
            const gb = this.gainB.next();
            this.mixAt(this.through(directFrom, i * directRate), ga, gb);
            for (let c = 0; c < this.channels; c += 1) this.direct[c][i] = this.mixScratch[c][0];
        }

        let stretched = needStretch;
        if (needStretch) {
            const s = this.stretch!;
            try {
                const memory = this.memory();
                // What leaves the stretcher now was analysed outLat earlier: ask for the input
                // that many frames (at this rate) ahead, so the output lands on the playhead.
                const end = Math.round(start + s.outLat * rate + s.inLat);
                for (let c = 0; c < this.channels; c += 1) {
                    const buf = new Float32Array(memory, s.inPtr[c], s.len);
                    for (let k = 0; k < s.len; k += 1) {
                        const f = this.mapFrame(start, end - s.len + k);
                        buf[k] = this.sample('a', f, c) * gaStart + (gbStart !== 0 ? this.sample('b', f, c) * gbStart : 0);
                    }
                }
                s.mod._seek(s.len, rate);
                s.mod._process(0, n);
                const after = this.memory();
                for (let c = 0; c < this.channels; c += 1) this.stretched[c].set(new Float32Array(after, s.outPtr[c], n));
            } catch (error) {
                // A trap in the stretcher: drop it for good, keep playing by resampling.
                this.stretch = null;
                this.stretchError = String(error);
                this.port.postMessage({ type: 'stretch', ready: false, error: this.stretchError });
                stretched = false;
                this.blend.snap(0);
            }
        }

        // While crossfading, the two paths are not phase-aligned: they can cancel or add
        // up. The gain keeps the mix at the blend of the two paths' energies, from
        // energies and their correlation smoothed over ~5 ms (shorter estimates follow
        // the waveform itself and pump); at either end of the fade it is exactly 1.
        const crossfading = stretched && !this.blend.settled;
        if (!crossfading) {
            this.xf = null;
        } else if (!this.xf) {
            let ed = 0;
            let es = 0;
            let eds = 0;
            for (let i = 0; i < n; i += 1) {
                for (let c = 0; c < this.channels; c += 1) {
                    const d = this.direct[c][i];
                    const t = this.stretched[c][i];
                    ed += d * d;
                    es += t * t;
                    eds += d * t;
                }
            }
            this.xf = { ed: ed / n, es: es / n, eds: eds / n };
        }
        const xf = this.xf;
        for (let i = 0; i < n; i += 1) {
            const w = stretched ? this.blend.next() : (this.blend.next(), 0);
            let gain = 1;
            if (xf) {
                let ed = 0;
                let es = 0;
                let eds = 0;
                for (let c = 0; c < this.channels; c += 1) {
                    const d = this.direct[c][i];
                    const t = this.stretched[c][i];
                    ed += d * d;
                    es += t * t;
                    eds += d * t;
                }
                xf.ed += (ed - xf.ed) * this.xfAverage;
                xf.es += (es - xf.es) * this.xfAverage;
                xf.eds += (eds - xf.eds) * this.xfAverage;
                const target = (1 - w) * xf.ed + w * xf.es;
                const mixed = (1 - w) * (1 - w) * xf.ed + w * w * xf.es + 2 * w * (1 - w) * xf.eds;
                if (mixed > 1e-12 && target > 0) gain = Math.min(4, Math.max(0.25, Math.sqrt(target / mixed)));
            }
            const v = this.volume.next() * this.declick.next() * gain;
            for (let c = 0; c < this.channels; c += 1) {
                const d = this.direct[c][i];
                const x = w > 0 ? d + (this.stretched[c][i] - d) * w : d;
                out[c][offset + i] = x * v;
            }
        }
        if (this.xfFrom !== null) this.xfFrom = this.blend.settled ? null : this.through(this.xfFrom, n);
        this.advance(n * rate);
        if (!this.loop && this.pos >= this.total) {
            this.playing = false;
            this.ended = true;
            this.pos = this.total;
            // A jump still fading out ends with the clip; the seq tells a late 'ended' from a fresh play.
            this.pendingJump = null;
            this.port.postMessage({ type: 'ended', seq: this.seq });
        }
    }

    private render(out: Float32Array[], offset: number, n: number): void {
        if (n <= 0) return;
        if (!this.playing) {
            for (const ch of out) ch.fill(0, offset, offset + n);
            return;
        }
        if (this.pendingJump) {
            // Fade out over the declick ramp, then land the jump.
            const m = Math.min(n, Math.max(1, this.jumpFramesLeft));
            this.renderPlaying(out, offset, m);
            this.jumpFramesLeft -= m;
            if (this.jumpFramesLeft <= 0) {
                const message = this.pendingJump;
                this.pendingJump = null;
                this.land(message);
            }
            this.render(out, offset + m, n - m);
            return;
        }
        this.renderPlaying(out, offset, n);
    }

    process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
        const out = outputs[0];
        if (!out || out.length === 0) return !this.disposing;
        if (this.stretchWanted) this.ensureStretch();
        const n = out[0].length;
        this.queue.sort((x, y) => (x.frame < 0 ? -1 : x.frame) - (y.frame < 0 ? -1 : y.frame));
        if (this.resampler) {
            // Messages due in this quantum land at its start (the clip's frames do not line up with the context's).
            while (this.queue.length > 0 && (this.queue[0].frame < 0 || this.queue[0].frame - currentFrame < n)) {
                this.apply(this.queue.shift()!.message);
            }
            const need = this.resampler.need(n);
            if (this.clipOut[0].length < need) this.clipOut = Array.from({ length: this.channels }, () => new Float32Array(need));
            for (let k = 0; k < need; k += BLOCK) this.render(this.clipOut, k, Math.min(BLOCK, need - k));
            this.resampler.push(this.clipOut, need);
            this.resampler.process(out, n);
        } else {
            // Messages due in this quantum, in order; a timed one splits the block at its frame.
            let done = 0;
            while (this.queue.length > 0) {
                const next = this.queue[0];
                const at = next.frame < 0 ? 0 : next.frame - currentFrame;
                if (at >= n) break;
                const split = Math.max(done, Math.min(n, at));
                this.render(out, done, split - done);
                done = split;
                this.queue.shift();
                this.apply(next.message);
            }
            this.render(out, done, n - done);
        }

        if (this.disposing && !this.playing) {
            // Faded out: let go of the audio and the stretcher, and stop being processed.
            this.stems.a.clear();
            this.stems.b.clear();
            this.stretch = null;
            this.queue = [];
            return false;
        }

        this.blocks += 1;
        if (this.blocks % REPORT_EVERY === 0 || this.ended) {
            this.port.postMessage({
                type: 'pos',
                position: this.pos,
                seq: this.seq,
                frame: currentFrame + n,
                playing: this.playing,
                stalled: this.stalled,
                underruns: this.underruns,
                underrunFrames: this.underrunFrames,
                stretching: this.blend.value > 0,
                segmentsA: this.stems.a.size,
                segmentsB: this.stems.b.size,
            });
            this.ended = false;
        }
        return true;
    }
}

registerProcessor('rtd-stream-engine', StreamEngineProcessor);

export {};
