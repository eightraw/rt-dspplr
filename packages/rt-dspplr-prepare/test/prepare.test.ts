// Node tests for the long-audio prepare step (run: npm test): the streaming WAV
// reader in every supported encoding, the resampler's passband and aliasing,
// the source kept as it is and its index read back sample-exact, peaks against
// a brute-force reference, loudness,
// the job lifecycle and the decoder hook, stems and processors, and the
// hardening around them (file names, write errors, cancels, what a manifest
// may publish, process cleanup).

import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    memoryStorage,
    prepareAudio,
    wavDecoder,
    builtinDecoder,
    type AudioDecoder,
    attachStem,
    functionProcessor,
    commandProcessor,
    dockerProcessor,
    ffmpegDecoder,
    httpProcessor,
    checkDockerImage,
    AUDIO_DEMUXERS,
    type AudioManifest,
} from '../src/index';
import { storedRanges } from '../src/prepareAudio';
import { readSegment } from '../src/sourceReader';
import { deepestRun, indexSegments, mapSource } from '../src/sourceIndex';
import { main } from '../src/cli';
import { multipartHead, redactUrl } from '../src/processors';
import { designResampler, StreamingResampler } from '../src/resampler';
import { resampleInParallel } from '../src/parallelResample';
import { createPreparePool, JobPool } from '../src/pool';
import { markStem } from '../src/attachStem';
import Ajv2020 from 'ajv/dist/2020';
import manifestSchema from '@saitdigital/rt-dspplr/manifest.schema.json';
// The formats come from the player package (one implementation for both).
import {
    assertManifest,
    computeHighPassCoefficients,
    decodeBandsFile,
    decodePeaksFile,
    decodeSpectrogramFile,
    highPassEnergyRatio,
    HIGH_PASS_SECTION_Q,
    parseWavFile,
} from '@saitdigital/rt-dspplr/format';

const results: string[] = [];

// ---- helpers ------------------------------------------------------------------------

type Enc = { tag: 1 | 3; bits: number; extensible?: boolean };

/** Encode planar float channels as a WAV in the given encoding (+ a LIST chunk with an odd size before data). */
function encodeWav(channels: Float64Array[], rate: number, enc: Enc): Uint8Array {
    const frames = channels[0].length;
    const C = channels.length;
    const bps = enc.bits / 8;
    const fmtSize = enc.extensible ? 40 : 16;
    const list = 'LIST odd';
    const listSize = 5; // odd: followed by a pad byte
    const dataBytes = frames * C * bps;
    const total = 12 + 8 + fmtSize + 8 + listSize + 1 + 8 + dataBytes;
    const bytes = new Uint8Array(total);
    const v = new DataView(bytes.buffer);
    const text = (o: number, s: string) => { for (let i = 0; i < s.length; i += 1) bytes[o + i] = s.charCodeAt(i); };
    text(0, 'RIFF'); v.setUint32(4, total - 8, true); text(8, 'WAVE');
    let o = 12;
    text(o, 'fmt '); v.setUint32(o + 4, fmtSize, true);
    v.setUint16(o + 8, enc.extensible ? 0xfffe : enc.tag, true);
    v.setUint16(o + 10, C, true); v.setUint32(o + 12, rate, true);
    v.setUint32(o + 16, rate * C * bps, true); v.setUint16(o + 20, C * bps, true); v.setUint16(o + 22, enc.bits, true);
    if (enc.extensible) { v.setUint16(o + 24, 22, true); v.setUint16(o + 26, enc.bits, true); v.setUint32(o + 28, 0, true); v.setUint16(o + 32, enc.tag, true); }
    o += 8 + fmtSize;
    text(o, list.slice(0, 4)); v.setUint32(o + 4, listSize, true); o += 8 + listSize + 1;
    text(o, 'data'); v.setUint32(o + 4, dataBytes, true); o += 8;
    for (let i = 0; i < frames; i += 1) {
        for (let c = 0; c < C; c += 1) {
            const x = Math.max(-1, Math.min(1, channels[c][i]));
            if (enc.tag === 3) {
                if (enc.bits === 32) v.setFloat32(o, x, true); else v.setFloat64(o, x, true);
            } else if (enc.bits === 8) {
                bytes[o] = Math.max(0, Math.min(255, Math.round(x * 128) + 128));
            } else if (enc.bits === 16) {
                v.setInt16(o, Math.max(-32768, Math.min(32767, Math.round(x * 32768))), true);
            } else if (enc.bits === 24) {
                const q = Math.max(-8388608, Math.min(8388607, Math.round(x * 8388608)));
                bytes[o] = q & 255; bytes[o + 1] = (q >> 8) & 255; bytes[o + 2] = (q >> 16) & 255;
            } else {
                v.setInt32(o, Math.max(-2147483648, Math.min(2147483647, Math.round(x * 2147483648))), true);
            }
            o += bps;
        }
    }
    return bytes;
}

/** Feed bytes in pseudo-random chunk sizes (splitting headers and frames). */
async function* chunks(bytes: Uint8Array, seed = 1, max = 4096): AsyncGenerator<Uint8Array> {
    let s = seed;
    let o = 0;
    while (o < bytes.length) {
        s = (s * 1103515245 + 12345) % 2147483648;
        const n = 1 + (s % max);
        yield bytes.slice(o, o + n);
        o += n;
    }
}

async function decodeAll(decoder: AudioDecoder, input: AsyncIterable<Uint8Array>) {
    const stream = decoder(input);
    const parts: Float32Array[][] = [];
    for await (const block of stream.blocks) parts.push(block);
    const format = await stream.format;
    const frames = parts.reduce((n, p) => n + p[0].length, 0);
    const out = Array.from({ length: format.channels }, () => new Float32Array(frames));
    let o = 0;
    for (const p of parts) { p.forEach((ch, c) => out[c].set(ch, o)); o += p[0].length; }
    return { format, channels: out };
}

function speechLike(frames: number, rate: number, channels: number, seed = 3): Float64Array[] {
    let s = seed;
    const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    return Array.from({ length: channels }, (_, c) => {
        const out = new Float64Array(frames);
        for (let i = 0; i < frames; i += 1) {
            const t = i / rate;
            const env = Math.max(0, Math.sin(2 * Math.PI * 1.7 * t + c)) ** 2;
            out[i] = 0.6 * env * Math.sin(2 * Math.PI * (130 + 40 * Math.sin(t)) * t) + 0.02 * (rnd() * 2 - 1);
        }
        return out;
    });
}

/** A timeline's segment i, read the player's way (its range of the stored source, decoded, cut out). */
function segmentAt(storage: { getObject(key: string): Promise<Uint8Array | null> }, segments: AudioManifest['segments'], channels: number, i: number): Promise<Float32Array[]> {
    return readSegment(segments.source, segments.list[i], channels, storedRanges(storage as never, segments.source.url));
}

/** A whole timeline read back segment by segment. */
async function timelineAt(storage: { getObject(key: string): Promise<Uint8Array | null> }, segments: AudioManifest['segments'], channels: number): Promise<Float32Array[]> {
    const frames = segments.list.reduce((n, seg) => n + seg.frames, 0);
    const out = Array.from({ length: channels }, () => new Float32Array(frames));
    for (const seg of segments.list) {
        const planes = await segmentAt(storage, segments, channels, seg.index);
        planes.forEach((p, c) => out[c].set(p, seg.startFrame));
    }
    return out;
}

/** The largest difference between two planar signals of the same shape. */
const maxDiff = (a: Float32Array[], b: Float32Array[]) => {
    assert.equal(a.length, b.length);
    let worst = 0;
    a.forEach((x, c) => {
        assert.equal(x.length, b[c].length);
        for (let i = 0; i < x.length; i += 1) worst = Math.max(worst, Math.abs(x[i] - b[c][i]));
    });
    return worst;
};
/** The same values (-0 and 0 alike). */
const sameSamples = (a: Float32Array[], b: Float32Array[]) => maxDiff(a, b) === 0;

// ---- WAV reader ----------------------------------------------------------------------

{
    const rate = 44100;
    const src = speechLike(3001, rate, 2);
    const cases: Array<[string, Enc, number]> = [
        ['8-bit', { tag: 1, bits: 8 }, 1 / 128],
        ['16-bit', { tag: 1, bits: 16 }, 0.5 / 32768],
        ['24-bit', { tag: 1, bits: 24 }, 0.5 / 8388608],
        ['24-bit extensible', { tag: 1, bits: 24, extensible: true }, 0.5 / 8388608],
        ['32-bit int', { tag: 1, bits: 32 }, 1e-7],
        ['float32', { tag: 3, bits: 32 }, 1e-7],
        ['float64', { tag: 3, bits: 64 }, 1e-7],
    ];
    for (const [name, enc, tol] of cases) {
        const wav = encodeWav(src, rate, enc);
        const { format, channels } = await decodeAll(wavDecoder, chunks(wav, enc.bits));
        assert.equal(format.sampleRate, rate, name);
        assert.equal(format.channels, 2, name);
        assert.equal(channels[0].length, 3001, `${name}: frames`);
        let err = 0;
        for (let c = 0; c < 2; c += 1) for (let i = 0; i < 3001; i += 1) err = Math.max(err, Math.abs(channels[c][i] - src[c][i]));
        assert.ok(err <= tol + 1e-7, `${name}: max error ${err}`);
    }
    // In-memory parse (the browser's segment path) agrees with the streaming one.
    const wav16 = encodeWav(src, rate, { tag: 1, bits: 16 });
    const whole = parseWavFile(wav16.buffer.slice(0) as ArrayBuffer);
    const streamed = await decodeAll(wavDecoder, chunks(wav16, 9, 97));
    assert.deepEqual(whole.channels[1], streamed.channels[1]);
    // Not a WAV: a clear error that names ffmpeg and the decoder hook.
    await assert.rejects(decodeAll(wavDecoder, chunks(new TextEncoder().encode('ID3\u0004 this is an mp3, honest'))), /ffmpeg.*decoder/s);
    results.push(`WAV reader: ${cases.map((c) => c[0]).join(', ')}; odd LIST chunk, 1-byte..4 KB chunks; non-WAV names ffmpeg`);
}

// ---- FLAC and MP3 in process -----------------------------------------------------------

/**
 * A FLAC stream of the channels quantized as encodeWav() does: verbatim subframes (FLAC's
 * uncompressed form, every decoder reads it), fixed block size, or with `variable` block sizes
 * that cycle through those given (frames then carry sample numbers); optionally an ID3v2 tag in
 * front and a padding block of `padding` bytes among the metadata.
 */
function encodeFlac(channels: Float64Array[], rate: number, bits: 16 | 24, blockSize: number, extra: { id3?: number; padding?: number; variable?: number[] } = {}): Uint8Array {
    const C = channels.length;
    const frames = channels[0].length;
    const full = 2 ** (bits - 1);
    const q = channels.map((x) => Int32Array.from(x, (v) => Math.max(-full, Math.min(full - 1, Math.round(Math.max(-1, Math.min(1, v)) * full)))));
    const out: number[] = [];
    const put = (...b: number[]) => { for (const x of b) out.push(x & 255); };
    const crc8 = (b: number[]) => { let c = 0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k += 1) c = c & 0x80 ? ((c << 1) ^ 0x07) & 255 : (c << 1) & 255; } return c; };
    const crc16 = (b: number[]) => { let c = 0; for (const x of b) { c ^= x << 8; for (let k = 0; k < 8; k += 1) c = c & 0x8000 ? ((c << 1) ^ 0x8005) & 0xffff : (c << 1) & 0xffff; } return c; };
    if (extra.id3) {
        const n = extra.id3;
        put(0x49, 0x44, 0x33, 4, 0, 0, (n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127);
        for (let i = 0; i < n; i += 1) put(0);
    }
    put(0x66, 0x4c, 0x61, 0x43);
    put(extra.padding ? 0 : 0x80, 0, 0, 34); // STREAMINFO
    const sizes = extra.variable ?? [blockSize];
    const min = Math.min(...sizes);
    const max = Math.max(...sizes);
    put(min >> 8, min, max >> 8, max, 0, 0, 0, 0, 0, 0);
    // rate (20 bits), channels − 1 (3), bits − 1 (5), total frames (36), then a zero MD5
    put(rate >> 12, rate >> 4, ((rate & 15) << 4) | ((C - 1) << 1) | ((bits - 1) >> 4), (((bits - 1) & 15) << 4) | Math.floor(frames / 2 ** 32), frames >>> 24, frames >>> 16, frames >>> 8, frames);
    for (let i = 0; i < 16; i += 1) put(0);
    if (extra.padding) {
        const n = extra.padding;
        put(0x81, n >> 16, n >> 8, n);
        for (let i = 0; i < n; i += 1) put(0);
    }
    // The frame's coded number, UTF-8 style: n continuation bytes hold 5n + 6 bits.
    const utf8 = (v: number): number[] => {
        if (v < 0x80) return [v];
        let n = 1;
        while (v >= 2 ** (5 * n + 6)) n += 1;
        const bytes: number[] = [];
        for (let k = 0; k < n; k += 1) { bytes.unshift(0x80 | (v % 64)); v = Math.floor(v / 64); }
        return [((0xff << (7 - n)) & 0xff) | v, ...bytes];
    };
    for (let f = 0, start = 0; start < frames; f += 1) {
        const n = Math.min(sizes[f % sizes.length], frames - start);
        const frame: number[] = [0xff, extra.variable ? 0xf9 : 0xf8, 0x70, (C - 1) << 4, ...utf8(extra.variable ? start : f)];
        frame.push((n - 1) >> 8, (n - 1) & 255);
        frame.push(crc8(frame));
        for (let c = 0; c < C; c += 1) {
            frame.push(0x02); // verbatim, no wasted bits
            for (let i = 0; i < n; i += 1) {
                const v = q[c][start + i];
                if (bits === 24) frame.push((v >> 16) & 255);
                frame.push((v >> 8) & 255, v & 255);
            }
        }
        const crc = crc16(frame);
        frame.push(crc >> 8, crc & 255);
        put(...frame);
        start += n;
    }
    return Uint8Array.from(out);
}

