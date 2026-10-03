import {
    useCallback,
    useEffect,
    useId,
    useLayoutEffect,
    useRef,
    useState,
    type CSSProperties,
    type ReactNode,
    type RefObject,
} from 'react';
import type {
    AudioInput,
    AudioPlayerCore,
    AudioPlayerOptions,
} from '../core/AudioPlayer';
import { DEFAULT_SPEEDS } from '../core/controls';
import type { SpectrogramOptions } from '../core/spectrogram/SpectrogramView';
import { MixSlider, SoundPanel, SpeedSegments } from './controls';
import { clamp, fileNameFromUrl, formatClock } from './format';
import { IconNext, IconPause, IconPlay, IconSliders, IconToStart } from './icons';
import { Scrubber, type ScrubberHandle } from './Scrubber';
import { useAudioPlayer, useAudioPlayerState, type UseAudioPlayerResult } from './useAudioPlayer';
import { useWaveform } from './useWaveform';

// ---------------------------------------------------------------------------
// <AudioPlayer /> — an inline card: play button, waveform scrubber with a
// loop band, time readout; a tool row with speed segments, loop toggle,
// two-track mixer slider (Stem A ⇄ Stem B) and a "Post FX" popover. Below `compactBreakpoint`
// px of container width it folds into one row with a settings drawer.
// ---------------------------------------------------------------------------

const DEFAULT_COMPACT_BREAKPOINT = 420;
const DEFAULT_LOOP_FRACTION = 0.2;
const MIN_DEFAULT_LOOP_SECONDS = 1;

const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export interface AudioPlayerProps {
    /**
     * Controlled mode: an instance from useAudioPlayer() (or createAudioPlayer()).
     * The component only renders it; the app decides what to load.
     */
    player?: AudioPlayerCore | UseAudioPlayerResult;

    /** Self-managed mode: what to play. Changing `src` (or `clipId`) loads the new clip. */
    src?: AudioInput | null;
    /** Stem B for `src` (read whenever `src`/`clipId` changes). */
    srcB?: AudioInput | null;
    /** Identity of the clip in self-managed mode. Default: `src` when it is a URL. */
    clipId?: string;
    /** Self-managed mode: start playing when `src` changes. Subject to the browser's autoplay policy. */
    autoPlay?: boolean;
    /** Self-managed mode: player options, read on mount. */
    options?: AudioPlayerOptions;

    /** Heading above the waveform. Default: the file name from the URL. */
    title?: ReactNode;
    /** Secondary text next to the title. */
    meta?: ReactNode;
    /** Shown in the waveform area when nothing is loaded. */
    emptyText?: ReactNode;
    /** Makes the title a button. */
    onTitleClick?: () => void;
    /** Shows an "Auto-next" toggle (e.g. "play the next clip when this one ends"). */
    autoPlayNext?: boolean;
    onAutoPlayNextChange?: (next: boolean) => void;
    /** Called when the clip plays to its end. */
    onEnded?: () => void;

    /** Speeds offered by the speed control. Default: the player's speeds. */
    speeds?: readonly number[];
    /** Seconds moved by the step buttons. Default 0.5. */
    skipSeconds?: number;
    /** Show the "to start" and step back/forward buttons next to play. Default true. */
    navButtons?: boolean;
    /**
     * 'envelope' (default): min/max peak envelope with an inner RMS layer,
     * one column per device pixel. 'bars': rounded bars.
     */
    waveformStyle?: 'envelope' | 'bars';
    /**
     * What the seek bar draws: 'waveform' (default), 'spectrogram' (follows
     * the mix and the zoom), or 'both': the waveform as an outline over the
     * spectrogram.
     */
    display?: 'waveform' | 'spectrogram' | 'both';
    /** Colours and axis of the spectrogram. */
    spectrogram?: SpectrogramOptions;
    /**
     * 'plain' (default): the mouse wheel over the waveform zooms around the
     * pointer. 'modifier': only Ctrl/Cmd + wheel zooms, so the page keeps
     * scrolling. Shift + wheel or a horizontal wheel pans in both modes.
     */
    wheelZoom?: 'plain' | 'modifier';
    /**
     * Zoom and pan with the wheel, a pinch, the keys and the overview strip. Default true.
     * false: the waveform always shows the whole clip and the wheel scrolls the page.
     */
    zoom?: boolean;
    /** Time ruler and zoom overview under the waveform (full layout). Default true. */
    ruler?: boolean;
    /** 'auto' folds into one row below `compactBreakpoint` px of container width. */
    layout?: 'auto' | 'full' | 'compact';
    /** Default 420. */
    compactBreakpoint?: number;
    /** Default 'light'. 'auto' follows prefers-color-scheme. */
    theme?: 'light' | 'dark' | 'auto';
    className?: string;
    style?: CSSProperties;
}

