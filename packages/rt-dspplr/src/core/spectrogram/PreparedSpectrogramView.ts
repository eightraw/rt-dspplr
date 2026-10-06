import type { AudioPlayerCore, AudioPlayerState } from '../AudioPlayer';
import { mixGains } from '../controls';
import { SpectrogramAnalyzer, type SpectrogramData } from './SpectrogramAnalyzer';
import type { SpectralPyramid } from './protocol';
import { sampleSpectralPyramid } from './sample';
import { paintSpectrogram, spectrogramBackground, type SpectrogramPalette } from './paint';
import { resolvePalette, themePalette } from './themePalette';
import { chooseFft, type SpectrogramOptions, type SpectrogramView } from './SpectrogramView';
import { applyDspToSpectrogram } from './dspPaint';
import { previewSettings } from '../effects/preview';
import { subscribeDspPreview, type DspPreview } from '../waveform/followWaveform';

// ---------------------------------------------------------------------------
// The spectrogram of a prepared (segmented) clip.
//
//   overview   the precomputed spectrogram.bin levels, drawn for any window
//              at once, before a single segment has been decoded — the same
//              sampling and colouring as the whole-clip pyramid.
//   zoomed in  past the overview's resolution, the window's decoded segments
//              go through the same spectrogram worker (SpectrogramAnalyzer)
//              and the sharp picture replaces the overview where it covers it.
//
// Both are coloured against the prepared file's loudest bin, so the live
// close-up has the levels of the overview around it.
// ---------------------------------------------------------------------------

const MAX_PIXELS = 4096;

type PlayerLike = Pick<AudioPlayerCore, 'getState' | 'subscribe'> & Partial<Pick<AudioPlayerCore, 'on' | 'setView' | 'getWindowAudio'>>;