{
    const rate = 44100;
    const src = speechLike(3 * rate + 777, rate, 2, 21);
    const cases: Array<[string, 16 | 24, number, { id3?: number; padding?: number }]> = [
        ['16-bit', 16, 4096, {}],
        // an ID3v2 tag in front, and a header longer than the decoder first reads (it opens again with more)
        ['24-bit, ID3 tag, 6 MiB padding block', 24, 1152, { id3: 1000, padding: 6 << 20 }],
    ];
    for (const [name, bits, blockSize, extra] of cases) {
        const flac = encodeFlac(src, rate, bits, blockSize, extra);
        const fromFlac = await decodeAll(builtinDecoder, chunks(flac, bits, 65536));
        const fromWav = await decodeAll(wavDecoder, chunks(encodeWav(src, rate, { tag: 1, bits }), 3, 65536));
        assert.equal(fromFlac.format.encoding, 'flac', name);
        assert.equal(fromFlac.format.frames, src[0].length, name);
        assert.equal(fromFlac.format.bitsPerSample, bits, name);
        assert.deepEqual(fromFlac.channels, fromWav.channels, `${name}: the same samples as the WAV`);
    }
    // prepare from FLAC keeps the file as it is, indexed by its frames (fixed block sizes count
    // frames, variable ones samples), every segment reading back the decoder's samples; and it
    // writes the analyses it writes from the same samples in a WAV.
    const flac = encodeFlac(src, rate, 16, 4096);
    const viaFlac = await prepareMemory(flac, { segmentSeconds: 1 });
    const viaWav = await prepareMemory(encodeWav(src, rate, { tag: 1, bits: 16 }), { segmentSeconds: 1 });
    const keys = [...viaWav.storage.objects.keys()].filter((k) => k !== 'manifest.json' && k !== 'source.wav').sort();
    assert.deepEqual([...viaFlac.storage.objects.keys()].filter((k) => k !== 'manifest.json' && k !== 'source.flac').sort(), keys);
    for (const k of keys) assert.ok(Buffer.from(viaFlac.storage.objects.get(k)!).equals(Buffer.from(viaWav.storage.objects.get(k)!)), `${k}: FLAC and WAV prepare alike`);
    assert.ok(sameSamples(await timelineAt(viaFlac.storage, viaFlac.manifest.segments, 2), await timelineAt(viaWav.storage, viaWav.manifest.segments, 2)), 'FLAC and WAV play the same samples');
    const kept: Array<[string, Uint8Array]> = [
        ['fixed block size', flac],
        ['variable block sizes, 24-bit, ID3 tag', encodeFlac(src, rate, 24, 0, { id3: 300, variable: [4096, 1152, 576, 4608, 192] })],
    ];
    for (const [name, bytes] of kept) {
        const { manifest: m, storage, job } = bytes === flac ? viaFlac : await prepareMemory(bytes, { segmentSeconds: 0.3 });
        assert.equal(m.source.encoding, 'flac', name);
        assert.equal(m.segments.source.url, 'source.flac', name);
        assert.equal(m.segments.source.codec, 'flac', name);
        assert.ok(Buffer.from(storage.objects.get('source.flac')!).equals(Buffer.from(bytes)), `${name}: kept byte for byte`);
        assert.deepEqual(job.stats!.warnings, [], name);
        // What a run is decoded after: fLaC and the STREAMINFO, the last metadata block; a run is
        // not the stream, so its total samples and MD5 are unknown (0).
        const header = Buffer.from(m.segments.source.header!, 'base64');
        assert.equal(header.length, 42, name);
        assert.equal(header.toString('latin1', 0, 4), 'fLaC', name);
        assert.equal(header[4], 0x80, name);
        assert.ok((header[8 + 13] & 15) === 0 && header.subarray(8 + 14).every((b) => b === 0), `${name}: total samples and MD5 unknown`);
        assert.ok(m.segments.list.every((seg) => seg.range && seg.range[1] - seg.range[0] < bytes.length), `${name}: ranges`);
        const { channels } = await decodeAll(builtinDecoder, chunks(bytes, 7, 65536));
        assert.equal(maxDiff(await timelineAt(storage, m.segments, 2), channels), 0, `${name}: every segment reads back the decoder's samples`);
        assert.doesNotThrow(() => assertManifest(JSON.parse(JSON.stringify(m))), name);
    }
    // A stream cut short after its header fails, it is not taken for a shorter one.
    await assert.rejects(decodeAll(builtinDecoder, chunks(flac.subarray(0, Math.floor(flac.length * 0.6)))), /FLAC stream is broken/);
    // Formats the built-in decoder does not read name the decoder hook; a broken FLAC says FLAC.
    await assert.rejects(decodeAll(builtinDecoder, chunks(new TextEncoder().encode('OggS\0\u0002 this is an ogg, honest'))), /not WAV, MP3, Opus or FLAC.*decoder/s);
    await assert.rejects(decodeAll(builtinDecoder, chunks(new TextEncoder().encode('fLaC\0\0\0"this is not a flac at all'))), /FLAC/);
    await assert.rejects(decodeAll(builtinDecoder, chunks(new Uint8Array(0))), /empty/);
    results.push(`FLAC in process: ${cases.map((c) => c[0]).join('; ')}: the WAV's samples exactly; prepare writes the same ${keys.length} analysis files as from a WAV and keeps the FLAC as it is (${kept.map((c) => c[0]).join('; ')}), every segment reading back exactly; cut and foreign streams refused`);
}

{
    // MP3 and Opus: lossy fixtures made by ffmpeg from speechLike(…, seed 31) as 16-bit WAV
    // (test/fixtures/make-sources.mjs says how). Gapless - as many frames as the source, at no
    // lag - and as close to it as the codec gets.
    const fixtures = new URL('../../../test/fixtures/', import.meta.url); // from node_modules/.cache/rtd-prepare-test
    const lossy = [
        { file: 'sine-speech.mp3', rate: 44100, encoding: 'mp3' },
        { file: 'sine-speech.opus', rate: 48000, encoding: 'opus' },
    ];
    const notes: string[] = [];
    for (const c of lossy) {
        const bytes = new Uint8Array(fs.readFileSync(new URL(c.file, fixtures)));
        const src = speechLike(2 * c.rate + 333, c.rate, 2, 31).map((x) => Float64Array.from(x, (v) => Math.max(-32768, Math.min(32767, Math.round(Math.max(-1, Math.min(1, v)) * 32768))) / 32768));
        const { format, channels } = await decodeAll(builtinDecoder, chunks(bytes, 7, 4096));
        assert.equal(format.encoding, c.encoding, c.file);
        assert.equal(format.sampleRate, c.rate, c.file);
        assert.equal(channels[0].length, src[0].length, `${c.file}: gapless`);
        const snr = (lag: number) => {
            let s = 0, e = 0;
            for (let ch = 0; ch < 2; ch += 1) {
                for (let i = 1000; i < src[0].length - 1000; i += 1) {
                    const d = channels[ch][i + lag] - src[ch][i];
                    s += src[ch][i] * src[ch][i];
                    e += d * d;
                }
            }
            return 10 * Math.log10(s / e);
        };
        const at0 = snr(0);
        assert.ok(at0 > 15, `${c.file}: ${at0.toFixed(1)} dB against the source`);
        for (const lag of [-2, -1, 1, 2]) assert.ok(snr(lag) < at0, `${c.file}: closer at lag ${lag}`);
        notes.push(`${c.encoding} ${at0.toFixed(1)} dB`);
    }
    // prepare from Opus: 48 kHz kept, the timeline exactly the source's length.
    const { manifest } = await prepareMemory(new Uint8Array(fs.readFileSync(new URL('sine-speech.opus', fixtures))));
    assert.equal(manifest.source.encoding, 'opus');
    assert.equal(manifest.sampleRate, 48000);
    assert.equal(manifest.frames, 2 * 48000 + 333);
    // The file itself is kept, and its index reads back what the decoder gave, segment by segment:
    // MP3 exactly (from 6 frames early); Opus within float rounding (whole pages, 500 ms early: a
    // fresh decoder converges on the continuous decode to about -140 dB).
    for (const c of lossy) {
        const bytes = new Uint8Array(fs.readFileSync(new URL(c.file, fixtures)));
        const { manifest: m, storage, job } = await prepareMemory(bytes, { segmentSeconds: 0.3 });
        const key = `source.${c.encoding}`;
        assert.equal(m.segments.source.url, key, c.file);
        assert.ok(Buffer.from(storage.objects.get(key)!).equals(Buffer.from(bytes)), `${c.file}: kept byte for byte`);
        assert.deepEqual(job.stats!.warnings, []);
        assert.ok(m.segments.list.length >= 6 && m.segments.list.every((seg) => seg.range && seg.range[1] - seg.range[0] < bytes.length), `${c.file}: ranges`);
        const { channels } = await decodeAll(builtinDecoder, chunks(bytes, 7, 4096));
        const diff = maxDiff(await timelineAt(storage, m.segments, 2), channels);
        assert.ok(c.encoding === 'mp3' ? diff === 0 : diff < 1e-6, `${c.file}: every segment reads back the decoder's samples (off by ${diff})`);
        notes.push(`${c.encoding} index ${diff === 0 ? 'exact' : `within ${diff.toExponential(0)}`}`);
        assert.doesNotThrow(() => assertManifest(JSON.parse(JSON.stringify(m))), `${c.encoding} source`);
    }
    // Ogg that is not Opus (a Vorbis identification page): the hint to pass a decoder.
    const ascii = (t: string) => [...t].map((ch) => ch.charCodeAt(0));
    const vorbis = Uint8Array.from([...ascii('OggS'), 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 30, 1, ...ascii('vorbis'), ...new Array(23).fill(0)]);
    await assert.rejects(decodeAll(builtinDecoder, chunks(vorbis)), /not WAV, MP3, Opus or FLAC.*decoder/s);
    results.push(`MP3 and Opus in process: gapless (the source's frames, best at lag 0), ${notes.join(', ')} against the source; prepare from Opus keeps 48 kHz; MP3 and Opus kept as they are, every segment of their index reads back the decoder's samples; Ogg Vorbis names the decoder hook`);
}

{
    // Low-bitrate MP3s (test/fixtures/make-sources.mjs), where the bit reservoir reaches back more
    // than 6 frames: 32 kbit/s at 48 kHz, 8 kbit/s at 16 kHz, VBR -V9 over 1.5 s of silence. With
    // 6 frames of warm-up the first published segments that read back wrong, the second fell back
    // to a WAV and a run of the third could not be decoded at all. Each run now starts once the
    // reservoir is full.
    const fixtures = new URL('../../../test/fixtures/', import.meta.url);
    const notes: string[] = [];
    for (const file of ['low-32k-48k.mp3', 'low-8k-16k.mp3', 'low-v9-22k.mp3']) {
        const bytes = new Uint8Array(fs.readFileSync(new URL(file, fixtures)));
        const { format, channels } = await decodeAll(builtinDecoder, chunks(bytes, 7, 4096));
        for (const segmentSeconds of [0.1, 1]) {
            const { manifest: m, storage, job } = await prepareMemory(bytes, { segmentSeconds });
            assert.deepEqual(job.stats!.warnings, [], `${file}, ${segmentSeconds} s segments`);
            assert.equal(m.segments.source.url, 'source.mp3', file);
            const diff = maxDiff(await timelineAt(storage, m.segments, channels.length), channels);
            assert.equal(diff, 0, `${file}, ${segmentSeconds} s segments: every segment reads back the decoder's samples (off by ${diff})`);
        }
        // The index is checked on the segment whose run goes back furthest too, against a run from further back still.
        const map = await mapSource(fileURLToPath(new URL(file, fixtures)), format.layout!, format.sampleRate, format.channels, channels[0].length);
        const list = indexSegments(channels[0].length, Math.round(0.1 * format.sampleRate), map);
        const deepest = deepestRun(list, map)!;
        const seg = list[deepest.index];
        const warmups = list.map((s) => map.rangeFor(s.startFrame, s.frames).warmup!);
        assert.equal(warmups[deepest.index], Math.max(...warmups));
        assert.ok(warmups[deepest.index] > 6, `${file}: the deepest run starts ${warmups[deepest.index]} frames early`);
        assert.ok(deepest.reference.range![0] < seg.range![0] && deepest.reference.range![1] === seg.range![1] && deepest.reference.tail === seg.tail, file);
        if (file === 'low-v9-22k.mp3') {
            const at = seg.startFrame / format.sampleRate;
            assert.ok(at > 1.5 && at < 3.5, `the VBR file's deepest run is behind its silence (${at.toFixed(2)} s)`);
        }
        notes.push(`${file} up to ${Math.max(...warmups)} frames`);
    }
    results.push(`low-bitrate MP3: kept, every segment exact at 0.1 s and 1 s; runs start early enough for the reservoir (${notes.join(', ')}); the deepest run is checked`);
}

// ---- resampler ----------------------------------------------------------------------

function resampleAll(input: Float32Array, from: number, to: number, chunk: number): Float32Array {
    const r = new StreamingResampler(1, from, to);
    const parts: Float32Array[] = [];
    for (let o = 0; o < input.length; o += chunk) parts.push(r.push([input.subarray(o, o + chunk)])[0]);
    parts.push(r.end()[0]);
    const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
}

/** Amplitude of frequency f in x[from..to) by projection (x is at `rate`). */
function amplitude(x: Float32Array, rate: number, f: number, from: number, to: number): number {
    let re = 0;
    let im = 0;
    for (let i = from; i < to; i += 1) {
        re += x[i] * Math.cos(2 * Math.PI * f * i / rate);
        im += x[i] * Math.sin(2 * Math.PI * f * i / rate);
    }
    return 2 * Math.hypot(re, im) / (to - from);
}

{
    const lines: string[] = [];
    for (const from of [96000, 88200, 192000]) {
        const to = 48000;
        const seconds = 1;
        const n = from * seconds;
        const expectLen = Math.round(n * to / from);
        // Passband: 1, 10 and 19 kHz come through at their level (±0.01 dB).
        for (const f of [1000, 10000, 19000]) {
            const x = new Float32Array(n);
            for (let i = 0; i < n; i += 1) x[i] = 0.5 * Math.sin(2 * Math.PI * f * i / from);
            const y = resampleAll(x, from, to, 7777);
            assert.equal(y.length, expectLen, `${from}: length`);
            const a = amplitude(y, to, f, 2000, y.length - 2000);
            const db = 20 * Math.log10(a / 0.5);
            assert.ok(Math.abs(db) < 0.01, `${from} → ${to}: ${f} Hz at ${db.toFixed(4)} dB`);
            // Zero phase: the output lines up with the input's timeline.
            let err = 0;
            for (let i = 2000; i < y.length - 2000; i += 1) err = Math.max(err, Math.abs(y[i] - 0.5 * Math.sin(2 * Math.PI * f * i / to)));
            assert.ok(err < 1e-3, `${from}: ${f} Hz time-aligned (max error ${err})`);
        }
        // Above the output Nyquist: what would alias must be ≥ 90 dB down.
        let worst = -Infinity;
        for (const f of [24500, 30000, 40000, Math.min(from / 2 - 1000, 70000)]) {
            const x = new Float32Array(n);
            for (let i = 0; i < n; i += 1) x[i] = 0.5 * Math.sin(2 * Math.PI * f * i / from);
            const y = resampleAll(x, from, to, 4096);
            let alias = Math.abs(f % to);
            if (alias > to / 2) alias = to - alias;
            const a = amplitude(y, to, alias, 2000, y.length - 2000);
            let rms = 0;
            for (let i = 2000; i < y.length - 2000; i += 1) rms += y[i] * y[i];
            rms = Math.sqrt(rms / (y.length - 4000));
            const db = 20 * Math.log10(Math.max(a, rms * Math.SQRT2, 1e-12) / 0.5);
            worst = Math.max(worst, db);
            assert.ok(db < -90, `${from} → ${to}: ${f} Hz leaks at ${db.toFixed(1)} dB`);
        }
        // Chunking does not change a single sample.
        const x = new Float32Array(20000).map((_, i) => Math.sin(i * 0.01) * Math.sin(i * 0.37));
        assert.deepEqual(resampleAll(x, from, to, 1), resampleAll(x, from, to, 20000));
        const info = designResampler(from, to).info;
        lines.push(`${from / 1000}k→48k (${info.tapsPerPhase} taps/phase): passband ±0.01 dB, aliasing ≤ ${worst.toFixed(0)} dB`);
    }
    results.push(`resampler: ${lines.join('; ')}; chunk-size invariant`);
}

// ---- segments, peaks, loudness, job --------------------------------------------------

async function prepareMemory(wav: Uint8Array, options: Parameters<typeof prepareAudio>[1] = {}) {
    const storage = memoryStorage();
    const job = prepareAudio(chunks(wav, 5, 65536), { storage, sizeHint: wav.length, ...options });
    const statuses: string[] = [job.status];
    job.on('status', (s) => statuses.push(s));
    const manifest = await job.done;
    return { manifest, storage, statuses, job };
}

