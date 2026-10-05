import type { AudioPlayerCore } from '../AudioPlayer';

/**
 * What the timeline needs from a player: the classic AudioPlayerCore, or any
 * player with the same transport surface (the stream player).
 */
export type TimelinePlayer = Pick<AudioPlayerCore, 'getState' | 'subscribe' | 'getCurrentTime' | 'seek' | 'setLoop'>
    & Partial<Pick<AudioPlayerCore, 'on' | 'setView' | 'getWindowAudio'>>;
import type { LoopRange } from '../engine';
import { createSpectrogram, type SpectrogramOptions, type SpectrogramView } from '../spectrogram/SpectrogramView';
import type { WaveformPeakPyramid } from '../waveform/pyramid';
import { clamp, formatClock, spokenTime } from './format';
import { computeTicks } from './ruler';
import { barCountFor, computeBarHeights, drawBars } from './waveBars';
import { drawEnvelope } from './waveEnvelope';

// ---------------------------------------------------------------------------
// TimelineCore — the waveform (or the spectrogram) as a seek bar, in plain DOM.
//
//   click            seek (outside an active loop: also clears the loop)
//   tap              seek; a finger that swipes scrolls the page instead
//   drag             select a loop (a finger: after moving sideways)
//   loop handles     drag or arrow keys to move an edge
//   Ctrl/Cmd + wheel zoom around the pointer, in proportion to the wheel's
//                    travel, down to a 0.5 s window (wheelZoom 'plain': the
//                    wheel alone). Only a change of zoom takes the event from
//                    the page, so at 1x the page keeps scrolling.
//   Shift + wheel /  pan while zoomed; the overview strip under the ruler
//   horizontal wheel can also be dragged or clicked
//   keyboard         ←/→ ±1 s, PageUp/PageDown ±5 s, Home/End,
//                    + / − zoom, 0 resets zoom, Esc clears the loop
//
// With `zoomable` off there is no zoom or pan by any means (wheel, keys,
// overview strip): the view is the whole clip and the wheel scrolls the
// page. Seeking and loops work as before.
//
// It is driven from outside: update() hands it the clip's facts, setTime()
// moves the playhead. createTimeline() wires it to a player; the React card
// drives it itself, beside its own time readout.
// ---------------------------------------------------------------------------

const MIN_LOOP_SECONDS = 0.05;
const DRAG_THRESHOLD_PX = 5;
/** A finger wobbles more than a mouse before it means to drag. */
const TOUCH_DRAG_THRESHOLD_PX = 8;
/** Smallest visible window when fully zoomed in (seconds). */
const MIN_VISIBLE_WINDOW = 0.5;
/** Wheel travel that doubles (or halves) the zoom: three notches of a mouse wheel. */
const WHEEL_PIXELS_PER_OCTAVE = 300;

/** A wheel's delta in pixels, whatever unit the event reports it in. */
function wheelPixels(delta: number, deltaMode: number, pageHeight: number): number {
    if (deltaMode === 1) return delta * 16;
    if (deltaMode === 2) return delta * pageHeight;
    return delta;
}

/** Keep the pointer's events on `el` while it is held; a synthetic pointer has no capture to give. */
function capture(el: Element, pointerId: number): void {
    try {
        el.setPointerCapture?.(pointerId);
    } catch {
        // no-op
    }
}

export type TimelineDisplay = 'waveform' | 'spectrogram' | 'both';

export interface TimelineCoreInput {
    hasAudio: boolean;
    duration: number;
    loop: LoopRange | null;
    pyramid: WaveformPeakPyramid | null;
    loading: boolean;
    /** Accessible name of the seek slider. */
    label: string;
    /** Text shown in the track before a clip. */
    emptyText: string;
    display: TimelineDisplay;
    waveformStyle: 'envelope' | 'bars';
    spectrogram?: SpectrogramOptions;
    wheelZoom: 'plain' | 'modifier';
    zoomable: boolean;
    ruler: boolean;
    /**
     * Told the visible range (seconds) and the track's width (CSS px) whenever
     * either changes. The stream player uses it to refine deep zooms.
     */
    onView?: (startSeconds: number, endSeconds: number, widthPx: number) => void;
}

