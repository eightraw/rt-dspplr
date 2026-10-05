// Long-audio page: the same recordings played two ways, side by side, by the
// same player core (createAudioPlayer):
//   Normal:   play({ src })      — fetch the whole WAV, decode it, analyse it.
//   Manifest: play({ manifest }) — manifest, peaks, bands and spectrogram
//             first; segments on demand. The waveform previews the DSP
//             (approximate overview, exact in the decoded window) and the
//             spectrogram draws from the prepared overview, refined when zoomed.
// Each panel shows the numbers that matter for long files. A toggle shows the
// React <AudioPlayer> card on the manifest instead.
// Stem B: prepare-all.mjs makes it in the same prepareAudio call as A (a
// ready-made processed file, or a Docker processor). Every manifest is
// published with its B, so the A/B knob works as soon as a recording opens.

import { createAudioPlayer, createTimeline, type AudioPlayerCore, type TimelineView } from '@saitdigital/rt-dspplr';
// An example third-party plugin (examples/plugins), to see a plugin in the sound, waveform and spectrogram.
import { threeBandEq } from '../../../plugins/three-band-eq.js';
import '@saitdigital/rt-dspplr/styles.css';
import { mountCard } from './card';
import './long.css';

interface Item {
    name: string;
    sourceUrl: string | null;
    sourceBytes: number | null;
    manifestUrl: string | null;
    duration: number | null;
    sampleRate: number | null;
    sourceSampleRate: number | null;
    channels: number | null;
    segments: number | null;
    preparedBytes: number | null;
    stemB: {
        status: string; error?: string; processor?: string; offsetMs?: number; confidence?: number; correlation?: number;
        mixLaw?: string; loudnessDeltaDb?: number; bandwidthHz?: number; sourceRate?: number; sourceChannels?: number;
    } | null;
}

type Mode = 'normal' | 'manifest';

const mb = (n: number | null) => (n == null ? '—' : `${(n / 1e6).toFixed(n > 1e8 ? 0 : 1)} MB`);
const clock = (s: number) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined) e.textContent = text;
    return e;
};

function slider(title: string, min: number, max: number, step: number, value: number, onInput: (v: number) => void): HTMLInputElement {
    const input = el('input', 'long-range');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.title = title;
    input.oninput = () => onInput(Number(input.value));
    return input;
}

class Panel {
    readonly root = el('section', 'long-panel');
    private readonly _title: HTMLElement;
    private readonly _seek = el('div', 'long-seek');
    private readonly _spec = el('div', 'long-spec');
    private readonly _time = el('span', 'long-time', '0:00 / 0:00');
    private readonly _metrics = el('dl', 'long-metrics');
    private readonly _play = el('button', 'long-btn', 'Play');
    private readonly _mix: HTMLInputElement;
    private readonly _mixNote = el('span', 'long-label', '');
    private _eqId: string | null = null;
    private readonly _eq = el('input');
    private _player: AudioPlayerCore | null = null;
    private _timeline: TimelineView | null = null;
    private _spectrogram: TimelineView | null = null;
    private _off: Array<() => void> = [];
    private _marks: Record<string, string> = {};
    private _t0 = 0;
    private _raf = 0;