{
    const rate = 48000;
    const frames = 47 * rate + 123;
    const src = speechLike(frames, rate, 2, 11);
    const wav = encodeWav(src, rate, { tag: 1, bits: 16 });
    for (const segmentSeconds of [10, 3.3]) {
        const { manifest, storage, statuses } = await prepareMemory(wav, { segmentSeconds, framesPerPeak: 32 });
        assert.deepEqual(statuses, ['queued', 'processing', 'ready']);
        assert.equal(manifest.frames, frames);
        assert.equal(manifest.sampleRate, rate);
        // The WAV is kept as it is; the segments tile the timeline and are ranges of its data
        // chunk, back to back, which read back as the source's samples.
        assert.ok(Buffer.from(storage.objects.get('source.wav')!).equals(Buffer.from(wav)), 'the source kept byte for byte');
        assert.deepEqual(manifest.segments.source, { url: 'source.wav', bytes: wav.length, codec: 'wav', sampleRate: rate, channels: 2, pcm: { encoding: 'int', bitsPerSample: 16, blockAlign: 4 } });
        const list = manifest.segments.list;
        let next = 0;
        let byte = wav.length - frames * 4;
        for (const seg of list) {
            assert.equal(seg.startFrame, next, `segment ${seg.index} starts where the last ended`);
            assert.deepEqual(seg.range, [byte, byte + seg.frames * 4]);
            assert.equal(seg.tail, seg.frames);
            next += seg.frames;
            byte += seg.frames * 4;
        }
        assert.equal(next, frames);
        assert.equal(byte, wav.length);
        const back = await timelineAt(storage, manifest.segments, 2);
        const q16 = src.map((ch) => Float32Array.from(ch, (x) => Math.max(-32768, Math.min(32767, Math.round(Math.max(-1, Math.min(1, x)) * 32768))) / 32768));
        assert.ok(sameSamples(back, q16), `${segmentSeconds} s segments read back the source's samples`);
        assert.equal(list[0].frames, Math.round(segmentSeconds * rate));
        assert.match(manifest.id, /^sha256:[0-9a-f]{64}$/);

        // Peaks: every level against a brute-force reference from the source samples.
        const peaksBytes = storage.objects.get('peaks.bin')!;
        const peaks = decodePeaksFile(peaksBytes.buffer.slice(peaksBytes.byteOffset, peaksBytes.byteOffset + peaksBytes.length) as ArrayBuffer);
        assert.deepEqual(peaks.levels.map((l) => l.framesPerPeak), [32, 256, 2048]);
        assert.ok(peaks.levels[peaks.levels.length - 1].peaks <= 2048);
        const q = (x: number) => Math.max(-32768, Math.min(32767, Math.round(x * 32768))) || 0; // no -0
        const samples = src.map((ch) => ch.map((x) => q(x) / 32768)); // what the reader sees (16-bit)
        let checked = 0;
        for (const level of peaks.levels) {
            for (let c = 0; c < 2; c += 1) {
                const d = level.channels![c];
                for (let b = 0; b < level.peaks; b += 1) {
                    const from = b * level.framesPerPeak;
                    const to = Math.min(frames, from + level.framesPerPeak);
                    let lo = Infinity; let hi = -Infinity; let sq = 0;
                    for (let i = from; i < to; i += 1) {
                        const x = samples[c][i];
                        if (x < lo) lo = x; if (x > hi) hi = x; sq += x * x;
                    }
                    assert.equal(d.min[b], q(lo), `min L${level.framesPerPeak} c${c} b${b}`);
                    assert.equal(d.max[b], q(hi), `max L${level.framesPerPeak} c${c} b${b}`);
                    assert.ok(Math.abs(d.rms[b] - q(Math.sqrt(sq / (to - from)))) <= 1, `rms L${level.framesPerPeak} c${c} b${b}`);
                    checked += 1;
                }
            }
        }
        // The manifest's level table matches the file's.
        assert.deepEqual(manifest.peaks.levels.map((l) => [l.framesPerPeak, l.peaks, l.byteOffset]), peaks.layout.map((l) => [l.framesPerPeak, l.peaks, l.byteOffset]));
        results.push(`segments ${segmentSeconds} s: the WAV kept, ${list.length} ranges tile ${frames} frames and read back == source; peaks: ${checked} bins over 3 levels == brute force`);
    }

    // Default ladder: finest 256, ×8, until ≤ 2048 peaks.
    const { manifest } = await prepareMemory(wav);
    assert.deepEqual(manifest.peaks.levels.map((l) => l.framesPerPeak), [256, 2048]);

    // Loudness of a 0.5 sine: peak -6.02 dBFS, RMS -9.03 dBFS.
    const sine = [new Float64Array(rate * 3).map((_, i) => 0.5 * Math.sin(2 * Math.PI * 440 * i / rate))];
    const { manifest: m2 } = await prepareMemory(encodeWav(sine, rate, { tag: 3, bits: 32 }));
    assert.ok(Math.abs(m2.loudness.peakDb + 6.02) < 0.02, `peak ${m2.loudness.peakDb}`);
    assert.ok(Math.abs(m2.loudness.rmsDb + 9.03) < 0.05, `rms ${m2.loudness.rmsDb}`);
    assert.ok(Math.abs(m2.loudness.gatedRmsDb + 9.03) < 0.05, `gated ${m2.loudness.gatedRmsDb}`);
    results.push(`loudness: 0.5 sine → peak ${m2.loudness.peakDb} dBFS, RMS ${m2.loudness.rmsDb} dBFS`);

    // 96 kHz, 24-bit: the timeline is the source's (the player converts), the file kept as it is.
    const hi = encodeWav(speechLike(96000 * 3, 96000, 1), 96000, { tag: 1, bits: 24 });
    const { manifest: m3, storage: s3 } = await prepareMemory(hi);
    assert.equal(m3.sampleRate, 96000);
    assert.equal(m3.sourceSampleRate, 96000);
    assert.equal(m3.frames, 96000 * 3);
    assert.deepEqual(m3.segments.source.pcm, { encoding: 'int', bitsPerSample: 24, blockAlign: 3 });
    const hiBack = await timelineAt(s3, m3.segments, 1);
    const hiRef = await decodeAll(wavDecoder, chunks(hi));
    assert.ok(sameSamples(hiBack, hiRef.channels), '24-bit read back exactly');
    results.push('rates: 96 kHz 24-bit kept as it is (3 s → 288000 frames), read back exactly');

    // A WAV whose decoder stops before the file's end (a chunk after the data): the whole file is
    // kept and is the content id, whatever the decoder read.
    const tail = new Uint8Array(wav.length + 16);
    tail.set(wav);
    tail.set([...'JUNK'].map((ch) => ch.charCodeAt(0)), wav.length);
    new DataView(tail.buffer).setUint32(wav.length + 4, 8, true);
    new DataView(tail.buffer).setUint32(4, tail.length - 8, true);
    const { manifest: mt, storage: st } = await prepareMemory(tail);
    assert.ok(Buffer.from(st.objects.get('source.wav')!).equals(Buffer.from(tail)), 'the trailing chunk is kept');
    assert.equal(mt.id, `sha256:${(await import('node:crypto')).createHash('sha256').update(tail).digest('hex')}`);
    assert.equal(mt.source.bytes, tail.length);

    // An index that does not read back what was decoded (here: a decoder that says MP3 and gives
    // other samples) is not published: the source is kept as a 16-bit WAV, with a warning.
    const mp3Bytes = new Uint8Array(fs.readFileSync(new URL('../../../test/fixtures/sine-speech.mp3', import.meta.url)));
    const louder: AudioDecoder = (bytes, options) => {
        const inner = builtinDecoder(bytes, options);
        return { format: inner.format, blocks: (async function* () { for await (const b of inner.blocks) yield b.map((c) => c.map((x) => x * 0.5)); })() };
    };
    const { manifest: mf, storage: sf, job: jf } = await prepareMemory(mp3Bytes, { decoder: louder, segmentSeconds: 0.5 });
    assert.equal(mf.segments.source.url, 'source.wav');
    assert.equal(sf.objects.has('source.mp3'), false);
    assert.equal(jf.stats!.warnings.length, 1);
    assert.match(jf.stats!.warnings[0], /^A: the mp3 file could not be indexed \(segment 0 reads back off by up to .*\); kept as a 16-bit WAV instead$/);
    const halved = (await decodeAll(louder, chunks(mp3Bytes))).channels.map((c) => Float32Array.from(c, (x) => Math.max(-32768, Math.min(32767, Math.round(x * 32768))) / 32768));
    assert.ok(sameSamples(await timelineAt(sf, mf.segments, 2), halved), 'the WAV holds what was decoded');
    results.push('the source: a chunk after the data kept and hashed; an index that does not read back → a 16-bit WAV of what was decoded, with a warning');

    // Failures: an input the built-in decoder does not read fails the job with the hint to pass one.
    const bad = prepareAudio(chunks(new TextEncoder().encode('OggS\0\0\0\"this is not a wav at all')), { storage: memoryStorage() });
    await assert.rejects(bad.done, /ffmpegDecoder/);
    assert.equal(bad.status, 'failed');
    // A valid file with no samples (as ffmpeg makes of an M4A it cannot read from a pipe): said so.
    const empty = prepareAudio(chunks(encodeWav([new Float64Array(0), new Float64Array(0)], 44100, { tag: 1, bits: 16 })), { storage: memoryStorage() });
    await assert.rejects(empty.done, /no audio: it decoded to 0 frames/);

    // The decoder hook: any source of planar blocks.
    const toneDecoder: AudioDecoder = () => ({
        format: Promise.resolve({ sampleRate: 22050, channels: 1, encoding: 'synthetic', bitsPerSample: 32, frames: 22050 }),
        blocks: (async function* () {
            for (let k = 0; k < 10; k += 1) yield [new Float32Array(2205).fill(0.25)];
        })(),
    });
    const { manifest: m5, storage: s5 } = await prepareMemory(new Uint8Array(1), { decoder: toneDecoder });
    assert.equal(m5.frames, 22050);
    assert.equal(m5.source.encoding, 'synthetic');
    // No layout from the decoder: kept as a 16-bit WAV of what it gave.
    assert.equal(m5.segments.source.url, 'source.wav');
    assert.ok((await timelineAt(s5, m5.segments, 1))[0].every((x) => x === 0.25));
    assert.ok(Math.abs(m5.loudness.peakDb - 20 * Math.log10(0.25)) < 0.01);
    results.push('job: queued → processing → ready; non-WAV → failed (names ffmpeg); custom decoder hook');
}

// ---- v2 outputs: bands.bin and spectrogram.bin ------------------------------------------

function biquadRun(x: Float64Array, c: { b0: number; b1: number; b2: number; a1: number; a2: number }): Float64Array {
    const y = new Float64Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i += 1) {
        const v = c.b0 * x[i] + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
        x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
    }
    return y;
}

{
    const rate = 48000;
    const frames = rate * 12;
    // Speech-like plus a strong 60 Hz hum and a 150 Hz component: lots of low end to remove.
    const src = speechLike(frames, rate, 2, 21);
    for (let c = 0; c < 2; c += 1) for (let i = 0; i < frames; i += 1) {
        src[c][i] = 0.6 * src[c][i] + 0.15 * Math.sin(2 * Math.PI * 60 * i / rate) + 0.08 * Math.sin(2 * Math.PI * 150 * i / rate + c);
    }
    const wav = encodeWav(src, rate, { tag: 3, bits: 32 });
    const { manifest, storage } = await prepareMemory(wav);
    assert.equal(manifest.formatVersion, 4);
    assert.ok(manifest.bands && manifest.spectrogram);
    const bandsBytes = storage.objects.get('bands.bin')!;
    const bands = decodeBandsFile(bandsBytes.buffer.slice(bandsBytes.byteOffset, bandsBytes.byteOffset + bandsBytes.length) as ArrayBuffer);
    assert.deepEqual(bands.cutoffs, [25, 35, 50, 71, 100, 141, 200, 283, 400, 566]);
    assert.equal(bands.bins, Math.ceil(frames / 2048));

    // Brute force at the full rate: mono downmix (of the float32 samples), total and the player's 4th-order high-pass.
    const mono = new Float64Array(frames);
    for (let i = 0; i < frames; i += 1) mono[i] = (Math.fround(src[0][i]) + Math.fround(src[1][i])) / 2;
    const lp = bands.cutoffs.map((hz) => HIGH_PASS_SECTION_Q.reduce((x, q) => biquadRun(x, computeHighPassCoefficients(rate, hz, q)), mono));
    const binMs = (x: Float64Array, b: number) => {
        let s2 = 0;
        const from = b * 2048;
        const to = Math.min(frames, from + 2048);
        for (let i = from; i < to; i += 1) s2 += x[i] * x[i];
        return s2 / (to - from);
    };
    const width = 1 + bands.cutoffs.length;
    let worstTotal = 0;
    let worstLp = 0;
    for (let b = 2; b < bands.bins - 1; b += 1) {
        const total = binMs(mono, b);
        worstTotal = Math.max(worstTotal, Math.abs(10 * Math.log10(bands.meanSquares[b * width] / total)));
        for (let k = 0; k < bands.cutoffs.length; k += 1) {
            const ref = binMs(lp[k], b);
            if (ref < 1e-7) continue;
            const e = Math.abs(10 * Math.log10(bands.meanSquares[b * width + 1 + k] / ref));
            worstLp = Math.max(worstLp, e);
        }
    }
    assert.ok(worstTotal < 0.01, `band total vs brute force: ${worstTotal} dB`);
    assert.ok(worstLp < 0.5, `high-passed energies vs brute force (split/decimated path): ${worstLp.toFixed(3)} dB`);

    // The high-pass estimate against the real 4th-order high-pass of the player.
    let worstHp = 0;
    let sumHp = 0;
    let countHp = 0;
    for (const hz of [40, 80, 150, 300, 500]) {
        const hp = HIGH_PASS_SECTION_Q.reduce((x, q) => biquadRun(x, computeHighPassCoefficients(rate, hz, q)), mono);
        for (let b = 4; b < bands.bins - 1; b += 1) {
            const est = highPassEnergyRatio(bands, b, hz) * binMs(mono, b);
            const ref = binMs(hp, b);
            if (ref < 1e-6) continue;
            const e = Math.abs(10 * Math.log10(est / ref));
            worstHp = Math.max(worstHp, e);
            sumHp += e;
            countHp += 1;
        }
    }
    // Octave-spaced cutoffs: a strong tone between two of them (60 Hz hum, HP at 80 Hz) is the worst case.
    assert.ok(worstHp < 1.5 && sumHp / countHp < 0.3, `high-pass energy estimate vs filtering: worst ${worstHp.toFixed(2)} dB, mean ${(sumHp / countHp).toFixed(2)} dB`);
    results.push(`bands.bin: totals within ${worstTotal.toFixed(3)} dB, high-passes within ${worstLp.toFixed(2)} dB of brute force; `
        + `HP 40-500 Hz energy estimate vs real filtering per 43 ms bin: mean ${(sumHp / countHp).toFixed(2)} dB, worst ${worstHp.toFixed(2)} dB (hum between half-octave cutoffs)`);
}

