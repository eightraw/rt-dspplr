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
//
// The parts are those of the audio as it plays. Inside a loop that is not the
// clip as it lies near the loop's edges: past the loop's end comes its start,
// and once playback has wrapped, its end comes before its start. So a frame is
// split in one of three ways (SplitMode, which the engine tells with each read):
//
//   0  as the clip lies (no loop, or the playhead is not in it)
//   1  in a loop, before its first wrap: past the end comes the start, before
//      the start what lies there (what played on the way in)
//   2  in a loop after a wrap (or read past the next one): the loop all round
//
// Each way has its own cache, and its own context in the module (its ring of
// spectra and its sliding median): one instance of the module serves all of a
// player's splits, each stem's three. A chunk whose making stays inside the loop
// is the same in all three ways, and comes from the first.
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
/**
 * The hops of stem audio chunk q is made from: from (q − REACH_BEHIND)·HOP up to (q + REACH_AHEAD)·HOP
 * (its grains q + 1 and q + 2, and the spectra their medians over time take in).
 */
const REACH_BEHIND = SPLIT_SIZE / SPLIT_HOP + SPLIT_HT - 1;
const REACH_AHEAD = SPLIT_SIZE / SPLIT_HOP + SPLIT_HT;
/**
 * Added to grain numbers in a loop's caches: the module leaves out spectra of negative frames
 * (before the clip's start: silence), but in a loop, what comes before its start is its end.
 */
const LOOPED_INDEX = 1 << 20;

export interface SplitExports {
    memory: WebAssembly.Memory;
    _initialize?: () => void;
    split_init(hop: number, ht: number, channels: number): void;
    /** Work on context i from now on (made on first use): 0, or −1 without memory for it. */
    split_select(i: number): number;
    split_reset(): void;
    split_in(): number;
    split_tonal(): number;
    split_atonal(): number;
    split_spectrum(f: number): void;
    split_grain(f: number): void;
}

/** What prepare() found: the parts are ready, the budget ran out, or the stem's audio is not in memory. */
export type SplitState = 'ready' | 'budget' | 'missing';

/** How a frame is split: as the clip lies (0), in a loop before its first wrap (1), in a loop after one (2). */
export type SplitMode = 0 | 1 | 2;

type Parts = { tonal: Float32Array[]; atonal: Float32Array[] };
type Read = (frame: number, channel: number) => number;
type Has = (from: number, to: number) => boolean;

/** The parts of a stem split one way: chunks made from what `read` gives, in context `ctx` of the module. */
class SplitCache {
    private readonly _x: SplitExports;
    private readonly _ctx: number;
    /** Whether the context has been taken (its sliding median is from this cache's own grains). */
    private _taken = false;
    private readonly _channels: number;
    private readonly _read: Read;
    private readonly _has: Has;
    /** Added to grain numbers for the module (a loop's caches: none is negative there). */
    private readonly _index: number;
    private readonly _slots = new Float64Array(RING).fill(-Infinity);
    private readonly _grains = new Map<number, Parts>();
    private readonly _chunks = new Map<number, Parts>();
    private _lastGrain = -Infinity;
    /** The chunk the accessors read last (consecutive frames almost always hit it). */
    private _cq = NaN;
    private _cp: Parts | null = null;

    constructor(x: SplitExports, ctx: number, channels: number, read: Read, has: Has, index: number) {
        this._x = x;
        this._ctx = ctx;
        this._channels = channels;
        this._read = read;
        this._has = has;
        this._index = index;
    }

    clear(): void {
        this._grains.clear();
        this._chunks.clear();
        this._slots.fill(-Infinity);
        this._lastGrain = -Infinity;
        this._cq = NaN;
        this._cp = null;
        if (this._taken && this._x.split_select(this._ctx) === 0) this._x.split_reset();
    }

    /** Select the context for the module's next calls; the first time, forget what it slid before (an instance used by another player). */
    private _use(): boolean {
        if (this._x.split_select(this._ctx) !== 0) return false;
        if (!this._taken) {
            this._taken = true;
            this._x.split_reset();
        }
        return true;
    }

