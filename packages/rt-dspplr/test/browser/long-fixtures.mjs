// Playwright global setup for the stream-player tests: writes synthetic
// recordings and prepares them with the built @saitdigital/rt-dspplr-prepare
// (packages/rt-dspplr-prepare/dist: `npm run build:lib` at the root builds it)
// into node_modules/.cache/rtd-long (served by the test server at /node_modules/.cache/rtd-long/).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const FIXTURES = path.join(root, 'node_modules', '.cache', 'rtd-long');
const PREPARE = path.resolve(root, '..', 'rt-dspplr-prepare', 'dist', 'index.js');

/** The built prepare package (a sibling workspace package; its dist must exist). */
export async function loadPrepare() {
    if (!fs.existsSync(PREPARE)) {
        throw new Error(`${PREPARE} is missing: build it first (npm run build -w packages/rt-dspplr-prepare, or npm run build:lib at the root)`);
    }
    return import(pathToFileURL(PREPARE).href);
}

function wav16(file, seconds, rate, channels) {
    const frames = Math.round(seconds * rate);
    const buf = Buffer.alloc(44 + frames * channels * 2);
    buf.write('RIFF', 0); buf.writeUInt32LE(buf.length - 8, 4); buf.write('WAVE', 8);
    buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(channels, 22);
    buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * channels * 2, 28); buf.writeUInt16LE(channels * 2, 32);
    buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(frames * channels * 2, 40);
    let p = 44;
    for (let i = 0; i < frames; i += 1) {
        const t = i / rate;
        // Always audible (no long silences), so "audio is playing" is unambiguous.
        const env = 0.35 + 0.25 * Math.sin(2 * Math.PI * 0.7 * t);
        for (let c = 0; c < channels; c += 1) {
            const v = env * Math.sin(2 * Math.PI * (180 + 60 * Math.sin(0.5 * t) + c * 7) * t) + 0.002 * Math.sin(i * 12.9898 + c);
            buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32768))), p);
            p += 2;
        }
    }
    fs.writeFileSync(file, buf);
}

/** Steady band-limited noise (stable RMS, unambiguous cross-correlation), mono 16-bit. */
function noise(seconds, rate) {
    const frames = Math.round(seconds * rate);
    const out = new Float64Array(frames);
    let seed = 12345, lp = 0, lp2 = 0;
    for (let i = 0; i < frames; i += 1) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const w = seed / 4294967296 - 0.5;
        lp += 0.25 * (w - lp);
        lp2 += 0.5 * (lp - lp2);
        out[i] = lp2;
    }
    let sq = 0;
    for (const v of out) sq += v * v;
    const k = 0.1 / Math.sqrt(sq / frames);
    for (let i = 0; i < frames; i += 1) out[i] *= k;
    return out;
}

function writeMono16(file, x, rate) {
    const buf = Buffer.alloc(44 + x.length * 2);
    buf.write('RIFF', 0); buf.writeUInt32LE(buf.length - 8, 4); buf.write('WAVE', 8);
    buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(x.length * 2, 40);
    for (let i = 0; i < x.length; i += 1) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32768))), 44 + i * 2);
    fs.writeFileSync(file, buf);
}

/** A/B pairs (stem B = A, 37 ms late; at A's level and at -6 dB), and an A-only clip that a test gives a B later. */
async function pairs() {
    const { prepareAudio } = await loadPrepare();
    const rate = 48000;
    const a = noise(20, rate);
    const delay = Math.round(0.037 * rate);
    const late = (gain) => Float64Array.from(a, (_, i) => (i >= delay ? a[i - delay] * gain : 0));
    const srcA = path.join(FIXTURES, 'pairA.wav');
    writeMono16(srcA, a, rate);
    writeMono16(path.join(FIXTURES, 'pairB0.wav'), late(1), rate);
    writeMono16(path.join(FIXTURES, 'pairB6.wav'), late(0.5), rate);
    const stems = {};
    for (const [name, b] of [['pairEq', 'pairB0.wav'], ['pairQuiet', 'pairB6.wav'], ['pairHot', null]]) {
        const out = path.join(FIXTURES, name);
        fs.rmSync(out, { recursive: true, force: true });
        // A and B in one prepare call, one manifest (pairHot: A only; the test attaches B later).
        const m = await prepareAudio(srcA, { outDir: out, segmentSeconds: 4, ...(b ? { stems: { b: { input: path.join(FIXTURES, b) } } } : {}) }).done;
        if (b) stems[name] = m.stems.b;
    }
    fs.writeFileSync(path.join(FIXTURES, 'pairs.json'), JSON.stringify(stems, null, 1));
    // Two named stems with labels (neutral keys; the labels are only examples): b at A's level, v1 at -6 dB.
    const named = path.join(FIXTURES, 'pairNamed');
    fs.rmSync(named, { recursive: true, force: true });
    await prepareAudio(srcA, {
        outDir: named,
        segmentSeconds: 4,
        stems: {
            b: { input: path.join(FIXTURES, 'pairB0.wav'), label: 'Noise reduction' },
            v1: { input: path.join(FIXTURES, 'pairB6.wav'), label: 'Voice conversion' },
        },
    }).done;
}

export default async function setup() {
    const { prepareAudio } = await loadPrepare();
    fs.mkdirSync(FIXTURES, { recursive: true });
    const items = [
        { name: 'stereo70', seconds: 70, rate: 48000, channels: 2, segmentSeconds: 10 },
        { name: 'mono30', seconds: 30, rate: 48000, channels: 1, segmentSeconds: 3 },
    ];
    for (const item of items) {
        const src = path.join(FIXTURES, `${item.name}.wav`);
        const out = path.join(FIXTURES, item.name);
        // Re-prepare when the fixture predates the current manifest version (v2: bands + spectrogram).
        const manifestPath = path.join(out, 'manifest.json');
        if (fs.existsSync(manifestPath) && fs.existsSync(src)
            && JSON.parse(fs.readFileSync(manifestPath, 'utf8')).formatVersion >= 3) continue;
        wav16(src, item.seconds, item.rate, item.channels);
        fs.rmSync(out, { recursive: true, force: true });
        await prepareAudio(src, { outDir: out, segmentSeconds: item.segmentSeconds }).done;
    }
    await pairs();
}