{
    // Spectrogram tiles against a reference DTFT: three steady tones.
    const rate = 48000;
    const frames = rate * 6;
    const tones = [[440, 0.3], [1000, 0.2], [2200, 0.1]];
    const x = [new Float64Array(frames)];
    for (let i = 0; i < frames; i += 1) for (const [f, a] of tones) x[0][i] += a * Math.sin(2 * Math.PI * f * i / rate);
    const { storage, manifest } = await prepareMemory(encodeWav(x, rate, { tag: 1, bits: 16 }));
    const bytes = storage.objects.get('spectrogram.bin')!;
    const spec = decodeSpectrogramFile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) as ArrayBuffer);
    assert.equal(spec.rows, 128);
    assert.equal(spec.levels[0].hop, 4096);
    assert.equal(spec.levels[0].columns, Math.ceil(frames / 4096));
    assert.deepEqual(manifest.spectrogram!.levels.map((l) => l.framesPerColumn), spec.levels.map((l) => l.hop));
    const rows = spec.rows;
    const rowHz = (r: number) => spec.minHz * Math.pow(spec.maxHz / spec.minHz, (rows - 1 - r) / (rows - 1));
    const levelDb = (q: number) => spec.topDb - spec.rangeDb + (q / 255) * spec.rangeDb;
    // The 2048-point Hann DTFT of the frame at a frequency, at the worker's scale (norm 1 at 2048).
    const dtft = (centre: number, hz: number) => {
        const N = 2048;
        let re = 0;
        let im = 0;
        const start = Math.round(centre - N / 2);
        for (let n = 0; n < N; n += 1) {
            const s = Math.round(Math.max(-1, Math.min(1, x[0][start + n])) * 32768); // what the WAV holds
            const v = Math.max(-32767, Math.min(32767, Math.round((s / 32768) * 32767))) / 32767; // the 16-bit downmix
            const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * n / (N - 1));
            re += v * w * Math.cos(2 * Math.PI * hz * (start + n) / rate);
            im -= v * w * Math.sin(2 * Math.PI * hz * (start + n) / rate);
        }
        return Math.hypot(re, im);
    };
    const f0 = 20; // a frame well inside the steady part
    const centre = (f0 + 0.5) * 4096;
    const column = spec.levels[0].a!.subarray(f0 * rows, (f0 + 1) * rows);
    let worst = 0;
    for (const [hz] of tones.filter(([f]) => f >= 400 && f <= 2400)) {
        let best = 0;
        for (let r = 0; r < rows; r += 1) if (Math.abs(Math.log(rowHz(r) / hz)) < Math.abs(Math.log(rowHz(best) / hz))) best = r;
        const peakRow = Math.max(column[best], column[best - 1] ?? 0, column[best + 1] ?? 0);
        worst = Math.max(worst, Math.abs(levelDb(peakRow) - 20 * Math.log10(dtft(centre, hz))));
    }
    assert.ok(worst < 2, `tone levels vs reference DTFT: ${worst.toFixed(2)} dB`);
    // Far from any tone (5-8 kHz) the picture is at least 40 dB below the loudest tone.
    const loudest = Math.max(...column);
    for (let r = 0; r < rows; r += 1) {
        const hz = rowHz(r);
        if (hz > 5000 && hz < 8000) assert.ok(levelDb(loudest) - levelDb(column[r]) > 40, `row ${hz.toFixed(0)} Hz too loud`);
    }
    // Coarser levels pool 8 columns (the louder per row).
    const l1 = spec.levels[1];
    if (l1) {
        for (let r = 0; r < rows; r += 1) {
            let m = 0;
            for (let f = 0; f < 8; f += 1) m = Math.max(m, spec.levels[0].a![f * rows + r]);
            assert.equal(l1.a![r], m);
        }
    }
    results.push(`spectrogram.bin: 128 rows, 4096-frame hop; tone levels within ${worst.toFixed(2)} dB of a reference Hann DTFT; 5-8 kHz >= 40 dB down`);
}

{
    // Parallel analysis: 1 thread and 4 threads write byte-identical outputs (jobs are a fixed cut of the timeline).
    const rate = 48000;
    const frames = rate * 70 + 777; // three jobs, the last one partial
    const src = speechLike(frames, rate, 2, 31);
    for (let c = 0; c < 2; c += 1) for (let i = 0; i < frames; i += 1) src[c][i] += 0.1 * Math.sin(2 * Math.PI * 60 * i / rate);
    const wav = encodeWav(src, rate, { tag: 1, bits: 16 });
    const one = await prepareMemory(wav, { concurrency: 1 });
    const four = await prepareMemory(wav, { concurrency: 4 });
    assert.equal(one.job.stats!.threads, 1);
    assert.equal(four.job.stats!.threads, 4, 'the worker pool started');
    const keys = [...one.storage.objects.keys()].filter((k) => k !== 'manifest.json').sort();
    assert.deepEqual(keys, [...four.storage.objects.keys()].filter((k) => k !== 'manifest.json').sort());
    for (const key of keys) {
        assert.ok(Buffer.from(one.storage.objects.get(key)!).equals(Buffer.from(four.storage.objects.get(key)!)), `${key} differs between 1 and 4 threads`);
    }
    const strip = (m: unknown) => JSON.stringify({ ...(m as object), createdAt: '' });
    assert.equal(strip(one.manifest), strip(four.manifest));
    results.push(`parallel prepare: 1 vs 4 worker threads → ${keys.length} files + manifest byte-identical (3 jobs of 25.6 s, warm-up carried)`);
}

{
    // Parallel resampling: bit-identical to the streaming resampler, for any chunk and thread count.
    const lines: string[] = [];
    for (const [from, to, ch] of [[16000, 48000, 1], [96000, 48000, 2], [44100, 48000, 1]] as const) {
        const frames = Math.round(from * 7.3) + 11;
        const x = speechLike(frames, from, ch, 17).map((c) => Float32Array.from(c));
        const ref = new StreamingResampler(ch, from, to);
        const parts: Float32Array[][] = [];
        for (let o = 0; o < frames; o += 4999) parts.push(ref.push(x.map((c) => c.subarray(o, Math.min(frames, o + 4999)))));
        parts.push(ref.end());
        const want = x.map((_, c) => { const n = parts.reduce((s, p) => s + p[c].length, 0); const y = new Float32Array(n); let o = 0; for (const p of parts) { y.set(p[c], o); o += p[c].length; } return y; });
        for (const [threads, chunk] of [[1, 10007], [4, 10007], [4, 1 << 19]] as const) {
            const pool = new JobPool(threads, new URL('./prepare-worker.mjs', import.meta.url));
            async function* blocks() { for (let o = 0; o < frames; o += 3333) yield x.map((c) => c.slice(o, Math.min(frames, o + 3333))); }
            const got: Float32Array[][] = [];
            for await (const b of resampleInParallel(blocks(), from, to, pool, undefined, chunk)) got.push(b);
            await pool.close();
            for (let c = 0; c < ch; c += 1) {
                const n = got.reduce((s, p) => s + p[c].length, 0);
                assert.equal(n, want[c].length, `${from}→${to}: ${n} frames, streaming gives ${want[c].length}`);
                const y = new Float32Array(n); let o = 0; for (const p of got) { y.set(p[c], o); o += p[c].length; }
                assert.ok(Buffer.from(y.buffer).equals(Buffer.from(want[c].buffer)), `${from}→${to} (${threads} threads, chunk ${chunk}) differs from the streaming resampler`);
            }
        }
        lines.push(`${from / 1000}→${to / 1000} kHz`);
    }
    results.push(`parallel resampling: ${lines.join(', ')} bit-identical to the streaming resampler (1/4 threads, 10007-frame and 512 K chunks)`);
}

// ---- stem B in the same prepare call ------------------------------------------------------

const asWav16 = (x: Float64Array[], r: number) => encodeWav(x, r, { tag: 1, bits: 16 });
const delayed = (x: Float64Array, d: number, gain: number) => {
    const y = new Float64Array(x.length);
    for (let i = d; i < x.length; i += 1) y[i] = x[i - d] * gain;
    return y;
};
const resampleF64 = (x: Float64Array, from: number, to: number) => {
    const r = new StreamingResampler(1, from, to);
    const out = [r.push([Float32Array.from(x)])[0], r.end()[0]];
    const y = new Float64Array(out[0].length + out[1].length);
    y.set(out[0]); y.set(out[1], out[0].length);
    return y;
};
const readManifestOf = (storage: ReturnType<typeof memoryStorage>) => JSON.parse(new TextDecoder().decode(storage.objects.get('manifest.json')!));
const levelDb = async (storage: ReturnType<typeof memoryStorage>, m: AudioManifest, i: number) => {
    const sa = (await segmentAt(storage, m.segments, 1, i))[0], sb = (await segmentAt(storage, m.stems!.b.segments!, 1, i))[0];
    let ea = 0, eb = 0, ab = 0;
    for (let k = 0; k < sa.length; k += 1) { ea += sa[k] ** 2; eb += sb[k] ** 2; ab += sa[k] * sb[k]; }
    return { db: 10 * Math.log10(eb / ea), rho: ab / Math.sqrt(ea * eb) };
};
const RATE = 48000;
const A40 = speechLike(RATE * 40, RATE, 1, 41);
const A40wav = asWav16(A40, RATE);

/** Every manifest the stem tests publish is checked against the shipped JSON Schema and assertManifest(). */
const validateSchema = new Ajv2020({ allErrors: true, strict: false }).compile(manifestSchema as object);
const schemaChecked: string[] = [];
function checkManifest(m: unknown, name: string): void {
    const ok = validateSchema(m);
    assert.ok(ok, `${name}: schema: ${JSON.stringify(validateSchema.errors)}`);
    assert.doesNotThrow(() => assertManifest(m), `${name}: assertManifest`);
    schemaChecked.push(name);
}


{
    // One call: A and B (16 kHz, mono, 37 ms late, -6 dB) → one manifest; same bytes for 1 and 4 threads.
    const bWav = asWav16([resampleF64(delayed(A40[0], Math.round(0.037 * RATE), 0.5), RATE, 16000)], 16000);
    const run = async (concurrency: number) => {
        const storage = memoryStorage();
        const job = prepareAudio(chunks(A40wav, 3, 65536), { storage, concurrency, stems: { b: { input: () => chunks(bWav, 7, 65536), name: 'b16.wav' } } });
        const stages = new Set<string>();
        job.on('progress', (p) => { if (p.stage) stages.add(p.stage); });
        const manifest = await job.done;
        return { storage, manifest, job, stages };
    };
    const one = await run(1);
    const four = await run(4);
    const m = one.manifest;
    checkManifest(m, 'A + b in one call');
    const b = m.stems!.b!;
    assert.equal(m.formatVersion, 4);
    assert.equal(m.revision, 1, 'published once');
    assert.equal(b.status, 'ready');
    assert.equal(b.aSourceId, m.id);
    assert.equal(b.processor, undefined);
    assert.ok(Math.abs(b.alignment!.offsetFrames - 1776) <= 1, `offset ${b.alignment!.offsetFrames}`);
    assert.ok(b.alignment!.confidence > 0.8);
    assert.equal(b.mixLaw, 'crossfade');
    assert.ok(Math.abs(b.source!.bandwidthHz - 8000) <= 700, `bandwidth ${b.source!.bandwidthHz}`);
    assert.equal(b.source!.sampleRate, 16000);
    assert.ok(Math.abs(b.loudnessDeltaDb! + 6) < 0.7);
    assert.equal(b.gainDb, 0);
    // Grid identity: B's segment boundaries are A's.
    assert.deepEqual(b.segments!.list.map((s) => [s.startFrame, s.frames]), m.segments.list.map((s) => [s.startFrame, s.frames]));
    // B at another rate than A: kept as a 16-bit WAV on A's grid.
    assert.equal(b.segments!.source.url, 'b/r1/source.wav');
    assert.equal(b.segments!.source.sampleRate, RATE);
    const lv = await levelDb(one.storage, m, 2);
    assert.ok(Math.abs(lv.db + 6) < 0.7 && lv.rho > 0.95, `B segment ${lv.db.toFixed(2)} dB, ρ ${lv.rho.toFixed(3)}`);
    assert.deepEqual([...one.stages].sort(), ['a', 'stem']);
    // Determinism across concurrency: every file, and the manifest but for timestamps.
    const keys = [...one.storage.objects.keys()].sort();
    assert.deepEqual(keys, [...four.storage.objects.keys()].sort());
    for (const key of keys.filter((k) => k !== 'manifest.json')) {
        assert.ok(Buffer.from(one.storage.objects.get(key)!).equals(Buffer.from(four.storage.objects.get(key)!)), `${key} differs between 1 and 4 threads`);
    }
    const strip = (x: typeof m) => JSON.stringify({ ...x, createdAt: '', stems: { b: { ...x.stems!.b!, updatedAt: '' } } });
    assert.equal(strip(one.manifest), strip(four.manifest));
    assert.ok(four.job.stats!.timings.stemMs! >= 0 && four.job.stats!.warnings.length === 0);

    // attachStem on an A-only folder runs the same code: the same B files, byte for byte.
    const later = memoryStorage();
    await prepareAudio(chunks(A40wav, 3, 65536), { storage: later, concurrency: 1 }).done;
    const attached = await attachStem({ storage: later }, 'b', () => chunks(bWav, 7, 65536), { concurrency: 1, name: 'b16.wav' });
    assert.ok(keys.filter((k) => k.startsWith('b/')).every((k) => k.startsWith('b/r1/')), 'the one-call stem is under b/r1/');
    for (const key of keys.filter((k) => k.startsWith('b/'))) {
        const attachedKey = key.replace('b/r1/', 'b/r2/');
        assert.ok(Buffer.from(later.objects.get(attachedKey)!).equals(Buffer.from(one.storage.objects.get(key)!)), `attachStem: ${attachedKey} differs from the one-call prepare's ${key}`);
    }
    assert.equal(readManifestOf(later).revision, 2);
    checkManifest(readManifestOf(later), 'attachStem b');
    assert.equal(attached.alignment!.offsetFrames, b.alignment!.offsetFrames);
    results.push(`prepare A+B in one call: B 16 kHz mono 37 ms late → offset ${b.alignment!.offsetFrames} (${b.alignment!.offsetMs} ms), confidence ${b.alignment!.confidence}, ρ ${b.correlation!.global}, ${b.mixLaw}, band ${b.source!.bandwidthHz} Hz, loudness ${b.loudnessDeltaDb} dB (info); one manifest (revision 1), B on A's grid; ${keys.length} files byte-identical for 1 vs 4 threads; attachStem writes the same B bytes`);
}

{
    // Refusals: 1-frame offset is exact; unrelated B fails the job, or (warn) publishes A only with the reason.
    const one = memoryStorage();
    const m1 = await prepareAudio(chunks(A40wav, 3, 65536), { storage: one, concurrency: 1, stems: { b: { input: { channels: [Float32Array.from(delayed(A40[0], 1, 1))], sampleRate: RATE } } } }).done;
    assert.equal(m1.stems!.b!.alignment!.offsetFrames, 1);
    const noise = Float64Array.from({ length: A40[0].length }, (_, i) => Math.sin(i * 12.9898) * 0.3 * Math.sin(i * 0.0001));
    const failing = memoryStorage();
    await assert.rejects(prepareAudio(chunks(A40wav, 3, 65536), { storage: failing, concurrency: 1, stems: { b: { input: () => chunks(asWav16([noise], RATE), 2, 65536) } } }).done, /does not line up/);
    assert.equal(failing.objects.has('manifest.json'), false, 'nothing published');
    const warned = memoryStorage();
    const job = prepareAudio(chunks(A40wav, 3, 65536), { storage: warned, concurrency: 1, stems: { b: { input: () => chunks(asWav16([noise], RATE), 2, 65536), onLowConfidence: 'warn' } } });
    const mw = await job.done;
    assert.equal(mw.stems!.b!.status, 'failed');
    assert.match(mw.stems!.b!.error!, /does not line up/);
    assert.ok(mw.stems!.b!.alignment);
    checkManifest(mw, 'b refused (warn)');
    assert.equal(job.stats!.warnings.length, 1);
    assert.ok(![...warned.objects.keys()].some((k) => k.startsWith('b/')), 'no B files');
    await assert.rejects(prepareAudio(chunks(A40wav, 3, 65536), { storage: memoryStorage(), stems: { b: {} } }).done, /exactly one/);
    results.push('stem B refusals: 1-frame offset exact; unrelated B fails the job (no manifest) or, with onLowConfidence "warn", publishes A only with stems.b failed + reason + measured alignment');
}

