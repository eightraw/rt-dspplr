import * as api from '../../dist/index.js';
import * as advanced from '../../dist/advanced.js';
import * as format from '../../dist/format.js';
// Internals (not public API) for the engine tests, straight from the source.
import { StreamEngine, loadStreamEngine, stretchAvailable } from '../../src/core/engine/StreamEngine.ts';
import { SegmentScheduler } from '../../src/core/stream/SegmentScheduler.ts';
import { applyDspToSpectrogram } from '../../src/core/spectrogram/dspPaint.ts';
import { AudioPlayer, Timeline, useAudioPlayer } from '../../dist/react.js';
import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import '../../dist/styles.css';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
/** A prepared WAV clip's segments, planar: their ranges of the source, cut out as the player does. */
async function preparedSegments(base, manifest) {
    const src = manifest.segments.source;
    const bytes = new Uint8Array(await (await fetch(`${base}/${src.url}`)).arrayBuffer());
    return manifest.segments.list.map((s) => format.segmentFromRun(s.range ? format.decodePcmRun(bytes.subarray(s.range[0], s.range[1]), src) : null, s, manifest.channels));
}
const buffer = (seconds = 8, frequency = 440) => {
    const b = new AudioBuffer({ length: Math.round(seconds * 48000), sampleRate: 48000, numberOfChannels: 1 });
    const data = b.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = 0.1 * Math.sin(i * 2 * Math.PI * frequency / 48000);
    return b;
};
const wav = (seconds = 1) => {
    const b = buffer(seconds), samples = b.getChannelData(0);
    const bytes = new ArrayBuffer(44 + samples.length * 2), v = new DataView(bytes);
    const str = (offset, text) => [...text].forEach((c, i) => v.setUint8(offset + i, c.charCodeAt(0)));
    str(0, 'RIFF'); v.setUint32(4, bytes.byteLength - 8, true); str(8, 'WAVE'); str(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 48000, true); v.setUint32(28, 96000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, samples.length * 2, true);
    samples.forEach((s, i) => v.setInt16(44 + i * 2, s * 32767, true));
    return bytes;
};
const slowBlob = (seconds, delay = 200) => new class extends Blob {
    async arrayBuffer() { await sleep(delay); return super.arrayBuffer(); }
}([wav(seconds)], { type: 'audio/wav' });
// A deterministic delayed worker for transport race tests. AudioContext and
// playback nodes are real; the built-in vocoder is tested separately.
const delayedStrategy = (delay = 350) => ({
    id: `test-delay-${crypto.randomUUID()}`, poolSize: 1,
    createWorker() {
        const url = URL.createObjectURL(new Blob([`onmessage = ({data: m}) => setTimeout(() => {
            const length = Math.round(m.channels[0].byteLength / 4 / m.speed);
            const channels = m.channels.map(c => {
                const src = new Float32Array(c), dst = new Float32Array(length);
                for (let i = 0; i < length; i++) dst[i] = src[Math.min(src.length - 1, Math.floor(i * m.speed))];
                return dst.buffer;
            });
            postMessage({ type: 'stretch-complete', requestId: m.requestId, channels, length, sampleRate: m.sampleRate }, channels);
        }, ${delay});`], { type: 'text/javascript' }));
        const worker = new Worker(url); URL.revokeObjectURL(url); return worker;
    },
});
const make = (options = {}) => api.createAudioPlayer({ element: document.body.appendChild(document.createElement('div')), stretcher: 'native', prewarmSpeeds: false, processing: { highPassHz: 0, compression: 0 }, ...options });
const rms = player => {
    const data = new Float32Array(player.analyser.fftSize); player.analyser.getFloatTimeDomainData(data);
    return Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length);
};
function StrictPlayer({ clip }) {
    const player = useAudioPlayer({ stretcher: 'native', prewarmSpeeds: false });
    useEffect(() => { window.strictPlayer = player.player; void player.play(clip); }, [player.player, clip]);
    return <AudioPlayer player={player} />;
}
function CustomPlayer() {
    const player = useAudioPlayer({ stretcher: 'native', prewarmSpeeds: false });
    window.customPlayer = player.player;
    return <div ref={player.ref}><button onClick={() => void player.play(buffer())}>Custom play</button></div>;
}
function TimelinePage(props) {
    const player = useAudioPlayer({ stretcher: 'native', prewarmSpeeds: false });
    useEffect(() => { window.timelinePlayer = player.player; void player.load(buffer()); }, [player.player]);
    return <div ref={player.ref}><div style={{ height: 120 }}><Timeline player={player} {...props} /></div><div style={{ height: 3000 }} /></div>;
}
function CardPage({ clip, options }) {
    const player = useAudioPlayer({ prewarmSpeeds: false, ...options });
    useEffect(() => { window.cardPlayer = player.player; void player.load(clip); }, [player.player, clip]);
    return <div style={{ width: 720 }}><AudioPlayer player={player} title="Card" /></div>;
}
window.h = { ...api, advanced, format, internals: { StreamEngine, loadStreamEngine, stretchAvailable, SegmentScheduler, applyDspToSpectrogram }, preparedSegments, sleep, buffer, wav, slowBlob, delayedStrategy, make, rms,
    mountMenu(layout, options) { const root = createRoot(document.getElementById('root')); root.render(<AudioPlayer layout={layout} title="Example" options={options} />); return root; },
    renderMenu(root, layout) { root.render(<AudioPlayer layout={layout} title="Example" />); },
    mountCustom() { const root = createRoot(document.getElementById('root')); root.render(<StrictMode><CustomPlayer /></StrictMode>); return root; },
    mountTimeline(props) { const root = createRoot(document.getElementById('root')); root.render(<TimelinePage {...props} />); return root; },
    mountCard(clip, options) { const root = createRoot(document.getElementById('root')); root.render(<CardPage clip={clip} options={options} />); return root; },
    mountStrict() { const root = createRoot(document.getElementById('root')); root.render(<StrictMode><StrictPlayer clip={buffer()} /></StrictMode>); return root; },
};
