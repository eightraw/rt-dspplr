import {
    forwardRef,
    useCallback,
    useEffect,
    useImperativeHandle,
    useLayoutEffect,
    useRef,
    useState,
    type KeyboardEvent as ReactKeyboardEvent,
    type PointerEvent as ReactPointerEvent,
    type ReactNode,
} from 'react';
import type { LoopRange } from '../core/engine';
import type { AudioPlayerCore } from '../core/AudioPlayer';
import { createSpectrogram, type SpectrogramOptions, type SpectrogramView } from '../core/spectrogram/SpectrogramView';
import type { WaveformPeakPyramid } from '../core/waveform/pyramid';
import { clamp, formatClock, spokenTime } from './format';
import { computeTicks } from './ruler';
import { barCountFor, computeBarHeights, drawBars } from './waveBars';
import { drawEnvelope } from './waveEnvelope';

// ---------------------------------------------------------------------------
// Scrubber — the waveform (or the spectrogram) doubles as the seek bar.
//
//   click            seek (outside an active loop: also clears the loop)
//   drag             select a loop
//   loop handles     drag or arrow keys to move an edge
//   wheel            zoom around the pointer in 0.5x steps, down to a 0.5 s
//                    window (wheelZoom="modifier": only with Ctrl/Cmd)
//   Shift + wheel /  pan while zoomed; the overview strip under the ruler
//   horizontal wheel can also be dragged or clicked
//   keyboard         ←/→ ±1 s, PageUp/PageDown ±5 s, Home/End,
//                    + / − zoom, 0 resets zoom, Esc clears the loop
//
// With `zoomable` off there is no zoom or pan by any means (wheel, pinch,
// keys, overview strip): the view is the whole clip and the wheel scrolls
// the page. Seeking and loops work as before.
//
// The playhead and the played fill are moved by setTime() from the parent's
// animation frame, outside React rendering.
// ---------------------------------------------------------------------------

const MIN_LOOP_SECONDS = 0.05;
const DRAG_THRESHOLD_PX = 5;
/** Smallest visible window when fully zoomed in (seconds). */
const MIN_VISIBLE_WINDOW = 0.5;
/** Zoom change per wheel notch. */
const WHEEL_ZOOM_STEP = 0.5;

export interface ScrubberHandle {
    setTime(seconds: number, following: boolean): void;
}

interface ScrubberProps {
    core: AudioPlayerCore;
    hasAudio: boolean;
    duration: number;
    loop: LoopRange | null;
    pyramid: WaveformPeakPyramid | null;
    /** Changes whenever colours may have changed (theme switch). */
    paletteKey: string;
    loading: boolean;
    emptyText: ReactNode;
    /** Resets zoom when it changes. */
    resetKey: string;
    /** Called when the user moved the playhead (for the time readout). */
    onUserSeek: (seconds: number) => void;
    label: string;
    /** What the track draws: the waveform, the spectrogram, or the waveform over the spectrogram. */
    display: 'waveform' | 'spectrogram' | 'both';
    waveformStyle: 'envelope' | 'bars';
    /** Look of the spectrogram. */
    spectrogram?: SpectrogramOptions;
    wheelZoom: 'plain' | 'modifier';
    /** Zoom and pan at all. */
    zoomable: boolean;
    /** Time ruler and overview strip under the waveform. */
    ruler: boolean;
}

type Drag =
    | { kind: 'track'; startX: number; anchor: number; selecting: boolean; pointerId: number }
    | { kind: 'edge'; edge: 'start' | 'end'; pointerId: number }
    | { kind: 'overview'; grab: number; pointerId: number };

function readVar(el: Element, name: string, fallback: string): string {
    if (typeof getComputedStyle === 'undefined') return fallback;
    return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
}

