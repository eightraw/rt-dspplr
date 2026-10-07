// ---------------------------------------------------------------------------
// SplitSource — the tonal and atonal parts of one stem, for the stream engine's
// realtime stretch (wasm/split.c does the math). The stretcher takes the tonal
// part (held notes: they stretch smoothly) and the engine's short OLA the atonal
// part (attacks and noise: they stay single and sharp). The two parts sum back
// to the stem.
//
// Frames are timeline frames. A part is made in chunks of one hop, each from the
// two grains that cover it, each grain from the spectra of the frames around it
// (the median over time looks SPLIT_HT frames ahead): what a frame needs from the
// stem reaches SPLIT_MARGIN frames each way. The audio is in memory (the clip's
// segments), so looking ahead costs no latency; it only has to be there.
// ---------------------------------------------------------------------------

export const SPLIT_SIZE = 2048;
export const SPLIT_HOP = 1024;
/** Half the median over time, in frames (9 frames, about 200 ms at 44.1 kHz). */
export const SPLIT_HT = 4;
/** Stem frames a part's frame depends on, each way. */
export const SPLIT_MARGIN = SPLIT_SIZE + (SPLIT_HT + 1) * SPLIT_HOP;

const RING = 40; // spectra kept by the module (split.c)
const KEEP_CHUNKS = 96;
const KEEP_GRAINS = 96;

export interface SplitExports {
    memory: WebAssembly.Memory;
    _initialize?: () => void;
    split_init(hop: number, ht: number, channels: number): void;
    split_reset(): void;
    split_in(): number;
    split_tonal(): number;
    split_atonal(): number;
    split_spectrum(f: number): void;
    split_grain(f: number): void;
}

/** What prepare() found: the parts are ready, the budget ran out, or the stem's audio is not in memory. */
export type SplitState = 'ready' | 'budget' | 'missing';

type Parts = { tonal: Float32Array[]; atonal: Float32Array[] };

export class SplitSource {
    private readonly _x: SplitExports;
    private readonly _channels: number;
    private readonly _read: (frame: number, channel: number) => number;
    private readonly _has: (from: number, to: number) => boolean;
    private readonly _slots = new Float64Array(RING).fill(-Infinity);
    private readonly _grains = new Map<number, Parts>();
    private readonly _chunks = new Map<number, Parts>();
    private _lastGrain = -Infinity;
    /** The chunk the accessors read last (consecutive frames almost always hit it). */
    private _cq = NaN;
    private _cp: Parts | null = null;

    /**
     * @param read  the stem's sample at a timeline frame (0 outside the clip)
     * @param has   whether the stem's frames [from, to] are in memory
     */
    constructor(x: SplitExports, channels: number, read: (frame: number, channel: number) => number, has: (from: number, to: number) => boolean) {
        this._x = x;
        this._channels = channels;
        this._read = read;
        this._has = has;
        x.split_init(SPLIT_HOP, SPLIT_HT, channels);
    }

    /** Forget everything (the stem's audio changed). */
    clear(): void {
        this._grains.clear();
        this._chunks.clear();
        this._slots.fill(-Infinity);
        this._lastGrain = -Infinity;
        this._cq = NaN;
        this._cp = null;
        this._x.split_reset();
    }

    /**
     * Make the chunks holding the given timeline frames ready. `frames(i)` gives the i-th
     * frame of a span of `count`, read through the loop as the engine reads it; `budget.left`
     * is how much work this block may still do (a grain costs 1, a spectrum 0.25).
     */
    prepare(count: number, frames: (i: number) => number, budget: { left: number }): SplitState {
        let last = NaN;
        for (let i = 0; i <= count; i += SPLIT_HOP >> 2) {
            const q = Math.floor(frames(Math.min(i, count)) / SPLIT_HOP);
            if (q === last) continue;
            last = q;
            const state = this._chunk(q, budget);
            if (state !== 'ready') return state;
        }
        return 'ready';
    }

    /** The tonal part at a timeline frame (its chunk must be prepared; 0 otherwise). */
    tonal(frame: number, channel: number): number {
        const p = this._parts(frame);
        return p ? p.tonal[channel < p.tonal.length ? channel : p.tonal.length - 1][frame - this._cq * SPLIT_HOP] : 0;
    }

