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
//   volume (smoothed) · declick on jumps ─▶ output ─▶ the player's post-FX chain
//
// Timing (frames, not context-time math):
// - every message is applied at the start of the next render quantum, or at its
//   `frame` (context frame) when given: the 128-frame block is split there;
// - loop wraps happen inside the render loop at the exact sample;
// - the position reported back is the timeline frame the engine has rendered.
//
// Underrun: when the audio at the playhead (or the stretcher's look-ahead) is
// not here yet, the engine outputs silence and HOLDS the playhead (counting the
// event and the silent frames), and resumes from the same sample when the
// segment arrives — content is never skipped.
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
    | { type: 'pause'; frame?: number; seq: number }
    | { type: 'seek'; position: number; frame?: number; seq: number }
    | { type: 'loop'; start: number; end: number } | { type: 'loop'; start: null; end: null }
    | { type: 'rate'; rate: number }
    | { type: 'volume'; value: number }
    | { type: 'mix'; a: number; b: number }
    | { type: 'stretch'; enabled: boolean };

interface Options {
    channels: number;
    /** Start frame of every segment, and the total at the end (length n + 1). */
    starts: number[];
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
/** Frames per energy-normalised step of the direct ⇄ stretched crossfade. */
const XFADE_CHUNK = 32;

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
    private pendingJump: Message | null = null;

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

