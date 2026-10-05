import type { WaveformPeakLevel, WaveformPeakPyramid } from '../waveform/pyramid';

// ---------------------------------------------------------------------------
// peaks.bin — multi-level min/max/RMS peaks of a prepared file.
//
// Little-endian. Header (32 bytes), then the level table, then the data:
//
//   0  char[4] magic "RTDP"
//   4  u16     version (1)
//   6  u16     header bytes (32 + 16 × levels, rounded up to 8): where data may start
//   8  u32     sample rate of the playback timeline
//  12  u16     channels
//  14  u16     level count
//  16  f64     frames (f64: exact to 2^53, i.e. beyond any u32)
//  24  u32     flags: bit 0 = RMS present (always set in v1)
//  28  u32     reserved (0)
//  32  level table, finest level first, 16 bytes each:
//        u32 framesPerPeak, u32 peak count, f64 byte offset of the level's data
//
// Level data, stored COARSEST FIRST so that one HTTP Range request for the
// start of the file brings the header and every level but the finest (which
// is ~85 % of the file) — the overview draws from that while the finest level
// follows. Inside a level, channel after channel, each as three Int16 arrays:
// min[peaks], max[peaks], rms[peaks]. Values are sample × 32768, rounded and
// clamped to Int16 (RMS likewise, always ≥ 0).
//
// Why two Int16 and not two float16 packed in an Int32: the same 4 bytes per
// min/max pair, decoding is a plain Int16Array view in every browser (no
// Float16Array, no bit twiddling), and linear 1/32768 steps are finer than a
// device pixel of any waveform. float16 would only win for a log-scale
// display of very quiet material, which this player does not draw.
// ---------------------------------------------------------------------------

export const PEAKS_MAGIC = 'RTDP';
export const PEAKS_VERSION = 1;
const HEADER_FIXED = 32;
const LEVEL_ENTRY = 16;

export interface PeakChannelData {
    min: Int16Array;
    max: Int16Array;
    rms: Int16Array;
}

export interface PeakLevelData {
    framesPerPeak: number;
    peaks: number;
    /** Per channel; absent when the level's bytes were not (yet) loaded. */
    channels: PeakChannelData[] | null;
}

export interface PeaksFile {
    version: number;
    sampleRate: number;
    channels: number;
    frames: number;
    /** Finest first. */
    levels: PeakLevelData[];
}

export interface PeakLevelLayout {
    framesPerPeak: number;
    peaks: number;
    byteOffset: number;
    byteLength: number;
}

function headerBytes(levelCount: number): number {
    return Math.ceil((HEADER_FIXED + LEVEL_ENTRY * levelCount) / 8) * 8;
}

/** Byte layout of every level for the given level shape (finest first, data coarsest first). */
export function peaksLayout(channels: number, levels: Array<{ framesPerPeak: number; peaks: number }>): { headerBytes: number; totalBytes: number; levels: PeakLevelLayout[] } {
    const header = headerBytes(levels.length);
    const out: PeakLevelLayout[] = levels.map((level) => ({ ...level, byteOffset: 0, byteLength: level.peaks * channels * 3 * 2 }));
    let offset = header;
    for (let i = out.length - 1; i >= 0; i -= 1) {
        out[i].byteOffset = offset;
        // Keep every level 8-byte aligned so Int16Array views never need a copy.
        offset += Math.ceil(out[i].byteLength / 8) * 8;
    }
    return { headerBytes: header, totalBytes: offset, levels: out };
}

export function encodePeaksFile(file: PeaksFile): Uint8Array {
    const layout = peaksLayout(file.channels, file.levels);
    const bytes = new Uint8Array(layout.totalBytes);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < 4; i += 1) bytes[i] = PEAKS_MAGIC.charCodeAt(i);
    view.setUint16(4, PEAKS_VERSION, true);
    view.setUint16(6, layout.headerBytes, true);
    view.setUint32(8, file.sampleRate, true);
    view.setUint16(12, file.channels, true);
    view.setUint16(14, file.levels.length, true);
    view.setFloat64(16, file.frames, true);
    view.setUint32(24, 1, true);
    view.setUint32(28, 0, true);
    layout.levels.forEach((level, i) => {
        const entry = HEADER_FIXED + i * LEVEL_ENTRY;
        view.setUint32(entry, level.framesPerPeak, true);
        view.setUint32(entry + 4, level.peaks, true);
        view.setFloat64(entry + 8, level.byteOffset, true);
        const data = file.levels[i].channels;
        if (!data) throw new Error('encodePeaksFile: every level needs its data');
        let p = level.byteOffset;
        for (const channel of data) {
            for (const array of [channel.min, channel.max, channel.rms]) {
                bytes.set(new Uint8Array(array.buffer, array.byteOffset, level.peaks * 2), p);
                p += level.peaks * 2;
            }
        }
    });
    return bytes;
}