    part(frame: number, channel: number, tonal: boolean): number {
        const q = Math.floor(frame / SPLIT_HOP);
        if (q !== this._cq) {
            this._cq = q;
            this._cp = this._chunks.get(q) ?? null;
        }
        const p = this._cp;
        if (!p) return 0;
        const planes = tonal ? p.tonal : p.atonal;
        return planes[channel < planes.length ? channel : planes.length - 1][frame - q * SPLIT_HOP];
    }

    /** Chunk q: frames [q·HOP, (q + 1)·HOP) of both parts, from grains q + 1 and q + 2. */
    chunk(q: number, budget: { left: number }): SplitState {
        if (this._chunks.has(q)) return 'ready';
        for (let f = q + 1; f <= q + SPLIT_SIZE / SPLIT_HOP; f += 1) {
            if (f + this._index < 0 || this._grains.has(f)) continue;
            const state = this._grain(f, budget);
            if (state !== 'ready') return state;
        }
        const C = this._channels;
        const tonal = Array.from({ length: C }, () => new Float32Array(SPLIT_HOP));
        const atonal = Array.from({ length: C }, () => new Float32Array(SPLIT_HOP));
        for (let f = q + 1; f <= q + SPLIT_SIZE / SPLIT_HOP; f += 1) {
            const g = this._grains.get(f);
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

    private _slot(g: number): number {
        return (((g + this._index) % RING) + RING) % RING;
    }

    private _grain(f: number, budget: { left: number }): SplitState {
        // No memory for the context: as if the audio were not here (the engine stretches the mix whole).
        if (!this._use()) return 'missing';
        for (let d = -SPLIT_HT - 1; d <= SPLIT_HT; d += 1) {
            const g = f + d;
            if (g + this._index < 0 || this._slots[this._slot(g)] === g) continue;
            if (d === -SPLIT_HT - 1) continue; // only needed to slide the median: rebuilt below if absent
            if (budget.left <= 0) return 'budget';
            if (!this._has(g * SPLIT_HOP - SPLIT_SIZE, g * SPLIT_HOP - 1)) return 'missing';
            this._spectrum(g);
            budget.left -= 0.25;
        }
        if (budget.left <= 0) return 'budget';
        // The module slides its median from the last grain when it can; otherwise it rebuilds it.
        const behind = f - SPLIT_HT - 1;
        if (!(f === this._lastGrain + 1 && (behind + this._index < 0 || this._slots[this._slot(behind)] === behind))) this._x.split_reset();
        this._x.split_grain(f + this._index);
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
        this._x.split_spectrum(g + this._index);
        this._slots[this._slot(g)] = g;
    }
}

export class SplitSource {
    /** Mode 0, and every chunk made inside a loop. */
    private readonly _linear: SplitCache;
    /** Mode 1 near the loop's end (and mode 2 there, which is the same): past the end comes the start. */
    private readonly _ahead: SplitCache;
    /** Mode 2 near the loop's start: before the start comes the end. */
    private readonly _around: SplitCache;
    private _loop: { start: number; end: number } | null = null;
    /** The cache the accessors used last, for which chunk and mode. */
    private _sq = NaN;
    private _sm = -1;
    private _sc: SplitCache;

    /**
     * @param x     the module's instance (shared by every SplitSource of a player)
     * @param ctx   the first of the three contexts of the module this stem's split uses
     * @param read  the stem's sample at a timeline frame (0 outside the clip)
     * @param has   whether the stem's frames [from, to] are in memory
     */
    constructor(x: SplitExports, ctx: number, channels: number, read: Read, has: Has) {
        x.split_init(SPLIT_HOP, SPLIT_HT, channels);
        this._linear = new SplitCache(x, ctx, channels, read, has, 0);
        this._ahead = new SplitCache(x, ctx + 1, channels, (f, c) => read(this._wrap(f, false), c), (from, to) => this._hasLooped(from, to, false, has), LOOPED_INDEX);
        this._around = new SplitCache(x, ctx + 2, channels, (f, c) => read(this._wrap(f, true), c), (from, to) => this._hasLooped(from, to, true, has), LOOPED_INDEX);
        this._sc = this._linear;
    }

    /** The loop playback goes round (null: none). A new one makes the parts near its edges anew. */
    setLoop(loop: { start: number; end: number } | null): void {
        const next = loop && loop.end > loop.start ? { start: loop.start, end: loop.end } : null;
        const prev = this._loop;
        if (prev === next || (prev && next && prev.start === next.start && prev.end === next.end)) return;
        this._loop = next;
        this._ahead.clear();
        this._around.clear();
        this._sq = NaN;
    }

    /** Forget everything (the stem's audio changed). */
    clear(): void {
        this._linear.clear();
        this._ahead.clear();
        this._around.clear();
        this._sq = NaN;
    }

    /**
     * Make the chunks holding the given timeline frames ready. `frames(i)` gives the i-th
     * frame of a span of `count`, read through the loop as the engine reads it, and `modes(i)`
     * how it is split there (default 0); `budget.left` is how much work this block may still do
     * (a grain costs 1, a spectrum 0.25).
     */
    prepare(count: number, frames: (i: number) => number, budget: { left: number }, modes: (i: number) => SplitMode = () => 0): SplitState {
        // Chunk by chunk along the span. It runs on frame by frame, in one mode, except where it
        // jumps back (a loop wrap, anywhere in a chunk; the mode changes only there): the first
        // frame after a jump starts the next piece.
        let i = 0;
        let f = frames(0);
        let m = modes(0);
        for (;;) {
            const q = Math.floor(f / SPLIT_HOP);
            const state = this._cache(q, m).chunk(q, budget);
            if (state !== 'ready') return state;
            if (i >= count) return 'ready';
            const next = (q + 1) * SPLIT_HOP;
            const from = i;
            const at = f;
            const mode = m;
            const runsOn = (k: number) => frames(k) - at === k - from && modes(k) === mode;
            let j = Math.min(count, i + (next - f));
            if (!runsOn(j)) {
                // A jump between i and j: the first frame past it (jumps only go back, so the frames
                // before it run on from f and none after it does).
                let lo = from;
                let hi = j;
                while (hi - lo > 1) {
                    const mid = (lo + hi) >> 1;
                    if (runsOn(mid)) lo = mid;
                    else hi = mid;
                }
                j = hi;
            } else if (frames(j) < next) {
                return 'ready'; // the rest of the span is in this chunk
            }
            i = j;
            f = frames(j);
            m = modes(j);
        }
    }

    /** The tonal part at a timeline frame, split as `mode` says (its chunk must be prepared; 0 otherwise). */
    tonal(frame: number, channel: number, mode: SplitMode = 0): number {
        return this._at(frame, mode).part(frame, channel, true);
    }

    /** The atonal part at a timeline frame, split as `mode` says (its chunk must be prepared; 0 otherwise). */
    atonal(frame: number, channel: number, mode: SplitMode = 0): number {
        return this._at(frame, mode).part(frame, channel, false);
    }

    private _at(frame: number, mode: SplitMode): SplitCache {
        const q = Math.floor(frame / SPLIT_HOP);
        if (q !== this._sq || mode !== this._sm) {
            this._sq = q;
            this._sm = mode;
            this._sc = this._cache(q, mode);
        }
        return this._sc;
    }

    /** Which cache chunk q comes from in `mode`: a loop's own only where its making reaches across an edge. */
    private _cache(q: number, mode: SplitMode): SplitCache {
        const loop = this._loop;
        if (mode === 0 || !loop) return this._linear;
        if (mode === 2 && (q - REACH_BEHIND) * SPLIT_HOP < loop.start) return this._around;
        return (q + REACH_AHEAD) * SPLIT_HOP > loop.end ? this._ahead : this._linear;
    }

    /** A frame of the loop's audio: past its end, its start again; with `before`, before its start, its end. */
    private _wrap(f: number, before: boolean): number {
        const loop = this._loop!;
        const len = loop.end - loop.start;
        if (f >= loop.end) return loop.start + ((f - loop.start) % len);
        if (before && f < loop.start) return loop.end - ((loop.start - f) % len || len);
        return f;
    }

    /** Whether frames [from, to] of the loop's audio are in memory: the stem's frames they come from, piece by piece. */
    private _hasLooped(from: number, to: number, before: boolean, has: Has): boolean {
        const end = this._loop!.end;
        for (let a = from; a <= to;) {
            const m = this._wrap(a, before);
            // The frames run on from m up to the loop's end (then they wrap).
            const b = Math.min(to, a + (end - 1 - m));
            if (!has(m, m + (b - a))) return false;
            a = b + 1;
        }
        return true;
    }
}
