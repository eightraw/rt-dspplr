// Node tests for the long-audio prepare step (run: npm test): the streaming WAV
// reader in every supported encoding, the resampler's passband and aliasing,
// sample-exact segments, peaks against a brute-force reference, loudness,
// the job lifecycle and the decoder hook.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
    memoryStorage,
    prepareAudio,
    wavDecoder,
    type AudioDecoder,
    attachStem,
    functionProcessor,
    commandProcessor,
    httpProcessor,
} from '../src/index';
import { designResampler, StreamingResampler } from '../src/resampler';
import { resampleInParallel } from '../src/parallelResample';
import { JobPool } from '../src/pool';
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
        assert.equal(manifest.resample, null);
        // Segments tile the timeline exactly, and their PCM concatenated is the source's data chunk.
        const list = manifest.segments.list;
        let next = 0;
        const pcm: Uint8Array[] = [];
        for (const seg of list) {
            assert.equal(seg.startFrame, next, `segment ${seg.index} starts where the last ended`);
            const file = storage.objects.get(seg.url)!;
            assert.equal(file.length, seg.bytes);
            const parsed = parseWavFile(file.buffer.slice(file.byteOffset, file.byteOffset + file.length) as ArrayBuffer);
            assert.equal(parsed.frames, seg.frames);
            pcm.push(file.subarray(44));
            next += seg.frames;
        }
        assert.equal(next, frames);
        const joined = Buffer.concat(pcm);
        const sourceData = Buffer.from(wav.subarray(wav.length - frames * 4));
        assert.ok(joined.equals(sourceData), `${segmentSeconds} s segments: concatenation equals the source`);
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
        results.push(`segments ${segmentSeconds} s: ${list.length} files tile ${frames} frames, concatenation == source; peaks: ${checked} bins over 3 levels == brute force`);
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

    // 96 kHz input: resampled to 48 kHz by default, kept with targetRate 'keep'.
    const hi = encodeWav(speechLike(96000 * 3, 96000, 1), 96000, { tag: 1, bits: 24 });
    const { manifest: m3 } = await prepareMemory(hi);
    assert.equal(m3.sampleRate, 48000);
    assert.equal(m3.sourceSampleRate, 96000);
    assert.equal(m3.frames, 48000 * 3);
    assert.ok(m3.resample && m3.resample.stopbandDb === 100);
    const { manifest: m4 } = await prepareMemory(hi, { targetRate: 'keep' });
    assert.equal(m4.sampleRate, 96000);
    results.push('rates: 96 kHz → 48 kHz by default (3 s → 144000 frames), kept with targetRate "keep"');

    // Failures: a non-WAV input fails the job with the ffmpeg message.
    const bad = prepareAudio(chunks(new TextEncoder().encode('fLaC\0\0\0\"this is not a wav at all')), { storage: memoryStorage() });
    await assert.rejects(bad.done, /ffmpeg/);
    assert.equal(bad.status, 'failed');

    // The decoder hook: any source of planar blocks.
    const toneDecoder: AudioDecoder = () => ({
        format: Promise.resolve({ sampleRate: 22050, channels: 1, encoding: 'synthetic', bitsPerSample: 32, frames: 22050 }),
        blocks: (async function* () {
            for (let k = 0; k < 10; k += 1) yield [new Float32Array(2205).fill(0.25)];
        })(),
    });
    const { manifest: m5 } = await prepareMemory(new Uint8Array(1), { decoder: toneDecoder });
    assert.equal(m5.frames, 22050);
    assert.equal(m5.source.encoding, 'synthetic');
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
    assert.equal(manifest.formatVersion, 3);
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
const segOf = (storage: ReturnType<typeof memoryStorage>, key: string) => { const x = storage.objects.get(key)!; return parseWavFile(x.buffer.slice(x.byteOffset, x.byteOffset + x.length) as ArrayBuffer).channels[0]; };
const levelDb = (storage: ReturnType<typeof memoryStorage>, m: { segments: { list: { url: string }[] }; stems: { b: { segments: { list: { url: string }[] } } } }, i: number) => {
    const sa = segOf(storage, m.segments.list[i].url), sb = segOf(storage, m.stems.b.segments.list[i].url);
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
    assert.equal(m.formatVersion, 3);
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
    const lv = levelDb(one.storage, m as never, 2);
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
    for (const key of keys.filter((k) => k.startsWith('b/'))) {
        assert.ok(Buffer.from(later.objects.get(key)!).equals(Buffer.from(one.storage.objects.get(key)!)), `attachStem: ${key} differs from the one-call prepare`);
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
    assert.ok(![...warned.objects.keys()].some((k) => k.startsWith('b/seg/')), 'no B segments');
    await assert.rejects(prepareAudio(chunks(A40wav, 3, 65536), { storage: memoryStorage(), stems: { b: {} } }).done, /exactly one/);
    results.push('stem B refusals: 1-frame offset exact; unrelated B fails the job (no manifest) or, with onLowConfidence "warn", publishes A only with stems.b failed + reason + measured alignment');
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
    assert.ok(m.stems!.v1.segments!.list.every((x) => x.url.startsWith('v1/seg/')));
    assert.ok(storage.objects.has('v1/peaks.bin') && storage.objects.has('b/peaks.bin'));
    assert.deepEqual([...seen].sort(), ['b', 'v1']);
    assert.deepEqual(Object.keys(job.stats!.timings.stems).sort(), ['b', 'v1']);
    const lv = levelDb(storage, { ...m, stems: { b: m.stems!.v1 } } as never, 1);
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
    results.push(`named stems: b ("Noise reduction") + v1 ("Voice conversion") in one call, each on A's grid under <key>/, offsets ${m.stems!.b.alignment!.offsetMs} / ${m.stems!.v1.alignment!.offsetMs} ms; attachStem v2 + markStem v3; keys validated (a reserved, pattern, case-insensitive collisions, labels)`);
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
    assert.match(ms.stems!.b!.error!, /exited with 3/);
    assert.equal(ms.stems!.b!.processor!.id, 'test.cli-bad');
    assert.equal(job.stats!.warnings.length, 1);
    // Timeout: a CLI that hangs is killed at the deadline.
    const t0 = performance.now();
    const hang = commandProcessor({ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 60000)'], id: 'test.cli-hang', timeoutMs: 400 });
    await assert.rejects(prepareAudio(aFile, { storage: memoryStorage(), concurrency: 1, stems: { b: { processor: hang } } }).done, /test\.cli-hang.*timed out after 400 ms/);
    assert.ok(performance.now() - t0 < 10000);
    // Cancellation reaches the processor.
    const controller = new AbortController();
    const slow = functionProcessor(({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('stopped by signal')))), { id: 'test.slow', version: '0' });
    const cancelled = prepareAudio(aFile, { storage: memoryStorage(), concurrency: 1, signal: controller.signal, stems: { b: { processor: slow } } });
    setTimeout(() => controller.abort(new Error('user cancelled')), 50);
    await assert.rejects(cancelled.done);
    results.push(`command processor: node CLI → offset ${b.alignment!.offsetFrames}, ρ ${b.correlation!.global}; exit 3 → job fails naming the processor, exit code and stderr; onProcessorError "skip" → A only + recorded error; 400 ms timeout kills a hung CLI; cancel reaches the processor`);
}

{
    // HTTP processor: A posted to a local service, B in the response (raw body, then multipart).
    const server = http.createServer((req, res) => {
        const parts: Buffer[] = [];
        req.on('data', (d: Buffer) => parts.push(d));
        req.on('end', () => {
            let body = Buffer.concat(parts);
            if (req.url === '/fail') { res.writeHead(503); res.end('busy'); return; }
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
        results.push(`http processor: raw body and multipart → offset ${b.alignment!.offsetFrames}, ρ ${b.correlation!.global}; 503 → job fails with the status and body`);
    } finally {
        server.closeAllConnections();
        server.close();
    }
}
fs.rmSync(tmpRoot, { recursive: true, force: true });

results.push(`manifests checked against manifest.schema.json and assertManifest(): ${schemaChecked.length}`);
console.log(results.map((line) => `  ok  ${line}`).join('\n'));
console.log('\nprepare tests passed');