/**
 * Read a peaks file, or the first part of one: levels whose bytes are not all
 * in `buffer` come back with `channels: null`. Needs at least the header.
 */
export function decodePeaksFile(buffer: ArrayBuffer, byteOffset = 0): PeaksFile & { headerBytes: number; layout: PeakLevelLayout[] } {
    const view = new DataView(buffer, byteOffset);
    const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    if (magic !== PEAKS_MAGIC) throw new Error('Not an rtd peaks file');
    const version = view.getUint16(4, true);
    if (version > PEAKS_VERSION) throw new Error(`Unsupported peaks version ${version}`);
    const header = view.getUint16(6, true);
    const sampleRate = view.getUint32(8, true);
    const channels = view.getUint16(12, true);
    const levelCount = view.getUint16(14, true);
    const frames = view.getFloat64(16, true);
    const layout: PeakLevelLayout[] = [];
    const levels: PeakLevelData[] = [];
    for (let i = 0; i < levelCount; i += 1) {
        const entry = HEADER_FIXED + i * LEVEL_ENTRY;
        const framesPerPeak = view.getUint32(entry, true);
        const peaks = view.getUint32(entry + 4, true);
        const offset = view.getFloat64(entry + 8, true);
        const byteLength = peaks * channels * 6;
        layout.push({ framesPerPeak, peaks, byteOffset: offset, byteLength });
        levels.push({ framesPerPeak, peaks, channels: null });
    }
    const available = buffer.byteLength - byteOffset;
    layout.forEach((level, i) => {
        if (level.byteOffset + level.byteLength > available) return;
        levels[i].channels = readLevel(buffer, byteOffset + level.byteOffset, level.peaks, channels);
    });
    return { version, sampleRate, channels, frames, levels, headerBytes: header, layout };
}

/** Views (no copy when aligned) of one level's data starting at `offset` in `buffer`. */
export function readLevel(buffer: ArrayBuffer, offset: number, peaks: number, channels: number): PeakChannelData[] {
    const out: PeakChannelData[] = [];
    let p = offset;
    const take = () => {
        const array = p % 2 === 0
            ? new Int16Array(buffer, p, peaks)
            : new Int16Array(buffer.slice(p, p + peaks * 2));
        p += peaks * 2;
        return array;
    };
    for (let c = 0; c < channels; c += 1) {
        const min = take();
        const max = take();
        const rms = take();
        out.push({ min, max, rms });
    }
    return out;
}

/** One display level: channels merged (min of mins, max of maxes, RMS over all channels). */
export function mergeLevel(level: PeakLevelData): WaveformPeakLevel | null {
    const data = level.channels;
    if (!data || data.length === 0) return null;
    const n = level.peaks;
    const minPeaks = new Float32Array(n);
    const maxPeaks = new Float32Array(n);
    const rmsPeaks = new Float32Array(n);
    const scale = 1 / 32768;
    const count = data.length;
    for (let i = 0; i < n; i += 1) {
        let lo = Infinity;
        let hi = -Infinity;
        let sq = 0;
        for (let c = 0; c < count; c += 1) {
            const ch = data[c];
            if (ch.min[i] < lo) lo = ch.min[i];
            if (ch.max[i] > hi) hi = ch.max[i];
            sq += ch.rms[i] * ch.rms[i];
        }
        minPeaks[i] = lo * scale;
        maxPeaks[i] = hi * scale;
        rmsPeaks[i] = Math.sqrt(sq / count) * scale;
    }
    return { binSize: level.framesPerPeak, minPeaks, maxPeaks, rmsPeaks };
}

/** The timeline's pyramid from the loaded levels (finest first, missing ones skipped). */
export function peaksToPyramid(file: Pick<PeaksFile, 'frames' | 'levels'>, merged?: Map<number, WaveformPeakLevel>): WaveformPeakPyramid {
    const levels: WaveformPeakLevel[] = [];
    for (const level of file.levels) {
        const done = merged?.get(level.framesPerPeak) ?? mergeLevel(level);
        if (!done) continue;
        merged?.set(level.framesPerPeak, done);
        levels.push(done);
    }
    return { totalSamples: file.frames, levels };
}