    /** The atonal part at a timeline frame (its chunk must be prepared; 0 otherwise). */
    atonal(frame: number, channel: number): number {
        const p = this._parts(frame);
        return p ? p.atonal[channel < p.atonal.length ? channel : p.atonal.length - 1][frame - this._cq * SPLIT_HOP] : 0;
    }

    private _parts(frame: number): Parts | null {
        const q = Math.floor(frame / SPLIT_HOP);
        if (q !== this._cq) {
            this._cq = q;
            this._cp = this._chunks.get(q) ?? null;
        }
        return this._cp;
    }

    /** Chunk q: frames [q·HOP, (q + 1)·HOP) of both parts, from grains q + 1 and q + 2. */
    private _chunk(q: number, budget: { left: number }): SplitState {
        if (this._chunks.has(q)) return 'ready';
        for (let f = q + 1; f <= q + SPLIT_SIZE / SPLIT_HOP; f += 1) {
            if (f < 0 || this._grains.has(f)) continue;
            const state = this._grain(f, budget);
            if (state !== 'ready') return state;
        }
        const C = this._channels;
        const tonal = Array.from({ length: C }, () => new Float32Array(SPLIT_HOP));
        const atonal = Array.from({ length: C }, () => new Float32Array(SPLIT_HOP));
        for (let f = q + 1; f <= q + SPLIT_SIZE / SPLIT_HOP; f += 1) {
            const g = f >= 0 ? this._grains.get(f) : undefined;
            if (!g) continue;
            const offset = q * SPLIT_HOP - (f * SPLIT_HOP - SPLIT_SIZE);
            for (let c = 0; c < C; c += 1) {
                const gt = g.tonal[c];
                const ga = g.atonal[c];
                const t = tonal[c];
                const a = atonal[c];
                for (let i = 0; i < SPLIT_HOP; i += 1) {
                    t[i] += gt[offset + i];
                    a[i] += ga[offset + i];
                }
            }
        }
        this._chunks.set(q, { tonal, atonal });
        if (q === this._cq) this._cq = NaN;
        if (this._chunks.size > KEEP_CHUNKS) this._chunks.delete(this._chunks.keys().next().value!);
        return 'ready';
    }

    private _grain(f: number, budget: { left: number }): SplitState {
        for (let d = -SPLIT_HT - 1; d <= SPLIT_HT; d += 1) {
            const g = f + d;
            if (g < 0 || this._slots[g % RING] === g) continue;
            if (d === -SPLIT_HT - 1) continue; // only needed to slide the median: rebuilt below if absent
            if (budget.left <= 0) return 'budget';
            if (!this._has(g * SPLIT_HOP - SPLIT_SIZE, g * SPLIT_HOP - 1)) return 'missing';
            this._spectrum(g);
            budget.left -= 0.25;
        }
        if (budget.left <= 0) return 'budget';
        // The module slides its median from the last grain when it can; otherwise it rebuilds it.
        const behind = f - SPLIT_HT - 1;
        if (!(f === this._lastGrain + 1 && (behind < 0 || this._slots[behind % RING] === behind))) this._x.split_reset();
        this._x.split_grain(f);
        this._lastGrain = f;
        const C = this._channels;
        const memory = this._x.memory.buffer;
        const t = new Float32Array(memory, this._x.split_tonal(), C * SPLIT_SIZE);
        const a = new Float32Array(memory, this._x.split_atonal(), C * SPLIT_SIZE);
        this._grains.set(f, {
            tonal: Array.from({ length: C }, (_, c) => t.slice(c * SPLIT_SIZE, (c + 1) * SPLIT_SIZE)),
            atonal: Array.from({ length: C }, (_, c) => a.slice(c * SPLIT_SIZE, (c + 1) * SPLIT_SIZE)),
        });
        if (this._grains.size > KEEP_GRAINS) this._grains.delete(this._grains.keys().next().value!);
        budget.left -= 1;
        return 'ready';
    }

    /** Frame g's samples into the module, and its spectra into the ring. */
    private _spectrum(g: number): void {
        const C = this._channels;
        const input = new Float32Array(this._x.memory.buffer, this._x.split_in(), C * SPLIT_SIZE);
        const from = g * SPLIT_HOP - SPLIT_SIZE;
        for (let c = 0; c < C; c += 1) {
            const base = c * SPLIT_SIZE;
            for (let k = 0; k < SPLIT_SIZE; k += 1) input[base + k] = this._read(from + k, c);
        }
        this._x.split_spectrum(g);
        this._slots[g % RING] = g;
    }
}
