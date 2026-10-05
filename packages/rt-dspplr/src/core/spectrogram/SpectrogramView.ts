import { mixGains } from '../controls';
import type { AudioPlayerCore, AudioPlayerState } from '../AudioPlayer';
import { SpectrogramAnalyzer, type SpectrogramData } from './SpectrogramAnalyzer';
import type { SpectralPyramid } from './protocol';
import { sampleSpectralPyramid } from './sample';
import { createPreparedSpectrogram } from './PreparedSpectrogramView';
import { applyDspToSpectrogram } from './dspPaint';
import { previewSettings } from '../effects/preview';
import { subscribeDspPreview, type DspPreview } from '../waveform/followWaveform';
import {
    DEFAULT_SPECTROGRAM_PALETTE,
    paintSpectrogram,
    type SpectrogramPalette,
    type SpectrogramColorMode,
} from './paint';

// ---------------------------------------------------------------------------
// createSpectrogram — a canvas that draws the player's clip as a spectrogram
// ---------------------------------------------------------------------------
//
// The canvas follows the player: a new clip or a stem B arriving recomputes
// it in a worker, a moved mix repaints it from what was computed, and a
// resize recomputes it at the new pixel size. Playhead, seeking and any
// other interaction belong to the interface around it.
//
// Off screen it costs nothing: the clip goes to the worker, and anything is
// computed, only once the canvas comes within 200 px of the viewport.
//
// Like the waveform, it is computed once per clip: a quick picture of the
// whole clip first, then the clip's spectral pyramid, after which every zoom,
// pan, resize and mix is drawn from the pyramid on the spot, and the worker
// holds nothing for it.

export interface SpectrogramOptions {
    /** 'single' (default): one colour from the mix position. 'dual': each cell coloured by its stem. */
    colorMode?: SpectrogramColorMode;
    palette?: Partial<SpectrogramPalette>;
    /** How far below the loudest bin is drawn as background. Default 66 dB. */
    floorDb?: number;
    /** Frequency axis, logarithmic. Default 30 Hz to 16 kHz. */
    minHz?: number;
    maxHz?: number;
    /**
     * FFT length, a power of two from 256 to 16384, or 'auto' (default). Auto
     * keeps the harmonics on a 2048-point FFT at every zoom. Zoomed in, the
     * bass below 300 Hz comes from 4096 points and the top above 3 kHz from
     * 1024 (512 when very close), so attacks sharpen without blurring the
     * harmonics; a whole long clip uses 4096 points.
     */
    fftSize?: number | 'auto';
}

export interface SpectrogramView {
    /** Show part of the clip, in seconds; null shows all of it. */
    setRange(range: { start: number; end: number } | null): void;
    setOptions(options: SpectrogramOptions): void;
    dispose(): void;
}

const MAX_PIXELS = 4096;
/** Rows of the pyramid: the frequency axis at up to ~2x a 200 px tall view. */
const PYRAMID_ROWS = 384;
/** How far below the loudest bin the pyramid keeps detail; a floorDb past it shows as background. */
const PYRAMID_RANGE_DB = 80;

function normalizeFftSize(size: number): number {
    const value = Math.round(size);
    const power = Math.round(Math.log2(Math.min(16384, Math.max(256, value))));
    return 2 ** power;
}

/** FFT lengths for a view, from how many samples each column of pixels spans. */
export function chooseFft(option: number | 'auto' | undefined, samplesPerColumn: number) {
    if (typeof option === 'number') return { fftSize: normalizeFftSize(option) };
    // A whole clip: one FFT length for every row.
    if (samplesPerColumn >= 512) return { fftSize: samplesPerColumn > 2048 ? 4096 : 2048 };
    const top = samplesPerColumn < 64 ? 512 : 1024;
    return {
        fftSize: 2048,
        bands: [
            { fftSize: 4096, fromHz: 0 },
            { fftSize: 2048, fromHz: 300 },
            { fftSize: top, fromHz: 3000 },
        ],
    };
}

type SpectrogramPlayer = Pick<AudioPlayerCore, 'getState' | 'subscribe'>
    & Partial<Pick<AudioPlayerCore, 'on' | 'setView' | 'getWindowAudio'>>;

/**
 * A spectrogram of the player's clip on `canvas`. A whole clip is analysed
 * in the worker; a prepared clip draws its precomputed overview at once and
 * refines zoomed-in views from its decoded segments. The view follows the
 * player from one kind of clip to the other.
 */