{
    // A pool kept between calls (a service's): the same bytes as without one, still usable after
    // a call (prepareAudio does not close it), shared by calls that overlap.
    const bWav = asWav16([delayed(A40[0], 480, 0.5)], RATE);
    const run = async (pool?: ReturnType<typeof createPreparePool>) => {
        const storage = memoryStorage();
        await prepareAudio(chunks(A40wav, 3, 65536), { storage, concurrency: 1, ...(pool ? { pool } : {}), stems: { b: { input: () => chunks(bWav, 5, 65536) } } }).done;
        return storage;
    };
    const inline = await run();
    const pool = createPreparePool({ concurrency: 2 });
    try {
        assert.equal(pool.size, 2);
        const [first, second] = await Promise.all([run(pool), run(pool)]);
        const third = await run(pool);
        assert.equal(pool.failed, null);
        for (const other of [first, second, third]) {
            const keys = [...inline.objects.keys()].filter((k) => k !== 'manifest.json').sort();
            assert.deepEqual([...other.objects.keys()].filter((k) => k !== 'manifest.json').sort(), keys);
            for (const key of keys) assert.ok(Buffer.from(other.objects.get(key)!).equals(Buffer.from(inline.objects.get(key)!)), `${key} differs through the kept pool`);
        }
    } finally {
        await pool.close();
    }
    results.push(`kept pool (${pool.threaded ? 'threaded' : 'inline: no worker script'}): two overlapping calls and a third, every file byte-identical to a call without it; prepareAudio leaves it open`);
}

{
    // Alignment goes by the windows that agree, not by how strongly the stem correlates with A:
    // a quiet part of A (20 dB under it, ρ ≈ 0.1) is accepted at its offset; a stem that is
    // silent for most of the file is measured where it sounds; a silent stem is refused.
    const frames = A40[0].length;
    // Breath-like noise bursts: a part of A of its own, unrelated to the voiced tone.
    let seed = 991;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed / 2147483647) * 2 - 1; };
    const part = Float64Array.from({ length: frames }, (_, i) => rnd() * Math.max(0, Math.sin(2 * Math.PI * 0.9 * (i / RATE) + 1)) ** 2);
    let ea = 0, ep = 0;
    for (let i = 0; i < frames; i += 1) { ea += A40[0][i] ** 2; ep += part[i] ** 2; }
    const g = Math.sqrt((ea / ep) * 10 ** (-20 / 10));
    const quiet = part.map((v) => v * g);
    const mixed = A40[0].map((v, i) => v + quiet[i]);
    const mq = await prepareAudio(chunks(asWav16([mixed], RATE), 3, 65536), { storage: memoryStorage(), concurrency: 1, stems: { quiet: { input: { channels: [Float32Array.from(delayed(quiet, 480, 1))], sampleRate: RATE } } } }).done;
    const q = mq.stems!.quiet!;
    assert.equal(q.status, 'ready');
    assert.equal(q.alignment!.offsetFrames, 480);
    assert.ok(q.alignment!.confidence >= 0.75, `confidence ${q.alignment!.confidence}`);
    assert.ok(q.correlation!.global < 0.3, `ρ ${q.correlation!.global}: the quiet part correlates weakly, as it should`);
    checkManifest(mq, 'quiet stem');

    const partTime = Float32Array.from(A40[0], (v, i) => (i < frames * 0.4 ? v : 0));
    const mp = await prepareAudio(chunks(A40wav, 3, 65536), { storage: memoryStorage(), concurrency: 1, stems: { vocal: { input: { channels: [partTime], sampleRate: RATE } } } }).done;
    const p = mp.stems!.vocal!.alignment!;
    assert.equal(mp.stems!.vocal!.status, 'ready');
    assert.ok(p.windows < 8 && p.windows >= 2 && p.agreeing === p.windows && p.offsetFrames === 0, JSON.stringify(p));

    await assert.rejects(
        prepareAudio(chunks(A40wav, 3, 65536), { storage: memoryStorage(), concurrency: 1, stems: { b: { input: { channels: [new Float32Array(frames)], sampleRate: RATE } } } }).done,
        /silent wherever A sounds/,
    );
    results.push(`alignment by agreement: a part 20 dB under A (ρ ${q.correlation!.global}) accepted at 10 ms, ${q.alignment!.agreeing}/${q.alignment!.windows} windows; a stem silent for 60 % measured on ${p.windows} windows, all agreeing; a silent stem refused`);
}

// ---- named stems ----------------------------------------------------------------------------

{
    // Two stems with neutral keys and labels, in one call: each on A's grid under its own folder.
    const storage = memoryStorage();
    const bWav = asWav16([delayed(A40[0], Math.round(0.037 * RATE), 0.5)], RATE);
    const v1Wav = asWav16([delayed(A40[0], Math.round(0.011 * RATE), 0.8)], RATE);
    const job = prepareAudio(chunks(A40wav, 3, 65536), {
        storage,
        concurrency: 2,
        stems: {
            b: { input: () => chunks(bWav, 5, 65536), label: 'Noise reduction' },
            v1: { input: () => chunks(v1Wav, 5, 65536), label: 'Voice conversion' },
        },
    });
    const seen = new Set<string>();
    job.on('progress', (p) => { if (p.stage === 'stem' && p.stem) seen.add(p.stem); });
    const m = await job.done;
    assert.deepEqual(Object.keys(m.stems!), ['b', 'v1']);
    assert.equal(m.stems!.b.label, 'Noise reduction');
    assert.equal(m.stems!.v1.label, 'Voice conversion');
    assert.equal(m.stems!.b.status, 'ready');
    assert.equal(m.stems!.v1.status, 'ready');
    assert.ok(Math.abs(m.stems!.b.alignment!.offsetFrames - Math.round(0.037 * RATE)) <= 1);
    assert.ok(Math.abs(m.stems!.v1.alignment!.offsetFrames - Math.round(0.011 * RATE)) <= 1);
    // A WAV at A's rate: kept as it is, its index shifted by the offset.
    assert.equal(m.stems!.v1.segments!.source.url, 'v1/r1/source.wav');
    assert.ok(Buffer.from(storage.objects.get('v1/r1/source.wav')!).equals(Buffer.from(v1Wav)), 'v1 kept byte for byte');
    assert.ok(storage.objects.has('v1/r1/peaks.bin') && storage.objects.has('b/r1/peaks.bin'));
    assert.deepEqual([...seen].sort(), ['b', 'v1']);
    assert.deepEqual(Object.keys(job.stats!.timings.stems).sort(), ['b', 'v1']);
    const lv = await levelDb(storage, { ...m, stems: { b: m.stems!.v1 } }, 1);
    assert.ok(Math.abs(lv.db - 20 * Math.log10(0.8)) < 0.5, `v1 level ${lv.db.toFixed(2)} dB`);
    checkManifest(m, 'two named stems');

    // attachStem / markStem take any valid key, and keep a label.
    const v2 = await attachStem({ storage }, 'v2', () => chunks(v1Wav, 5, 65536), { concurrency: 1, label: 'Variant 2' });
    assert.equal(v2.label, 'Variant 2');
    const after = readManifestOf(storage);
    assert.deepEqual(Object.keys(after.stems), ['b', 'v1', 'v2']);
    assert.equal(after.revision, 2);
    checkManifest(after, 'attachStem v2');
    const marked = await markStem({ storage }, 'v3', 'processing');
    assert.equal(marked.stems!.v3.status, 'processing');
    checkManifest(marked, 'markStem v3 processing');
    // 'ready' only for a stem that is ready with its files (else the player would refuse the whole manifest).
    await assert.rejects(markStem({ storage }, 'v9', 'ready'), /no ready files.*no such stem/);
    await assert.rejects(markStem({ storage }, 'v3', 'ready'), /no ready files.*processing/);
    await markStem({ storage }, 'v4', 'failed', 'gave up');
    await assert.rejects(markStem({ storage }, 'v4', 'ready'), /no ready files.*failed/);
    const stillReady = await markStem({ storage }, 'v1', 'ready');
    assert.equal(stillReady.stems!.v1.segments!.list.length, m.segments.list.length);
    checkManifest(stillReady, 'markStem v1 ready (was ready)');
    checkManifest(readManifestOf(storage), 'after refused markStem calls');

    // Replacing a stem: a new folder; the old version's files stay, byte for byte, for caches that hold the old manifest.
    const oldV2 = new Map([...storage.objects].filter(([k]) => k.startsWith('v2/')).map(([k, v]) => [k, Buffer.from(v)]));
    assert.ok(oldV2.size > 0 && [...oldV2.keys()].every((k) => k.startsWith('v2/r2/')), 'attached at revision 2: v2/r2/');
    const before = readManifestOf(storage).revision;
    const v2new = await attachStem({ storage }, 'v2', () => chunks(bWav, 5, 65536), { concurrency: 1, label: 'Variant 2b' });
    const replaced = readManifestOf(storage);
    assert.equal(replaced.revision, before + 1);
    const prefix = `v2/r${before + 1}/`;
    assert.ok(v2new.segments!.source.url.startsWith(prefix) && v2new.peaks!.url.startsWith(prefix), `new version under ${prefix}`);
    for (const [k, v] of oldV2) assert.ok(Buffer.from(storage.objects.get(k)!).equals(v), `${k} was overwritten`);
    assert.ok(!JSON.stringify(replaced).includes('v2/r2/'), 'the new manifest does not list the old files');
    checkManifest(replaced, 'attachStem v2 replaced');

    // Key validation: reserved 'a', invalid characters, case-insensitive collisions, labels.
    const bad = async (stems: Record<string, unknown>, re: RegExp) => assert.rejects(
        prepareAudio(chunks(A40wav, 3, 65536), { storage: memoryStorage(), concurrency: 1, stems: stems as never }).done, re);
    const input = { input: { channels: [Float32Array.from(A40[0])], sampleRate: RATE } };
    await bad({ a: input }, /reserved/);
    await bad({ A: input }, /reserved/);
    await bad({ 'two words': input }, /Invalid stem key/);
    await bad({ '-x': input }, /Invalid stem key/);
    await bad({ ['k'.repeat(33)]: input }, /Invalid stem key/);
    await bad({ '../b': input }, /Invalid stem key/);
    await bad({ V1: input, v1: input }, /collides/);
    await bad({ v1: { ...input, label: '' } }, /label/);
    await assert.rejects(attachStem({ storage }, 'a', () => chunks(v1Wav, 5, 65536)), /reserved/);
    await assert.rejects(markStem({ storage }, 'no/slash', 'processing'), /Invalid stem key/);
    results.push(`named stems: b ("Noise reduction") + v1 ("Voice conversion") in one call, each on A's grid under <key>/r1/, offsets ${m.stems!.b.alignment!.offsetMs} / ${m.stems!.v1.alignment!.offsetMs} ms; attachStem v2 + markStem v3; markStem 'ready' refused without ready files; replacing v2 writes a new folder and leaves the old files byte for byte; keys validated (a reserved, pattern, case-insensitive collisions, labels)`);
}

{
    // A stem the player reads as it is (an MP3 or a FLAC at A's rate, as a byte stream: spooled) is
    // kept byte for byte, its index shifted by the offset: every segment reads back the decoder's
    // samples, shifted, with silence where the stem has none (lead at the start, trail at the end).
    const fixtures = new URL('../../../test/fixtures/', import.meta.url);
    const mp3 = new Uint8Array(fs.readFileSync(new URL('sine-speech.mp3', fixtures)));
    const rate = 44100;
    const flacB = encodeFlac((await decodeAll(builtinDecoder, chunks(mp3))).channels.map((c) => Float64Array.from(c)), rate, 16, 4096);
    const notes: string[] = [];
    for (const [codec, bytesB] of [['mp3', mp3], ['flac', flacB]] as const) {
    const decodedB = (await decodeAll(builtinDecoder, chunks(bytesB))).channels;
    for (const shift of [-2205, 1323]) {
        // A[t] = B[t + shift]: B is `shift` frames late against A.
        const at = (c: Float32Array, t: number) => (t >= 0 && t < c.length ? c[t] : 0);
        const a = decodedB.map((c) => Float64Array.from({ length: c.length }, (_, t) => at(c, t + shift)));
        const storage = memoryStorage();
        const job = prepareAudio(chunks(encodeWav(a, rate, { tag: 1, bits: 16 }), 3, 65536), { storage, concurrency: 1, segmentSeconds: 0.5, stems: { b: { input: () => chunks(bytesB, 5, 4096) } } });
        const m = await job.done;
        const b = m.stems!.b!;
        assert.equal(b.status, 'ready');
        assert.equal(b.alignment!.offsetFrames, shift);
        assert.equal(b.segments!.source.url, `b/r1/source.${codec}`);
        assert.ok(Buffer.from(storage.objects.get(`b/r1/source.${codec}`)!).equals(Buffer.from(bytesB)), `${codec}: kept byte for byte`);
        assert.deepEqual(job.stats!.warnings, []);
        const list = b.segments!.list;
        if (shift < 0) assert.equal(list[0].lead, -shift);
        else {
            // B ends that many frames before A: the segment it ends in has the rest as trail, any after it are silence.
            const end = m.frames - shift;
            for (const seg of list) {
                if (seg.startFrame >= end) assert.equal(seg.range, null);
                else if (seg.startFrame + seg.frames > end) assert.equal(seg.trail, seg.startFrame + seg.frames - end);
                else assert.equal(seg.trail, undefined);
            }
        }
        const want = decodedB.map((c) => Float32Array.from({ length: m.frames }, (_, t) => at(c, t + shift)));
        assert.ok(sameSamples(await timelineAt(storage, b.segments!, 2), want), `${codec}, shift ${shift}: B's segments read back shifted`);
        assert.ok(b.correlation!.global > 0.99, `ρ ${b.correlation!.global}`);
        checkManifest(m, `${codec} stem kept, shift ${shift}`);
        notes.push(`${codec} ${shift} frames (${shift < 0 ? 'lead' : 'trail'} ${Math.abs(shift)})`);
    }
    }
    results.push(`stem kept as it is: an MP3 and a FLAC at A's rate stored byte for byte, the index shifted by the measured offset (${notes.join(', ')}); every segment reads back the decoder's samples`);
}

{
    // A time-warped variant (3 % longer: what re-timing output looks like) is not a stem: alignment refuses it,
    // and the message says what to do instead.
    const warped = resampleF64(A40[0], RATE, Math.round(RATE * 1.03));
    const stems = { v1: { input: { channels: [Float32Array.from(warped)], sampleRate: RATE } } };
    const err = await prepareAudio(chunks(A40wav, 3, 65536), { storage: memoryStorage(), concurrency: 2, stems }).done.then(() => null, (e: Error) => e);
    assert.ok(err, 'a 3 % stretched stem must be refused');
    assert.match(err!.message, /stems\.v1 does not line up with A/);
    assert.match(err!.message, /time-aligned derivative of A/);
    assert.match(err!.message, /separate clip with its own manifest/);
    const warned = await prepareAudio(chunks(A40wav, 3, 65536), { storage: memoryStorage(), concurrency: 2, stems: { v1: { ...stems.v1, onLowConfidence: 'warn' as const, label: 'Variant' } } }).done;
    assert.equal(warned.stems!.v1.status, 'failed');
    assert.equal(warned.stems!.v1.label, 'Variant');
    checkManifest(warned, 'failed stem (warn)');
    results.push(`time-warped stem (+3 %): refused (confidence ${warned.stems!.v1.alignment?.confidence}), message points to a separate clip`);
}

// ---- stem processors ------------------------------------------------------------------------