type Drag =
    | { kind: 'track'; startX: number; anchor: number; selecting: boolean; pointerId: number; touch: boolean }
    | { kind: 'edge'; edge: 'start' | 'end'; pointerId: number }
    | { kind: 'overview'; grab: number; pointerId: number };

function readVar(el: Element, name: string, fallback: string): string {
    const view = el.ownerDocument.defaultView;
    if (!view) return fallback;
    return view.getComputedStyle(el).getPropertyValue(name).trim() || fallback;
}

/** Make `parent`'s children exactly the elements given, in that order (false skips one). */
function arrange(parent: Element, wanted: Array<Element | false>): void {
    let cursor: ChildNode | null = parent.firstChild;
    for (const el of wanted) {
        if (!el) continue;
        if (el === cursor) cursor = cursor.nextSibling;
        else parent.insertBefore(el, cursor);
    }
    while (cursor) {
        const next: ChildNode | null = cursor.nextSibling;
        cursor.remove();
        cursor = next;
    }
}

export class TimelineCore {
    /** The element given, made the timeline's `.rtd-wavebox` root; its owner removes it. */
    readonly element: HTMLElement;
    /** Shown in the track before a clip, holding `emptyText`. */
    private readonly _empty: HTMLDivElement;

    private readonly _core: TimelinePlayer;
    private readonly _onUserSeek: (seconds: number) => void;
    private _input: TimelineCoreInput;

    private readonly _frame: HTMLDivElement;
    private readonly _track: HTMLDivElement;
    private readonly _spectroCanvas: HTMLCanvasElement;
    private readonly _baseCanvas: HTMLCanvasElement;
    private readonly _playedLayer: HTMLDivElement;
    private readonly _playedCanvas: HTMLCanvasElement;
    private readonly _band: HTMLDivElement;
    private readonly _playhead: HTMLDivElement;
    private readonly _handles: Record<'start' | 'end', HTMLDivElement>;
    private readonly _hover: HTMLDivElement;
    private readonly _hoverTip: HTMLSpanElement;
    private readonly _zoomReset: HTMLButtonElement;
    private readonly _ruler: HTMLDivElement;
    private readonly _overview: HTMLDivElement;
    private readonly _overviewLoop: HTMLSpanElement;
    private readonly _overviewWindow: HTMLSpanElement;
    private readonly _overviewHead: HTMLSpanElement;

    private _spectro: SpectrogramView | null = null;
    private _resize: ResizeObserver | null = null;
    private _size = { w: 0, h: 0 };
    private _zoom = 1;
    private _offset = 0;
    private _hoverX: number | null = null;
    private _draft: LoopRange | null = null;
    private _drag: Drag | null = null;
    private _time = 0;
    private _ticksKey = '';
    private _handlesShown = { start: false, end: false };
    private _ariaNow = '';
    private _disposed = false;
    private readonly _off: Array<() => void> = [];

    constructor(element: HTMLElement, core: TimelinePlayer, input: TimelineCoreInput, onUserSeek: (seconds: number) => void = () => {}) {
        this._core = core;
        this._input = input;
        this._onUserSeek = onUserSeek;
        const doc = element.ownerDocument;
        const on = <E extends Event>(target: EventTarget, type: string, handler: (event: E) => void, options?: AddEventListenerOptions) => {
            const listener = handler as EventListener;
            target.addEventListener(type, listener, options);
            this._off.push(() => target.removeEventListener(type, listener, options));
        };
        const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] => {
            const el = doc.createElement(tag);
            el.className = className;
            return el;
        };

        this.element = element;
        element.classList.add('rtd-wavebox');
        this._frame = make('div', 'rtd-scrub');
        this._track = make('div', 'rtd-scrub-track');
        this._track.setAttribute('role', 'slider');
        this._track.setAttribute('aria-valuemin', '0');
        this._spectroCanvas = make('canvas', 'rtd-wave rtd-spectrogram');
        this._spectroCanvas.setAttribute('aria-hidden', 'true');
        this._baseCanvas = make('canvas', 'rtd-wave');
        this._baseCanvas.setAttribute('aria-hidden', 'true');
        this._playedLayer = make('div', 'rtd-wave-played');
        this._playedLayer.setAttribute('aria-hidden', 'true');
        this._playedCanvas = make('canvas', 'rtd-wave');
        this._playedLayer.append(this._playedCanvas);
        this._empty = make('div', 'rtd-scrub-empty');
        this._band = make('div', 'rtd-loop-band');
        this._band.setAttribute('aria-hidden', 'true');
        this._playhead = make('div', 'rtd-playhead');
        this._playhead.setAttribute('aria-hidden', 'true');
        this._track.append(this._playhead);

