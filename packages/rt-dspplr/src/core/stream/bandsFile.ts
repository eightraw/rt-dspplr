// ---------------------------------------------------------------------------
// bands.bin — low-frequency energy track for the high-pass preview.
//
// Per bin of `framesPerBin` frames (default 2048, ≈ 43 ms at 48 kHz), the
// mean square of the mono downmix: total, and after the player's own
// high-pass (4th-order Butterworth) at each stored cutoff (25 … 566 Hz,
// half-octave steps). The energy a high-pass at fc leaves is E_hp interpolated in
// log-energy over log-frequency between the stored cutoffs; its ratio to the
// total scales the bin's peaks. Measured directly, not as E_total − E_lowpass,
// which cancels catastrophically where the high-pass removes nearly
// everything (hum, rumble): see prepare/overviewAnalysis.ts.
//
// Little-endian:
//   0  char[4] "RTDB"
//   4  u16     version (1)
//   6  u16     header bytes (24 + 4 × cutoffs, rounded up to 8)
//   8  u32     sample rate
//  12  u32     frames per bin
//  16  u32     bins
//  20  u16     cutoffs (K)
//  22  u16     reserved
//  24  f32[K]  cutoffs in Hz, ascending
//  data: bins × (1 + K) u16, bin-major: [total, hp(c0), …, hp(cK-1)]
//        value = round((10·log10(meanSquare) + 160) × 400), clamped to 0..65535
//        (0.0025 dB steps, −160 … +3.8 dB; 0 means silence)
// ---------------------------------------------------------------------------

export const BANDS_MAGIC = 'RTDB';
export const BANDS_VERSION = 1;
/** Half-octave steps over the high-pass range (0–500 Hz): a strong tone between two cutoffs stays within ~0.5 dB. */
export const DEFAULT_BAND_CUTOFFS = [25, 35, 50, 71, 100, 141, 200, 283, 400, 566] as const;
export const DEFAULT_FRAMES_PER_BAND_BIN = 2048;

export interface BandsFile {
    sampleRate: number;
    framesPerBin: number;
    bins: number;
    cutoffs: number[];
    /** bins × (1 + cutoffs) mean squares, bin-major: total, then each low-pass. */
    meanSquares: Float32Array;
}

const OFFSET_DB = 160;
const STEPS_PER_DB = 400;

export function encodeMeanSquare(ms: number): number {
    if (!(ms > 0)) return 0;
    const q = Math.round((10 * Math.log10(ms) + OFFSET_DB) * STEPS_PER_DB);
    return q < 0 ? 0 : q > 65535 ? 65535 : q;
}

export function decodeMeanSquare(q: number): number {
    return q === 0 ? 0 : 10 ** ((q / STEPS_PER_DB - OFFSET_DB) / 10);
}

function headerBytes(cutoffs: number): number {
    return Math.ceil((24 + 4 * cutoffs) / 8) * 8;
}

export function encodeBandsFile(file: BandsFile): Uint8Array {
    const k = file.cutoffs.length;
    const header = headerBytes(k);
    const bytes = new Uint8Array(header + file.bins * (1 + k) * 2);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < 4; i += 1) bytes[i] = BANDS_MAGIC.charCodeAt(i);
    view.setUint16(4, BANDS_VERSION, true);
    view.setUint16(6, header, true);
    view.setUint32(8, file.sampleRate, true);
    view.setUint32(12, file.framesPerBin, true);
    view.setUint32(16, file.bins, true);
    view.setUint16(20, k, true);
    file.cutoffs.forEach((c, i) => view.setFloat32(24 + 4 * i, c, true));
    for (let i = 0; i < file.bins * (1 + k); i += 1) view.setUint16(header + 2 * i, encodeMeanSquare(file.meanSquares[i]), true);
    return bytes;
}

export function decodeBandsFile(buffer: ArrayBuffer): BandsFile {
    if (buffer.byteLength < 24) throw new Error('Not an rtd bands file (too short)');
    const view = new DataView(buffer);
    const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    if (magic !== BANDS_MAGIC) throw new Error('Not an rtd bands file');
    if (view.getUint16(4, true) > BANDS_VERSION) throw new Error('Unsupported bands version');
    const header = view.getUint16(6, true);
    const sampleRate = view.getUint32(8, true);
    const framesPerBin = view.getUint32(12, true);
    const bins = view.getUint32(16, true);
    const k = view.getUint16(20, true);
    const n = bins * (1 + k);
    // The sizes come from the file: check them against its length before allocating anything.
    if (header < 24 + 4 * k || buffer.byteLength < header + 2 * n) {
        throw new Error(`rtd bands file: ${buffer.byteLength} bytes, its header says ${header} + ${bins} bins × ${1 + k} values`);
    }
    const cutoffs = Array.from({ length: k }, (_, i) => view.getFloat32(24 + 4 * i, true));
    const meanSquares = new Float32Array(n);
    for (let i = 0; i < n; i += 1) meanSquares[i] = decodeMeanSquare(view.getUint16(header + 2 * i, true));
    return { sampleRate, framesPerBin, bins, cutoffs, meanSquares };
}

/**
 * Fraction of a bin's energy a 4th-order Butterworth high-pass at `hz` keeps:
 * E_hp(hz) / E_total, E_hp interpolated in dB over log2(Hz) between the
 * stored cutoffs (below the lowest one, towards E_total at half of it).
 */
export function highPassEnergyRatio(file: BandsFile, bin: number, hz: number): number {
    const k = file.cutoffs.length;
    const base = bin * (1 + k);
    const total = file.meanSquares[base];
    if (!(total > 0) || !(hz > 0) || k === 0) return 1;
    const cut = file.cutoffs;
    const hp = (i: number) => Math.max(1e-30, Math.min(total, file.meanSquares[base + 1 + i]));
    let kept: number;
    if (hz <= cut[0]) {
        const lo = cut[0] / 2;
        if (hz <= lo) return 1;
        const t = Math.log(hz / lo) / Math.log(cut[0] / lo);
        kept = Math.exp(Math.log(total) * (1 - t) + Math.log(hp(0)) * t);
    } else if (hz >= cut[k - 1]) {
        kept = hp(k - 1);
    } else {
        let i = 0;
        while (hz > cut[i + 1]) i += 1;
        const t = Math.log(hz / cut[i]) / Math.log(cut[i + 1] / cut[i]);
        kept = Math.exp(Math.log(hp(i)) * (1 - t) + Math.log(hp(i + 1)) * t);
    }
    return Math.min(1, Math.max(0, kept / total));
}