/** The test's processor: a high-shelf cut and a downward expander, 23 ms late, at 0.7. */
function processB(x: Float32Array, rate: number): Float32Array {
    const d = Math.round(0.023 * rate);
    const y = new Float32Array(x.length);
    let lp = 0, env = 0;
    const a = Math.exp(-2 * Math.PI * 3000 / rate);
    for (let i = 0; i < x.length; i += 1) {
        lp = (1 - a) * x[i] + a * lp;
        const shelf = lp + 0.5 * (x[i] - lp); // highs −6 dB
        env = Math.max(Math.abs(shelf), env * 0.999);
        const g = env > 0.01 ? 1 : (env / 0.01) ** 2;
        if (i + d < y.length) y[i + d] = 0.7 * shelf * g;
    }
    return y;
}
const wavMono16 = (x: Float32Array, rate: number) => asWav16([Float64Array.from(x)], rate);
const checkProcessed = (m: Awaited<ReturnType<typeof prepareAudio>['done']>, id: string) => {
    checkManifest(m, id);
    const b = m.stems!.b!;
    assert.equal(b.status, 'ready', `${id}: ${b.error}`);
    assert.equal(b.processor!.id, id);
    assert.ok(b.processor!.version && b.processor!.durationMs >= 0);
    assert.equal(b.aSourceId, m.id);
    assert.ok(Math.abs(b.alignment!.offsetFrames - 1104) <= 1, `${id}: offset ${b.alignment!.offsetFrames} (23 ms = 1104)`);
    assert.ok(b.alignment!.confidence > 0.8 && b.correlation!.global > 0.8, `${id}: confidence ${b.alignment!.confidence}, ρ ${b.correlation!.global}`);
    assert.equal(m.revision, 1);
    return b;
};
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rtd-stem-test-'));
const aFile = path.join(tmpRoot, 'a.wav');
fs.writeFileSync(aFile, A40wav);

{
    // Function processor (decoded audio out), A given as a stream: A is copied to a temp file for it.
    let startedAt = 0;
    const proc = functionProcessor(async ({ path: p, sampleRate, channels, frames, tmpDir }) => {
        startedAt = performance.now();
        assert.ok(fs.existsSync(p) && fs.existsSync(tmpDir));
        assert.equal(sampleRate, RATE); assert.equal(channels, 1); assert.equal(frames, A40[0].length);
        const x = parseWavFile(new Uint8Array(fs.readFileSync(p)).buffer as ArrayBuffer).channels[0];
        await new Promise((r) => setTimeout(r, 300));
        return { channels: [processB(x, sampleRate)], sampleRate };
    }, { id: 'test.shelf-expander', version: '1.0.0', params: { shelfDb: -6, delayMs: 23 } });
    const t0 = performance.now();
    const job = prepareAudio(chunks(A40wav, 3, 65536), { storage: memoryStorage(), concurrency: 2, stems: { b: { processor: proc } } });
    const m = await job.done;
    const b = checkProcessed(m, 'test.shelf-expander');
    assert.deepEqual(b.processor!.params, { shelfDb: -6, delayMs: 23 });
    const t = job.stats!.timings;
    assert.ok(t.processorMs! >= 300 && t.processorWaitMs < t.processorMs!, `processor ${t.processorMs} ms, waited ${t.processorWaitMs} ms after A`);
    assert.ok(startedAt - t0 < t.aMs, 'the processor started before A was done');
    results.push(`function processor: B 23 ms late → offset ${b.alignment!.offsetFrames}, confidence ${b.alignment!.confidence}, ρ ${b.correlation!.global}; provenance ${b.processor!.id}@${b.processor!.version} ${b.processor!.durationMs} ms; ran beside A (A ${t.aMs} ms, processor ${t.processorMs} ms, waited ${t.processorWaitMs} ms)`);
}

{
    // Command processor: a tiny node script as the CLI.
    const script = path.join(tmpRoot, 'proc.mjs');
    fs.writeFileSync(script, `import fs from 'node:fs';
const [inp, out] = process.argv.slice(2);
const b = fs.readFileSync(inp);
let p = 12, data = 0, len = 0, rate = 0;
while (p < b.length) { const id = b.toString('ascii', p, p + 4), n = b.readUInt32LE(p + 4); if (id === 'fmt ') rate = b.readUInt32LE(p + 12); if (id === 'data') { data = p + 8; len = n; break; } p += 8 + n + (n & 1); }
const frames = len / 2, d = Math.round(0.023 * rate);
const o = Buffer.alloc(44 + frames * 2);
o.write('RIFF', 0); o.writeUInt32LE(36 + frames * 2, 4); o.write('WAVE', 8); o.write('fmt ', 12); o.writeUInt32LE(16, 16); o.writeUInt16LE(1, 20); o.writeUInt16LE(1, 22); o.writeUInt32LE(rate, 24); o.writeUInt32LE(rate * 2, 28); o.writeUInt16LE(2, 32); o.writeUInt16LE(16, 34); o.write('data', 36); o.writeUInt32LE(frames * 2, 40);
for (let i = d; i < frames; i += 1) o.writeInt16LE(Math.round(b.readInt16LE(data + (i - d) * 2) * 0.7), 44 + i * 2);
fs.writeFileSync(out, o);
`);
    const proc = commandProcessor({ command: process.execPath, args: [script, '{in}', '{out}'], id: 'test.cli-delay', version: '2' });
    const m = await prepareAudio(aFile, { storage: memoryStorage(), concurrency: 2, stems: { b: { processor: proc } } }).done;
    const b = checkProcessed(m, 'test.cli-delay');
    // A failing CLI names its exit code and stderr; skip publishes A only with the error recorded.
    const bad = commandProcessor({ command: process.execPath, args: ['-e', 'console.error("model not found"); process.exit(3)'], id: 'test.cli-bad' });
    await assert.rejects(prepareAudio(aFile, { storage: memoryStorage(), concurrency: 1, stems: { b: { processor: bad } } }).done, /test\.cli-bad.*exited with 3.*model not found/);
    const skipped = memoryStorage();
    const job = prepareAudio(aFile, { storage: skipped, concurrency: 1, stems: { b: { processor: bad, onProcessorError: 'skip' } } });
    const ms = await job.done;
    assert.equal(ms.stems!.b!.status, 'failed');
    assert.equal(ms.stems!.b!.error, 'processor failed: exit code 3');
    assert.equal(ms.stems!.b!.processor!.id, 'test.cli-bad');
    assert.deepEqual(ms.stems!.b!.processor!.params, {}, 'the command and its arguments are not published');
    assert.ok(!JSON.stringify(ms).includes('model not found') && !JSON.stringify(ms).includes('process.exit'), 'no stderr or arguments in the manifest');
    assert.equal(job.stats!.warnings.length, 1);
    assert.match(job.stats!.warnings[0], /exited with 3.*model not found/, 'the detail is in the warnings, for the log');
    checkManifest(ms, 'cli failed (skip)');
    assert.throws(() => commandProcessor({ command: 'x', args: [], outName: '../b.wav' }), /plain file name/);
    // Timeout: a CLI that hangs is killed at the deadline.
    const t0 = performance.now();
    const hang = commandProcessor({ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 60000)'], id: 'test.cli-hang', timeoutMs: 400 });
    await assert.rejects(prepareAudio(aFile, { storage: memoryStorage(), concurrency: 1, stems: { b: { processor: hang } } }).done, /test\.cli-hang.*timed out after 400 ms/);
    assert.ok(performance.now() - t0 < 10000);
    const timedOut = await prepareAudio(aFile, { storage: memoryStorage(), concurrency: 1, stems: { b: { processor: hang, onProcessorError: 'skip' } } }).done;
    assert.equal(timedOut.stems!.b!.error, 'processor timed out');
    // Cancellation reaches the processor.
    const controller = new AbortController();
    const slow = functionProcessor(({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('stopped by signal')))), { id: 'test.slow', version: '0' });
    const cancelled = prepareAudio(aFile, { storage: memoryStorage(), concurrency: 1, signal: controller.signal, stems: { b: { processor: slow } } });
    setTimeout(() => controller.abort(new Error('user cancelled')), 50);
    await assert.rejects(cancelled.done);
    results.push(`command processor: node CLI → offset ${b.alignment!.offsetFrames}, ρ ${b.correlation!.global}; exit 3 → job fails naming the processor, exit code and stderr; onProcessorError "skip" → A only, the manifest says "processor failed: exit code 3" (stderr only in the warnings), params {}; 400 ms timeout kills a hung CLI; cancel reaches the processor`);
}

{
    // HTTP processor: A posted to a local service, B in the response (raw body, then multipart).
    const server = http.createServer((req, res) => {
        const parts: Buffer[] = [];
        req.on('data', (d: Buffer) => parts.push(d));
        req.on('end', () => {
            let body = Buffer.concat(parts);
            if (req.url?.startsWith('/fail')) { res.writeHead(503); res.end('busy'); return; }
            if (req.url === '/big') {
                // 4 MiB, chunked (no content-length): the cap must hold while streaming.
                res.writeHead(200, { 'content-type': 'audio/wav' });
                const chunk = Buffer.alloc(65536);
                let n = 0;
                const pump = (): void => {
                    while (n < 64) {
                        n += 1;
                        if (!res.write(chunk)) { res.once('drain', pump); return; }
                    }
                    res.end();
                };
                res.on('error', () => undefined);
                pump();
                return;
            }
            if ((req.headers['content-type'] ?? '').startsWith('multipart/form-data')) {
                const start = body.indexOf('RIFF');
                body = body.subarray(start);
            }
            const x = parseWavFile(new Uint8Array(body).buffer as ArrayBuffer);
            res.writeHead(200, { 'content-type': 'audio/wav' });
            res.end(Buffer.from(wavMono16(processB(x.channels[0], x.sampleRate), x.sampleRate)));
        });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    try {
        const raw = await prepareAudio(aFile, { storage: memoryStorage(), concurrency: 2, stems: { b: { processor: httpProcessor({ url: `http://127.0.0.1:${port}/process`, id: 'test.http', version: '3' }) } } }).done;
        const b = checkProcessed(raw, 'test.http');
        const form = await prepareAudio(aFile, { storage: memoryStorage(), concurrency: 1, stems: { b: { processor: httpProcessor({ url: `http://127.0.0.1:${port}/process`, field: 'audio', id: 'test.http' }) } } }).done;
        checkProcessed(form, 'test.http');
        await assert.rejects(prepareAudio(aFile, { storage: memoryStorage(), concurrency: 1, stems: { b: { processor: httpProcessor({ url: `http://127.0.0.1:${port}/fail`, id: 'test.http' }) } } }).done, /answered 503: busy/);
        // Skipped: the manifest says "HTTP 503" and nothing else; the log line has the body, without the query string.
        const secretUrl = `http://127.0.0.1:${port}/fail?token=s3cret`;
        const skipped = prepareAudio(aFile, { storage: memoryStorage(), concurrency: 1, stems: { b: { processor: httpProcessor({ url: secretUrl }), onProcessorError: 'skip' } } });
        const ms = await skipped.done;
        assert.equal(ms.stems!.b!.error, 'processor failed: HTTP 503');
        assert.deepEqual(ms.stems!.b!.processor!.params, {}, 'the URL is not published');
        assert.ok(!JSON.stringify(ms).includes('s3cret') && !JSON.stringify(ms).includes('busy') && !JSON.stringify(ms).includes('/fail'), JSON.stringify(ms.stems));
        assert.match(skipped.stats!.warnings[0], /\/fail\?<redacted> answered 503: busy/);
        assert.ok(!skipped.stats!.warnings[0].includes('s3cret'));
        checkManifest(ms, 'http 503 (skip)');
        // Credentials in the URL never reach an error text.
        const withCredentials = `http://user:pa55word@127.0.0.1:${port}/process?key=abc`;
        const err = await prepareAudio(aFile, { storage: memoryStorage(), concurrency: 1, stems: { b: { processor: httpProcessor({ url: withCredentials, id: 'test.http' }) } } }).done.then(() => null, (e: Error) => e);
        assert.ok(err && !err.message.includes('pa55word') && !err.message.includes('key=abc'), err?.message);
        assert.equal(redactUrl('https://u:p@host.internal:8443/v1/sep?token=1#x'), 'https://host.internal:8443/v1/sep?<redacted>');
        // Response size: refused up front by content-length, or while streaming a chunked body.
        await assert.rejects(prepareAudio(aFile, { storage: memoryStorage(), concurrency: 1, stems: { b: { processor: httpProcessor({ url: `http://127.0.0.1:${port}/process`, id: 'test.http', maxResponseBytes: 100_000 }) } } }).done, /more than maxResponseBytes \(100000\)/);
        const big = await prepareAudio(aFile, { storage: memoryStorage(), concurrency: 1, stems: { b: { processor: httpProcessor({ url: `http://127.0.0.1:${port}/big`, id: 'test.http', maxResponseBytes: 1 << 20 }), onProcessorError: 'skip' } } }).done;
        assert.equal(big.stems!.b!.error, 'processor failed: response too large');
        // Multipart: a file name cannot end the part header.
        const head = multipartHead('BOUNDARY', 'au"dio', 'a"b\r\nX-Evil: 1\\.wav');
        assert.equal(head, '--BOUNDARY\r\nContent-Disposition: form-data; name="au_dio"; filename="a_b__X-Evil: 1_.wav"\r\nContent-Type: application/octet-stream\r\n\r\n');
        results.push(`http processor: raw body and multipart → offset ${b.alignment!.offsetFrames}, ρ ${b.correlation!.global}; 503 → job fails with the status and body (log), the manifest says only "HTTP 503"; URL credentials and query strings redacted; maxResponseBytes up front and while streaming; multipart file name sanitized`);
    } finally {
        server.closeAllConnections();
        server.close();
    }
}
// ---- hardening: names, write errors, docker, cancels, bad output, checks, processes ------------

/** Polls until `test` holds; fails after `ms`. */
async function waitFor(test: () => boolean, what: string, ms = 8000): Promise<void> {
    const t0 = performance.now();
    while (!test()) {
        if (performance.now() - t0 > ms) assert.fail(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 50));
    }
}
const alive = (pid: number) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};
const readPid = (file: string) => (fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0);
/** processB() on A's file, as decoded audio. */
const echoProcessor = (id: string) => functionProcessor(({ path: p }) => {
    const x = parseWavFile(new Uint8Array(fs.readFileSync(p)).buffer as ArrayBuffer).channels[0];
    return { channels: [processB(x, RATE)], sampleRate: RATE };
}, { id, version: '1' });
const A2wav = asWav16([A40[0].subarray(0, RATE * 2)], RATE);

{
    // A name is never a path: a stream input's scratch copy has a fixed name, the manifest a bare file name.
    const deep = path.join(tmpRoot, 'trav', 'x', 'y');
    fs.mkdirSync(deep, { recursive: true });
    let seen = '';
    const proc = functionProcessor((input) => {
        seen = input.path;
        return echoProcessor('test.trav').run(input);
    }, { id: 'test.trav', version: '1' });
    const m = await prepareAudio(chunks(A40wav, 3, 65536), { storage: memoryStorage(), concurrency: 1, tmpDir: deep, name: '../../evil.wav', stems: { b: { processor: proc } } }).done;
    assert.equal(m.source.name, 'evil.wav');
    assert.equal(m.stems!.b!.status, 'ready');
    assert.equal(path.basename(seen), 'a.wav');
    assert.ok(path.resolve(seen).startsWith(path.resolve(deep) + path.sep), `the scratch copy ${seen} is inside tmpDir`);
    assert.deepEqual(fs.readdirSync(path.join(tmpRoot, 'trav')), ['x'], 'nothing written above the scratch folder');
    assert.deepEqual(fs.readdirSync(path.join(tmpRoot, 'trav', 'x')), ['y'], 'nothing written above the scratch folder');
    assert.deepEqual(fs.readdirSync(deep), [], 'the scratch folder is removed');
    checkManifest(m, 'name with ../');
    const m2 = await prepareAudio(chunks(A2wav, 3, 65536), { storage: memoryStorage(), concurrency: 1, name: 'C:\\uploads\\..\\x\u0001y.flac' }).done;
    assert.equal(m2.source.name, 'xy.flac');
    const m3 = await prepareAudio(chunks(A2wav, 3, 65536), { storage: memoryStorage(), concurrency: 1, name: '../..' }).done;
    assert.equal(m3.source.name, null);
    results.push('names: "../../evil.wav" → manifest "evil.wav", the scratch copy is <tmp>/a.wav and nothing is written outside it; Windows paths and control characters stripped');
}