    constructor(readonly mode: Mode) {
        this._title = el('h2', 'long-panel-title', mode === 'normal' ? 'Normal mode — whole file' : 'Manifest mode — segments');
        const controls = el('div', 'long-controls');
        const speed = el('select', 'long-select');
        for (const s of [0.75, 1, 1.25, 1.5, 2]) speed.append(new Option(`${s}×`, String(s), s === 1, s === 1));
        speed.onchange = () => void this._player?.setSpeed(Number(speed.value));
        const loop = el('button', 'long-btn', 'Loop 2 s here');
        loop.onclick = () => {
            const p = this._player;
            if (!p) return;
            if (p.getState().loop) p.setLoop(null);
            else {
                const t = p.getCurrentTime();
                p.setLoop({ start: t, end: t + 2 });
            }
        };
        this._play.onclick = () => void this._player?.toggle();
        this._mix = slider('A/B mix (stem B = server-processed)', 0, 1, 0.01, 0, (v) => this._player?.setMix(v));
        this._mix.disabled = true;
        this._eq.type = 'checkbox';
        this._eq.title = 'Example plugin: 3-band EQ, highs -12 dB';
        this._eq.onchange = () => this._syncEq();
        controls.append(
            this._play, speed, loop,
            el('label', 'long-label', 'HP'), slider('High-pass Hz', 0, 500, 10, 0, (v) => this._player?.setHighPass(v)),
            el('label', 'long-label', 'Comp'), slider('Compression', 0, 1, 0.05, 0, (v) => this._player?.setCompression(v)),
            el('label', 'long-label', 'Gain'), slider('Output gain dB', -24, 12, 1, 0, (v) => this._player?.setOutputGain(v)),
            el('label', 'long-label', 'Vol'), slider('Volume (post-FX fader)', 0, 1.5, 0.01, 1, (v) => this._player?.setVolume(v)),
            el('label', 'long-label', 'EQ plugin'), this._eq,
            el('label', 'long-label', 'A/B'), this._mix, this._mixNote,
            this._time,
        );
        this.root.append(this._title, this._seek, this._spec, controls, this._metrics);
        this._renderMetrics();
    }

    async open(item: Item): Promise<void> {
        this.close();
        const url = this.mode === 'normal' ? item.sourceUrl : item.manifestUrl;
        if (!url) {
            this._marks = { note: this.mode === 'normal' ? 'no source WAV' : 'not prepared — run npm run long:prepare' };
            this._renderMetrics();
            return;
        }
        const player = createAudioPlayer({ element: this.root, prewarmSpeeds: false });
        this._player = player;
        this._timeline = createTimeline(this._seek, player);
        this._spectrogram = createTimeline(this._spec, player, { display: 'spectrogram', ruler: false, label: 'Seek (spectrogram)' });
        this._marks = {};
        this._t0 = performance.now();
        const mark = (key: string) => {
            if (!this._marks[key]) this._marks[key] = `${Math.round(performance.now() - this._t0)} ms`;
        };
        this._eqId = null;
        this._syncEq();
        this._mix.value = '0';
        this._off.push(player.subscribe(() => {
            const s = player.getState();
            this._play.textContent = s.isPlaying ? 'Pause' : 'Play';
            this._mix.disabled = !s.capabilities.canMixStemB;
            this._mixNote.textContent = s.statusB === 'processing' ? 'processing…' : s.statusB === 'unavailable' ? 'no stem B' : s.capabilities.canMixStemB ? `law ${s.mixLaw}` : s.statusB;
            if (s.status === 'ready') mark('ready (duration known)');
            if (s.status === 'error') this._marks.error = String(s.error?.message);
        }));
        // UI ready = first waveform pixels; first audio = signal at the analyser.
        const watch = () => {
            if (!this._marks['waveform drawn'] && this._drawn(this._seek)) mark('waveform drawn');
            if (!this._marks['spectrogram drawn'] && this._drawn(this._spec, true)) mark('spectrogram drawn');
            const analyser = player.analyser;
            if (!this._marks['first audio'] && analyser && player.getState().isPlaying) {
                const d = new Float32Array(analyser.fftSize);
                analyser.getFloatTimeDomainData(d);
                if (d.some((v) => Math.abs(v) > 1e-4)) mark('first audio');
            }
            this._time.textContent = `${clock(player.getCurrentTime())} / ${clock(player.getState().duration)}`;
            this._renderMetrics();
            this._raf = requestAnimationFrame(watch);
        };
        this._raf = requestAnimationFrame(watch);
        const onSeekClick = () => {
            const s0 = performance.now();
            const startPos = player.getCurrentTime();
            const check = () => {
                const moved = Math.abs(player.getCurrentTime() - startPos) > 0.05;
                if (moved && player.getState().isPlaying) this._marks['last seek'] = `${Math.round(performance.now() - s0)} ms`;
                else if (performance.now() - s0 < 5000) requestAnimationFrame(check);
            };
            if (player.getState().isPlaying) requestAnimationFrame(check);
        };
        this._seek.addEventListener('pointerup', onSeekClick);
        this._off.push(() => this._seek.removeEventListener('pointerup', onSeekClick));
        if (this.mode === 'normal') await player.play({ src: url });
        else await player.play({ manifest: url });
    }

