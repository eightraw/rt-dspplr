import type { SpectralLevel, SpectralPyramid } from '../spectrogram/protocol';

// ---------------------------------------------------------------------------
// spectrogram.bin — the precomputed overview spectrogram of a prepared file.
//
// Frames on a grid of `hop` frames (4096 ≈ 85 ms at 48 kHz), each the mono
// downmix through the spectrogram worker's own analysis (shared code:
// core/spectrogram/spectral.ts — Hann-windowed 4096/2048/1024-point bands
// blended on a logarithmic axis of `rows` rows, minHz…maxHz), stored as 8-bit
// levels: 255 = topDb, 0 = topDb − rangeDb and below, on an ABSOLUTE scale
// (fixed topDb), so the file can be written in one streaming pass. Coarser
// levels pool 8 frames (the louder of each, row by row).
//
// Little-endian:
//   0  char[4] "RTDS"
//   4  u16     version (1)
//   6  u16     header bytes (48 + 16 × levels, rounded up to 8)
//   8  u32     sample rate
//  12  u16     rows
//  14  u16     level count
//  16  f64     frames (timeline)
//  24  f32     minHz       28 f32 maxHz
//  32  f32     topDb       36 f32 rangeDb
//  40  f32     referenceMax (loudest bin, linear, the worker's 2048-point scale)
//  44  u32     reserved
//  48  level table, finest first: u32 framesPerColumn (hop), u32 columns, f64 byteOffset
//  data, COARSEST FIRST (one Range request = header + overview), per level:
//        columns × rows u8, column-major, row 0 = the highest frequency
//        (the layout of SpectralLevel.a)
// ---------------------------------------------------------------------------

export const SPECTROGRAM_MAGIC = 'RTDS';
export const SPECTROGRAM_VERSION = 1;
const FIXED = 48;
const ENTRY = 16;

export interface SpectrogramFile {
    sampleRate: number;
    rows: number;
    frames: number;
    minHz: number;
    maxHz: number;
    topDb: number;
    rangeDb: number;
    referenceMax: number;
    /** Finest first; `a` is null when its bytes were not (yet) loaded. */
    levels: Array<{ hop: number; columns: number; a: Uint8Array | null }>;
}

export interface SpectrogramLevelLayout {
    hop: number;
    columns: number;
    byteOffset: number;
    byteLength: number;
}

function headerBytes(levels: number): number {
    return Math.ceil((FIXED + ENTRY * levels) / 8) * 8;
}

export function spectrogramLayout(rows: number, levels: Array<{ hop: number; columns: number }>) {
    const header = headerBytes(levels.length);
    const out: SpectrogramLevelLayout[] = levels.map((l) => ({ ...l, byteOffset: 0, byteLength: l.columns * rows }));
    let offset = header;
    for (let i = out.length - 1; i >= 0; i -= 1) {
        out[i].byteOffset = offset;
        offset += Math.ceil(out[i].byteLength / 8) * 8;
    }
    return { headerBytes: header, totalBytes: offset, levels: out };
}

export function encodeSpectrogramFile(file: SpectrogramFile): Uint8Array {
    const layout = spectrogramLayout(file.rows, file.levels);
    const bytes = new Uint8Array(layout.totalBytes);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < 4; i += 1) bytes[i] = SPECTROGRAM_MAGIC.charCodeAt(i);
    view.setUint16(4, SPECTROGRAM_VERSION, true);
    view.setUint16(6, layout.headerBytes, true);
    view.setUint32(8, file.sampleRate, true);
    view.setUint16(12, file.rows, true);
    view.setUint16(14, file.levels.length, true);
    view.setFloat64(16, file.frames, true);
    view.setFloat32(24, file.minHz, true);
    view.setFloat32(28, file.maxHz, true);
    view.setFloat32(32, file.topDb, true);
    view.setFloat32(36, file.rangeDb, true);
    view.setFloat32(40, file.referenceMax, true);
    layout.levels.forEach((level, i) => {
        const entry = FIXED + i * ENTRY;
        view.setUint32(entry, level.hop, true);
        view.setUint32(entry + 4, level.columns, true);
        view.setFloat64(entry + 8, level.byteOffset, true);
        const data = file.levels[i].a;
        if (!data) throw new Error('encodeSpectrogramFile: every level needs its data');
        bytes.set(data.subarray(0, level.byteLength), level.byteOffset);
    });
    return bytes;
}

/** Read a spectrogram file or its first part; levels not fully present come back with `a: null`. */
export function decodeSpectrogramFile(buffer: ArrayBuffer): SpectrogramFile & { layout: SpectrogramLevelLayout[] } {
    const view = new DataView(buffer);
    const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    if (magic !== SPECTROGRAM_MAGIC) throw new Error('Not an rtd spectrogram file');
    if (view.getUint16(4, true) > SPECTROGRAM_VERSION) throw new Error('Unsupported spectrogram version');
    const rows = view.getUint16(12, true);
    const count = view.getUint16(14, true);
    const layout: SpectrogramLevelLayout[] = [];
    for (let i = 0; i < count; i += 1) {
        const entry = FIXED + i * ENTRY;
        const hop = view.getUint32(entry, true);
        const columns = view.getUint32(entry + 4, true);
        layout.push({ hop, columns, byteOffset: view.getFloat64(entry + 8, true), byteLength: hop > 0 ? columns * rows : 0 });
    }
    return {
        sampleRate: view.getUint32(8, true),
        rows,
        frames: view.getFloat64(16, true),
        minHz: view.getFloat32(24, true),
        maxHz: view.getFloat32(28, true),
        topDb: view.getFloat32(32, true),
        rangeDb: view.getFloat32(36, true),
        referenceMax: view.getFloat32(40, true),
        levels: layout.map((l) => ({
            hop: l.hop,
            columns: l.columns,
            a: l.byteOffset + l.byteLength <= buffer.byteLength ? new Uint8Array(buffer, l.byteOffset, l.byteLength) : null,
        })),
        layout,
    };
}

/** The loaded levels as a SpectralPyramid the spectrogram view draws as-is. */
export function toSpectralPyramid(file: SpectrogramFile): SpectralPyramid | null {
    const levels: SpectralLevel[] = file.levels
        .filter((l) => l.a)
        .map((l) => ({ binSize: l.hop, frames: l.columns, a: l.a!, b: null }));
    if (levels.length === 0) return null;
    return {
        sampleRate: file.sampleRate,
        totalSamples: file.frames,
        rows: file.rows,
        minHz: file.minHz,
        maxHz: file.maxHz,
        topDb: file.topDb,
        rangeDb: file.rangeDb,
        referenceSum: file.referenceMax,
        referenceMax: file.referenceMax,
        levels,
    };
}
