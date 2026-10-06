import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { wavHeader16, type ManifestSegment, type ManifestSource, type SourceCodec } from '@saitdigital/rt-dspplr/format';
import type { SourceLayout } from './decoder';
import { wasmInt16 } from './wasm/kernels';

// ---------------------------------------------------------------------------
// The index of a source (manifest v4): where in the file the samples of any
// stretch of it are, so the player fetches just those bytes and decodes them.
// The file itself is kept as it is; a format the player does not read is
// written once as a 16-bit WAV (sourceWavSink) and indexed like any WAV.
//
//   wav   bytes = dataOffset + frame × blockAlign
//   mp3   whole frames; a run starts MP3_WARMUP frames early (the bit reservoir,
//         the overlap) and is counted back from its end, because the decoder
//         gives nothing for a first frame whose reservoir lies outside the run
//   opus  whole Ogg pages; a run starts OPUS_PREROLL samples early, at the first
//         packet that begins on its first page: a fresh decoder converges on
//         the continuous decode's samples
// ---------------------------------------------------------------------------

/** Frames of an MP3 a run starts before its first sample's frame. */
const MP3_WARMUP = 6;
/**
 * Samples (48 kHz) an Opus run is decoded before its first sample: 500 ms. RFC 7845's 80 ms
 * left errors up to -35 dBFS (music, 40 ms pages); 240 ms, -81 dB; 400 ms, the same samples.
 */
const OPUS_PREROLL = 24000;

export interface SourceMap {
    /** What the manifest says about the file (its url and bytes are the caller's). */
    describe: Omit<ManifestSource, 'url' | 'bytes'>;
    /** Decoded frames of the source. */
    frames: number;
    /** The bytes of a run holding samples [start, start + count) and how many of the run's samples, from `start` to its end, there are. */
    rangeFor(start: number, count: number): { range: [number, number]; tail: number };
}

/** Whether the player decodes this layout itself (else the source is written as a WAV). */
export function mappable(layout: SourceLayout | undefined): layout is SourceLayout {
    return layout?.kind === 'wav' || layout?.kind === 'mp3' || layout?.kind === 'opus';
}

export const SOURCE_CONTENT_TYPES: Record<SourceCodec, string> = { wav: 'audio/wav', mp3: 'audio/mpeg', flac: 'audio/flac', opus: 'audio/ogg' };

/** The map of a 16-bit WAV written by sourceWavSink(). */
export function wavMap(channels: number, sampleRate: number, frames: number): SourceMap {
    return pcmMap({ kind: 'wav', dataOffset: 44, blockAlign: channels * 2, encoding: 'int', bitsPerSample: 16 }, sampleRate, channels, frames);
}

function pcmMap(layout: Extract<SourceLayout, { kind: 'wav' }>, sampleRate: number, channels: number, frames: number): SourceMap {
    const { dataOffset, blockAlign, encoding, bitsPerSample } = layout;
    return {
        describe: { codec: 'wav', sampleRate, channels, pcm: { encoding, bitsPerSample, blockAlign } },
        frames,
        rangeFor: (start, count) => ({ range: [dataOffset + start * blockAlign, dataOffset + (start + count) * blockAlign], tail: count }),
    };
}