{
    // A tee or spool file that cannot be written fails the job (its 'error' used to go unhandled and end the process).
    const original = fs.createWriteStream;
    const unwritable = path.join(tmpRoot, 'no-such-dir', 'file');
    const redirect = (match: (file: string) => boolean) => {
        (fs as { createWriteStream: unknown }).createWriteStream = (file: fs.PathLike, options?: unknown) =>
            original(match(String(file)) ? unwritable : file, options as never);
    };
    const streamed = functionProcessor(({ path: p }) => {
        const x = parseWavFile(new Uint8Array(fs.readFileSync(p)).buffer as ArrayBuffer).channels[0];
        return { stream: chunks(wavMono16(processB(x, RATE), RATE), 4, 65536) };
    }, { id: 'test.stream', version: '1' });
    try {
        redirect((file) => /rtd-prepare-[^\\/]+[\\/]a\.wav$/.test(file));
        const teeStorage = memoryStorage();
        await assert.rejects(prepareAudio(chunks(A40wav, 3, 65536), { storage: teeStorage, concurrency: 1, stems: { b: { processor: echoProcessor('test.echo') } } }).done, /ENOENT/);
        assert.equal(teeStorage.objects.has('manifest.json'), false);
        redirect((file) => file.endsWith('b.stream'));
        await assert.rejects(prepareAudio(aFile, { storage: memoryStorage(), concurrency: 1, stems: { b: { processor: streamed } } }).done, /ENOENT/);
        const skipped = await prepareAudio(aFile, { storage: memoryStorage(), concurrency: 1, stems: { b: { processor: streamed, onProcessorError: 'skip' } } }).done;
        assert.equal(skipped.stems!.b!.error, 'processor failed: output could not be read');
    } finally {
        (fs as { createWriteStream: unknown }).createWriteStream = original;
    }
    // Writable again: the tee and the spool work.
    checkProcessed(await prepareAudio(chunks(A40wav, 3, 65536), { storage: memoryStorage(), concurrency: 1, stems: { b: { processor: streamed } } }).done, 'test.stream');
    results.push('write errors: an unwritable tee (A as a stream) or spool (a processor stream) fails the job (ENOENT), or with skip records "output could not be read"');
}

{
    // Docker: the container sees A alone (read-only), a work folder, no network, no new privileges.
    // A fake docker CLI records its arguments and does what the image would (the command test's script).
    const fakeDocker = path.join(tmpRoot, 'fake-docker.mjs');
    const log = path.join(tmpRoot, 'docker-calls.json');
    fs.writeFileSync(fakeDocker, `import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const argv = process.argv.slice(2);
const log = ${JSON.stringify(log)};
const mounts = {};
for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '--mount') continue;
    const m = {};
    for (const part of argv[i + 1].split(',')) { const j = part.indexOf('='); if (j < 0) m[part] = true; else m[part.slice(0, j)] = part.slice(j + 1); }
    mounts[m.dst] = m;
}
const calls = fs.existsSync(log) ? JSON.parse(fs.readFileSync(log, 'utf8')) : [];
calls.push({ argv, mounts, inFiles: mounts['/in'] ? fs.readdirSync(mounts['/in'].src) : null });
fs.writeFileSync(log, JSON.stringify(calls));
if (argv[0] === 'run') {
    const host = (p) => { for (const [dst, m] of Object.entries(mounts)) if (p.startsWith(dst + '/')) return path.join(m.src, p.slice(dst.length + 1)); throw new Error('not mounted: ' + p); };
    const [inArg, outArg] = argv.slice(argv.indexOf('fake-image') + 1);
    execFileSync(process.execPath, [${JSON.stringify(path.join(tmpRoot, 'proc.mjs'))}, host(inArg), host(outArg)]);
}
`);
    const proc = dockerProcessor({ image: 'fake-image', args: ['{in}', '{out}'], docker: [process.execPath, fakeDocker], id: 'test.docker', version: '1' });
    // Without an id or version, the adapters publish nothing of the host's setup.
    const neutral = [
        commandProcessor({ command: '/opt/tools/separate', args: [] }),
        dockerProcessor({ image: 'registry.internal/sep:3', args: [] }),
        httpProcessor({ url: 'https://gpu.internal:8080/sep?key=secret' }),
    ];
    assert.deepEqual(neutral.map((p) => [p.id, p.version, p.params]), [['command', '0', {}], ['docker', '0', {}], ['http', '0', {}]]);
    const uploads = path.join(tmpRoot, 'uploads');
    fs.mkdirSync(uploads);
    fs.copyFileSync(aFile, path.join(uploads, 'talk.wav'));
    fs.writeFileSync(path.join(uploads, 'someone-else.wav'), 'private');
    const m = await prepareAudio(path.join(uploads, 'talk.wav'), { storage: memoryStorage(), concurrency: 1, stems: { b: { processor: proc } } }).done;
    checkProcessed(m, 'test.docker');
    assert.deepEqual(m.stems!.b!.processor!.params, {}, 'the image and its arguments are not published');
    const [call] = JSON.parse(fs.readFileSync(log, 'utf8'));
    assert.deepEqual(call.inFiles, ['a.wav'], 'only A is in the folder mounted at /in');
    assert.notEqual(path.resolve(call.mounts['/in'].src), path.resolve(uploads));
    assert.equal(call.mounts['/in'].readonly, true);
    assert.equal(call.mounts['/work'].readonly, undefined);
    assert.equal(call.argv[call.argv.indexOf('--security-opt') + 1], 'no-new-privileges');
    assert.equal(call.argv[call.argv.indexOf('--network') + 1], 'none');
    assert.deepEqual(call.argv.slice(-2), ['/in/a.wav', '/work/b.wav']);
    // A path that would add options of its own to --mount (a comma) is refused before docker runs.
    const comma = path.join(tmpRoot, 'x,type=volume');
    fs.mkdirSync(comma);
    await assert.rejects(prepareAudio(aFile, { storage: memoryStorage(), concurrency: 1, tmpDir: comma, stems: { b: { processor: proc } } }).done, /refusing to mount/);
    assert.equal(JSON.parse(fs.readFileSync(log, 'utf8')).length, 1, 'docker was not started');
    results.push(`docker processor (fake CLI): offset ${m.stems!.b!.alignment!.offsetFrames}; /in holds A alone (read-only, not A's own folder), --network none, no-new-privileges; a comma in a mount path is refused`);
}

{
    // A cancel while waiting for a processor whose errors are skipped fails the job: nothing is published.
    const storage = memoryStorage();
    const slow = functionProcessor(({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('stopped by signal')))), { id: 'test.slow', version: '0' });
    const job = prepareAudio(aFile, { storage, concurrency: 1, stems: { b: { processor: slow, onProcessorError: 'skip' } } });
    job.on('progress', (p) => { if (p.stage === 'processor') job.cancel(); });
    await assert.rejects(job.done, /prepareAudio cancelled/);
    assert.equal(job.status, 'failed');
    assert.equal(storage.objects.has('manifest.json'), false, 'a cancelled job publishes nothing');
    // The same with a processor that ignores the signal.
    const deaf = functionProcessor(() => new Promise<never>(() => undefined), { id: 'test.deaf', version: '0' });
    const job2 = prepareAudio(aFile, { storage, concurrency: 1, stems: { b: { processor: deaf, onProcessorError: 'skip' } } });
    job2.on('progress', (p) => { if (p.stage === 'processor') job2.cancel(); });
    await assert.rejects(job2.done, /prepareAudio cancelled/);
    assert.equal(storage.objects.has('manifest.json'), false);
    // An already-aborted signal: nothing is read, nothing is written.
    const early = new AbortController();
    early.abort(new Error('cancelled before it started'));
    let decoded = false;
    const watching: AudioDecoder = (bytes) => { decoded = true; return wavDecoder(bytes); };
    const earlyStorage = memoryStorage();
    await assert.rejects(prepareAudio(aFile, { storage: earlyStorage, decoder: watching, signal: early.signal }).done, /cancelled before it started/);
    assert.equal(decoded, false);
    assert.equal(earlyStorage.objects.size, 0);
    // The job's listener on the caller's signal goes when the job ends, ready or failed.
    const long = new AbortController();
    await prepareAudio(chunks(A2wav, 3, 65536), { storage: memoryStorage(), concurrency: 1, signal: long.signal }).done;
    await assert.rejects(prepareAudio(chunks(new TextEncoder().encode('RIFF....not a wave file')), { storage: memoryStorage(), signal: long.signal }).done);
    assert.equal(getEventListeners(long.signal, 'abort').length, 0);
    // attachStem with an aborted signal does not touch the folder either.
    const folder = memoryStorage();
    await prepareAudio(chunks(A2wav, 3, 65536), { storage: folder, concurrency: 1 }).done;
    const filesBefore = folder.objects.size;
    await assert.rejects(attachStem({ storage: folder }, 'b', { channels: [Float32Array.from(A40[0].subarray(0, RATE * 2))], sampleRate: RATE }, { signal: early.signal }), /cancelled before it started/);
    assert.equal(readManifestOf(folder).revision, 1);
    assert.equal(folder.objects.size, filesBefore);
    results.push('cancel: during a skippable processor (listening or deaf) → failed, no manifest; an aborted signal stops prepareAudio and attachStem before they read; the abort listener is removed when the job ends');
}

{
    // onProcessorError 'skip' also covers a processor that succeeds with output that cannot be decoded.
    const garbage = path.join(tmpRoot, 'garbage.bin');
    fs.writeFileSync(garbage, 'this is not audio at all, only text');
    const junk = functionProcessor(() => ({ path: garbage }), { id: 'test.junk', version: '1' });
    const failing = memoryStorage();
    await assert.rejects(prepareAudio(aFile, { storage: failing, concurrency: 1, stems: { b: { processor: junk } } }).done, /not WAV, MP3, Opus or FLAC/);
    assert.equal(failing.objects.has('manifest.json'), false);
    const job = prepareAudio(aFile, { storage: memoryStorage(), concurrency: 1, stems: { b: { processor: junk, onProcessorError: 'skip', label: 'Junk' } } });
    const m = await job.done;
    assert.equal(m.stems!.b!.status, 'failed');
    assert.equal(m.stems!.b!.error, 'processor failed: output could not be read');
    assert.equal(m.stems!.b!.label, 'Junk');
    assert.match(job.stats!.warnings[0], /not WAV, MP3, Opus or FLAC/);
    checkManifest(m, 'undecodable processor output (skip)');
    results.push('undecodable processor output: fails the job, or with skip publishes A with stems.b failed ("output could not be read")');
}

{
    // framesPerPeak: a power of two from 16 to 65536, in the API and the CLI.
    for (const bad of [12345, 8, 100, 1 << 17, 256.5, Number.NaN]) {
        await assert.rejects(prepareAudio(chunks(A2wav, 3, 65536), { storage: memoryStorage(), framesPerPeak: bad }).done, /framesPerPeak must be a power of two from 16 to 65536/, String(bad));
    }
    const fine = await prepareAudio(chunks(A2wav, 3, 65536), { storage: memoryStorage(), concurrency: 1, framesPerPeak: 16 }).done;
    assert.equal(fine.peaks.levels[0].framesPerPeak, 16);
    const errors: string[] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
    try {
        assert.equal(await main(['in.wav', 'out', '--peak', 'abc']), 2);
        assert.equal(await main(['in.wav', 'out', '--peak', '12345']), 2);
    } finally {
        console.error = consoleError;
    }
    assert.match(errors[0], /--peak: framesPerPeak must be a power of two from 16 to 65536, got abc/);
    assert.match(errors[1], /got 12345/);
    results.push('framesPerPeak: 12345, 8, 100, 2^17, 256.5, NaN refused (API); --peak abc / 12345 exit 2 with the rule (CLI)');
}

{
    // The other limits: segments of 0.1 to 60 s (the player refuses longer ones; shorter ones only
    // swell the manifest), 1 to 64 threads, and the rates and channel counts the player plays.
    for (const bad of [0.05, 0.00001, 61, 1e9, Number.NaN, Infinity, -1]) {
        await assert.rejects(prepareAudio(chunks(A2wav, 3, 65536), { storage: memoryStorage(), segmentSeconds: bad }).done, /segmentSeconds must be a number from 0.1 to 60/, String(bad));
    }
    for (const bad of [Number.NaN, 0, 65, 2.5, -1]) {
        await assert.rejects(prepareAudio(chunks(A2wav, 3, 65536), { storage: memoryStorage(), concurrency: bad }).done, /concurrency must be an integer from 1 to 64/, String(bad));
        assert.throws(() => createPreparePool({ concurrency: bad }), /concurrency must be an integer from 1 to 64/);
    }
    assert.equal(new JobPool(Number.NaN).size, 1, 'a pool of NaN threads is one, inline');
    const shortest = await prepareAudio(chunks(A2wav, 3, 65536), { storage: memoryStorage(), concurrency: 1, segmentSeconds: 0.1 }).done;
    assert.equal(shortest.segments.framesPerSegment, RATE / 10);
    const longest = await prepareAudio(chunks(A2wav, 3, 65536), { storage: memoryStorage(), concurrency: 1, segmentSeconds: 60 }).done;
    assert.equal(longest.segments.list.length, 1);
    // A's rate is the timeline's: 8 to 384 kHz. Channels: 1 to 32, for A and its stems.
    for (const rate of [4000, 400000]) {
        await assert.rejects(prepareAudio(chunks(asWav16([new Float64Array(rate / 2)], rate)), { storage: memoryStorage(), concurrency: 1 }).done, new RegExp(`at ${rate} Hz: the player plays 8000 to 384000 Hz`));
    }
    const manyChannels: AudioDecoder = () => ({
        format: Promise.resolve({ sampleRate: RATE, channels: 33, encoding: 'synthetic', bitsPerSample: 32, frames: 4800 }),
        blocks: (async function* () { yield Array.from({ length: 33 }, () => new Float32Array(4800)); })(),
    });
    await assert.rejects(prepareAudio(chunks(new Uint8Array(1)), { storage: memoryStorage(), concurrency: 1, decoder: manyChannels }).done, /has 33 channels: the player plays 1 to 32/);
    const stem33 = Array.from({ length: 33 }, () => new Float32Array(RATE * 2));
    await assert.rejects(prepareAudio(chunks(A2wav, 3, 65536), { storage: memoryStorage(), concurrency: 1, stems: { b: { input: { channels: stem33, sampleRate: RATE }, offsetFrames: 0 } } }).done, /stems\.b has 33 channels/);
    // A stem at a rate the player would not play is converted to A's like any other.
    const at4k = Float32Array.from({ length: 4000 * 2 }, (_, i) => A40[0][i * 12]);
    const slow = await prepareAudio(chunks(A2wav, 3, 65536), { storage: memoryStorage(), concurrency: 1, stems: { b: { input: { channels: [at4k], sampleRate: 4000 }, offsetFrames: 0 } } }).done;
    assert.equal(slow.stems!.b!.status, 'ready');
    assert.equal(slow.stems!.b!.source!.sampleRate, 4000);
    assert.equal(slow.stems!.b!.segments!.source.sampleRate, RATE);

    // The CLI: numbers parsed strictly, every rule broken exits 2 before anything runs; the docker
    // image is a name, never a flag.
    const errors: string[] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
    try {
        for (const args of [
            ['--segment', '0.05'], ['--segment', 'abc'], ['--segment', '1e9'], ['--segment', '61'], ['--segment', ''],
            ['--concurrency', 'abc'], ['--concurrency', '0'], ['--concurrency', '65'], ['--concurrency', '2.5'], ['--concurrency', '1e1'],
            ['--decoder', 'docker:--privileged'], ['--decoder', 'docker:-v'], ['--decoder', 'docker:img --rm'], ['--decoder', 'docker:'], ['--decoder', 'docker:Upper/Case'],
            ['--decoder', 'ffmpeg', '--demuxers', 'mov;ogg'], ['--decoder', 'ffmpeg', '--demuxers', ''], ['--demuxers', 'mov'], ['--decoder', 'sox'],
        ]) {
            errors.length = 0;
            assert.equal(await main(['in.wav', 'out', ...args]), 2, args.join(' '));
            assert.ok(/usage: rtd-prepare/.test(errors.join('\n')), args.join(' '));
        }
        errors.length = 0;
        await main(['in.wav', 'out', '--concurrency', 'abc']);
        assert.match(errors[0], /--concurrency: concurrency must be an integer from 1 to 64, got abc/);
        errors.length = 0;
        await main(['in.wav', 'out', '--decoder', 'docker:--privileged']);
        assert.match(errors[0], /not a Docker image reference.*"--privileged"/);
    } finally {
        console.error = consoleError;
    }
    for (const good of ['ffmpeg', 'jrottenberg/ffmpeg:4.4-alpine', 'localhost:5000/tools/ffmpeg', 'ghcr.io/org/ff_mpeg:v1.2', `ffmpeg@sha256:${'ab'.repeat(32)}`]) {
        assert.equal(checkDockerImage(good), good);
    }
    for (const bad of ['--privileged', '-v', 'ffmpeg --rm', 'ffmpeg:', 'FFmpeg', 'a//b', '', 'x'.repeat(256)]) {
        assert.throws(() => checkDockerImage(bad), /not a Docker image reference/, bad);
    }
    assert.throws(() => dockerProcessor({ image: '--privileged', args: [] }), /not a Docker image reference/);
    results.push('limits: segmentSeconds 0.1-60, concurrency integer 1-64 (API, pool, CLI exit 2), A at 8-384 kHz, 1-32 channels for A and stems, a 4 kHz stem converted; docker image names checked (CLI and dockerProcessor)');
}