    constructor(options: { processorOptions: Options }) {
        super();
        const o = options.processorOptions;
        this.channels = o.channels;
        this.starts = Float64Array.from(o.starts);
        this.total = o.starts[o.starts.length - 1] ?? 0;
        this.mixScratch = Array.from({ length: this.channels }, () => new Float32Array(1));
        this.direct = Array.from({ length: this.channels }, () => new Float32Array(128));
        this.stretched = Array.from({ length: this.channels }, () => new Float32Array(128));
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

    /** Whether stem A has the frames [from, to] (clipped to the clip) in memory. */
    private hasRange(from: number, to: number): boolean {
        const a = Math.max(0, Math.floor(from));
        const b = Math.min(this.total - 1, Math.ceil(to));
        if (b < a) return true;
        for (let i = this.segmentOf(a); i < this.starts.length - 1 && this.starts[i] <= b; i += 1) {
            if (!this.stems.a.has(i)) return false;
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
        let f = from + offset;
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
            mod._presetDefault(this.channels, sampleRate);
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
                if (!this.playing) this.seq = message.seq;
                if (this.playing) {
                    this.jump(message);
                } else {
                    this.pos = message.position;
                    this.wrapped = false;
                    this.playing = true;
                    this.ended = false;
                    this.stalled = false;
                    this.starting = true;
                    this.stayStretched = false;
                    this.snapBlend = true;
            this.stayStretched = false;
            this.snapBlend = true;
                    this.declick.set(1, DECLICK_SECONDS * sampleRate);
                }
                break;
            case 'pause':
                if (this.playing) this.jump(message);
                break;
            case 'seek':
                if (this.playing) this.jump(message);
                else {
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
                this.volume.set(message.value, RAMP_SECONDS * sampleRate);
                break;
            case 'mix':
                this.targetA = message.a;
                this.targetB = message.b;
                break;
            case 'stretch':
                this.stretchWanted = message.enabled;
                break;
        }
    }

    /** Seek, pause or a new play while sounding: fade out, jump, fade in. */
    private jump(message: Message): void {
        this.pendingJump = message;
        this.jumpFramesLeft = Math.round(DECLICK_SECONDS * sampleRate);
        this.declick.set(0, this.jumpFramesLeft);
    }

    private jumpFramesLeft = 0;

    private land(message: Message): void {
        if ('seq' in message) this.seq = message.seq;
        if (message.type === 'pause') {
            this.playing = false;
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
            this.declick.set(1, DECLICK_SECONDS * sampleRate);
        }
    }

    // ---- rendering ---------------------------------------------------------------------------

    private xfadeGain = 1;

    private blendTarget(): number {
        return this.stayStretched && this.stretchWanted && !!this.stretch ? 1 : 0;
    }

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
        // fade) picks the path outright, and once a clip is being stretched it stays in
        // the stretcher, 1x included, until the next start or jump. Only the first speed
        // change away from 1x while playing blends into it over 20 ms.
        const useStretch = this.stretchWanted && !!this.stretch;
        if (useStretch && Math.abs(this.rate - 1) > 1e-6) this.stayStretched = true;
        const wantStretch = useStretch && this.stayStretched;
        if (this.snapBlend) {
            this.blend.snap(wantStretch ? 1 : 0);
            this.snapBlend = false;
        } else {
            this.blend.set(wantStretch ? 1 : 0, RAMP_SECONDS * sampleRate);
        }
        const rate = this.rate;
        const needStretch = !!this.stretch && useStretch && (this.blend.value > 0 || !this.blend.settled);
        // What must be in memory for this block (stem A).
        const ahead = n * rate + 2;
        const ok = needStretch
            ? this.hasRange(this.pos + this.stretch!.outLat * rate + this.stretch!.inLat - this.stretch!.len - 1, this.pos + this.stretch!.outLat * rate + this.stretch!.inLat + ahead)
            : this.hasRange(this.pos, this.pos + ahead);
        if (!ok) {
            // Waiting right after a start or a seek is the fetch, not an underrun.
            // (nor is a fade-out before a jump whose old audio was already let go).
            const waiting = this.starting || this.pendingJump !== null;
            if (!this.stalled && !waiting) this.underruns += 1;
            this.stalled = true;
            if (!waiting) this.underrunFrames += n;
            for (let i = 0; i < n; i += 1) this.declick.next(); // a pending jump still lands
            for (const ch of out) ch.fill(0, offset, offset + n);
            return;
        }
        this.stalled = false;
        this.starting = false;
        const bHere = this.hasB(this.pos);
        // Stem B not in memory: stem A at full, as the whole-clip source does.
        const ta = bHere ? this.targetA : 1;
        const tb = bHere ? this.targetB : 0;
        this.gainA.set(ta, RAMP_SECONDS * sampleRate);
        this.gainB.set(tb, RAMP_SECONDS * sampleRate);

        // Direct path (also while blending to or from the stretcher).
        const start = this.pos;
        const gaStart = this.gainA.value;
        const gbStart = this.gainB.value;
        for (let i = 0; i < n; i += 1) {
            const ga = this.gainA.next();
            const gb = this.gainB.next();
            this.mixAt(this.through(start, i * rate), ga, gb);
            for (let c = 0; c < this.channels; c += 1) this.direct[c][i] = this.mixScratch[c][0];
        }

        if (needStretch) {
            const s = this.stretch!;
            const memory = this.memory();
            // What leaves the stretcher now was analysed outLat earlier: ask for the input
            // that many frames (at this rate) ahead, so the output lands on the playhead.
            const end = Math.round(start + s.outLat * rate + s.inLat);
            for (let c = 0; c < this.channels; c += 1) {
                const buf = new Float32Array(memory, s.inPtr[c], s.len);
                for (let k = 0; k < s.len; k += 1) {
                    const f = this.through(start, end - s.len + k - start);
                    buf[k] = this.sample('a', f, c) * gaStart + (gbStart !== 0 ? this.sample('b', f, c) * gbStart : 0);
                }
            }
            s.mod._seek(s.len, rate);
            s.mod._process(0, n);
            const after = this.memory();
            for (let c = 0; c < this.channels; c += 1) this.stretched[c].set(new Float32Array(after, s.outPtr[c], n));
        }

        const crossfading = needStretch && !this.blend.settled;
        for (let i0 = 0; i0 < n; i0 += XFADE_CHUNK) {
            const i1 = Math.min(n, i0 + XFADE_CHUNK);
            // While crossfading, the two paths are not phase-aligned and can cancel: keep
            // the chunk's energy at the blend of the two paths' energies.
            let gain = 1;
            const w0 = this.blend.value;
            if (crossfading) {
                let ed = 0;
                let es = 0;
                let em = 0;
                let w = w0;
                const step = (this.blend.settled ? 0 : (this.blendTarget() - w0) / Math.max(1, RAMP_SECONDS * sampleRate));
                for (let i = i0; i < i1; i += 1) {
                    for (let c = 0; c < this.channels; c += 1) {
                        const d = this.direct[c][i];
                        const t = this.stretched[c][i];
                        const x = d + (t - d) * w;
                        ed += d * d;
                        es += t * t;
                        em += x * x;
                    }
                    w = Math.min(1, Math.max(0, w + step));
                }
                const wm = (w0 + w) / 2;
                const target = (1 - wm) * ed + wm * es;
                if (em > 1e-12) gain = Math.min(8, Math.max(1, Math.sqrt(target / em)));
            }
            const g0 = this.xfadeGain;
            this.xfadeGain = gain;
            for (let i = i0; i < i1; i += 1) {
                const w = needStretch ? this.blend.next() : (this.blend.next(), 0);
                // The normalising gain ramps across the chunk, so its steps cannot click.
                const v = this.volume.next() * this.declick.next() * (g0 + (gain - g0) * ((i - i0 + 1) / (i1 - i0)));
                for (let c = 0; c < this.channels; c += 1) {
                    const d = this.direct[c][i];
                    const x = w > 0 ? d + (this.stretched[c][i] - d) * w : d;
                    out[c][offset + i] = x * v;
                }
            }
        }
        this.advance(n * rate);
        if (!this.loop && this.pos >= this.total) {
            this.playing = false;
            this.ended = true;
            this.pos = this.total;
            this.port.postMessage({ type: 'ended' });
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
        if (!out || out.length === 0) return true;
        if (this.stretchWanted) this.ensureStretch();
        const n = out[0].length;
        // Messages due in this quantum, in order; a timed one splits the block at its frame.
        let done = 0;
        this.queue.sort((x, y) => (x.frame < 0 ? -1 : x.frame) - (y.frame < 0 ? -1 : y.frame));
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
