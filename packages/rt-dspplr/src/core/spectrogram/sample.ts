import { pickPeakPyramidLevel } from '../waveform/pyramid';
import type { SpectralPyramid } from './protocol';
import type { SpectrogramData } from './SpectrogramAnalyzer';

// ---------------------------------------------------------------------------
// Reading a window of the spectral pyramid at a given width
// ---------------------------------------------------------------------------
//
// The level is picked as the waveform picks its peaks: the finest one that has
// no more frames in sight than there are columns. A column then takes the
// loudest frame it covers, or, zoomed in past the finest level, a blend of the
// two frames around it. The result has the shape of a worker's answer, so it
// is coloured the same way.

const decodeTables = new Map<string, Float32Array>();

/** Linear magnitude of each stored 8-bit level. */
function decodeTable(topDb: number, rangeDb: number): Float32Array {
    const key = `${topDb}:${rangeDb}`;
    const known = decodeTables.get(key);
    if (known) return known;
    const table = new Float32Array(256);
    for (let q = 1; q < 256; q += 1) table[q] = Math.pow(10, (topDb - rangeDb + (q / 255) * rangeDb) / 20);
    if (decodeTables.size > 16) decodeTables.clear();
    decodeTables.set(key, table);
    return table;
}

/**
 * The part of the clip from `start` to `end` seconds across `columns`
 * columns. Pass the previous result as `reuse` to fill its arrays instead of
 * allocating new ones.
 */
export function sampleSpectralPyramid(
    pyramid: SpectralPyramid,
    start: number,
    end: number,
    columns: number,
    reuse?: SpectrogramData | null,
): SpectrogramData {
    const rows = pyramid.rows;
    const cells = columns * rows;
    const hasB = pyramid.levels[0]?.b != null;
    const magA = reuse && reuse.magA.length === cells ? reuse.magA : new Float32Array(cells);
    const magB = hasB ? (reuse?.magB && reuse.magB.length === cells ? reuse.magB : new Float32Array(cells)) : null;
    const startSample = start * pyramid.sampleRate;
    const endSample = end * pyramid.sampleRate;
    const level = pickPeakPyramidLevel(pyramid, startSample, endSample, columns) ?? pyramid.levels[0];
    const table = decodeTable(pyramid.topDb, pyramid.rangeDb);
    const perColumn = (endSample - startSample) / columns;
    const bin = level.binSize;
    const last = level.frames - 1;

    for (let column = 0; column < columns; column += 1) {
        const from = startSample + column * perColumn;
        const to = from + perColumn;
        // Frame f covers samples from f·bin to (f + 1)·bin; its centre is (f + 0.5)·bin.
        if (perColumn < bin) {
            const position = Math.min(last, Math.max(0, (from + to) / 2 / bin - 0.5));
            const left = Math.floor(position);
            const right = Math.min(last, left + 1);
            const k = position - left;
            const l = left * rows;
            const r = right * rows;
            for (let row = 0; row < rows; row += 1) {
                const at = row * columns + column;
                magA[at] = table[level.a[l + row]] * (1 - k) + table[level.a[r + row]] * k;
                if (magB && level.b) magB[at] = table[level.b[l + row]] * (1 - k) + table[level.b[r + row]] * k;
            }
            continue;
        }
        const first = Math.min(last, Math.max(0, Math.floor(from / bin)));
        const final = Math.min(last, Math.max(first, Math.ceil(to / bin) - 1));
        for (let row = 0; row < rows; row += 1) {
            let qa = 0;
            let qb = 0;
            for (let frame = first; frame <= final; frame += 1) {
                const index = frame * rows + row;
                if (level.a[index] > qa) qa = level.a[index];
                if (level.b && level.b[index] > qb) qb = level.b[index];
            }
            const at = row * columns + column;
            magA[at] = table[qa];
            if (magB) magB[at] = table[qb];
        }
    }

    return {
        start,
        end,
        columns,
        rows,
        magA,
        magB,
        referenceSum: pyramid.referenceSum,
        referenceMax: pyramid.referenceMax,
    };
}