export function createPreparedSpectrogram(
    canvas: HTMLCanvasElement,
    player: PlayerLike,
    initialOptions: SpectrogramOptions = {},
): SpectrogramView {
    let options = initialOptions;
    let range: { start: number; end: number } | null = null;
    let frame = 0;
    let disposed = false;
    let pyramid: SpectralPyramid | null = null;
    let sampled: SpectrogramData | null = null;
    let sampledKey = '';
    let image: ImageData | null = null;
    let liveImage: ImageData | null = null;
    let live: SpectrogramData | null = null;
    let windowKey = '';
    let windowOffset = 0;
    let asked = '';
    const scratch = canvas.ownerDocument.createElement('canvas');
    let preview: DspPreview | null = null;
    let lastDsp = '';
    const offPreview = subscribeDspPreview(player, (next) => {
        preview = next;
        schedulePaint();
    });
    const dspSlots = { sampled: null as SpectrogramData | null, live: null as SpectrogramData | null };
    function dsp(d: SpectrogramData, slot: keyof typeof dspSlots, minHz: number, maxHz: number): SpectrogramData {
        const state = player.getState();
        const out = applyDspToSpectrogram(d, { state, preview, timelineRate: state.manifest?.sampleRate ?? 48000, minHz, maxHz }, dspSlots[slot]);
        if (out !== d) dspSlots[slot] = out;
        return out;
    }
    const liveScratch = canvas.ownerDocument.createElement('canvas');

    const analyzer = new SpectrogramAnalyzer((data) => {
        if (data.columns === 0) return;
        // Window-relative times back on the clip's timeline.
        live = { ...data, start: data.start + windowOffset, end: data.end + windowOffset };
        schedulePaint();
    });

    // The theme's palette, read once and again after refreshColors(); options.palette wins.
    let themed: SpectrogramPalette | null = null;
    function look() {
        themed ??= themePalette(canvas);
        return {
            colorMode: options.colorMode ?? 'single',
            palette: resolvePalette(themed, options.palette),
            floorDb: options.floorDb ?? 66,
        };
    }

    function view(): { start: number; end: number } {
        const duration = player.getState().duration;
        const start = Math.max(0, range?.start ?? 0);
        const end = Math.min(duration, range?.end ?? duration);
        return end > start ? { start, end } : { start: 0, end: duration };
    }

    /** Ask for the live close-up when the overview is too coarse for the view. */
    function request(): void {
        const state = player.getState();
        const w = view();
        const span = w.end - w.start;
        if (!pyramid || span <= 0 || canvas.width === 0) return;
        player.setView?.(w.start, w.end);
        const samplesPerColumn = (span * pyramid.sampleRate) / canvas.width;
        if (samplesPerColumn * 2 >= pyramid.levels[0].binSize) {
            live = null;
            return;
        }
        const audio = player.getWindowAudio?.() ?? null;
        if (!audio) return;
        const offset = audio.startFrame / audio.sampleRate;
        const covered = audio.buffer.duration;
        if (w.start < offset || w.end > offset + covered + 1e-6) return;
        if (audio.key !== windowKey) {
            windowKey = audio.key;
            windowOffset = offset;
            analyzer.setBuffers(audio.buffer, audio.bufferB ?? null);
            asked = '';
        }
        const key = `${windowKey}|${w.start}|${w.end}|${canvas.width}|${canvas.height}|${options.minHz}|${options.maxHz}|${options.fftSize}`;
        if (key === asked) return;
        asked = key;
        analyzer.request({
            start: w.start - offset,
            end: w.end - offset,
            columns: Math.min(MAX_PIXELS, canvas.width),
            rows: canvas.height,
            minHz: options.minHz ?? 30,
            maxHz: Math.min(options.maxHz ?? 16000, state.manifest ? state.manifest.sampleRate / 2 : 24000),
            ...chooseFft(options.fftSize, samplesPerColumn),
        });
    }

    function paint(): void {
        frame = 0;
        const context = canvas.getContext('2d');
        if (!context || disposed) return;
        const current = look();
        if (!pyramid) {
            // Nothing of the clip yet: no panel either (the card's empty state shows through).
            context.clearRect(0, 0, canvas.width, canvas.height);
            return;
        }
        context.fillStyle = spectrogramBackground(current.palette);
        context.fillRect(0, 0, canvas.width, canvas.height);
        const w = view();
        const width = canvas.width;
        const key = `${w.start}|${w.end}|${width}`;
        if (key !== sampledKey || !sampled) {
            sampled = sampleSpectralPyramid(pyramid, w.start, w.end, width, sampled);
            sampledKey = key;
        }
        if (!image || image.width !== width || image.height !== pyramid.rows) image = new ImageData(width, pyramid.rows);
        paintSpectrogram(image, dsp(sampled, 'sampled', pyramid.minHz, pyramid.maxHz), stemGains(player.getState()), current, pyramid.referenceMax);
        scratch.width = width;
        scratch.height = pyramid.rows;
        scratch.getContext('2d')?.putImageData(image, 0, 0);
        context.imageSmoothingEnabled = true;
        context.drawImage(scratch, 0, 0, width, pyramid.rows, 0, 0, canvas.width, canvas.height);

        // The live close-up over it, where it covers the view.
        const data = live;
        if (!data || data.columns === 0) return;
        const from = Math.max(w.start, data.start);
        const to = Math.min(w.end, data.end);
        if (to <= from) return;
        if (!liveImage || liveImage.width !== data.columns || liveImage.height !== data.rows) liveImage = new ImageData(data.columns, data.rows);
        const state = player.getState();
        paintSpectrogram(liveImage, dsp(data, 'live', options.minHz ?? 30, Math.min(options.maxHz ?? 16000, (state.manifest?.sampleRate ?? 48000) / 2)), stemGains(state), current, pyramid.referenceMax);
        liveScratch.width = data.columns;
        liveScratch.height = data.rows;
        liveScratch.getContext('2d')?.putImageData(liveImage, 0, 0);
        const span = Math.max(1e-9, data.end - data.start);
        const viewSpan = Math.max(1e-9, w.end - w.start);
        context.drawImage(
            liveScratch,
            ((from - data.start) / span) * data.columns, 0, Math.max(1e-3, ((to - from) / span) * data.columns), data.rows,
            ((from - w.start) / viewSpan) * canvas.width, 0, ((to - from) / viewSpan) * canvas.width, canvas.height,
        );
    }

    function schedulePaint(): void {
        if (frame || disposed) return;
        const win = canvas.ownerDocument.defaultView;
        frame = win ? win.requestAnimationFrame(paint) : 0;
        if (!win) paint();
    }

    function resize(): void {
        const ratio = canvas.ownerDocument.defaultView?.devicePixelRatio ?? 1;
        const width = Math.min(MAX_PIXELS, Math.max(1, Math.round(canvas.clientWidth * ratio)));
        const height = Math.min(MAX_PIXELS, Math.max(1, Math.round(canvas.clientHeight * ratio)));
        if (width === canvas.width && height === canvas.height) return;
        canvas.width = width;
        canvas.height = height;
        request();
        schedulePaint();
    }

    function onState(): void {
        const dspKey = `${previewSettings(player.getState()).key}|${stemGains(player.getState()).join(',')}`;
        if (dspKey !== lastDsp) {
            lastDsp = dspKey;
            schedulePaint();
        }
        const next = player.getState().prepared?.spectrogram ?? null;
        if (next !== pyramid) {
            pyramid = next;
            sampledKey = '';
            request();
            schedulePaint();
        }
    }

    const unsubscribe = player.subscribe(onState);
    const off = player.on?.('sourceupdate', ({ what }) => {
        if (what === 'segment') request();
    }) ?? null;
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => resize()) : null;
    observer?.observe(canvas);
    resize();
    onState();
    schedulePaint();

    return {
        setRange(next) {
            range = next ? { start: next.start, end: next.end } : null;
            live = live && range && live.start <= range.start && live.end >= range.end ? live : null;
            request();
            schedulePaint();
        },
        setOptions(next) {
            options = next;
            asked = '';
            request();
            schedulePaint();
        },
        refreshColors() {
            themed = null;
            schedulePaint();
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            unsubscribe();
            off?.();
            observer?.disconnect();
            if (frame) canvas.ownerDocument.defaultView?.cancelAnimationFrame(frame);
            offPreview();
            analyzer.dispose();
        },
    };
}

/** The A/B gains the engine plays with (B's explicit trim included), for painting the blend. */
function stemGains(state: AudioPlayerState): [number, number] {
    const stem = state.stem ? state.manifest?.stems?.[state.stem] : undefined;
    if (!stem || stem.status !== 'ready') return [1, 0];
    const [a, b] = mixGains(state.processing.mix, state.mixLaw);
    return [a, b * Math.pow(10, (stem.gainDb ?? 0) / 20)];
}