export const Scrubber = forwardRef<ScrubberHandle, ScrubberProps>(function Scrubber({
    core,
    hasAudio,
    duration,
    loop,
    pyramid,
    paletteKey,
    loading,
    emptyText,
    resetKey,
    onUserSeek,
    label,
    display,
    waveformStyle,
    spectrogram,
    wheelZoom,
    zoomable,
    ruler,
}, ref) {
    const boxRef = useRef<HTMLDivElement | null>(null);
    const frameRef = useRef<HTMLDivElement | null>(null);
    const overviewRef = useRef<HTMLDivElement | null>(null);
    const overviewHeadRef = useRef<HTMLDivElement | null>(null);
    const trackRef = useRef<HTMLDivElement | null>(null);
    const baseCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const playedCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const spectroCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const spectroRef = useRef<SpectrogramView | null>(null);
    const spectroOptionsRef = useRef(spectrogram);
    spectroOptionsRef.current = spectrogram;
    const isSpectrogram = display !== 'waveform';
    const drawsWaveform = display !== 'spectrogram';
    const overlay = display === 'both';
    const playedLayerRef = useRef<HTMLDivElement | null>(null);
    const playheadRef = useRef<HTMLDivElement | null>(null);
    const timeRef = useRef(0);
    const dragRef = useRef<Drag | null>(null);
    const draftRef = useRef<LoopRange | null>(null);

    const [size, setSize] = useState({ w: 0, h: 0 });
    const [zoom, setZoom] = useState(1);
    const [offset, setOffset] = useState(0);
    const [hoverX, setHoverX] = useState<number | null>(null);
    const [draft, setDraft] = useState<LoopRange | null>(null);

    draftRef.current = draft;
    const viewSize = 1 / zoom;
    const shownLoop = draft ?? loop;
    const canInteract = hasAudio && duration > 0;

    const wheelZoomRef = useRef(wheelZoom);
    wheelZoomRef.current = wheelZoom;
    const viewRef = useRef({ zoom, offset, viewSize, duration, width: size.w });
    viewRef.current = { zoom, offset, viewSize, duration, width: size.w };

    // ---- geometry ----------------------------------------------------------
    const timeToFraction = useCallback((t: number) => {
        const v = viewRef.current;
        if (v.duration <= 0) return 0;
        return (t / v.duration - v.offset) / v.viewSize;
    }, []);

    const timeAtClientX = useCallback((clientX: number) => {
        const el = trackRef.current;
        const v = viewRef.current;
        if (!el || v.duration <= 0) return 0;
        const rect = el.getBoundingClientRect();
        const f = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
        return clamp((v.offset + f * v.viewSize) * v.duration, 0, v.duration);
    }, []);

    // ---- size --------------------------------------------------------------
    useLayoutEffect(() => {
        const el = trackRef.current;
        if (!el) return undefined;
        const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
        measure();
        if (typeof ResizeObserver === 'undefined') {
            window.addEventListener('resize', measure);
            return () => window.removeEventListener('resize', measure);
        }
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    // ---- reset zoom on a new clip -------------------------------------------
    useEffect(() => {
        setZoom(1);
        setOffset(0);
        setDraft(null);
    }, [resetKey]);

    // ---- spectrogram -----------------------------------------------------------
    // Drawn by its own view, which follows the clip and the mix; the scrubber
    // only tells it which part of the clip is in sight.
    useEffect(() => {
        const canvas = spectroCanvasRef.current;
        if (!isSpectrogram || !canvas) return undefined;
        const view = createSpectrogram(canvas, core, spectroOptionsRef.current);
        spectroRef.current = view;
        return () => {
            view.dispose();
            if (spectroRef.current === view) spectroRef.current = null;
        };
    }, [core, isSpectrogram]);

    const spectroKey = JSON.stringify(spectrogram ?? {});
    useEffect(() => {
        spectroRef.current?.setOptions(spectroOptionsRef.current ?? {});
    }, [spectroKey]);

    useEffect(() => {
        spectroRef.current?.setRange(zoom > 1 && duration > 0
            ? { start: offset * duration, end: (offset + viewSize) * duration }
            : null);
    }, [zoom, offset, viewSize, duration, isSpectrogram]);

    // ---- draw ----------------------------------------------------------------
    useLayoutEffect(() => {
        if (!drawsWaveform) return;
        const base = baseCanvasRef.current;
        const playedCanvas = playedCanvasRef.current;
        const frame = frameRef.current;
        if (!base || !playedCanvas || !frame || size.w <= 0 || size.h <= 0) return;
        const total = pyramid?.totalSamples ?? 0;
        const start = clamp(Math.floor(offset * total), 0, total);
        const end = clamp(Math.ceil((offset + viewSize) * total), start + 1, Math.max(start + 1, total));
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
            const count = barCountFor(size.w);
            const heights = total > 0 ? computeBarHeights(pyramid, start, end, count) : new Float32Array(0);
            drawBars(base, heights, size.w, size.h, wave);
            drawBars(playedCanvas, heights, size.w, size.h, overlay ? played : readVar(frame, '--rtd-wave-played', '#0f766e'));
            return;
        }
        const source = total > 0 ? pyramid : null;
        drawEnvelope(base, source, start, end, size.w, size.h, wave, waveRms);
        drawEnvelope(playedCanvas, source, start, end, size.w, size.h, played, playedRms);
    }, [pyramid, size.w, size.h, offset, viewSize, paletteKey, waveformStyle, drawsWaveform, overlay]);

    // ---- playhead -------------------------------------------------------------
    const paint = useCallback((t: number) => {
        const f = timeToFraction(t);
        const visible = f >= 0 && f <= 1;
        const clipped = clamp(f, 0, 1);
        if (playedLayerRef.current) {
            playedLayerRef.current.style.clipPath = `inset(0 ${((1 - clipped) * 100).toFixed(3)}% 0 0)`;
        }
        if (playheadRef.current) {
            playheadRef.current.style.left = `${(clipped * 100).toFixed(3)}%`;
            playheadRef.current.style.visibility = visible && viewRef.current.duration > 0 ? 'visible' : 'hidden';
        }
        if (overviewHeadRef.current) {
            const d = viewRef.current.duration;
            overviewHeadRef.current.style.left = `${d > 0 ? clamp(t / d, 0, 1) * 100 : 0}%`;
        }
    }, [timeToFraction]);

    useImperativeHandle(ref, () => ({
        setTime(seconds: number, following: boolean) {
            timeRef.current = seconds;
            const v = viewRef.current;
            if (following && v.zoom > 1 && v.duration > 0) {
                const f = timeToFraction(seconds);
                if (f < 0 || f > 1) {
                    const next = clamp(seconds / v.duration - v.viewSize * 0.1, 0, 1 - v.viewSize);
                    viewRef.current = { ...v, offset: next };
                    setOffset(next);
                }
            }
            paint(seconds);
        },
    }), [paint, timeToFraction]);

    useLayoutEffect(() => {
        paint(timeRef.current);
    });

    // ---- zoom -------------------------------------------------------------------
    const zoomTo = useCallback((targetZoom: number, anchorFraction: number) => {
        const v = viewRef.current;
        if (v.duration <= 0) return;
        const max = Math.max(1, v.duration / MIN_VISIBLE_WINDOW);
        const nextZoom = clamp(targetZoom, 1, max);
        const nextSize = 1 / nextZoom;
        const anchor = v.offset + anchorFraction * v.viewSize;
        const nextOffset = clamp(anchor - anchorFraction * nextSize, 0, 1 - nextSize);
        viewRef.current = { ...v, zoom: nextZoom, viewSize: nextSize, offset: nextOffset };
        setZoom(nextZoom);
        setOffset(nextOffset);
    }, []);

    const zoomAround = useCallback((factor: number, anchorFraction: number) => {
        zoomTo(viewRef.current.zoom * factor, anchorFraction);
    }, [zoomTo]);

    const panTo = useCallback((nextOffset: number) => {
        const v = viewRef.current;
        const next = clamp(nextOffset, 0, 1 - v.viewSize);
        viewRef.current = { ...v, offset: next };
        setOffset(next);
    }, []);

    // Turning zoom off shows the whole clip again.
    useEffect(() => {
        if (!zoomable && viewRef.current.zoom > 1) zoomTo(1, 0);
    }, [zoomable, zoomTo]);

    useEffect(() => {
        const el = boxRef.current;
        const frame = frameRef.current;
        // Without zoom no listener at all, so the wheel (and a pinch, which
        // arrives as Ctrl + wheel) stays with the page.
        if (!el || !frame || !zoomable) return undefined;
        const onWheel = (event: WheelEvent) => {
            const v = viewRef.current;
            if (v.duration <= 0) return;
            const rect = frame.getBoundingClientRect();
            const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY);
            if (horizontal || event.shiftKey) {
                // Pan (Shift + wheel arrives as deltaX in some browsers).
                if (v.zoom <= 1) return;
                event.preventDefault();
                const delta = horizontal ? event.deltaX : event.deltaY;
                panTo(v.offset + (delta / Math.max(1, rect.width)) * v.viewSize);
                return;
            }
            if (event.deltaY === 0) return;
            if (wheelZoomRef.current === 'modifier' && !event.ctrlKey && !event.metaKey) return;
            event.preventDefault();
            const f = clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
            zoomTo(v.zoom - Math.sign(event.deltaY) * WHEEL_ZOOM_STEP, f);
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, [zoomTo, panTo, zoomable]);

    // ---- seeking ------------------------------------------------------------------
    const seekTo = useCallback((t: number) => {
        const target = clamp(t, 0, viewRef.current.duration);
        timeRef.current = target;
        paint(target);
        onUserSeek(target);
        void core.seek(target);
    }, [core, onUserSeek, paint]);

    const commitLoop = useCallback((range: LoopRange | null) => {
        core.setLoop(range && range.end - range.start >= MIN_LOOP_SECONDS ? range : null);
    }, [core]);

    // ---- track pointer --------------------------------------------------------------
    const onTrackPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!canInteract || event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        event.currentTarget.dataset.pointer = '';
        event.currentTarget.focus({ preventScroll: true });
        const t = timeAtClientX(event.clientX);
        dragRef.current = { kind: 'track', startX: event.clientX, anchor: t, selecting: false, pointerId: event.pointerId };
        const active = core.getState().loop;
        if (active && (t < active.start || t > active.end)) {
            core.setLoop(null);
        }
        seekTo(t);
    };

    const onFramePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
        const frame = frameRef.current;
        if (frame && canInteract) {
            const rect = frame.getBoundingClientRect();
            setHoverX(clamp(event.clientX - rect.left, 0, rect.width));
        }
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        if (drag.kind === 'overview') {
            panTo(overviewFraction(event.clientX) - drag.grab);
            return;
        }
        const t = timeAtClientX(event.clientX);
        if (drag.kind === 'track') {
            if (!drag.selecting && Math.abs(event.clientX - drag.startX) < DRAG_THRESHOLD_PX) return;
            drag.selecting = true;
            const range = { start: Math.min(drag.anchor, t), end: Math.max(drag.anchor, t) };
            draftRef.current = range;
            setDraft(range);
            commitLoop(range);
            return;
        }
        const current = draftRef.current ?? core.getState().loop;
        if (!current) return;
        const range = drag.edge === 'start'
            ? { start: clamp(t, 0, current.end - MIN_LOOP_SECONDS), end: current.end }
            : { start: current.start, end: clamp(t, current.start + MIN_LOOP_SECONDS, viewRef.current.duration) };
        draftRef.current = range;
        setDraft(range);
        commitLoop(range);
    };

    const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        dragRef.current = null;
        const range = draftRef.current;
        setDraft(null);
        if (drag.kind === 'track' && drag.selecting && range) {
            if (range.end - range.start < MIN_LOOP_SECONDS) {
                core.setLoop(null);
            } else {
                seekTo(range.start);
            }
        }
    };

    const overviewFraction = (clientX: number) => {
        const el = overviewRef.current;
        if (!el) return 0;
        const rect = el.getBoundingClientRect();
        return clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    };

    const onOverviewPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!canInteract || event.button !== 0 || zoom <= 1) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        const f = overviewFraction(event.clientX);
        const v = viewRef.current;
        // Grabbing the window keeps the grab point; clicking elsewhere centres it there.
        const inside = f >= v.offset && f <= v.offset + v.viewSize;
        const grab = inside ? f - v.offset : v.viewSize / 2;
        if (!inside) panTo(f - grab);
        dragRef.current = { kind: 'overview', grab, pointerId: event.pointerId };
    };

    const onEdgePointerDown = (edge: 'start' | 'end') => (event: ReactPointerEvent<HTMLDivElement>) => {
        if (!canInteract || event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        event.currentTarget.dataset.pointer = '';
        event.currentTarget.focus({ preventScroll: true });
        dragRef.current = { kind: 'edge', edge, pointerId: event.pointerId };
    };

    // ---- keyboard ---------------------------------------------------------------------
    const onTrackKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
        delete event.currentTarget.dataset.pointer;
        if (!canInteract) return;
        if (!zoomable && ['+', '=', '-', '_', '0'].includes(event.key)) return;
        const now = core.getCurrentTime();
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
            case '=': event.preventDefault(); zoomAround(1.5, clamp(timeToFraction(now), 0, 1)); return;
            case '-':
            case '_': event.preventDefault(); zoomAround(1 / 1.5, clamp(timeToFraction(now), 0, 1)); return;
            case '0': event.preventDefault(); zoomAround(0, 0); return;
            case 'Escape':
                if (core.getState().loop) {
                    event.preventDefault();
                    core.setLoop(null);
                }
                return;
            default: return;
        }
        event.preventDefault();
        seekTo(target);
    };

    const onEdgeKeyDown = (edge: 'start' | 'end') => (event: ReactKeyboardEvent<HTMLDivElement>) => {
        delete event.currentTarget.dataset.pointer;
        const current = core.getState().loop;
        if (!current) return;
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
                core.setLoop(null);
                trackRef.current?.focus();
                return;
            default: return;
        }
        event.preventDefault();
        const base = edge === 'start' ? current.start : current.end;
        const value = absolute ?? base + delta;
        commitLoop(edge === 'start'
            ? { start: clamp(value, 0, current.end - MIN_LOOP_SECONDS), end: current.end }
            : { start: current.start, end: clamp(value, current.start + MIN_LOOP_SECONDS, duration) });
    };

    // ---- render -------------------------------------------------------------------------
    const nowForAria = Math.min(duration, timeRef.current);
    const bandStart = shownLoop ? clamp(timeToFraction(shownLoop.start), 0, 1) : 0;
    const bandEnd = shownLoop ? clamp(timeToFraction(shownLoop.end), 0, 1) : 0;
    const startVisible = shownLoop ? timeToFraction(shownLoop.start) >= 0 && timeToFraction(shownLoop.start) <= 1 : false;
    const endVisible = shownLoop ? timeToFraction(shownLoop.end) >= 0 && timeToFraction(shownLoop.end) <= 1 : false;
    const hoverTime = hoverX !== null && size.w > 0 && duration > 0
        ? clamp((offset + (hoverX / size.w) * viewSize) * duration, 0, duration)
        : null;

    const ticks = ruler && canInteract ? computeTicks(duration, offset, viewSize) : [];

    return (
        <div
            ref={boxRef}
            className="rtd-wavebox"
            onPointerMove={onFramePointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onPointerLeave={() => setHoverX(null)}
        >
        <div
            ref={frameRef}
            className="rtd-scrub"
            data-loading={loading || undefined}
            data-zoomed={zoom > 1 || undefined}
            data-display={display}
        >
            <div
                ref={trackRef}
                className="rtd-scrub-track"
                role="slider"
                tabIndex={canInteract ? 0 : -1}
                aria-label={label}
                aria-disabled={!canInteract || undefined}
                aria-valuemin={0}
                aria-valuemax={Math.round(duration * 10) / 10}
                aria-valuenow={Math.round(nowForAria * 10) / 10}
                aria-valuetext={`${spokenTime(nowForAria)} of ${spokenTime(duration)}`}
                onPointerDown={onTrackPointerDown}
                onKeyDown={onTrackKeyDown}
            >
                {isSpectrogram && (
                    <canvas ref={spectroCanvasRef} className="rtd-wave rtd-spectrogram" aria-hidden="true" />
                )}
                {drawsWaveform && (
                    <>
                        <canvas ref={baseCanvasRef} className="rtd-wave" aria-hidden="true" />
                        <div ref={playedLayerRef} className="rtd-wave-played" aria-hidden="true">
                            <canvas ref={playedCanvasRef} className="rtd-wave" />
                        </div>
                    </>
                )}
                {!hasAudio && <div className="rtd-scrub-empty">{emptyText}</div>}
                {shownLoop && bandEnd > bandStart && (
                    <div
                        className="rtd-loop-band"
                        aria-hidden="true"
                        style={{ left: `${bandStart * 100}%`, width: `${(bandEnd - bandStart) * 100}%` }}
                    />
                )}
                <div ref={playheadRef} className="rtd-playhead" aria-hidden="true" />
            </div>

            {shownLoop && (['start', 'end'] as const).map((edge) => {
                const visible = edge === 'start' ? startVisible : endVisible;
                if (!visible) return null;
                const value = edge === 'start' ? shownLoop.start : shownLoop.end;
                return (
                    <div
                        key={edge}
                        className="rtd-loop-handle"
                        data-edge={edge}
                        role="slider"
                        tabIndex={0}
                        aria-label={edge === 'start' ? 'Loop start' : 'Loop end'}
                        aria-valuemin={edge === 'start' ? 0 : Math.round(shownLoop.start * 100) / 100}
                        aria-valuemax={edge === 'start' ? Math.round(shownLoop.end * 100) / 100 : Math.round(duration * 100) / 100}
                        aria-valuenow={Math.round(value * 100) / 100}
                        aria-valuetext={spokenTime(value)}
                        style={{ left: `${(edge === 'start' ? bandStart : bandEnd) * 100}%` }}
                        onPointerDown={onEdgePointerDown(edge)}
                        onKeyDown={onEdgeKeyDown(edge)}
                    >
                        <span className="rtd-loop-grip" />
                    </div>
                );
            })}

            {hoverTime !== null && hoverX !== null && (
                <div className="rtd-hover" aria-hidden="true" style={{ left: `${hoverX}px` }}>
                    <span className="rtd-hover-tip">{formatClock(hoverTime, true)}</span>
                </div>
            )}

            {zoom > 1 && (
                <button
                    type="button"
                    className="rtd-zoom-reset"
                    onClick={() => zoomAround(0, 0)}
                    title="Show the whole clip (0)"
                >
                    {`${zoom < 10 ? zoom.toFixed(1) : Math.round(zoom)}× · reset`}
                </button>
            )}
        </div>
        {ruler && (
            <>
                <div className="rtd-ruler" aria-hidden="true">
                    {ticks.map((tick, i) => (
                        <span
                            key={i}
                            className="rtd-tick"
                            data-major={tick.major || undefined}
                            style={{ left: `${tick.left}%` }}
                        >
                            {tick.major && <span className="rtd-tick-label">{tick.label}</span>}
                        </span>
                    ))}
                </div>
                {zoomable && (
                    <div
                        ref={overviewRef}
                        className="rtd-overview"
                        data-active={zoom > 1 || undefined}
                        aria-hidden="true"
                        onPointerDown={onOverviewPointerDown}
                    >
                        {shownLoop && duration > 0 && (
                            <span
                                className="rtd-overview-loop"
                                style={{ left: `${(shownLoop.start / duration) * 100}%`, width: `${((shownLoop.end - shownLoop.start) / duration) * 100}%` }}
                            />
                        )}
                        <span className="rtd-overview-window" style={{ left: `${offset * 100}%`, width: `${viewSize * 100}%` }} />
                        <span ref={overviewHeadRef} className="rtd-overview-head" />
                    </div>
                )}
            </>
        )}
        </div>
    );
});
