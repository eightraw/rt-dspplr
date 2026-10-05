#!/usr/bin/env node
// Makes a "server-processed" stem B for each synthetic recording in the
// long-audio folder, the way a denoiser would hand one back: a downward
// expander removes the noise floor in the pauses, a low-pass at 7 kHz takes
// the top off, the output is 20 ms late and mono at 48 kHz whatever the source
// was (so attaching it exercises alignment, resampling and mono → stereo).
//   node scripts/long/make-stems.mjs [dir]   → <dir>/stems/<name>.b.wav
// The espeak recording gets its B from make-speech-docker.sh (clean speech
// before the noise, 37 ms late, 16 kHz). Streams in 1 s chunks (flat memory).
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.argv[2] ?? process.env.LONG_STORAGE_DIR ?? 'storage/long');
const stems = path.join(dir, 'stems');
fs.mkdirSync(stems, { recursive: true });

function readHeader(fd) {
    const head = Buffer.alloc(4096);
    fs.readSync(fd, head, 0, head.length, 0);
    let p = 12, fmt = null;
    while (p + 8 <= head.length) {
        const id = head.toString('ascii', p, p + 4);
        const size = head.readUInt32LE(p + 4);
        if (id === 'fmt ') fmt = { channels: head.readUInt16LE(p + 10), rate: head.readUInt32LE(p + 12), bits: head.readUInt16LE(p + 22) };
        if (id === 'data') return { ...fmt, dataOffset: p + 8, dataBytes: size };
        p += 8 + size + (size & 1);
    }
    throw new Error('no data chunk');
}

function header(frames, rate) {
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + frames * 2, 4); h.write('WAVE', 8);
    h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
    h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
    h.write('data', 36); h.writeUInt32LE(frames * 2, 40);
    return h;
}

/** RBJ low-pass biquad. */
function lowPass(rate, hz) {
    const w = 2 * Math.PI * hz / rate, q = Math.SQRT1_2, al = Math.sin(w) / (2 * q), c = Math.cos(w), a0 = 1 + al;
    const b0 = (1 - c) / 2 / a0, b1 = (1 - c) / a0, b2 = b0, a1 = -2 * c / a0, a2 = (1 - al) / a0;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    return (x) => { const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x; y2 = y1; y1 = y; return y; };
}

for (const file of fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.wav') && !f.includes('espeak'))) {
    const name = file.slice(0, -4);
    const out = path.join(stems, `${name}.b.wav`);
    if (fs.existsSync(out) && fs.statSync(out).mtimeMs > fs.statSync(path.join(dir, file)).mtimeMs) {
        console.log(`${name}: stem B up to date`);
        continue;
    }
    const t0 = Date.now();
    const fd = fs.openSync(path.join(dir, file), 'r');
    const h = readHeader(fd);
    if (h.bits !== 16) throw new Error(`${file}: 16-bit only`);
    const frames = Math.floor(h.dataBytes / (2 * h.channels));
    const outRate = 48000;
    const step = h.rate / outRate; // 1 or 2 here: decimate after the 7 kHz low-pass
    const outFrames = Math.floor(frames / step);
    const delay = Math.round(0.020 * outRate);
    const wfd = fs.openSync(out, 'w');
    fs.writeSync(wfd, header(outFrames, outRate));
    const lp1 = lowPass(h.rate, 7000), lp2 = lowPass(h.rate, 7000);
    const attack = Math.exp(-1 / (0.005 * h.rate)), release = Math.exp(-1 / (0.08 * h.rate));
    const thr = Math.pow(10, -46 / 20);
    let env = 0, gain = 0;
    const gSmooth = Math.exp(-1 / (0.01 * h.rate));
    // The delay: 20 ms of silence first, the last 20 ms dropped (same length as A).
    let written = 0;
    const pending = [];
    const flush = (force = false) => {
        if (!pending.length || (!force && pending.length < outRate)) return;
        const n = Math.min(pending.length, outFrames - written);
        const buf = Buffer.alloc(n * 2);
        for (let i = 0; i < n; i += 1) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pending[i] * 32767))), i * 2);
        fs.writeSync(wfd, buf);
        written += n;
        pending.length = 0;
    };
    for (let i = 0; i < delay; i += 1) pending.push(0);
    const chunkFrames = h.rate;
    const raw = Buffer.alloc(chunkFrames * h.channels * 2);
    let phase = 0;
    for (let f = 0; f < frames; f += chunkFrames) {
        const n = Math.min(chunkFrames, frames - f);
        fs.readSync(fd, raw, 0, n * h.channels * 2, h.dataOffset + f * h.channels * 2);
        for (let i = 0; i < n; i += 1) {
            let x = 0;
            for (let c = 0; c < h.channels; c += 1) x += raw.readInt16LE((i * h.channels + c) * 2);
            x /= 32768 * h.channels;
            const a = Math.abs(x);
            env = a > env ? attack * env + (1 - attack) * a : release * env + (1 - release) * a;
            const target = env >= thr ? 1 : (env / thr) ** 3;
            gain = gSmooth * gain + (1 - gSmooth) * target;
            const y = lp2(lp1(x * gain));
            phase += 1;
            if (phase >= step) {
                phase -= step;
                pending.push(y);
            }
        }
        flush();
    }
    flush(true);
    // Pad (rounding) to the announced length.
    if (written < outFrames) fs.writeSync(wfd, Buffer.alloc((outFrames - written) * 2));
    fs.closeSync(wfd);
    fs.closeSync(fd);
    console.log(`${name}: stem B (expander + 7 kHz low-pass, 20 ms late, mono 48 kHz) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