    private _syncEq(): void {
        const p = this._player;
        if (!p) return;
        if (this._eq.checked && !this._eqId) this._eqId = p.effects.add(threeBandEq, { params: { high: -12 } });
        if (!this._eq.checked && this._eqId) {
            p.effects.remove(this._eqId);
            this._eqId = null;
        }
    }

    close(): void {
        cancelAnimationFrame(this._raf);
        for (const off of this._off.splice(0)) off();
        this._timeline?.dispose();
        this._timeline = null;
        this._spectrogram?.dispose();
        this._spectrogram = null;
        this._player?.dispose();
        this._player = null;
    }

    /** Ink on the box's canvases (bright pixels for the dark spectrogram). */
    private _drawn(box: HTMLElement, bright = false): boolean {
        for (const c of box.querySelectorAll('canvas')) {
            if (!c.width || !c.height) continue;
            const g = c.getContext('2d', { willReadFrequently: true });
            if (!g) continue;
            const px = g.getImageData(0, 0, c.width, Math.min(c.height, 60)).data;
            for (let i = 0; i < px.length; i += 4 * 9) {
                if (bright ? px[i] + px[i + 1] + px[i + 2] > 200 : px[i + 3] > 0) return true;
            }
        }
        return false;
    }

    private _renderMetrics(): void {
        const rows: Array<[string, string]> = Object.entries(this._marks);
        const p = this._player;
        const s = p?.getStreamStats() ?? null;
        if (p && s) {
            rows.push(['buffering', String(p.getState().buffering)]);
            rows.push(['decoded in memory', `${s.cachedSeconds.toFixed(0)} s / cap ${s.capSeconds.toFixed(0)} s (${mb(s.cachedBytes)})`]);
            rows.push(['segments fetched', `${s.fetches} (${mb(s.fetchedBytes)}), avg fetch ${s.avgFetchMs.toFixed(0)} ms, decode ${s.avgDecodeMs.toFixed(1)} ms`]);
            rows.push(['peaks', `${mb(s.peaksCoarseBytes)} first + ${mb(s.peaksFineBytes)} finest`]);
            const ready = s.spectrogramReadyMs == null ? '—' : `${Math.round(s.spectrogramReadyMs)} ms`;
            rows.push(['spectrogram file', `${mb(s.spectrogramCoarseBytes)} first + ${mb(s.spectrogramFineBytes)} finest, first levels in ${ready}`]);
            rows.push(['bands (HP preview)', mb(s.bandsBytes)]);
            rows.push(['waveform preview', p.getWindowAudio() ? 'exact in the decoded window, approximate elsewhere' : 'approximate (stored peaks + bands)']);
            rows.push(['playback', s.playback === 'engine' ? `AudioWorklet engine${s.stretch.ready ? `, realtime stretch ready (window ${Math.round(s.stretch.latencyFrames / 48)} ms)${s.stretch.active ? ', active' : ''}` : ''}` : String(s.playback)]);
            rows.push(['underruns', `${s.underruns} (${s.underrunFrames} silent frames)`]);
            if (s.seekLatencies.length) rows.push(['seek → scheduled', `${s.seekLatencies.slice(-3).map((v) => v.toFixed(0)).join(', ')} ms`]);
        } else if (p) {
            const b = p.getState().buffer;
            if (b) rows.push(['decoded in memory', `${clock(b.duration)} (${mb(b.length * b.numberOfChannels * 4)} PCM)`]);
        }
        const stem = p?.getState().manifest?.stems?.b;
        if (stem) {
            rows.push(['stem B', stem.status === 'ready'
                ? `ready${stem.processor ? ` (${stem.processor.id}@${stem.processor.version}, ${(stem.processor.durationMs / 1000).toFixed(1)} s)` : ''}: offset ${stem.alignment?.offsetMs} ms (confidence ${stem.alignment?.confidence}), correlation ${stem.correlation?.global}, ${stem.mixLaw}, ${stem.loudnessDeltaDb} dB vs A (info), B up to ${((stem.source?.bandwidthHz ?? 0) / 1000).toFixed(1)} kHz; B segments fetched ${s?.fetchesB ?? 0}`
                : stem.status]);
        }
        if (p && p.getState().clipId) {
            rows.push(['speed', p.getState().capabilities.canPreservePitch ? 'pitch kept (stretch worker)' : 'playbackRate: pitch follows speed']);
        }
        this._metrics.replaceChildren(...rows.flatMap(([k, v]) => [el('dt', '', k), el('dd', '', v)]));
    }
}

