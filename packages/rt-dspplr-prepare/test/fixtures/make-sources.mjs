// How the lossy fixtures were made. Their source is speechLike() of prepare.test.ts (seed 31),
// written as 16-bit WAV the way encodeWav() writes it; the tests make the same signal again.
//
//   node make-sources.mjs   → opus-src.wav (48 kHz), mp3-src.wav (44.1 kHz): stereo, 2 s + 333 frames (not kept)
//   ffmpeg -i opus-src.wav -c:a libopus -b:a 64k -map_metadata -1 sine-speech.opus
//   ffmpeg -i mp3-src.wav -c:a libmp3lame -b:a 128k -map_metadata -1 sine-speech.mp3
//
// (ffmpeg 6.1.1 of Alpine 3.20.)
import fs from 'node:fs';

function speechLike(frames, rate, channels, seed = 3) {
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

function wav16(channels, rate) {
    const frames = channels[0].length, C = channels.length;
    const b = Buffer.alloc(44 + frames * C * 2);
    b.write('RIFF', 0); b.writeUInt32LE(36 + frames * C * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16);
    b.writeUInt16LE(1, 20); b.writeUInt16LE(C, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * C * 2, 28); b.writeUInt16LE(C * 2, 32); b.writeUInt16LE(16, 34);
    b.write('data', 36); b.writeUInt32LE(frames * C * 2, 40);
    let o = 44;
    for (let i = 0; i < frames; i += 1) for (let c = 0; c < C; c += 1) {
        const x = Math.max(-1, Math.min(1, channels[c][i]));
        b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x * 32768))), o);
        o += 2;
    }
    return b;
}

fs.writeFileSync(new URL('./opus-src.wav', import.meta.url), wav16(speechLike(2 * 48000 + 333, 48000, 2, 31), 48000));
fs.writeFileSync(new URL('./mp3-src.wav', import.meta.url), wav16(speechLike(2 * 44100 + 333, 44100, 2, 31), 44100));
console.log('written');