/** The map of a source file, from what its decoder said about it and how many frames it decoded to. */
export async function mapSource(file: string, layout: SourceLayout, sampleRate: number, channels: number, frames: number): Promise<SourceMap> {
    if (layout.kind === 'wav') return pcmMap(layout, sampleRate, channels, frames);
    if (layout.kind === 'mp3') {
        const table = await mp3Frames(file);
        if (table.count === 0) throw new Error('the MP3 has no frames to index');
        const delay = layout.delay;
        if (frames > table.totalSamples - delay) throw new Error(`the MP3 decoded to ${frames} frames, its frames hold ${table.totalSamples - delay}`);
        /** The frame holding raw sample r (binary search over the frames' first samples). */
        const frameOf = (r: number) => {
            let lo = 0;
            let hi = table.count - 1;
            while (lo < hi) {
                const mid = (lo + hi + 1) >> 1;
                if (table.firstSample[mid] <= r) lo = mid;
                else hi = mid - 1;
            }
            return lo;
        };
        return {
            describe: { codec: 'mp3', sampleRate, channels },
            frames,
            rangeFor: (start, count) => {
                const r = start + delay;
                const f0 = Math.max(0, frameOf(r) - MP3_WARMUP);
                const fl = frameOf(r + count - 1);
                const end = fl + 1 < table.count ? table.offset[fl + 1] : table.end;
                const runEnd = fl + 1 < table.count ? table.firstSample[fl + 1] : table.totalSamples;
                return { range: [table.offset[f0], end], tail: runEnd - r };
            },
        };
    }
    if (layout.kind === 'opus') {
        const t = await oggOpusPages(file);
        if (sampleRate !== 48000) throw new Error(`an Opus source decodes at 48000 Hz, not ${sampleRate}`);
        if (t.channels !== channels) throw new Error(`the OpusHead says ${t.channels} channels, the decoder gave ${channels}`);
        if (t.mapping !== 0) throw new Error(`Opus channel mapping family ${t.mapping} is not indexed (mono and stereo only)`);
        const pages = t.count;
        // The first page of a run for raw sample r: the last whose first packet starts PREROLL before it.
        const firstPage = (r: number) => {
            let lo = t.firstAudioPage;
            let hi = pages - 1;
            while (lo < hi) {
                const mid = (lo + hi + 1) >> 1;
                if (t.runStart[mid] <= r) lo = mid;
                else hi = mid - 1;
            }
            return lo;
        };
        // The last page of a run ending at raw sample e: the first whose completed packets reach it.
        const lastPage = (e: number) => {
            let lo = t.firstAudioPage;
            let hi = pages - 1;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (t.endRaw[mid] >= e) hi = mid;
                else lo = mid + 1;
            }
            return lo;
        };
        if (frames > t.endRaw[pages - 1] - t.preSkip) throw new Error(`the Opus stream decoded to ${frames} frames, its packets hold ${t.endRaw[pages - 1] - t.preSkip}`);
        return {
            describe: { codec: 'opus', sampleRate, channels, header: Buffer.from(t.head).toString('base64') },
            frames,
            rangeFor: (start, count) => {
                const r = start + t.preSkip;
                const p0 = firstPage(Math.max(0, r - OPUS_PREROLL));
                const pl = lastPage(r + count);
                return { range: [t.offset[p0], t.pageEnd[pl]], tail: t.endRaw[pl] - r };
            },
        };
    }
    throw new Error(`no index for ${layout.kind} sources yet`);
}

/**
 * The segments of a timeline of `frames` (segments of `framesPerSegment`) on a source whose
 * sample `t + offset` plays at timeline frame t (a stem's alignment): silence where it has none.
 */
export function indexSegments(frames: number, framesPerSegment: number, map: SourceMap, offset = 0): ManifestSegment[] {
    const list: ManifestSegment[] = [];
    for (let start = 0, index = 0; start < frames; start += framesPerSegment, index += 1) {
        const length = Math.min(framesPerSegment, frames - start);
        const from = start + offset;
        const lead = Math.max(0, -from);
        const s0 = Math.max(0, from);
        const s1 = Math.min(from + length, map.frames);
        if (s1 <= s0) {
            list.push({ index, startFrame: start, frames: length, range: null, tail: 0 });
            continue;
        }
        const trail = length - lead - (s1 - s0);
        const { range, tail } = map.rangeFor(s0, s1 - s0);
        list.push({ index, startFrame: start, frames: length, range, tail, ...(lead ? { lead } : {}), ...(trail ? { trail } : {}) });
    }
    return list;
}

// ---- MP3 frames ------------------------------------------------------------------------------

interface Mp3Table {
    count: number;
    offset: Float64Array;
    firstSample: Float64Array;
    totalSamples: number;
    /** Where the last frame ends. */
    end: number;
}

const BITRATE_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATE_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** Growable Float64Array columns. */
function columns(n: number) {
    const cols = Array.from({ length: n }, () => new Float64Array(4096));
    let count = 0;
    return {
        push(...values: number[]) {
            if (count === cols[0].length) {
                for (let i = 0; i < n; i += 1) {
                    const grown = new Float64Array(count * 2);
                    grown.set(cols[i]);
                    cols[i] = grown;
                }
            }
            for (let i = 0; i < n; i += 1) cols[i][count] = values[i];
            count += 1;
        },
        get count() { return count; },
        column: (i: number) => cols[i].subarray(0, count),
    };
}

/**
 * The audio frames of an MP3 file, read in chunks: after an ID3v2 tag, without a Xing/Info
 * frame (the decoder skips it too), resynchronising over junk. Layer III, as dr_mp3 decodes it.
 */