function resolveCore(player: AudioPlayerCore | UseAudioPlayerResult): AudioPlayerCore {
    return 'player' in player && typeof (player as UseAudioPlayerResult).state === 'object'
        ? (player as UseAudioPlayerResult).player
        : player as AudioPlayerCore;
}

export function AudioPlayer(props: AudioPlayerProps) {
    if (props.player) {
        return <AudioPlayerCard {...props} core={resolveCore(props.player)} />;
    }
    return <SelfManagedAudioPlayer {...props} />;
}

function SelfManagedAudioPlayer(props: AudioPlayerProps) {
    const { src, srcB, clipId, autoPlay = false, options } = props;
    const { player } = useAudioPlayer(options);
    const srcBRef = useRef(srcB);
    srcBRef.current = srcB;

    useEffect(() => {
        if (src === null || src === undefined) {
            player.stop();
            return;
        }
        const clip = { src, srcB: srcBRef.current ?? null, id: clipId };
        void (autoPlay ? player.play(clip) : player.load(clip));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [player, src, clipId]);

    return <AudioPlayerCard {...props} core={player} />;
}

// ---- hooks ------------------------------------------------------------------

/** Container width, measured with a ResizeObserver. */
function useWidth(ref: RefObject<HTMLElement>): number {
    const [width, setWidth] = useState(0);
    useIsomorphicLayoutEffect(() => {
        const el = ref.current;
        if (!el) return undefined;
        const measure = () => setWidth(el.clientWidth);
        measure();
        if (typeof ResizeObserver === 'undefined') {
            window.addEventListener('resize', measure);
            return () => window.removeEventListener('resize', measure);
        }
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);
    return width;
}

/** Re-renders when the OS colour scheme flips (only matters for theme="auto"). */
function useSystemScheme(active: boolean): 'light' | 'dark' {
    const query = '(prefers-color-scheme: dark)';
    const read = () => (typeof window !== 'undefined' && window.matchMedia?.(query).matches ? 'dark' : 'light');
    const [scheme, setScheme] = useState<'light' | 'dark'>(read);
    useEffect(() => {
        if (!active || typeof window === 'undefined' || !window.matchMedia) return undefined;
        const mq = window.matchMedia(query);
        const onChange = () => setScheme(mq.matches ? 'dark' : 'light');
        onChange();
        mq.addEventListener?.('change', onChange);
        return () => mq.removeEventListener?.('change', onChange);
    }, [active]);
    return scheme;
}

/** Closes a popover on outside pointer-down and on Escape. */
function useDismiss(open: boolean, close: (restoreFocus: boolean) => void, refs: RefObject<HTMLElement>[]): void {
    const closeRef = useRef(close);
    closeRef.current = close;
    useEffect(() => {
        if (!open) return undefined;
        const onPointer = (event: PointerEvent) => {
            const target = event.target as Node | null;
            if (refs.some((r) => r.current?.contains(target))) return;
            closeRef.current(false);
        };
        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.stopPropagation();
                closeRef.current(true);
            }
        };
        document.addEventListener('pointerdown', onPointer, true);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('pointerdown', onPointer, true);
            document.removeEventListener('keydown', onKey);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);
}

// ---- the card ------------------------------------------------------------------

interface CardProps extends AudioPlayerProps {
    core: AudioPlayerCore;
}

function AudioPlayerCard({
    core,
    title,
    meta,
    emptyText = 'No audio loaded',
    onTitleClick,
    autoPlayNext,
    onAutoPlayNextChange,
    onEnded,
    speeds: speedsProp,
    skipSeconds = 0.5,
    navButtons = true,
    waveformStyle = 'envelope',
    display = 'waveform',
    spectrogram,
    wheelZoom = 'plain',
    zoom = true,
    ruler = true,
    layout = 'auto',
    compactBreakpoint = DEFAULT_COMPACT_BREAKPOINT,
    theme = 'light',
    className,
    style,
}: CardProps) {
    const state = useAudioPlayerState(core);
    const speeds = speedsProp && speedsProp.length > 0
        ? speedsProp
        : (core.speeds.length > 0 ? core.speeds : DEFAULT_SPEEDS);
    const hasAudio = state.clipId !== null;
    const ready = hasAudio && state.duration > 0;
    const duration = state.duration;

    const rootRef = useRef<HTMLElement>(null);
    useEffect(() => (rootRef.current ? core.mount(rootRef.current) : undefined), [core]);
    const width = useWidth(rootRef);
    const compact = layout === 'compact' || (layout === 'auto' && width > 0 && width < compactBreakpoint);
    const scheme = useSystemScheme(theme === 'auto');
    const paletteKey = theme === 'auto' ? `auto-${scheme}` : theme;
    const pyramid = useWaveform(state, display !== 'spectrogram');

    const scrubberRef = useRef<ScrubberHandle>(null);
    const elapsedRef = useRef<HTMLSpanElement>(null);
    const [soundOpen, setSoundOpen] = useState(false);
    const [drawerOpen, setDrawerOpen] = useState(false);
    const soundButtonRef = useRef<HTMLButtonElement>(null);
    const soundPopoverRef = useRef<HTMLDivElement>(null);
    const ids = useId();

    // ---- time readout + playhead ------------------------------------------
    const showTime = useCallback((t: number, following: boolean) => {
        scrubberRef.current?.setTime(t, following);
        if (elapsedRef.current) elapsedRef.current.textContent = formatClock(t, true);
    }, []);

    useIsomorphicLayoutEffect(() => {
        if (!state.isPlaying) showTime(hasAudio ? state.currentTime : 0, false);
    }, [state.currentTime, state.isPlaying, hasAudio, showTime, compact]);

    useEffect(() => {
        if (!state.isPlaying) return undefined;
        let raf = 0;
        const tick = () => {
            showTime(Math.min(core.getCurrentTime(), core.getState().duration), true);
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [state.isPlaying, core, showTime, compact]);

    const onUserSeek = useCallback((t: number) => showTime(t, false), [showTime]);

    // A new clip or a restart drops the loop.
    useEffect(() => {
        core.setLoop(null);
    }, [core, state.clipId, state.playRequestId]);

    // `ended` -> onEnded
    const onEndedRef = useRef(onEnded);
    onEndedRef.current = onEnded;
    useEffect(() => core.on('ended', () => onEndedRef.current?.()), [core]);

    // ---- loop toggle ---------------------------------------------------------
    const toggleLoop = useCallback(() => {
        const current = core.getState();
        if (current.loop) {
            core.setLoop(null);
            return;
        }
        if (current.duration <= 0) return;
        const length = clamp(current.duration * DEFAULT_LOOP_FRACTION, Math.min(MIN_DEFAULT_LOOP_SECONDS, current.duration), current.duration);
        const start = clamp(core.getCurrentTime(), 0, current.duration - length);
        core.setLoop({ start, end: start + length });
    }, [core]);

    // ---- popovers ------------------------------------------------------------------
    const closeSound = useCallback((restoreFocus: boolean) => {
        setSoundOpen(false);
        if (restoreFocus) soundButtonRef.current?.focus();
    }, []);
    useDismiss(soundOpen, closeSound, [soundButtonRef, soundPopoverRef]);
    useEffect(() => {
        if (soundOpen) soundPopoverRef.current?.querySelector<HTMLInputElement>('input')?.focus();
    }, [soundOpen]);
    useEffect(() => {
        setSoundOpen(false);
        if (!compact) setDrawerOpen(false);
    }, [compact]);

    // ---- labels ----------------------------------------------------------------------
    const urlFileName = fileNameFromUrl(state.src);
    const resolvedTitle: ReactNode = title ?? urlFileName ?? state.clipId ?? null;
    const titleText = typeof resolvedTitle === 'string' ? resolvedTitle : undefined;
    const status: ReactNode = state.status === 'loading'
        ? 'Loading…'
        : state.status === 'error'
            ? <span className="rtd-error">Could not load audio</span>
            : null;
    const metaLine: ReactNode = status ?? meta ?? null;
    const showAuto = typeof onAutoPlayNextChange === 'function';
    const loopOn = state.loop !== null;

    // ---- pieces -------------------------------------------------------------------------
    const playButton = (
        <button
            type="button"
            className="rtd-play"
            onClick={() => { if (hasAudio) void core.toggle(); }}
            disabled={!hasAudio}
            aria-label={state.isPlaying ? 'Pause' : 'Play'}
            title={state.isPlaying ? 'Pause' : 'Play'}
        >
            {state.isPlaying ? <IconPause /> : <IconPlay />}
        </button>
    );

    const step = skipSeconds > 0 ? skipSeconds : 0.5;
    const stepLabel = `${Number(step.toFixed(2))}`;
    const seekBy = (delta: number | null) => {
        const s = core.getState();
        if (s.clipId === null || s.duration <= 0) return;
        const target = delta === null ? 0 : clamp(core.getCurrentTime() + delta, 0, s.duration);
        showTime(target, false);
        void core.seek(target);
    };
    const navStart = (
        <button
            type="button"
            className="rtd-btn rtd-icon-btn rtd-nav"
            disabled={!ready}
            aria-label="Back to start"
            title="Back to start"
            onClick={() => seekBy(null)}
        >
            <IconToStart />
        </button>
    );
    const navBack = (
        <button
            type="button"
            className="rtd-btn rtd-step"
            disabled={!ready}
            aria-label={`Back ${stepLabel} seconds`}
            title={`Back ${stepLabel} s`}
            onClick={() => seekBy(-step)}
        >
            −{stepLabel}
        </button>
    );
    const navForward = (
        <button
            type="button"
            className="rtd-btn rtd-step"
            disabled={!ready}
            aria-label={`Forward ${stepLabel} seconds`}
            title={`Forward ${stepLabel} s`}
            onClick={() => seekBy(step)}
        >
            +{stepLabel}
        </button>
    );

    const scrubber = (
        <Scrubber
            ref={scrubberRef}
            core={core}
            hasAudio={hasAudio}
            duration={duration}
            loop={state.loop}
            pyramid={hasAudio ? pyramid : null}
            paletteKey={paletteKey}
            loading={state.status === 'loading'}
            emptyText={emptyText}
            resetKey={`${state.clipId ?? ''}:${state.playRequestId}`}
            onUserSeek={onUserSeek}
            label={titleText ? `Seek in ${titleText}` : 'Seek'}
            display={display}
            waveformStyle={waveformStyle}
            spectrogram={spectrogram}
            wheelZoom={wheelZoom}
            zoomable={zoom}
            ruler={ruler && !compact}
        />
    );

    const time = (
        <div className="rtd-time" aria-hidden="true">
            <span ref={elapsedRef} className="rtd-time-now">0:00.0</span>
            <span className="rtd-time-total">{formatClock(ready ? duration : 0, true)}</span>
        </div>
    );

    const loopButton = (
        <button
            type="button"
            className="rtd-btn rtd-chip"
            aria-pressed={loopOn}
            disabled={!ready}
            onClick={toggleLoop}
            title={loopOn ? 'Stop looping (or click outside the band)' : 'Loop a section (or drag across the waveform)'}
        >
            Loop
        </button>
    );

    const speed = (
        <SpeedSegments
            speeds={speeds}
            value={state.processing.speed}
            pending={state.pendingSpeed}
            onChange={(next) => void core.setSpeed(next)}
        />
    );

    const actions = showAuto ? (
        <div className="rtd-actions">
            {showAuto && (
                <button
                    type="button"
                    className="rtd-btn rtd-icon-btn"
                    aria-pressed={!!autoPlayNext}
                    aria-label="Auto-play next clip"
                    title={autoPlayNext ? 'Auto-play next: on' : 'Auto-play next: off'}
                    onClick={() => onAutoPlayNextChange?.(!autoPlayNext)}
                >
                    <IconNext />
                </button>
            )}
        </div>
    ) : null;

    const heading = (
        <div className="rtd-head">
            <div className="rtd-titles">
                {onTitleClick && hasAudio ? (
                    <button type="button" className="rtd-title rtd-title-link" title={titleText} onClick={onTitleClick}>
                        {resolvedTitle}
                    </button>
                ) : (
                    <span className="rtd-title" title={titleText}>{resolvedTitle ?? ' '}</span>
                )}
                {metaLine !== null && <span className="rtd-meta">{metaLine}</span>}
            </div>
            {actions}
        </div>
    );

    const rootProps = {
        ref: rootRef as RefObject<HTMLElement>,
        className: ['rtd', className].filter(Boolean).join(' '),
        style,
        'data-theme': theme,
        'data-layout': compact ? 'compact' : 'full',
        'data-playing': state.isPlaying || undefined,
        'data-status': state.status,
        'aria-label': titleText ? `Audio player: ${titleText}` : 'Audio player',
    };

    if (compact) {
        const drawerId = `${ids}-drawer`;
        return (
            <section {...rootProps}>
                <div className="rtd-row">
                    {playButton}
                    {scrubber}
                    {time}
                    <button
                        type="button"
                        className="rtd-btn rtd-icon-btn"
                        aria-label="Player settings"
                        aria-expanded={drawerOpen}
                        aria-controls={drawerId}
                        title="Speed, loop, mixer and sound"
                        onClick={() => setDrawerOpen((open) => !open)}
                    >
                        <IconSliders />
                    </button>
                </div>
                {drawerOpen && (
                    <div className="rtd-drawer" id={drawerId}>
                        {heading}
                        <div className="rtd-tools">
                            {navButtons && <div className="rtd-transport">{navStart}{navBack}{navForward}</div>}
                            {speed}
                            {loopButton}
                        </div>
                        <MixSlider core={core} state={state} />
                        <SoundPanel core={core} state={state} />
                    </div>
                )}
            </section>
        );
    }

    const popoverId = `${ids}-sound`;
    return (
        <section {...rootProps}>
            {heading}
            <div className="rtd-row">
                {navButtons ? (
                    <div className="rtd-transport">
                        {navStart}
                        {navBack}
                        {playButton}
                        {navForward}
                    </div>
                ) : playButton}
                {scrubber}
                {time}
            </div>
            <div className="rtd-tools">
                {speed}
                {loopButton}
                <MixSlider core={core} state={state} />
                <div className="rtd-sound-anchor">
                    <button
                        ref={soundButtonRef}
                        type="button"
                        className="rtd-btn rtd-chip"
                        aria-expanded={soundOpen}
                        aria-controls={popoverId}
                        aria-haspopup="dialog"
                        onClick={() => setSoundOpen((open) => !open)}
                    >
                        <IconSliders />
                        <span>Post FX</span>
                    </button>
                    {soundOpen && (
                        <div
                            ref={soundPopoverRef}
                            id={popoverId}
                            className="rtd-popover"
                            role="dialog"
                            aria-label="Post FX"
                        >
                            <SoundPanel core={core} state={state} />
                        </div>
                    )}
                </div>
            </div>
        </section>
    );
}