{
    // A source that fails halfway fails the job with its own error, whatever the decoder makes of
    // it: here one that swallows the error and ends (a cut, clean WAV), one that stops reading early.
    const half = Math.floor(A2wav.length / 2);
    async function* failing(): AsyncGenerator<Uint8Array> {
        yield A2wav.slice(0, 44 + 4000);
        yield A2wav.slice(44 + 4000, half);
        throw new Error('source read failed at byte ' + half);
    }
    const swallowing: AudioDecoder = (bytes, options) => wavDecoder((async function* () {
        try {
            for await (const b of bytes) yield b;
        } catch {
            // swallowed: the WAV just ends here
        }
    })(), options);
    const earlyStop: AudioDecoder = (bytes) => {
        const inner = wavDecoder(bytes);
        return { format: inner.format, blocks: (async function* () { for await (const b of inner.blocks) { yield b; return; } })() };
    };
    for (const decoder of [swallowing, earlyStop, builtinDecoder]) {
        const storage = memoryStorage();
        await assert.rejects(prepareAudio(failing(), { storage, concurrency: 1, decoder }).done, /^Error: source read failed at byte/);
        assert.equal(storage.objects.has('manifest.json'), false);
    }
    results.push('a source that fails halfway: the job fails with its error with a decoder that swallows it, one that stops early, and the built-in one; nothing published');
}

{
    // Non-finite samples (a float WAV may hold them): replaced, counted, and the manifest still validates.
    const frames = RATE * 3;
    const wav = encodeWav(speechLike(frames, RATE, 2, 51), RATE, { tag: 3, bits: 32 });
    const view = new DataView(wav.buffer);
    const data = wav.length - frames * 8;
    view.setFloat32(data + 1000 * 8, Infinity, true);
    view.setFloat32(data + 2000 * 8 + 4, -Infinity, true);
    view.setFloat32(data + 3000 * 8, Number.NaN, true);
    const { manifest, storage, job } = await prepareMemory(wav);
    checkManifest(manifest, 'non-finite samples');
    assert.equal(manifest.loudness.peak, 1);
    assert.deepEqual(job.stats!.warnings, ['A: 3 non-finite samples replaced (NaN → 0, ±Infinity → ±1)']);
    // The float WAV that holds them is not kept: a 16-bit WAV of what was analysed is.
    assert.equal(manifest.segments.source.pcm!.bitsPerSample, 16);
    const seg = await segmentAt(storage, manifest.segments, 2, 0);
    assert.ok(seg[0][1000] > 0.999 && seg[1][2000] <= -0.999 && seg[0][3000] === 0, 'Infinity → 1, -Infinity → -1, NaN → 0');
    // In a stem too; the caller's arrays are left as they were.
    const bx = Float32Array.from(delayed(A40[0], 480, 0.5));
    bx[100000] = Number.NaN;
    bx[200000] = Infinity;
    const stemJob = prepareAudio(chunks(A40wav, 3, 65536), { storage: memoryStorage(), concurrency: 1, stems: { b: { input: { channels: [bx], sampleRate: RATE } } } });
    const ms = await stemJob.done;
    checkManifest(ms, 'stem with non-finite samples');
    assert.equal(ms.stems!.b!.status, 'ready');
    assert.deepEqual(stemJob.stats!.warnings, ['stems.b: 2 non-finite samples replaced (NaN → 0, ±Infinity → ±1)']);
    assert.ok(Number.isNaN(bx[100000]), "the caller's samples are not modified");
    // A manifest the player would refuse is not written: the job fails.
    const badDecoder: AudioDecoder = () => ({
        format: Promise.resolve({ sampleRate: RATE, channels: 1, encoding: 'synthetic', bitsPerSample: 0, frames: 4800 }),
        blocks: (async function* () { yield [new Float32Array(4800).fill(0.1)]; })(),
    });
    const refused = memoryStorage();
    await assert.rejects(prepareAudio(chunks(new Uint8Array(1)), { storage: refused, decoder: badDecoder }).done, /manifest does not validate.*\(source\)/);
    assert.equal(refused.objects.has('manifest.json'), false);
    results.push('non-finite samples: ±Inf → ±1, NaN → 0 in A and in a stem, counted in the warnings, loudness.peak 1; a manifest that fails assertManifest() fails the job');
}

{
    // The stem's finest peak level is A's, whatever framesPerPeak A was prepared with.
    const m = await prepareAudio(chunks(A40wav, 3, 65536), { storage: memoryStorage(), concurrency: 1, framesPerPeak: 1024, stems: { b: { input: { channels: [Float32Array.from(delayed(A40[0], 100, 0.5))], sampleRate: RATE } } } }).done;
    assert.equal(m.peaks.levels[0].framesPerPeak, 1024);
    assert.deepEqual(m.stems!.b!.peaks!.levels.map((l) => l.framesPerPeak), m.peaks.levels.map((l) => l.framesPerPeak));
    results.push(`stem peaks: A at framesPerPeak 1024 → the stem's levels are A's (${m.peaks.levels.map((l) => l.framesPerPeak).join(', ')})`);
}

{
    // ffmpeg decoder (a fake ffmpeg: there may be none here): protocols limited to the pipe, and the process
    // does not outlive a consumer that stops early or a cancel.
    const fakeFfmpeg = path.join(tmpRoot, 'fake-ffmpeg.mjs');
    const ffArgs = path.join(tmpRoot, 'ffmpeg-args.json');
    const ffPid = path.join(tmpRoot, 'ffmpeg-pid.txt');
    fs.writeFileSync(fakeFfmpeg, `import fs from 'node:fs';
const argv = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(ffArgs)}, JSON.stringify(argv));
fs.writeFileSync(${JSON.stringify(ffPid)}, String(process.pid));
const header = (rate) => { const b = Buffer.alloc(44); b.write('RIFF', 0); b.writeUInt32LE(0xffffffff, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(3, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(32, 34); b.write('data', 36); b.writeUInt32LE(0xffffffff, 40); return b; };
const formats = argv.indexOf('-format_whitelist');
if (formats >= 0 && !argv[formats + 1].split(',').includes('wav')) {
    process.stdin.resume();
    process.stderr.write("[wav @ 0000] Format not on whitelist '" + argv[formats + 1] + "'\\n");
    process.exit(1);
} else if (argv.includes('-fail')) {
    process.stdin.resume();
    process.stderr.write('Invalid data found when processing input\\n');
    process.exit(1);
} else if (argv.includes('-endless')) {
    process.stdin.resume();
    process.stdout.write(header(48000));
    const zeros = Buffer.alloc(1 << 16);
    const pump = () => { while (process.stdout.write(zeros)); process.stdout.once('drain', pump); };
    pump();
} else {
    const parts = [];
    process.stdin.on('data', (d) => parts.push(d));
    process.stdin.on('end', () => {
        const b = Buffer.concat(parts);
        let p = 12, data = 0, len = 0, rate = 0;
        // A cut input decodes as far as it goes, and exits 0: what ffmpeg does with a stream that ends early.
        while (p < b.length) { const id = b.toString('ascii', p, p + 4), n = b.readUInt32LE(p + 4); if (id === 'fmt ') rate = b.readUInt32LE(p + 12); if (id === 'data') { data = p + 8; len = Math.min(n, b.length - data) & ~1; break; } p += 8 + n + (n & 1); }
        const out = Buffer.alloc(len * 2);
        for (let i = 0; i < len / 2; i += 1) out.writeFloatLE(b.readInt16LE(data + i * 2) / 32768, i * 4);
        process.stdout.write(header(rate));
        process.stdout.end(out);
    });
}
`);
    const decoder = ffmpegDecoder({ command: [process.execPath, fakeFfmpeg] });
    const m = await prepareAudio(aFile, { storage: memoryStorage(), concurrency: 1, decoder }).done;
    assert.equal(m.frames, A40[0].length);
    assert.equal(m.source.encoding, 'ffmpeg:pcm-float');
    const args: string[] = JSON.parse(fs.readFileSync(ffArgs, 'utf8'));
    const w = args.indexOf('-protocol_whitelist');
    assert.ok(w >= 0 && args[w + 1] === 'pipe' && w < args.indexOf('-i'), args.join(' '));
    assert.equal(args.includes('-format_whitelist'), false, 'any demuxer unless demuxers says');
    // demuxers: ffmpeg's -format_whitelist before -i; an input of another format fails, with the hint.
    const listed = ffmpegDecoder({ command: [process.execPath, fakeFfmpeg], demuxers: ['mov', 'ogg'] });
    await assert.rejects(prepareAudio(aFile, { storage: memoryStorage(), concurrency: 1, decoder: listed }).done, /ffmpeg failed \(exit 1\) \(the input is in a format left out of `demuxers`\): .*Format not on whitelist 'mov,ogg'/);
    const listedArgs: string[] = JSON.parse(fs.readFileSync(ffArgs, 'utf8'));
    const f = listedArgs.indexOf('-format_whitelist');
    assert.ok(f >= 0 && listedArgs[f + 1] === 'mov,ogg' && f < listedArgs.indexOf('-i'), listedArgs.join(' '));
    const common = await prepareAudio(aFile, { storage: memoryStorage(), concurrency: 1, decoder: ffmpegDecoder({ command: [process.execPath, fakeFfmpeg], demuxers: AUDIO_DEMUXERS }) }).done;
    assert.equal(common.frames, A40[0].length);
    for (const bad of [[], ['mov,ogg'], ['-f'], ['mov', '']]) assert.throws(() => ffmpegDecoder({ demuxers: bad }), /demuxers must be a list of ffmpeg demuxer names/, JSON.stringify(bad));
    // A source that fails halfway: ffmpeg would end on the bytes it got (exit 0, a shorter recording).
    // It is killed instead, and the decoder (and the job) fail with the source's own error.
    async function* cut(): AsyncGenerator<Uint8Array> {
        yield A40wav.slice(0, 100000);
        throw new Error('upload interrupted');
    }
    await assert.rejects((async () => { for await (const block of decoder(cut()).blocks) void block; })(), /^Error: upload interrupted$/);
    await assert.rejects(prepareAudio(cut(), { storage: memoryStorage(), concurrency: 1, decoder }).done, /^Error: upload interrupted$/);
    // A stem from a stream decoded with it: the same error.
    const stemOf = (input: () => AsyncIterable<Uint8Array>) => prepareAudio(aFile, { storage: memoryStorage(), concurrency: 1, stems: { b: { input, decoder, offsetFrames: 0 } } }).done;
    assert.equal((await stemOf(() => chunks(A40wav, 3, 65536))).stems!.b!.status, 'ready');
    await assert.rejects(stemOf(cut), /^Error: upload interrupted$/);
    // ffmpeg refuses the input: the job fails with its stderr, and nothing is left unhandled (that would end this process).
    const refusing = ffmpegDecoder({ command: [process.execPath, fakeFfmpeg], inputArgs: ['-fail'] });
    await assert.rejects(prepareAudio(aFile, { storage: memoryStorage(), concurrency: 1, decoder: refusing }).done, /ffmpeg failed \(exit 1\): Invalid data/);
    await new Promise((r) => setTimeout(r, 300));
    // A consumer that stops early: ffmpeg is killed, not left running.
    const endless = ffmpegDecoder({ command: [process.execPath, fakeFfmpeg], inputArgs: ['-endless'] });
    const stopped = endless(chunks(A40wav, 3, 65536)).blocks[Symbol.asyncIterator]();
    await stopped.next();
    const pid1 = readPid(ffPid);
    assert.ok(pid1 > 0 && alive(pid1));
    await stopped.return!(undefined);
    await waitFor(() => !alive(pid1), 'ffmpeg to be killed after an early stop');
    // Cancelled: killed at once, and the blocks end with the cancel's reason.
    const controller = new AbortController();
    const cancelled = endless(chunks(A40wav, 3, 65536), { signal: controller.signal }).blocks[Symbol.asyncIterator]();
    await cancelled.next();
    const pid2 = readPid(ffPid);
    assert.ok(pid2 > 0 && pid2 !== pid1 && alive(pid2));
    controller.abort(new Error('stop decoding'));
    await waitFor(() => !alive(pid2), 'ffmpeg to be killed on abort');
    await assert.rejects((async () => { for (;;) if ((await cancelled.next()).done) return; })(), /stop decoding/);
    results.push('ffmpeg decoder (fake ffmpeg): -protocol_whitelist pipe before -i, -format_whitelist from demuxers (another format fails, with the hint); decodes through the pipe; a source that fails halfway fails the decoder, the job and a stem with its error; killed when the consumer stops early and on abort');
}

{
    // A cancel (or timeout) stops the processor's whole process tree, not only its direct child.
    // On Windows a Node grandchild would die with its parent anyway (libuv's job object); a detached
    // one is outside it, like the children of most other tools, so only taskkill /T reaches it.
    const pidFile = path.join(tmpRoot, 'grandchild.pid');
    const script = `const { spawn } = require('node:child_process');
const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', detached: ${process.platform === 'win32'} });
require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
setTimeout(() => {}, 60000);`;
    const tree = commandProcessor({ command: process.execPath, args: ['-e', script], id: 'test.tree' });
    const job = prepareAudio(aFile, { storage: memoryStorage(), concurrency: 1, stems: { b: { processor: tree } } });
    await waitFor(() => readPid(pidFile) > 0, 'the grandchild to start');
    const pid = readPid(pidFile);
    assert.ok(alive(pid));
    job.cancel();
    await assert.rejects(job.done, /cancelled/);
    await waitFor(() => !alive(pid), 'the grandchild to be killed');
    results.push(`process tree: a cancel kills the processor's grandchild too (${process.platform === 'win32' ? 'taskkill /T' : 'process group'})`);
}

fs.rmSync(tmpRoot, { recursive: true, force: true });

results.push(`manifests checked against manifest.schema.json and assertManifest(): ${schemaChecked.length}`);
console.log(results.map((line) => `  ok  ${line}`).join('\n'));
console.log('\nprepare tests passed');