export async function mp3Frames(file: string): Promise<Mp3Table> {
    const table = columns(2);
    let samples = 0;
    let end = 0;
    let first = true;
    let carry = new Uint8Array(0);
    let base = 0; // file offset of carry[0]
    let pos = 0; // next byte to look at, file offset
    for await (const chunk of fs.createReadStream(file, { highWaterMark: 1 << 20 })) {
        const bytes = new Uint8Array(carry.length + (chunk as Buffer).length);
        bytes.set(carry);
        bytes.set(chunk as Buffer, carry.length);
        if (base === 0 && pos === 0 && bytes.length >= 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
            // An ID3v2 tag: not looked at.
            pos = 10 + (((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f)) + (bytes[5] & 0x10 ? 10 : 0);
        }
        let i = pos - base;
        while (i + 4 <= bytes.length) {
            if (bytes[i] !== 0xff || (bytes[i + 1] & 0xe0) !== 0xe0) { i += 1; continue; }
            const version = (bytes[i + 1] >> 3) & 3;
            const layer = (bytes[i + 1] >> 1) & 3;
            const bitrateIndex = bytes[i + 2] >> 4;
            const rateIndex = (bytes[i + 2] >> 2) & 3;
            if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) { i += 1; continue; }
            const mpeg1 = version === 3;
            const n = mpeg1 ? 1152 : 576;
            const size = Math.floor(((n / 8) * (mpeg1 ? BITRATE_V1 : BITRATE_V2)[bitrateIndex] * 1000) / RATES[version][rateIndex]) + ((bytes[i + 2] >> 1) & 1);
            if (i + size > bytes.length) break; // the rest comes with the next chunk
            if (first) {
                first = false;
                const mono = (bytes[i + 3] >> 6) === 3;
                const at = i + 4 + (mpeg1 ? (mono ? 17 : 32) : (mono ? 9 : 17));
                const tag = String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
                if (tag === 'Xing' || tag === 'Info') { i += size; continue; }
            }
            table.push(base + i, samples);
            samples += n;
            end = base + i + size;
            i += size;
        }
        pos = base + i;
        carry = bytes.slice(i);
        base = pos;
    }
    return { count: table.count, offset: table.column(0), firstSample: table.column(1), totalSamples: samples, end };
}

// ---- Ogg Opus pages --------------------------------------------------------------------------

interface OpusTable {
    count: number;
    /** Where each page starts and ends in the file. */
    offset: Float64Array;
    pageEnd: Float64Array;
    /** Raw samples (48 kHz, from the stream's first) of the packets completed by each page's end. */
    endRaw: Float64Array;
    /** Raw start of the first packet that begins on each page (Infinity: none does). */
    runStart: Float64Array;
    /** The first page with audio packets. */
    firstAudioPage: number;
    head: Uint8Array;
    channels: number;
    preSkip: number;
    mapping: number;
}

/** Samples (48 kHz) of an Opus packet, from its TOC byte (and the frame count byte of code 3). */
function opusPacketSamples(toc: number, count: number): number {
    const config = toc >> 3;
    const size = config < 12 ? [480, 960, 1920, 2880][config & 3] : config < 16 ? [480, 960][config & 1] : [120, 240, 480, 960][config & 3];
    const code = toc & 3;
    return size * (code === 0 ? 1 : code === 3 ? count & 0x3f : 2);
}

/**
 * The pages of an Ogg Opus file (one logical stream), read in chunks: where each starts and ends,
 * how many samples its completed packets bring the stream to, and where a run starting on it begins.
 */