        const handle = (edge: 'start' | 'end') => {
            const el = make('div', 'rtd-loop-handle');
            el.dataset.edge = edge;
            el.setAttribute('role', 'slider');
            el.tabIndex = 0;
            el.setAttribute('aria-label', edge === 'start' ? 'Loop start' : 'Loop end');
            el.append(make('span', 'rtd-loop-grip'));
            on<PointerEvent>(el, 'pointerdown', (event) => this._onEdgePointerDown(edge, event));
            on<KeyboardEvent>(el, 'keydown', (event) => this._onEdgeKeyDown(edge, event));
            return el;
        };
        this._handles = { start: handle('start'), end: handle('end') };

        this._hover = make('div', 'rtd-hover');
        this._hover.setAttribute('aria-hidden', 'true');
        this._hoverTip = make('span', 'rtd-hover-tip');
        this._hover.append(this._hoverTip);
        this._zoomReset = make('button', 'rtd-zoom-reset');
        this._zoomReset.type = 'button';
        this._zoomReset.title = 'Show the whole clip (0)';
        on(this._zoomReset, 'click', () => this._zoomTo(1, 0));
        this._frame.append(this._track);
        this.element.append(this._frame);

        this._ruler = make('div', 'rtd-ruler');
        this._ruler.setAttribute('aria-hidden', 'true');
        this._overview = make('div', 'rtd-overview');
        this._overview.setAttribute('aria-hidden', 'true');
        this._overviewLoop = make('span', 'rtd-overview-loop');
        this._overviewWindow = make('span', 'rtd-overview-window');
        this._overviewHead = make('span', 'rtd-overview-head');
        this._overview.append(this._overviewWindow, this._overviewHead);
        on<PointerEvent>(this._overview, 'pointerdown', (event) => this._onOverviewPointerDown(event));

        on<PointerEvent>(this._track, 'pointerdown', (event) => this._onTrackPointerDown(event));
        on<KeyboardEvent>(this._track, 'keydown', (event) => this._onTrackKeyDown(event));
        on<PointerEvent>(element, 'pointermove', (event) => this._onPointerMove(event));
        on<PointerEvent>(element, 'pointerup', (event) => this._endDrag(event));
        on<PointerEvent>(element, 'pointercancel', (event) => this._endDrag(event));
        on(element, 'pointerleave', () => {
            this._hoverX = null;
            this._renderHover();
        });
        on(element, 'wheel', this._onWheel, { passive: false });

        this._applyDisplay();
        this._applyEmptyText();

