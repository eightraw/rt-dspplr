// ---------------------------------------------------------------------------
// WAV (RIFF/WAVE) header parsing and PCM sample conversion, shared by the
// Node prepare step (streaming, chunk by chunk) and the browser segment
// decoder (a whole small file in memory). No Node or DOM APIs here.
// ---------------------------------------------------------------------------

/** 'int' = integer PCM (8 unsigned, 16/24/32 signed), 'float' = IEEE float (32/64). */
export type WavEncoding = 'int' | 'float';

export interface WavFormat {
    encoding: WavEncoding;
    bitsPerSample: number;
    channels: number;
    sampleRate: number;
    /** Bytes per frame (all channels). */
    blockAlign: number;
    /** Byte offset of the first sample in the file. */
    dataOffset: number;
    /**
     * Bytes of sample data as the header declares them; null when the header
     * says "unknown" (0 or 0xFFFFFFFF, as streaming recorders write it): read to the end.
     */
    dataBytes: number | null;
}

const WAVE_FORMAT_PCM = 0x0001;
const WAVE_FORMAT_IEEE_FLOAT = 0x0003;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

const littleEndianHost = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

export class WavFormatError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'WavFormatError';
    }
}

function fourCC(bytes: Uint8Array, offset: number): string {
    return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

/** True when the bytes start like a RIFF/WAVE file (needs 12 bytes). */
export function looksLikeWav(bytes: Uint8Array): boolean {
    return bytes.length >= 12 && fourCC(bytes, 0) === 'RIFF' && fourCC(bytes, 8) === 'WAVE';
}

/**
 * Parse the header from the start of a WAV file. Returns null when more bytes
 * are needed (the `data` chunk has not been reached yet); throws on anything
 * that is not a supported WAV.
 */
export function parseWavHeader(bytes: Uint8Array): WavFormat | null {
    if (bytes.length < 12) return null;
    if (!looksLikeWav(bytes)) {
        throw new WavFormatError('Not a RIFF/WAVE file');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 12;
    let fmt: Omit<WavFormat, 'dataOffset' | 'dataBytes'> | null = null;
    while (offset + 8 <= bytes.length) {
        const id = fourCC(bytes, offset);
        const size = view.getUint32(offset + 4, true);
        const body = offset + 8;
        if (id === 'data') {
            if (!fmt) throw new WavFormatError('WAV "data" chunk before "fmt "');
            const declared = size === 0 || size === 0xffffffff ? null : size;
            return { ...fmt, dataOffset: body, dataBytes: declared };
        }
        if (body + size > bytes.length) return null; // chunk body not complete yet
        if (id === 'fmt ') {
            if (size < 16) throw new WavFormatError('WAV "fmt " chunk too short');
            let tag = view.getUint16(body, true);
            const channels = view.getUint16(body + 2, true);
            const sampleRate = view.getUint32(body + 4, true);
            const blockAlign = view.getUint16(body + 12, true);
            const bitsPerSample = view.getUint16(body + 14, true);
            if (tag === WAVE_FORMAT_EXTENSIBLE && size >= 40) {
                // The sub-format GUID starts with the format tag.
                tag = view.getUint16(body + 24, true);
            }
            let encoding: WavEncoding;
            if (tag === WAVE_FORMAT_PCM && [8, 16, 24, 32].includes(bitsPerSample)) encoding = 'int';
            else if (tag === WAVE_FORMAT_IEEE_FLOAT && (bitsPerSample === 32 || bitsPerSample === 64)) encoding = 'float';
            else throw new WavFormatError(`Unsupported WAV encoding (format tag ${tag}, ${bitsPerSample} bits)`);
            if (channels < 1 || channels > 32) throw new WavFormatError(`Unsupported channel count ${channels}`);
            if (!(sampleRate >= 1000 && sampleRate <= 768000)) throw new WavFormatError(`Unsupported sample rate ${sampleRate}`);
            const expectedAlign = channels * (bitsPerSample / 8);
            fmt = { encoding, bitsPerSample, channels, sampleRate, blockAlign: blockAlign || expectedAlign };
            if (fmt.blockAlign !== expectedAlign) throw new WavFormatError(`Unexpected WAV block align ${blockAlign}`);
        }
        // Chunks are word-aligned: an odd size is followed by a pad byte.
        offset = body + size + (size & 1);
    }
    return null;
}

/**
 * Convert interleaved sample bytes (whole frames) to planar Float32 channels.
 * Integer samples map to [-1, 1) by dividing by 2^(bits-1), so 16-bit audio
 * converts back exactly with `floatToInt16`.
 */
export function decodeInterleaved(
    format: Pick<WavFormat, 'encoding' | 'bitsPerSample' | 'channels'>,
    bytes: Uint8Array,
    frames: number,
    into?: Float32Array[],
): Float32Array[] {
    const { channels, bitsPerSample, encoding } = format;
    const out = into ?? Array.from({ length: channels }, () => new Float32Array(frames));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const bytesPer = bitsPerSample / 8;
    let p = 0;
    if (encoding === 'int' && bitsPerSample === 16 && bytes.byteOffset % 2 === 0 && littleEndianHost) {
        // Fast path: an aligned Int16 view (the usual case for fetched segments).
        const samples = new Int16Array(bytes.buffer, bytes.byteOffset, frames * channels);
        const scale = 1 / 32768;
        if (channels === 1) {
            const dst = out[0];
            for (let i = 0; i < frames; i += 1) dst[i] = samples[i] * scale;
            return out;
        }
        for (let c = 0; c < channels; c += 1) {
            const dst = out[c];
            for (let i = 0, j = c; i < frames; i += 1, j += channels) dst[i] = samples[j] * scale;
        }
        return out;
    }
    if (encoding === 'int' && bitsPerSample === 16) {
        for (let i = 0; i < frames; i += 1) {
            for (let c = 0; c < channels; c += 1) {
                out[c][i] = view.getInt16(p, true) / 32768;
                p += 2;
            }
        }
        return out;
    }
    for (let i = 0; i < frames; i += 1) {
        for (let c = 0; c < channels; c += 1) {
            let v: number;
            if (encoding === 'float') {
                v = bitsPerSample === 32 ? view.getFloat32(p, true) : view.getFloat64(p, true);
            } else if (bitsPerSample === 24) {
                const raw = bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16);
                v = ((raw << 8) >> 8) / 8388608;
            } else if (bitsPerSample === 32) {
                v = view.getInt32(p, true) / 2147483648;
            } else {
                v = (bytes[p] - 128) / 128; // 8-bit is unsigned
            }
            out[c][i] = v;
            p += bytesPer;
        }
    }
    return out;
}

/** Round to 16-bit, clamped; inverse of the 16-bit branch of decodeInterleaved. */
export function floatToInt16(value: number): number {
    const v = Math.round(value * 32768);
    return v > 32767 ? 32767 : v < -32768 ? -32768 : v;
}

/** A canonical 44-byte header for 16-bit PCM. */
export function wavHeader16(channels: number, sampleRate: number, frames: number): Uint8Array {
    const dataBytes = frames * channels * 2;
    const bytes = new Uint8Array(44);
    const view = new DataView(bytes.buffer);
    const text = (offset: number, s: string) => {
        for (let i = 0; i < s.length; i += 1) bytes[offset + i] = s.charCodeAt(i);
    };
    text(0, 'RIFF');
    view.setUint32(4, 36 + dataBytes, true);
    text(8, 'WAVE');
    text(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, WAVE_FORMAT_PCM, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * channels * 2, true);
    view.setUint16(32, channels * 2, true);
    view.setUint16(34, 16, true);
    text(36, 'data');
    view.setUint32(40, dataBytes, true);
    return bytes;
}

/**
 * Parse a complete, small WAV file into planar Float32 channels (used for
 * segments in the browser as the alternative to decodeAudioData).
 */
export function parseWavFile(buffer: ArrayBuffer): { sampleRate: number; channels: Float32Array[]; frames: number } {
    const bytes = new Uint8Array(buffer);
    const format = parseWavHeader(bytes);
    if (!format) throw new WavFormatError('Truncated WAV header');
    const available = bytes.length - format.dataOffset;
    const dataBytes = Math.min(format.dataBytes ?? available, available);
    const frames = Math.floor(dataBytes / format.blockAlign);
    const channels = decodeInterleaved(format, bytes.subarray(format.dataOffset, format.dataOffset + frames * format.blockAlign), frames);
    return { sampleRate: format.sampleRate, channels, frames };
}