async function main(): Promise<void> {
    const app = document.getElementById('app')!;
    const header = el('header', 'long-header');
    header.append(el('h1', '', 'Long audio: normal vs manifest mode'));
    header.append(el('p', 'long-muted', 'Recordings from the long-audio folder (LONG_STORAGE_DIR, default storage/long). '
        + 'Generate: npm run long:gen (or long:gen:quick) · prepare: npm run long:prepare.'));
    const list = el('ul', 'long-list');
    const panels = el('div', 'long-panels');
    const normal = new Panel('normal');
    const manifest = new Panel('manifest');

    // The React card on the manifest, instead of the manifest panel.
    const cardToggle = el('label', 'long-toggle');
    const cardBox = el('input');
    cardBox.type = 'checkbox';
    cardToggle.append(cardBox, ' Show the React <AudioPlayer> card for "Manifest" (instead of the manifest panel)');
    const cardHost = el('section', 'long-card');
    cardHost.hidden = true;
    let selected: Item | null = null;
    let unmountCard: (() => void) | null = null;
    const syncCard = () => {
        unmountCard?.();
        unmountCard = null;
        cardHost.hidden = !cardBox.checked;
        manifest.root.hidden = cardBox.checked;
        if (cardBox.checked) {
            manifest.close();
            if (selected?.manifestUrl) unmountCard = mountCard(cardHost, selected.manifestUrl, selected.name);
        } else if (selected) {
            void manifest.open(selected);
        }
    };
    cardBox.onchange = syncCard;

    panels.append(normal.root, manifest.root, cardHost);
    app.append(header, cardToggle, list, panels);

    const res = await fetch('/api/long/list', { cache: 'no-store' });
    const { items, dir } = await res.json() as { items: Item[]; dir: string };
    if (items.length === 0) list.append(el('li', 'long-muted', `Nothing in ${dir} yet.`));
    for (const item of items) {
        const li = el('li', 'long-item');
        const info = el('div', 'long-item-info');
        info.append(el('strong', '', item.name));
        info.append(el('span', 'long-muted', [
            item.duration ? clock(item.duration) : '',
            item.channels ? `${item.channels} ch` : '',
            item.sourceSampleRate ? `${item.sourceSampleRate / 1000} kHz${item.sampleRate !== item.sourceSampleRate ? ` → ${(item.sampleRate ?? 0) / 1000} kHz` : ''}` : '',
            `source ${mb(item.sourceBytes)}`,
            item.manifestUrl ? `prepared ${mb(item.preparedBytes)}, ${item.segments} segments` : 'not prepared',
        ].filter(Boolean).join(' · ')));
        const a = el('button', 'long-btn', 'Normal');
        a.disabled = !item.sourceUrl;
        a.onclick = () => void normal.open(item);
        const b = el('button', 'long-btn long-btn-accent', 'Manifest');
        b.disabled = !item.manifestUrl;
        b.onclick = () => {
            selected = item;
            if (cardBox.checked) syncCard();
            else void manifest.open(item);
        };
        const stem = item.stemB;
        if (stem) {
            info.append(el('span', 'long-muted', stem.status === 'ready'
                ? `stem B${stem.processor ? ` by ${stem.processor}` : ' (ready-made)'}: offset ${stem.offsetMs} ms, confidence ${stem.confidence}, ρ ${stem.correlation}, ${stem.mixLaw}, ${stem.loudnessDeltaDb} dB vs A, ${(stem.sourceRate ?? 0) / 1000} kHz ${stem.sourceChannels} ch, band ${((stem.bandwidthHz ?? 0) / 1000).toFixed(1)} kHz`
                : `stem B not attached: ${stem.error ?? stem.status}`));
        }
        li.append(info, a, b);
        list.append(li);
    }
}

void main();
