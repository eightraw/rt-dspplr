#!/usr/bin/env node
// Generates synthetic, speech-like test WAVs for the long-audio experiment.
//
//   node gen-test-wavs.mjs [outDir] [--quick]   (default: $LONG_STORAGE_DIR or storage/long)
//
// Voiced "syllables" (a band-limited harmonic wavetable per vowel, read with a
// gliding F0 between 90 and 240 Hz) grouped into words and phrases, with
// pauses of 0.15–1.6 s and a low noise floor (about -55 dBFS). Deterministic
// (seeded PRNG), written in one-second chunks, so memory stays flat for any
// length. 16-bit PCM.
//
// Default set (≈ 920 MB):
//   speech-60min-48k-mono.wav     60 min, 48 kHz, mono    (≈ 345 MB)
//   speech-30min-48k-stereo.wav   30 min, 48 kHz, stereo  (≈ 345 MB)
//   speech-10min-96k-stereo.wav   10 min, 96 kHz, stereo  (≈ 230 MB)
// --quick writes 2-minute versions of the same three, for smoke tests.

import fs from 'node:fs';
import path from 'node:path';

function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const TABLE = 4096;
// Formant pairs (Hz) of a few vowels; harmonics are weighted by resonance peaks.
const VOWELS = [[730, 1090], [270, 2290], [300, 870], [530, 1840], [660, 1720], [440, 1020], [490, 1350], [390, 1990]];

/** One period of a vowel-like wave for a nominal F0, band-limited to `nyquist`. */
function vowelTable(f1, f2, nominalF0, nyquist) {
    const table = new Float32Array(TABLE + 1);
    const harmonics = Math.min(40, Math.floor((nyquist * 0.45) / 240)); // safe for F0 up to 240 Hz
    const res = (f, fc, bw) => 1 / (1 + ((f - fc) / bw) ** 2);
    let peak = 0;
    for (let i = 0; i < TABLE; i += 1) {
        let v = 0;
        for (let h = 1; h <= harmonics; h += 1) {
            const f = h * nominalF0;
            const amp = (1 / h) * 0.3 + res(f, f1, 90) + 0.6 * res(f, f2, 120);
            v += amp * Math.sin((2 * Math.PI * h * i) / TABLE + h * 0.7);
        }
        table[i] = v;
        peak = Math.max(peak, Math.abs(v));
    }
    for (let i = 0; i < TABLE; i += 1) table[i] /= peak;
    table[TABLE] = table[0];
    return table;
}

/** Event script: alternating syllables and pauses, generated lazily. */
function* speechEvents(rand, sampleRate) {
    for (;;) {
        const words = 2 + Math.floor(rand() * 8);
        for (let w = 0; w < words; w += 1) {
            const syllables = 1 + Math.floor(rand() * 3);
            for (let s = 0; s < syllables; s += 1) {
                const dur = Math.round((0.09 + rand() * 0.22) * sampleRate);
                const f0a = 90 + rand() * 150;
                const f0b = Math.max(80, Math.min(250, f0a * (0.75 + rand() * 0.5)));
                yield { kind: 'voice', length: dur, vowel: Math.floor(rand() * VOWELS.length), f0a, f0b, level: 0.25 + rand() * 0.45 };
                if (rand() < 0.3) yield { kind: 'gap', length: Math.round((0.02 + rand() * 0.05) * sampleRate) };
            }
            yield { kind: 'gap', length: Math.round((0.05 + rand() * 0.15) * sampleRate) };
        }
        yield { kind: 'gap', length: Math.round((0.15 + rand() * 1.45) * sampleRate) };
    }
}

export function generateWav(file, { seconds, sampleRate, channels, seed = 1 }) {
    const frames = Math.round(seconds * sampleRate);
    const dataBytes = frames * channels * 2;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0); header.writeUInt32LE(36 + dataBytes, 4); header.write('WAVE', 8);
    header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22); header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * channels * 2, 28); header.writeUInt16LE(channels * 2, 32);
    header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(dataBytes, 40);

    const fd = fs.openSync(file, 'w');
    fs.writeSync(fd, header);
    const rand = mulberry32(seed);
    const noiseRand = mulberry32(seed * 7919 + 1);
    const tables = VOWELS.map(([f1, f2]) => vowelTable(f1, f2, 120, sampleRate / 2));
    const events = speechEvents(rand, sampleRate);
    // Second channel: the same voice 0.4 ms later at 0.8 gain, its own noise.
    const delay = Math.round(0.0004 * sampleRate);
    const history = new Float32Array(delay + 1);
    let hist = 0;

    let event = events.next().value;
    let pos = 0;
    let phase = 0;
    const chunkFrames = sampleRate;
    const out = Buffer.alloc(chunkFrames * channels * 2);
    for (let written = 0; written < frames; written += chunkFrames) {
        const n = Math.min(chunkFrames, frames - written);
        for (let i = 0; i < n; i += 1) {
            let v = 0;
            if (event.kind === 'voice') {
                const t = pos / event.length;
                const f0 = event.f0a + (event.f0b - event.f0a) * t;
                // Raised-cosine attack/decay, a slight vibrato-free tremolo.
                const env = Math.sin(Math.PI * Math.min(1, t * 1.15)) ** 1.5;
                const table = tables[event.vowel];
                const x = phase * TABLE;
                const i0 = x | 0;
                v = (table[i0] + (table[i0 + 1] - table[i0]) * (x - i0)) * env * event.level;
                phase += f0 / sampleRate;
                if (phase >= 1) phase -= 1;
            }
            pos += 1;
            if (pos >= event.length) { event = events.next().value; pos = 0; }
            const noise = (noiseRand() * 2 - 1) * 0.0018;
            const left = Math.max(-1, Math.min(1, v + noise));
            if (channels === 1) {
                out.writeInt16LE(Math.round(left * 32767), i * 2);
            } else {
                history[hist] = v;
                const delayed = history[(hist + 1) % history.length];
                hist = (hist + 1) % history.length;
                const right = Math.max(-1, Math.min(1, delayed * 0.8 + (noiseRand() * 2 - 1) * 0.0018));
                out.writeInt16LE(Math.round(left * 32767), i * 4);
                out.writeInt16LE(Math.round(right * 32767), i * 4 + 2);
            }
        }
        fs.writeSync(fd, out, 0, n * channels * 2);
    }
    fs.closeSync(fd);
    return { file, frames, bytes: 44 + dataBytes };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
if (isMain) {
    const outDir = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? process.env.LONG_STORAGE_DIR ?? 'storage/long';
    const quick = process.argv.includes('--quick');
    fs.mkdirSync(outDir, { recursive: true });
    const set = [
        { name: 'speech-60min-48k-mono', seconds: 3600, sampleRate: 48000, channels: 1, seed: 1 },
        { name: 'speech-30min-48k-stereo', seconds: 1800, sampleRate: 48000, channels: 2, seed: 2 },
        { name: 'speech-10min-96k-stereo', seconds: 600, sampleRate: 96000, channels: 2, seed: 3 },
    ];
    for (const item of set) {
        const seconds = quick ? 120 : item.seconds;
        const name = quick ? item.name.replace(/\d+min/, '2min') : item.name;
        const t0 = performance.now();
        const result = generateWav(path.join(outDir, `${name}.wav`), { ...item, seconds });
        console.log(`${name}.wav  ${(result.bytes / 1e6).toFixed(1)} MB  ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    }
}
