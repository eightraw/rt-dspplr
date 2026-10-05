import { resamplerDesign, type ResampleResult } from './jobs';
import type { JobPool } from './pool';
import { resampleInputRange, StreamingResampler, type ResamplerInfo, type ResamplerOptions } from './resampler';

// ---------------------------------------------------------------------------
// Resampling on prepare's worker pool. The output timeline is cut into fixed
// chunks (OUT_CHUNK frames). Each chunk is resampled from its slice of the
// input, with the filter's half-length of context on both sides
// (resampleRange). Every output frame reads exactly the taps the streaming
// resampler would read, in the same order, so the result is bit-identical to
// StreamingResampler for any chunking and any number of threads (tested).
// Chunks come back in timeline order. No more than the pool can work on is in
// flight, so memory stays bounded.
// ---------------------------------------------------------------------------

/** Output frames per resampling chunk (≈ 11 s at 48 kHz). */
export const OUT_CHUNK = 1 << 19;

export function resamplerInfo(from: number, to: number, options?: ResamplerOptions): ResamplerInfo {
    return resamplerDesign(from, to, options).info;
}

export async function* resampleInParallel(
    source: AsyncIterable<Float32Array[]>,
    from: number,
    to: number,
    pool: JobPool,
    options?: ResamplerOptions,
    chunk = OUT_CHUNK,
): AsyncGenerator<Float32Array[]> {
    const design = resamplerDesign(from, to, options);
    const { info, half } = design;
    let buf: Float32Array[] | null = null;
    let base = 0; // input index of buf[c][0]
    let len = 0;
    let inFrames = 0;
    let next = 0; // next output frame to dispatch
    let index = 0;
    const queue: Array<Promise<ResampleResult>> = [];

    const append = (block: Float32Array[]) => {
        const n = block[0]?.length ?? 0;
        if (!buf) buf = block.map(() => new Float32Array(Math.max(1 << 16, n * 2)));
        if (len + n > buf[0].length) {
            const size = Math.max(buf[0].length * 2, len + n);
            buf = buf.map((old) => {
                const grown = new Float32Array(size);
                grown.set(old.subarray(0, len));
                return grown;
            });
        }
        for (let c = 0; c < buf.length; c += 1) buf[c].set(block[c], len);
        len += n;
        inFrames += n;
    };

    const dispatch = (n0: number, n1: number, known: number) => {
        const [a, b] = resampleInputRange(info, half, n0, n1);
        const s = Math.max(0, a);
        const e = Math.max(s, Math.min(b, base + len));
        const channels = buf!.map((c) => c.slice(s - base, e - base));
        queue.push(pool.run({ kind: 'resample', index: index++, from, to, options, xStart: s, inFrames: known, n0, n1, channels }) as Promise<ResampleResult>);
        // Input before the next chunk's first tap is no longer needed.
        const keepFrom = Math.max(0, resampleInputRange(info, half, n1, n1 + 1)[0]);
        const drop = Math.min(len, Math.max(0, keepFrom - base));
        if (drop > 0) {
            for (const c of buf!) c.copyWithin(0, drop, len);
            len -= drop;
            base += drop;
        }
    };

    for await (const block of source) {
        if (!block.length || !(block[0]?.length > 0)) continue;
        append(block);
        for (;;) {
            const n1 = next + chunk;
            const need = resampleInputRange(info, half, next, n1)[1];
            if (need > inFrames) break;
            dispatch(next, n1, Infinity);
            next = n1;
        }
        while (queue.length > pool.size) yield (await queue.shift()!).channels;
    }
    if (!buf) return;
    const total = StreamingResampler.outputFrames(inFrames, from, to);
    while (next < total) {
        const n1 = Math.min(total, next + chunk);
        dispatch(next, n1, inFrames);
        next = n1;
        while (queue.length > pool.size) yield (await queue.shift()!).channels;
    }
    while (queue.length) yield (await queue.shift()!).channels;
}
