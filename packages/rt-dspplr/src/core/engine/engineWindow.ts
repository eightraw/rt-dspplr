// ---------------------------------------------------------------------------
// The segments a stream engine should hold around its playhead, for the
// sources that feed one (prepared clips from their segment store, whole clips
// from their decoded buffer): the playhead's segment, the one before while the
// stretcher's history reaches into it, the next ones along the play path
// (through the loop), and both ends of the loop as far as the engine reads
// across its wrap. Most important first.
// ---------------------------------------------------------------------------

export interface EngineWindowOptions {
    /** Loop in timeline frames, or null. */
    loop: { start: number; end: number } | null;
    /** Segments to hold ahead of the playhead's. */
    ahead: number;
    /** Frames the engine reads behind the playhead (the stretcher's history). */
    historyFrames: number;
    /** The speed: the engine reads this much more audio across a loop wrap. */
    speed: number;
}

/** The segment holding `frame`, given each segment's start and the total (length n + 1). */
export function segmentAt(starts: readonly number[], frame: number): number {
    let lo = 0;
    let hi = starts.length - 2;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= frame) lo = mid;
        else hi = mid - 1;
    }
    return lo;
}

export function engineWindow(starts: readonly number[], frame: number, options: EngineWindowOptions): number[] {
    const count = starts.length - 1;
    const total = starts[count];
    const out: number[] = [];
    if (count <= 0) return out;
    const add = (i: number) => {
        if (i >= 0 && i < count && !out.includes(i)) out.push(i);
    };
    const current = segmentAt(starts, Math.min(total - 1, Math.max(0, Math.floor(frame))));
    add(current);
    if (frame - starts[current] < options.historyFrames) add(current - 1);
    const loop = options.loop;
    let cursor = starts[current + 1];
    for (let k = 0; k < Math.max(1, options.ahead); k += 1) {
        if (loop && frame < loop.end && cursor >= loop.end) cursor = loop.start;
        if (cursor >= total) {
            if (!loop) break;
            cursor = loop.start;
        }
        const i = segmentAt(starts, cursor);
        add(i);
        cursor = starts[i + 1];
    }
    if (loop && loop.end > loop.start) {
        // Both ends of the loop, as far as the engine reads across the wrap: its look-ahead
        // past the end continues at the start, its history behind the start is the end.
        const margin = options.historyFrames * Math.max(1, options.speed);
        const span = (from: number, to: number) => {
            for (let i = segmentAt(starts, from); i <= segmentAt(starts, to); i += 1) add(i);
        };
        span(loop.start, Math.min(loop.end - 1, loop.start + margin));
        span(Math.max(loop.start, loop.end - margin), loop.end - 1);
    }
    return out;
}
