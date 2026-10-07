// How the lossy fixtures were made. Their source is speechLike() of prepare.test.ts (seed 31),
// written as 16-bit WAV the way encodeWav() writes it; the tests make the same signal again.
//
//   node make-sources.mjs   → opus-src.wav (48 kHz), mp3-src.wav (44.1 kHz): stereo, 2 s + 333 frames (not kept)
//   ffmpeg -i opus-src.wav -c:a libopus -b:a 64k -map_metadata -1 sine-speech.opus
//   ffmpeg -i mp3-src.wav -c:a libmp3lame -b:a 128k -map_metadata -1 sine-speech.mp3
//
// (ffmpeg 6.1.1 of Alpine 3.20.)
//
// The low-bitrate MP3s, where the bit reservoir reaches back more than 6 frames: 4 s + 333 frames
// with digital silence from 1.5 s to 3 s (a VBR encoder's smallest frames there).
//
//   node make-sources.mjs   → also low-src-48k.wav (stereo), low-src-16k.wav (mono), low-src-22k.wav (stereo) (not kept)
//   ffmpeg -i low-src-48k.wav -c:a libmp3lame -b:a 32k -map_metadata -1 low-32k-48k.mp3    MPEG-1, 32 kbit/s
//   ffmpeg -i low-src-16k.wav -c:a libmp3lame -b:a 8k -map_metadata -1 low-8k-16k.mp3      MPEG-2, 8 kbit/s
//   ffmpeg -i low-src-22k.wav -c:a libmp3lame -q:a 9 -map_metadata -1 low-v9-22k.mp3       MPEG-2, VBR -V9
//
// (ffmpeg n4.3.2 with LAME 3.100, Windows.)
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

/** speechLike() with digital silence from 1.5 s to 3 s. */
function gapped(frames, rate, channels) {
    return speechLike(frames, rate, channels, 31).map((x) => x.fill(0, Math.round(1.5 * rate), 3 * rate));
}

fs.writeFileSync(new URL('./opus-src.wav', import.meta.url), wav16(speechLike(2 * 48000 + 333, 48000, 2, 31), 48000));
fs.writeFileSync(new URL('./mp3-src.wav', import.meta.url), wav16(speechLike(2 * 44100 + 333, 44100, 2, 31), 44100));
fs.writeFileSync(new URL('./low-src-48k.wav', import.meta.url), wav16(gapped(4 * 48000 + 333, 48000, 2), 48000));
fs.writeFileSync(new URL('./low-src-16k.wav', import.meta.url), wav16(gapped(4 * 16000 + 333, 16000, 1), 16000));
fs.writeFileSync(new URL('./low-src-22k.wav', import.meta.url), wav16(gapped(4 * 22050 + 333, 22050, 2), 22050));
console.log('written');