export function createSpectrogram(
    canvas: HTMLCanvasElement,
    player: SpectrogramPlayer,
    initialOptions: SpectrogramOptions = {},
): SpectrogramView {
    let options = initialOptions;
    let range: { start: number; end: number } | null = null;
    let kind = player.getState().sourceKind === 'segmented' ? 'segmented' : 'buffer';
    const make = () => (kind === 'segmented'
        ? createPreparedSpectrogram(canvas, player, options)
        : createBufferSpectrogram(canvas, player, options));
    let inner = make();
    const unsubscribe = player.subscribe(() => {
        const next = player.getState().sourceKind === 'segmented' ? 'segmented' : 'buffer';
        if (next === kind) return;
        kind = next;
        inner.dispose();
        inner = make();
        inner.setRange(range);
    });
    return {
        setRange(next) {
            range = next;
            inner.setRange(next);
        },
        setOptions(next) {
            options = next;
            inner.setOptions(next);
        },
        dispose() {
            unsubscribe();
            inner.dispose();
        },
    };
}

function createBufferSpectrogram(
    canvas: HTMLCanvasElement,
    player: Pick<AudioPlayerCore, 'getState' | 'subscribe'>,
    initialOptions: SpectrogramOptions = {},
): SpectrogramView {
    let options = initialOptions;
    let range: { start: number; end: number } | null = null;
    let data: SpectrogramData | null = null;
    let image: ImageData | null = null;
    let frame = 0;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    let last: { buffer: AudioBuffer | null; bufferB: AudioBuffer | null } = { buffer: null, bufferB: null };
    let lastMix = Number.NaN;
    let lastDsp = '';
    // The DSP preview (gain track) shared with the waveform: the spectrogram shows what is heard.
    let preview: DspPreview | null = null;
    const offPreview = subscribeDspPreview(player, (next) => {
        preview = next;
        schedulePaint();
    });
    const dspSlots = { data: null as SpectrogramData | null, whole: null as SpectrogramData | null, sampled: null as SpectrogramData | null };
    /** The data with high-pass, dynamics and output gain applied (see dspPaint.ts). */
    function dsp(d: SpectrogramData, slot: keyof typeof dspSlots, minHz: number, maxHz: number): SpectrogramData {
        const state = player.getState();
        const out = applyDspToSpectrogram(d, { state, preview, timelineRate: state.buffer?.sampleRate ?? 48000, minHz, maxHz }, dspSlots[slot]);
        if (out !== d) dspSlots[slot] = out;
        return out;
    }
    const axis = () => {
        const rate = player.getState().buffer?.sampleRate ?? 48000;
        return { minHz: options.minHz ?? 30, maxHz: Math.min(options.maxHz ?? 16000, rate / 2) };
    };
    // The part of the clip asked for last; the picture on hand may still be of another.
    let shown: { start: number; end: number } | null = null;
    let visible = typeof IntersectionObserver !== 'function';
    let staleBuffers = false;
    let stalePicture = false;
    const scratch = canvas.ownerDocument.createElement('canvas');
    // The whole clip, kept while zoomed: drawn under the close-up, it fills
    // whatever a zoom or a pan uncovers before the worker has answered.
    let whole: SpectrogramData | null = null;
    let wholeImage: ImageData | null = null;
    const wholeScratch = canvas.ownerDocument.createElement('canvas');
    let pyramid: SpectralPyramid | null = null;
    let pyramidAsked = false;
    let sampled: SpectrogramData | null = null;
    let sampledKey = '';

    function forgetPicture(): void {
        whole = null;
        wholeImage = null;
        pyramid = null;
        pyramidAsked = false;
        sampled = null;
        sampledKey = '';
    }

    const analyzer = new SpectrogramAnalyzer((next) => {
        data = next;
        image = null;
        const duration = player.getState().buffer?.duration ?? 0;
        if (next.start <= 1e-6 && Math.abs(next.end - duration) < 1e-6) {
            whole = next;
            wholeImage = null;
            // Built once stem B is in or not coming, so it is not built twice.
            if (!pyramid && !pyramidAsked && player.getState().statusB !== 'loading') {
                pyramidAsked = true;
                analyzer.buildPyramid({
                    rows: PYRAMID_ROWS,
                    minHz: options.minHz ?? 30,
                    maxHz: options.maxHz ?? 16000,
                    rangeDb: PYRAMID_RANGE_DB,
                });
            }
        }
        schedulePaint();
    }, (built) => {
        pyramid = built;
        sampledKey = '';
        schedulePaint();
    });

    function look() {
        return {
            colorMode: options.colorMode ?? 'single',
            palette: { ...DEFAULT_SPECTROGRAM_PALETTE, ...options.palette },
            floorDb: options.floorDb ?? 66,
        };
    }

    function request(): void {
        if (!visible) {
            stalePicture = true;
            return;
        }
        stalePicture = false;
        const state = player.getState();
        const duration = state.buffer?.duration ?? 0;
        if (!state.buffer || duration <= 0 || canvas.width === 0 || canvas.height === 0) return;
        const start = Math.max(0, range?.start ?? 0);
        const end = Math.min(duration, range?.end ?? duration);
        shown = { start: end > start ? start : 0, end: end > start ? end : duration };
        schedulePaint();
        // With the pyramid in hand there is nothing to ask the worker.
        if (pyramid) return;
        const span = shown.end - shown.start;
        const samplesPerColumn = (span * state.buffer.sampleRate) / canvas.width;
        // Zoomed, a quarter of the view more on each side, at the same density, so
        // a pan has the sharp picture ready before it is asked for.
        const zoomed = span < duration - 1e-6;
        const from = zoomed ? Math.max(0, shown.start - span / 4) : shown.start;
        const to = zoomed ? Math.min(duration, shown.end + span / 4) : shown.end;
        const columns = Math.min(MAX_PIXELS, Math.round((canvas.width * (to - from)) / span));
        analyzer.request({
            start: from,
            end: to,
            columns,
            rows: canvas.height,
            minHz: options.minHz ?? 30,
            maxHz: options.maxHz ?? 16000,
            ...chooseFft(options.fftSize, samplesPerColumn),
        });
    }

    function paint(): void {
        frame = 0;
        const context = canvas.getContext('2d');
        if (!context || disposed) return;
        const current = look();
        if (pyramid && player.getState().buffer) {
            paintFromPyramid(context, pyramid, current);
            return;
        }
        if (!data || !player.getState().buffer) {
            context.fillStyle = current.palette.background;
            context.fillRect(0, 0, canvas.width, canvas.height);
            return;
        }
        const state = player.getState();
        const gains = mixGains(state.processing.mix, state.mixLaw);
        const referenceOf = (d: SpectrogramData) => (state.mixLaw === 'separation' ? d.referenceSum : d.referenceMax);
        if (!image || image.width !== data.columns || image.height !== data.rows) {
            image = new ImageData(data.columns, data.rows);
        }
        paintSpectrogram(image, dsp(data, 'data', axis().minHz, axis().maxHz), gains, current, referenceOf(data));
        const want = shown ?? { start: data.start, end: data.end };
        const sameRange = Math.abs(want.start - data.start) < 1e-6 && Math.abs(want.end - data.end) < 1e-6;
        if (sameRange && image.width === canvas.width && image.height === canvas.height) {
            context.putImageData(image, 0, 0);
            return;
        }
        // Zoomed, or between a change and the worker's answer: the picture on hand
        // is cropped and stretched to the view, over the whole clip, so nothing
        // the view uncovers is ever empty.
        context.fillStyle = current.palette.background;
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.imageSmoothingEnabled = true;
        if (whole && whole !== data) {
            if (!wholeImage || wholeImage.width !== whole.columns || wholeImage.height !== whole.rows) {
                wholeImage = new ImageData(whole.columns, whole.rows);
            }
            paintSpectrogram(wholeImage, dsp(whole, 'whole', axis().minHz, axis().maxHz), gains, current, referenceOf(whole));
            drawPart(context, wholeScratch, wholeImage, whole, want);
        }
        drawPart(context, scratch, image, data, want);
    }

    function paintFromPyramid(
        context: CanvasRenderingContext2D,
        source: SpectralPyramid,
        current: ReturnType<typeof look>,
    ): void {
        const state = player.getState();
        const duration = state.buffer?.duration ?? 0;
        const want = shown ?? { start: 0, end: duration };
        const width = canvas.width;
        const key = `${want.start}|${want.end}|${width}`;
        if (key !== sampledKey || !sampled) {
            sampled = sampleSpectralPyramid(source, want.start, want.end, width, sampled);
            sampledKey = key;
        }
        if (!image || image.width !== width || image.height !== source.rows) image = new ImageData(width, source.rows);
        const reference = state.mixLaw === 'separation' ? sampled.referenceSum : sampled.referenceMax;
        paintSpectrogram(image, dsp(sampled, 'sampled', source.minHz, source.maxHz), mixGains(state.processing.mix, state.mixLaw), current, reference);
        scratch.width = width;
        scratch.height = source.rows;
        scratch.getContext('2d')?.putImageData(image, 0, 0);
        context.imageSmoothingEnabled = true;
        context.drawImage(scratch, 0, 0, width, source.rows, 0, 0, canvas.width, canvas.height);
    }

    /** Draw the part of `picture` (computed for `source`) that falls within `want`, across the canvas. */
    function drawPart(
        context: CanvasRenderingContext2D,
        board: HTMLCanvasElement,
        picture: ImageData,
        source: { start: number; end: number },
        want: { start: number; end: number },
    ): void {
        board.width = picture.width;
        board.height = picture.height;
        board.getContext('2d')?.putImageData(picture, 0, 0);
        const span = Math.max(1e-9, source.end - source.start);
        const from = Math.max(want.start, source.start);
        const to = Math.min(want.end, source.end);
        if (to <= from) return;
        const sx = ((from - source.start) / span) * picture.width;
        const sw = ((to - from) / span) * picture.width;
        const viewSpan = Math.max(1e-9, want.end - want.start);
        const dx = ((from - want.start) / viewSpan) * canvas.width;
        const dw = ((to - from) / viewSpan) * canvas.width;
        context.drawImage(board, sx, 0, Math.max(1e-3, sw), picture.height, dx, 0, dw, canvas.height);
    }

    function schedulePaint(): void {
        if (frame || disposed) return;
        const view = canvas.ownerDocument.defaultView;
        frame = view ? view.requestAnimationFrame(paint) : 0;
        if (!view) paint();
    }

    function resize(): void {
        const ratio = canvas.ownerDocument.defaultView?.devicePixelRatio ?? 1;
        const width = Math.min(MAX_PIXELS, Math.max(1, Math.round(canvas.clientWidth * ratio)));
        const height = Math.min(MAX_PIXELS, Math.max(1, Math.round(canvas.clientHeight * ratio)));
        if (width === canvas.width && height === canvas.height) return;
        canvas.width = width;
        canvas.height = height;
        schedulePaint();
        request();
    }

    function onState(state: AudioPlayerState): void {
        if (state.buffer !== last.buffer || state.bufferB !== last.bufferB) {
            // While the next clip loads the buffer is briefly null: keep the old picture.
            if (state.buffer) {
                // Another clip, or stem B arriving: the picture is built again with it.
                forgetPicture();
                last = { buffer: state.buffer, bufferB: state.bufferB };
                staleBuffers = true;
                sync();
            }
        }
        const dspKey = previewSettings(state).key;
        if (dspKey !== lastDsp) {
            lastDsp = dspKey;
            schedulePaint();
        }
        if (state.processing.mix !== lastMix) {
            lastMix = state.processing.mix;
            schedulePaint();
        }
    }

    /** Hand the worker what changed while the canvas was out of sight. */
    function sync(): void {
        if (!visible) return;
        if (staleBuffers) {
            staleBuffers = false;
            analyzer.setBuffers(last.buffer, last.bufferB);
            request();
        } else if (stalePicture) {
            request();
        }
    }

    const unsubscribe = player.subscribe(() => onState(player.getState()));
    const sight = typeof IntersectionObserver === 'function'
        ? new IntersectionObserver((entries) => {
            visible = entries.some((entry) => entry.isIntersecting);
            sync();
        }, { rootMargin: '200px' })
        : null;
    sight?.observe(canvas);
    const observer = typeof ResizeObserver === 'function'
        ? new ResizeObserver(() => {
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => { resizeTimer = null; resize(); }, 40);
        })
        : null;
    observer?.observe(canvas);
    resize();
    onState(player.getState());
    schedulePaint();

    return {
        setRange(next) {
            range = next ? { start: next.start, end: next.end } : null;
            request();
        },
        setOptions(next) {
            const recompute = next.minHz !== options.minHz || next.maxHz !== options.maxHz
                || next.fftSize !== options.fftSize;
            options = next;
            if (recompute) {
                // The worker let go of the audio once the pyramid was built: hand it over again.
                forgetPicture();
                staleBuffers = last.buffer !== null;
                sync();
            }
            schedulePaint();
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            unsubscribe();
            observer?.disconnect();
            sight?.disconnect();
            if (resizeTimer) clearTimeout(resizeTimer);
            if (frame) canvas.ownerDocument.defaultView?.cancelAnimationFrame(frame);
            offPreview();
            analyzer.dispose();
        },
    };
}