export async function oggOpusPages(file: string): Promise<OpusTable> {
    const table = columns(3); // offset, pageEnd, endRaw
    let packetIndex = 0; // 0 OpusHead, 1 OpusTags, then audio
    let packetBytes: number[] = []; // the first bytes of the packet being assembled (TOC, count)
    let packetStarted = false;
    let packetPage = -1;
    let packetHead: Uint8Array[] = []; // OpusHead's bytes
    let raw = 0;
    let serial: number | null = null;
    let firstAudioPage = -1;
    let carry = new Uint8Array(0);
    let base = 0;
    /** Raw start of the first packet that begins on a page, by page. */
    const starts: number[] = [];
    for await (const chunk of fs.createReadStream(file, { highWaterMark: 1 << 20 })) {
        const bytes = new Uint8Array(carry.length + (chunk as Buffer).length);
        bytes.set(carry);
        bytes.set(chunk as Buffer, carry.length);
        let o = 0;
        while (o + 27 <= bytes.length) {
            if (bytes[o] !== 0x4f || bytes[o + 1] !== 0x67 || bytes[o + 2] !== 0x67 || bytes[o + 3] !== 0x53) throw new Error(`not an Ogg page at byte ${base + o}`);
            const segments = bytes[o + 26];
            if (o + 27 + segments > bytes.length) break;
            let bodySize = 0;
            for (let s = 0; s < segments; s += 1) bodySize += bytes[o + 27 + s];
            const size = 27 + segments + bodySize;
            if (o + size > bytes.length) break;
            const view = new DataView(bytes.buffer, bytes.byteOffset + o, 27);
            const pageSerial = view.getUint32(14, true);
            if (serial === null) serial = pageSerial;
            else if (pageSerial !== serial) throw new Error('the Ogg file holds more than one stream');
            const page = table.count;
            const continued = (bytes[o + 5] & 1) !== 0;
            if (!continued && packetStarted) throw new Error(`Ogg page ${page} drops an unfinished packet`);
            let p = o + 27 + segments;
            for (let s = 0; s < segments; s += 1) {
                const lace = bytes[o + 27 + s];
                if (!packetStarted) {
                    packetStarted = true;
                    packetPage = page;
                    packetBytes = [];
                }
                for (let k = 0; k < lace && packetBytes.length < 2; k += 1) packetBytes.push(bytes[p + k]);
                if (packetIndex === 0) packetHead.push(bytes.slice(p, p + lace));
                p += lace;
                if (lace < 255) {
                    // A packet ends here.
                    if (packetIndex >= 2) {
                        starts[packetPage] ??= raw;
                        if (firstAudioPage < 0) firstAudioPage = packetPage;
                        raw += packetBytes.length ? opusPacketSamples(packetBytes[0], packetBytes[1] ?? 0) : 0;
                    }
                    packetIndex += 1;
                    packetStarted = false;
                    packetBytes = [];
                }
            }
            table.push(base + o, base + o + size, raw);
            o += size;
        }
        carry = bytes.slice(o);
        base += o;
    }
    if (carry.length) throw new Error('the Ogg file ends inside a page');
    // A page on which no packet begins (one packet spans it): a run from it starts at the next packet.
    const runStart = new Float64Array(table.count).fill(Infinity);
    for (let page = table.count - 1, next = Infinity; page >= 0; page -= 1) {
        next = starts[page] ?? next;
        runStart[page] = next;
    }
    const headBytes = new Uint8Array(packetHead.reduce((n, b) => n + b.length, 0));
    let h = 0;
    for (const b of packetHead) { headBytes.set(b, h); h += b.length; }
    if (String.fromCharCode(...headBytes.subarray(0, 8)) !== 'OpusHead') throw new Error('not an Ogg Opus file');
    if (firstAudioPage < 0) throw new Error('the Opus file has no audio packets');
    const head = new DataView(headBytes.buffer);
    return {
        count: table.count,
        offset: table.column(0),
        pageEnd: table.column(1),
        endRaw: table.column(2),
        runStart,
        firstAudioPage,
        head: headBytes,
        channels: headBytes[9],
        preSkip: head.getUint16(10, true),
        mapping: headBytes[18],
    };
}

// ---- a 16-bit WAV of decoded audio (a source the player cannot read itself) ------------------

export interface WavSink {
    readonly file: string;
    write(block: Float32Array[]): Promise<void>;
    /** Sets the header's sizes and closes the file: the frames written. */
    end(): Promise<number>;
    /** Closes the file as it is (a failed job). */
    close(): Promise<void>;
}

/** A 16-bit WAV written block by block (samples rounded as floatToInt16); the header's sizes are set when it ends. */
export async function sourceWavSink(file: string, channels: number, rate: number): Promise<WavSink> {
    const handle = await fsp.open(file, 'w');
    await handle.write(wavHeader16(channels, rate, 0), 0, 44, 0);
    let frames = 0;
    let position = 44;
    let out = new Int16Array(0);
    let closed = false;
    return {
        file,
        async write(block) {
            const n = block[0]?.length ?? 0;
            if (n === 0) return;
            if (out.length < n * channels) out = new Int16Array(n * channels);
            if (!wasmInt16(block, 0, n, out, 0)) {
                for (let c = 0; c < channels; c += 1) {
                    const x = block[c];
                    for (let i = 0, p = c; i < n; i += 1, p += channels) {
                        const y = x[i] * 32768;
                        const r = Math.ceil(y);
                        const v = r - +(r - 0.5 > y);
                        out[p] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
                    }
                }
            }
            const bytes = new Uint8Array(out.buffer, 0, n * channels * 2);
            await handle.write(bytes, 0, bytes.length, position);
            position += bytes.length;
            frames += n;
        },
        async end() {
            const header = wavHeader16(channels, rate, frames);
            await handle.write(header, 0, header.length, 0);
            closed = true;
            await handle.close();
            return frames;
        },
        async close() {
            if (closed) return;
            closed = true;
            await handle.close().catch(() => undefined);
        },
    };
}

/** A local file's bytes [start, end). */
export async function readRange(file: string, start: number, end: number): Promise<Uint8Array> {
    const handle = await fsp.open(file, 'r');
    try {
        const out = new Uint8Array(end - start);
        let got = 0;
        while (got < out.length) {
            const { bytesRead } = await handle.read(out, got, out.length - got, start + got);
            if (bytesRead === 0) break;
            got += bytesRead;
        }
        return got === out.length ? out : out.subarray(0, got);
    } finally {
        await handle.close();
    }
}