        const win = doc.defaultView;
        this._size = { w: this._track.clientWidth, h: this._track.clientHeight };
        if (win && typeof win.ResizeObserver === 'function') {
            this._resize = new win.ResizeObserver(() => {
                const w = this._track.clientWidth;
                const h = this._track.clientHeight;
                if (w === this._size.w && h === this._size.h) return;
                this._size = { w, h };
                this._notifyView();
                this._draw();
                this._render();
            });
            this._resize.observe(this._track);
        }
        this._draw();
        this._render();
    }

    // ---- driven from outside ------------------------------------------------------

    update(patch: Partial<TimelineCoreInput>): void {
        if (this._disposed) return;
        const previous = this._input;
        const spectrogramChanged = 'spectrogram' in patch
            && JSON.stringify(patch.spectrogram ?? {}) !== JSON.stringify(previous.spectrogram ?? {});
        const keys = Object.keys(patch) as Array<keyof TimelineCoreInput>;
        if (!spectrogramChanged && keys.every((key) => key === 'spectrogram' || patch[key] === previous[key])) return;

        const next = { ...previous, ...patch };
        this._input = next;
        if (next.display !== previous.display) this._applyDisplay();
        if (next.emptyText !== previous.emptyText) this._applyEmptyText();
        if (spectrogramChanged) this._spectro?.setOptions(next.spectrogram ?? {});
        let redraw = next.pyramid !== previous.pyramid || next.waveformStyle !== previous.waveformStyle;
        if (!next.zoomable && this._zoom > 1) {
            this._zoom = 1;
            this._offset = 0;
            redraw = true;
        }
        if (redraw || next.duration !== previous.duration) this._applyRange();
        if (redraw) this._draw();
        this._render();
    }

    /** Back to the whole clip, without a loop being drawn: a new clip or a restart. */
    resetView(): void {
        this._zoom = 1;
        this._offset = 0;
        this._draft = null;
        this._applyRange();
        this._draw();
        this._render();
    }

    /** Move the playhead. With `following`, a zoomed view pans to keep it in sight. */
    setTime(seconds: number, following: boolean): void {
        if (this._disposed) return;
        this._time = seconds;
        const duration = this._input.duration;
        if (following && this._zoom > 1 && duration > 0) {
            const f = this._fraction(seconds);
            if (f < 0 || f > 1) {
                this._panTo(seconds / duration - this._viewSize * 0.1);
            }
        }
        this._paintTime();
    }

    /** Redraw with the current colours, after a theme change. */
    refreshColors(): void {
        this._draw();
    }

    dispose(): void {
        if (this._disposed) return;
        this._disposed = true;
        this._resize?.disconnect();
        this._spectro?.dispose();
        this._spectro = null;
        for (const off of this._off.splice(0)) off();
        this.element.replaceChildren();
        this.element.classList.remove('rtd-wavebox');
    }

    // ---- geometry ---------------------------------------------------------------------

    private get _viewSize(): number {
        return 1 / this._zoom;
    }

    private get _canInteract(): boolean {
        return this._input.hasAudio && this._input.duration > 0;
    }

    private _fraction(t: number): number {
        const duration = this._input.duration;
        if (duration <= 0) return 0;
        return (t / duration - this._offset) / this._viewSize;
    }

    private _timeAtClientX(clientX: number): number {
        const duration = this._input.duration;
        if (duration <= 0) return 0;
        const rect = this._track.getBoundingClientRect();
        const f = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
        return clamp((this._offset + f * this._viewSize) * duration, 0, duration);
    }

    // ---- what is in the track -----------------------------------------------------------

    private _applyDisplay(): void {
        const { display } = this._input;
        const spectrogram = display !== 'waveform';
        this._frame.dataset.display = display;
        this._arrangeTrack();
        if (spectrogram && !this._spectro) {
            this._spectro = createSpectrogram(this._spectroCanvas, this._core, this._input.spectrogram);
            this._applyRange();
        } else if (!spectrogram && this._spectro) {
            this._spectro.dispose();
            this._spectro = null;
        }
        this._draw();
    }

    private _bandShown = false;

    private _arrangeTrack(): void {
        const { display, hasAudio } = this._input;
        arrange(this._track, [
            display !== 'waveform' && this._spectroCanvas,
            display !== 'spectrogram' && this._baseCanvas,
            display !== 'spectrogram' && this._playedLayer,
            !hasAudio && this._empty,
            this._bandShown && this._band,
            this._playhead,
        ]);
    }

    private _applyEmptyText(): void {
        this._empty.textContent = this._input.emptyText;
    }

    private _notifyView(): void {
        const { duration, onView } = this._input;
        if (duration <= 0) return;
        const start = this._offset * duration;
        const end = (this._offset + this._viewSize) * duration;
        // A prepared clip decodes the segments of short views for the exact previews.
        this._core.setView?.(start, end);
        onView?.(start, end, this._size.w);
    }

    private _applyRange(): void {
        this._notifyView();
        const duration = this._input.duration;
        this._spectro?.setRange(this._zoom > 1 && duration > 0
            ? { start: this._offset * duration, end: (this._offset + this._viewSize) * duration }
            : null);
    }

    // ---- draw ---------------------------------------------------------------------------

    private _draw(): void {
        const { display, pyramid, waveformStyle } = this._input;
        if (display === 'spectrogram' || this._disposed) return;
        const { w, h } = this._size;
        if (w <= 0 || h <= 0) return;
        const overlay = display === 'both';
        const frame = this._frame;
        const total = pyramid?.totalSamples ?? 0;
        const start = clamp(Math.floor(this._offset * total), 0, total);
        const end = clamp(Math.ceil((this._offset + this._viewSize) * total), start + 1, Math.max(start + 1, total));
        // Over a spectrogram the waveform is an outline in its own two colours, light
        // enough to read the picture through.
        const color = (name: string, fallback: string, overlayName: string, overlayFallback: string) => (overlay
            ? readVar(frame, overlayName, overlayFallback)
            : readVar(frame, name, fallback));
        const wave = color('--rtd-wave', '#c9ced6', '--rtd-overlay-wave', 'rgba(255, 255, 255, 0.22)');
        const waveRms = color('--rtd-wave-rms', '#a7aeb8', '--rtd-overlay-wave-rms', 'rgba(255, 255, 255, 0.34)');
        const played = color('--rtd-wave-played', '#86c3bb', '--rtd-overlay-played', 'rgba(255, 255, 255, 0.42)');
        const playedRms = color('--rtd-wave-played-rms', '#0f766e', '--rtd-overlay-played-rms', 'rgba(255, 255, 255, 0.6)');
        if (waveformStyle === 'bars') {
            const count = barCountFor(w);
            const heights = total > 0 ? computeBarHeights(pyramid, start, end, count) : new Float32Array(0);
            drawBars(this._baseCanvas, heights, w, h, wave);
            drawBars(this._playedCanvas, heights, w, h, overlay ? played : readVar(frame, '--rtd-wave-played', '#0f766e'));
            return;
        }
        const source = total > 0 ? pyramid : null;
        drawEnvelope(this._baseCanvas, source, start, end, w, h, wave, waveRms);
        drawEnvelope(this._playedCanvas, source, start, end, w, h, played, playedRms);
    }

    // ---- render -------------------------------------------------------------------------

    private _render(): void {
        if (this._disposed) return;
        const { duration, loading, label, ruler, zoomable } = this._input;
        const canInteract = this._canInteract;
        const frame = this._frame;
        if (loading) frame.dataset.loading = ''; else delete frame.dataset.loading;
        if (this._zoom > 1) frame.dataset.zoomed = ''; else delete frame.dataset.zoomed;

        const track = this._track;
        track.tabIndex = canInteract ? 0 : -1;
        track.setAttribute('aria-label', label);
        if (canInteract) track.removeAttribute('aria-disabled'); else track.setAttribute('aria-disabled', 'true');
        track.setAttribute('aria-valuemax', String(Math.round(duration * 10) / 10));
        this._ariaNow = '';
        this._paintTime();

        // The loop: the band in the track, a handle on each visible edge.
        const shown = this._draft ?? this._input.loop;
        const bandStart = shown ? clamp(this._fraction(shown.start), 0, 1) : 0;
        const bandEnd = shown ? clamp(this._fraction(shown.end), 0, 1) : 0;
        this._bandShown = !!shown && bandEnd > bandStart;
        if (shown) {
            this._band.style.left = `${bandStart * 100}%`;
            this._band.style.width = `${(bandEnd - bandStart) * 100}%`;
        }
        this._arrangeTrack();
        for (const edge of ['start', 'end'] as const) {
            const el = this._handles[edge];
            const value = shown ? (edge === 'start' ? shown.start : shown.end) : 0;
            const f = shown ? this._fraction(value) : -1;
            const visible = !!shown && f >= 0 && f <= 1;
            this._handlesShown[edge] = visible;
            if (visible && shown) {
                el.style.left = `${(edge === 'start' ? bandStart : bandEnd) * 100}%`;
                el.setAttribute('aria-valuemin', String(edge === 'start' ? 0 : Math.round(shown.start * 100) / 100));
                el.setAttribute('aria-valuemax', String(edge === 'start' ? Math.round(shown.end * 100) / 100 : Math.round(duration * 100) / 100));
                el.setAttribute('aria-valuenow', String(Math.round(value * 100) / 100));
                el.setAttribute('aria-valuetext', spokenTime(value));
            }
        }

        this._renderHover();
        if (this._zoom > 1) this._zoomReset.textContent = `${this._zoom < 10 ? this._zoom.toFixed(1) : Math.round(this._zoom)}× · reset`;

        // Ruler and overview under the track.
        arrange(this.element, [frame, ruler && this._ruler, ruler && zoomable && this._overview]);
        if (ruler) {
            const key = canInteract ? `${duration}|${this._offset}|${this._viewSize}` : '';
            if (key !== this._ticksKey) {
                this._ticksKey = key;
                const doc = this._ruler.ownerDocument;
                const ticks = canInteract ? computeTicks(duration, this._offset, this._viewSize) : [];
                this._ruler.replaceChildren(...ticks.map((tick) => {
                    const el = doc.createElement('span');
                    el.className = 'rtd-tick';
                    if (tick.major) el.dataset.major = '';
                    el.style.left = `${tick.left}%`;
                    if (tick.major) {
                        const text = doc.createElement('span');
                        text.className = 'rtd-tick-label';
                        text.textContent = tick.label;
                        el.append(text);
                    }
                    return el;
                }));
            }
        }
        if (ruler && zoomable) {
            if (this._zoom > 1) this._overview.dataset.active = ''; else delete this._overview.dataset.active;
            const loop = shown && duration > 0 ? shown : null;
            arrange(this._overview, [!!loop && this._overviewLoop, this._overviewWindow, this._overviewHead]);
            if (loop) {
                this._overviewLoop.style.left = `${(loop.start / duration) * 100}%`;
                this._overviewLoop.style.width = `${((loop.end - loop.start) / duration) * 100}%`;
            }
            this._overviewWindow.style.left = `${this._offset * 100}%`;
            this._overviewWindow.style.width = `${this._viewSize * 100}%`;
        }
    }

    private _renderHover(): void {
        const { duration } = this._input;
        const x = this._hoverX;
        const time = x !== null && this._size.w > 0 && duration > 0
            ? clamp((this._offset + (x / this._size.w) * this._viewSize) * duration, 0, duration)
            : null;
        arrange(this._frame, [
            this._track,
            this._handlesShown.start && this._handles.start,
            this._handlesShown.end && this._handles.end,
            time !== null && this._hover,
            this._zoom > 1 && this._zoomReset,
        ]);
        if (time !== null && x !== null) {
            this._hover.style.left = `${x}px`;
            this._hoverTip.textContent = formatClock(time, true);
        }
    }

    /** The playhead, the played part, the overview's head and the slider's value. */
    private _paintTime(): void {
        const t = this._time;
        const duration = this._input.duration;
        const f = this._fraction(t);
        const clipped = clamp(f, 0, 1);
        this._playedLayer.style.clipPath = `inset(0 ${((1 - clipped) * 100).toFixed(3)}% 0 0)`;
        this._playhead.style.left = `${(clipped * 100).toFixed(3)}%`;
        this._playhead.style.visibility = f >= 0 && f <= 1 && duration > 0 ? 'visible' : 'hidden';
        this._overviewHead.style.left = `${duration > 0 ? clamp(t / duration, 0, 1) * 100 : 0}%`;
        const now = Math.min(duration, t);
        const ariaNow = String(Math.round(now * 10) / 10);
        if (ariaNow !== this._ariaNow) {
            this._ariaNow = ariaNow;
            this._track.setAttribute('aria-valuenow', ariaNow);
            this._track.setAttribute('aria-valuetext', `${spokenTime(now)} of ${spokenTime(duration)}`);
        }
    }

    // ---- zoom ---------------------------------------------------------------------------

    private _clampZoom(zoom: number): number {
        return clamp(zoom, 1, Math.max(1, this._input.duration / MIN_VISIBLE_WINDOW));
    }

    private _zoomTo(targetZoom: number, anchorFraction: number): void {
        const duration = this._input.duration;
        if (duration <= 0) return;
        const nextZoom = this._clampZoom(targetZoom);
        const nextSize = 1 / nextZoom;
        const anchor = this._offset + anchorFraction * this._viewSize;
        this._zoom = nextZoom;
        this._offset = clamp(anchor - anchorFraction * nextSize, 0, 1 - nextSize);
        this._viewChanged();
    }

    private _panTo(nextOffset: number): void {
        this._offset = clamp(nextOffset, 0, 1 - this._viewSize);
        this._viewChanged();
    }

    private _viewChanged(): void {
        this._applyRange();
        this._draw();
        this._render();
    }

    private readonly _onWheel = (event: WheelEvent): void => {
        // Without zoom the wheel (and a trackpad pinch, which arrives as Ctrl + wheel) stays with the page.
        if (!this._input.zoomable || this._input.duration <= 0) return;
        const rect = this._frame.getBoundingClientRect();
        const pageHeight = this.element.ownerDocument.defaultView?.innerHeight ?? 800;
        const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY);
        if (horizontal || event.shiftKey) {
            // Pan (Shift + wheel arrives as deltaX in some browsers).
            if (this._zoom <= 1) return;
            event.preventDefault();
            const delta = wheelPixels(horizontal ? event.deltaX : event.deltaY, event.deltaMode, pageHeight);
            this._panTo(this._offset + (delta / Math.max(1, rect.width)) * this._viewSize);
            return;
        }
        if (event.deltaY === 0) return;
        if (this._input.wheelZoom === 'modifier' && !event.ctrlKey && !event.metaKey) return;
        // In proportion to the wheel's travel: a notch is a small step, a trackpad's
        // fine deltas finer ones. The event is taken from the page only when the zoom
        // changes, so scrolling down at 1x, or up at the closest zoom, scrolls the page.
        const pixels = wheelPixels(event.deltaY, event.deltaMode, pageHeight);
        const next = this._clampZoom(this._zoom * 2 ** (-pixels / WHEEL_PIXELS_PER_OCTAVE));
        if (Math.abs(next - this._zoom) < 1e-6) return;
        event.preventDefault();
        const f = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
        this._zoomTo(next, f);
    };

    // ---- seeking and loops ----------------------------------------------------------------

    private _seekTo(t: number): void {
        const target = clamp(t, 0, this._input.duration);
        this._time = target;
        this._paintTime();
        this._onUserSeek(target);
        void this._core.seek(target);
    }

    private _commitLoop(range: LoopRange | null): void {
        this._core.setLoop(range && range.end - range.start >= MIN_LOOP_SECONDS ? range : null);
    }

    private _setDraft(range: LoopRange | null): void {
        this._draft = range;
        this._render();
    }

    /** Seek to `t`; a click outside the active loop also clears it. */
    private _seekAt(t: number): void {
        const active = this._core.getState().loop;
        if (active && (t < active.start || t > active.end)) {
            this._core.setLoop(null);
        }
        this._seekTo(t);
    }

    private _onTrackPointerDown(event: PointerEvent): void {
        if (!this._canInteract || event.button !== 0) return;
        event.preventDefault();
        capture(this._track, event.pointerId);
        this._track.focus({ preventScroll: true });
        const t = this._timeAtClientX(event.clientX);
        const touch = event.pointerType === 'touch';
        this._drag = { kind: 'track', startX: event.clientX, anchor: t, selecting: false, pointerId: event.pointerId, touch };
        // A mouse seeks on the press. A finger decides on release: a tap seeks, a
        // vertical swipe is the page's scroll (the browser cancels the pointer), a
        // sideways drag selects a loop.
        if (!touch) this._seekAt(t);
    }

    private _onPointerMove(event: PointerEvent): void {
        if (this._canInteract) {
            const rect = this._frame.getBoundingClientRect();
            this._hoverX = clamp(event.clientX - rect.left, 0, rect.width);
            this._renderHover();
        }
        const drag = this._drag;
        if (!drag || drag.pointerId !== event.pointerId) return;
        if (drag.kind === 'overview') {
            this._panTo(this._overviewFraction(event.clientX) - drag.grab);
            return;
        }
        const t = this._timeAtClientX(event.clientX);
        if (drag.kind === 'track') {
            const threshold = drag.touch ? TOUCH_DRAG_THRESHOLD_PX : DRAG_THRESHOLD_PX;
            if (!drag.selecting && Math.abs(event.clientX - drag.startX) < threshold) return;
            drag.selecting = true;
            const range = { start: Math.min(drag.anchor, t), end: Math.max(drag.anchor, t) };
            this._setDraft(range);
            this._commitLoop(range);
            return;
        }
        const current = this._draft ?? this._core.getState().loop;
        if (!current) return;
        const range = drag.edge === 'start'
            ? { start: clamp(t, 0, current.end - MIN_LOOP_SECONDS), end: current.end }
            : { start: current.start, end: clamp(t, current.start + MIN_LOOP_SECONDS, this._input.duration) };
        this._setDraft(range);
        this._commitLoop(range);
    }

    private _endDrag(event: PointerEvent): void {
        const drag = this._drag;
        if (!drag || drag.pointerId !== event.pointerId) return;
        this._drag = null;
        const range = this._draft;
        this._setDraft(null);
        if (drag.kind !== 'track') return;
        if (drag.selecting && range) {
            if (range.end - range.start < MIN_LOOP_SECONDS) {
                this._core.setLoop(null);
            } else {
                this._seekTo(range.start);
            }
        } else if (drag.touch && event.type !== 'pointercancel') {
            this._seekAt(drag.anchor);
        }
    }

    private _overviewFraction(clientX: number): number {
        const rect = this._overview.getBoundingClientRect();
        return clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    }

    private _onOverviewPointerDown(event: PointerEvent): void {
        if (!this._canInteract || event.button !== 0 || this._zoom <= 1) return;
        event.preventDefault();
        capture(this._overview, event.pointerId);
        const f = this._overviewFraction(event.clientX);
        // Grabbing the window keeps the grab point; clicking elsewhere centres it there.
        const inside = f >= this._offset && f <= this._offset + this._viewSize;
        const grab = inside ? f - this._offset : this._viewSize / 2;
        if (!inside) this._panTo(f - grab);
        this._drag = { kind: 'overview', grab, pointerId: event.pointerId };
    }

    private _onEdgePointerDown(edge: 'start' | 'end', event: PointerEvent): void {
        if (!this._canInteract || event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        const el = this._handles[edge];
        capture(el, event.pointerId);
        el.focus({ preventScroll: true });
        this._drag = { kind: 'edge', edge, pointerId: event.pointerId };
    }

    // ---- keyboard -------------------------------------------------------------------------

    private _onTrackKeyDown(event: KeyboardEvent): void {
        if (!this._canInteract) return;
        if (!this._input.zoomable && ['+', '=', '-', '_', '0'].includes(event.key)) return;
        const now = this._core.getCurrentTime();
        const duration = this._input.duration;
        let target: number | null = null;
        switch (event.key) {
            case 'ArrowLeft':
            case 'ArrowDown': target = now - 1; break;
            case 'ArrowRight':
            case 'ArrowUp': target = now + 1; break;
            case 'PageDown': target = now - 5; break;
            case 'PageUp': target = now + 5; break;
            case 'Home': target = 0; break;
            case 'End': target = duration; break;
            case '+':
            case '=': event.preventDefault(); this._zoomTo(this._zoom * 1.5, clamp(this._fraction(now), 0, 1)); return;
            case '-':
            case '_': event.preventDefault(); this._zoomTo(this._zoom / 1.5, clamp(this._fraction(now), 0, 1)); return;
            case '0': event.preventDefault(); this._zoomTo(1, 0); return;
            case 'Escape':
                if (this._core.getState().loop) {
                    event.preventDefault();
                    this._core.setLoop(null);
                }
                return;
            default: return;
        }
        event.preventDefault();
        this._seekTo(target);
    }

    private _onEdgeKeyDown(edge: 'start' | 'end', event: KeyboardEvent): void {
        const current = this._core.getState().loop;
        if (!current) return;
        const duration = this._input.duration;
        const small = event.shiftKey ? 1 : 0.1;
        let delta = 0;
        let absolute: number | null = null;
        switch (event.key) {
            case 'ArrowLeft':
            case 'ArrowDown': delta = -small; break;
            case 'ArrowRight':
            case 'ArrowUp': delta = small; break;
            case 'PageDown': delta = -1; break;
            case 'PageUp': delta = 1; break;
            case 'Home': absolute = edge === 'start' ? 0 : current.start + MIN_LOOP_SECONDS; break;
            case 'End': absolute = edge === 'start' ? current.end - MIN_LOOP_SECONDS : duration; break;
            case 'Escape':
            case 'Delete':
            case 'Backspace':
                event.preventDefault();
                this._core.setLoop(null);
                this._track.focus();
                return;
            default: return;
        }
        event.preventDefault();
        const base = edge === 'start' ? current.start : current.end;
        const value = absolute ?? base + delta;
        this._commitLoop(edge === 'start'
            ? { start: clamp(value, 0, current.end - MIN_LOOP_SECONDS), end: current.end }
            : { start: current.start, end: clamp(value, current.start + MIN_LOOP_SECONDS, duration) });
    }
}
