import type { AudioPlayerState, ClipInfo } from '../AudioPlayer';
import type AudioEngine from '../engine/AudioEngine';
import type { LoopRange } from '../engine/Track';
import { findZeroCrossing } from '../engine/zeroCrossing';
import type { SpectralPyramid } from '../spectrogram/protocol';
import type { WaveformPeakLevel, WaveformPeakPyramid } from '../waveform/pyramid';
import { decodeBandsFile, type BandsFile } from '../stream/bandsFile';
import { FileAccess, SourceError } from '../stream/fileAccess';
import { assertManifest, DEFAULT_STEM_KEY, readyStemKeys, type AudioManifest, type ManifestSegment, type ManifestStem, type ManifestStems } from '../stream/manifest';
import { mixGains, type MixLaw } from '../controls';
import { decodePeaksFile, peaksToPyramid, readLevel, type PeaksFile } from '../stream/peaksFile';
import { SegmentScheduler } from '../stream/SegmentScheduler';
import { SegmentStore, type SegmentStoreStats } from '../stream/SegmentStore';
import { loadStreamEngine, StreamEngine, type EngineReport } from '../engine/StreamEngine';
import { engineWindow } from '../engine/engineWindow';
import { decodeSpectrogramFile, toSpectralPyramid, type SpectrogramFile } from '../stream/spectrogramFile';
import type { PlaybackSource, SourceCapabilities, SourceHost, StemSummary } from './types';

// ---------------------------------------------------------------------------
// SegmentedSource — a prepared long recording (@saitdigital/rt-dspplr-prepare): manifest,
// peaks, bands and spectrogram first (KBs to a few MB), so the timeline is
// whole at once; segments are fetched and decoded around the playhead and
// handed to the stream engine (an AudioWorklet: sample-exact joins, stems in
// lockstep, realtime pitch-preserving speed with Signalsmith Stretch). Without
// AudioWorklet, SegmentScheduler plays them back to back with AudioBufferSourceNodes
// (playbackRate: the pitch follows the speed).
// ---------------------------------------------------------------------------

/** What a segmented clip brought for the overview, as it arrives. */
export interface PreparedOverview {
    /** Stored peak levels, channels merged, unprocessed. */
    peaks: WaveformPeakPyramid | null;
    /** Low-passed energies for the high-pass preview (manifest v2). */
    bands: BandsFile | null;
    /** Overview spectrogram (manifest v2); with stem B loaded, its levels carry B too (`b`). */
    spectrogram: SpectralPyramid | null;
    /** Stem B's stored peaks and bands (manifest v3), once the mix has asked for B. */
    peaksB?: WaveformPeakPyramid | null;
    bandsB?: BandsFile | null;
    /** A and B correlated (a dry/wet pair): the overview blends them coherently. */
    correlated?: boolean;
}

/** Decoded audio of the timeline's window (the segments on screen), for exact previews. */
export interface WindowAudio {
    buffer: AudioBuffer;
    /** Stem B over the same window, when the mix uses it and its segments are in. */
    bufferB?: AudioBuffer | null;
    /** Timeline frame of buffer sample 0. */
    startFrame: number;
    sampleRate: number;
    key: string;
}

export interface SegmentedOptions {
    /** Decoded audio kept around the playhead and the view, in seconds. Default 60. */
    cacheSeconds?: number;
    /** Segments fetched ahead of the playhead. Default 2. */
    prefetchSegments?: number;
    /** Sources are created this far ahead of the clock, seconds (scheduler fallback). Default 2. */
    scheduleAheadSeconds?: number;
    /**
     * Play through the AudioWorklet stream engine (default true): sample-exact,
     * smoothed volume and mix, realtime pitch-preserving speed. false (or no
     * AudioWorklet) falls back to AudioBufferSourceNodes on the context clock.
     */
    engine?: boolean;
    /**
     * Opt-in, for hosts that publish a manifest before its stem is made: while
     * the active stem says 'processing', re-read the manifest this often (ms) and show
     * 'processing'. Default 0: manifests are read as published (B there or not),
     * and refreshManifest() re-reads on demand.
     */
    pollStemsMs?: number;
}

export interface StreamStats extends SegmentStoreStats {
    cachedSeconds: number;
    peakCachedSeconds: number;
    capSeconds: number;
    underruns: number;
    /** Latency of the last seeks (call → audio scheduled), ms. */
    seekLatencies: number[];
    /** Time from play() to the first scheduled audio, ms. */
    startLatencyMs: number | null;
    peaksCoarseBytes: number;
    peaksFineBytes: number;
    bandsBytes: number;
    spectrogramCoarseBytes: number;
    spectrogramFineBytes: number;
    /** ms from load() to the overview spectrogram's first levels. */
    spectrogramReadyMs: number | null;
    /** Segments of stem B fetched (only while the mix wants B). */
    fetchesB: number;
    /** 'engine' (AudioWorklet) or 'scheduler' (AudioBufferSourceNodes). */
    playback: 'engine' | 'scheduler' | null;
    /** Frames of silence the engine played while waiting for segments. */
    underrunFrames: number;
    /** The realtime stretcher: ready, and its window (input + output latency) in frames. */
    stretch: { ready: boolean; latencyFrames: number; active: boolean; /** The tonal and atonal parts are stretched apart. */ split: boolean };
}

const LOOKAHEAD = 0.025;
const PUMP_MS = 40;
/** Views up to this long get their segments decoded for exact previews. */
export const WINDOW_MAX_SECONDS = 20;
const WINDOW_MAX_SEGMENTS = 4;
/** Failures in a row after which a segment counts as broken (the store keeps retrying, slowly). */
const SEGMENT_FAILURES_MAX = 4;

function clampTime(time: number, duration: number): number {
    const t = Number.isFinite(time) ? Math.max(0, time) : 0;
    return duration > 0 ? Math.min(t, Math.max(0, duration - 0.001)) : t;
}

export class SegmentedSource implements PlaybackSource {
    readonly kind = 'segmented' as const;
    capabilities: SourceCapabilities = SegmentedSource._caps(false);

    private static _caps(pitch: boolean, stemB = false, stems: readonly StemSummary[] = []): SourceCapabilities {
        return {
            kind: 'segmented',
            canPreservePitch: pitch,
            canMixStemB: stemB,
            stems,
            exactWaveformPreview: false,
            spectrogram: true,
            loopSnapping: false,
        };
    }

    private _eng: StreamEngine | null = null;
    private _engPlaying = false;
    // ---- stem B (manifest v3) ----
    private _storeB: SegmentStore | null = null;
    private _stemB: ManifestStem | null = null;
    /** Key of the stem the knob blends with (null: none); and the one the host asked for. */
    private _stemKey: string | null = null;
    private _wantStem: string | null = null;
    private _mix = 0;
    /** B is wanted while the mix is above 0, and for a while after the knob last moved. */
    private _bWantedUntil = 0;
    private _bOverviewAsked = false;
    private _pollTimer: ReturnType<typeof setInterval> | null = null;
    private _settling: Promise<void> = Promise.resolve();
    private _pendingLatency: { t0: number; reason: 'play' | 'seek' } | null = null;
    private _lastReport: EngineReport | null = null;
    private readonly _host: SourceHost;
    private readonly _options: SegmentedOptions;
    private _disposed = false;
    /** The current load still wants to start playing (cleared by pause / stop). */
    private _autoplay = false;
    private _loadId = 0;
    private _playId = 0;
    /** Aborts what the current load fetches (manifest, overview files, refreshes); a new load or unload() aborts it. */
    private _abort: AbortController | null = null;
    private _engine: AudioEngine | null = null;
    private _manifest: AudioManifest | null = null;
    /** How the clip's files are fetched: their URLs, the host's options, the load's signal. */
    private _files: FileAccess | null = null;
    private _clipId: string | null = null;
    private _store: SegmentStore | null = null;
    private _scheduler: SegmentScheduler | null = null;
    private _timer: ReturnType<typeof setInterval> | null = null;
    private _waiting: number | null = null;
    private _peaks: (PeaksFile & { headerBytes: number }) | null = null;
    private _merged = new Map<number, WaveformPeakLevel>();
    private _spectro: SpectrogramFile | null = null;
    private _visible: number[] = [];
    private _view: { start: number; end: number } | null = null;
    private _window: WindowAudio | null = null;
    private _pausedFrame = 0;
    private _playStartedAt = 0;
    private _loadStartedAt = 0;
    private _seekStartedAt: number | null = null;
    private _stats = SegmentedSource._freshStats();

    constructor(host: SourceHost, options: SegmentedOptions = {}) {
        this._host = host;
        this._options = options;
    }

    private static _freshStats() {
        return {
            underruns: 0, seekLatencies: [] as number[], startLatencyMs: null as number | null,
            coarse: 0, fine: 0, bands: 0, spectroCoarse: 0, spectroFine: 0, spectroReadyMs: null as number | null,
        };
    }

    private get _state(): AudioPlayerState {
        return this._host.getState();
    }

    private _update(patch: Partial<AudioPlayerState>): void {
        this._host.update(patch);
    }

    get manifest(): AudioManifest | null {
        return this._manifest;
    }

    isLoaded(clip: ClipInfo): boolean {
        return !!this._manifest && clip.id === this._clipId;
    }

    getCurrentTime(): number | null {
        const m = this._manifest;
        if (!m) return null;
        if (this._eng) return (this._engPlaying ? this._eng.position() : this._pausedFrame) / m.sampleRate;
        const ctx = this._engine?.context;
        if (this._scheduler?.running && ctx) return this._scheduler.positionAt(ctx.currentTime) / m.sampleRate;
        return this._pausedFrame / m.sampleRate;
    }

    stats(): StreamStats | null {
        const m = this._manifest;
        const store = this._store?.stats();
        if (!m || !store) return null;
        const bytesPerSecond = m.sampleRate * m.channels * 4;
        return {
            ...store,
            cachedSeconds: store.cachedBytes / bytesPerSecond,
            peakCachedSeconds: store.peakCachedBytes / bytesPerSecond,
            capSeconds: store.maxBytes / bytesPerSecond,
            seekLatencies: [...this._stats.seekLatencies],
            startLatencyMs: this._stats.startLatencyMs,
            peaksCoarseBytes: this._stats.coarse,
            peaksFineBytes: this._stats.fine,
            bandsBytes: this._stats.bands,
            spectrogramCoarseBytes: this._stats.spectroCoarse,
            spectrogramFineBytes: this._stats.spectroFine,
            spectrogramReadyMs: this._stats.spectroReadyMs,
            playback: this._eng ? 'engine' : this._scheduler ? 'scheduler' : null,
            fetchesB: this._storeB?.stats().fetches ?? 0,
            underruns: this._eng ? (this._lastReport?.underruns ?? 0) : this._stats.underruns,
            underrunFrames: this._lastReport?.underrunFrames ?? 0,
            stretch: { ready: !!this._eng?.stretch.ready, latencyFrames: this._eng?.stretch.latencyFrames ?? 0, active: !!this._lastReport?.stretching, split: !!this._lastReport?.splitting },
        };
    }

    // ---- transport ---------------------------------------------------------------------

    async load(clip: ClipInfo, startAt: number | undefined, autoplay: boolean): Promise<boolean> {
        if (this._disposed || !clip.manifest) return false;
        const loadId = ++this._loadId;
        this._playId += 1;
        // What the previous load still fetches is let go.
        this._abort?.abort();
        const abort = new AbortController();
        this._abort = abort;
        this._halt();
        // The previous clip goes silent now (not when the new manifest is in), and
        // nothing of its stem carries over to the new one.
        this._disposeEngine();
        this._clearStem();
        this._store?.dispose();
        this._store = null;
        this._scheduler = null;
        this._manifest = null;
        this._files = null;
        this._peaks = null;
        this._spectro = null;
        this._merged.clear();
        this._window = null;
        this._visible = [];
        this._stats = SegmentedSource._freshStats();
        const url = new URL(clip.manifest, typeof location !== 'undefined' ? location.href : undefined).href;
        this._clipId = clip.id;
        this._autoplay = autoplay;
        this._wantStem = clip.stem ?? null;
        this._playStartedAt = performance.now();
        this._loadStartedAt = this._playStartedAt;
        this._update({
            clipId: clip.id, src: clip.manifest, status: 'loading', progress: 0, error: null, isPlaying: false,
            currentTime: 0, duration: 0, ended: false, loop: null, startedAt: null, playbackStartPoint: 0,
            pendingSpeed: null, statusB: 'unavailable', stem: null, buffer: null, bufferB: null, mixLaw: this._host.options.mixLaw ?? 'crossfade',
            playRequestId: this._state.playRequestId + 1, manifest: null, buffering: autoplay,
            prepared: { peaks: null, bands: null, spectrogram: null },
        });
        const output = this._host.ensureOutput();
        // play() while the clip is still being set up waits for it (the engine is made last).
        let settle!: () => void;
        this._settling = new Promise<void>((resolve) => { settle = resolve; });
        try {
            const { fetchOptions, fetchOptionsOrigins } = this._host.options;
            const files = new FileAccess(url, { fetchOptions, fetchOptionsOrigins, signal: abort.signal });
            const response = await fetch(url, files.init(url));
            if (!response.ok) throw new Error(`Manifest: HTTP ${response.status}`);
            const manifest: unknown = await response.json();
            assertManifest(manifest);
            files.check(manifest);
            if (loadId !== this._loadId) return false;
            this._manifest = manifest;
            this._files = files;
            void this._loadPeaks(loadId);
            void this._loadBands(loadId);
            void this._loadSpectrogram(loadId);
            const start = clampTime(startAt ?? 0, manifest.duration);
            this._pausedFrame = this._frameOf(start);
            this._update({
                status: 'ready', progress: 1, duration: manifest.duration, manifest,
                currentTime: start, playbackStartPoint: start,
            });
            const out = await output;
            if (!out || loadId !== this._loadId) return false;
            this._engine = out.engine;
            const cacheSeconds = this._options.cacheSeconds ?? 60;
            this._store = new SegmentStore(files, manifest, {
                maxBytes: Math.max(1, cacheSeconds) * manifest.sampleRate * manifest.channels * 4,
            });
            this._store.onLoad((index) => this._onSegment(index));
            this._store.onError((index, error, failures) => this._onSegmentError(index, error, failures));
            this._scheduler = new SegmentScheduler(out.ctx, out.input, manifest.segments.list, manifest.sampleRate);
            this._scheduler.setRate(this._state.processing.speed);
            await this._createEngine(out.ctx, out.input, manifest, loadId);
            if (loadId !== this._loadId) return false;
            this._applyStems(manifest);
            settle();
            this._host.emit('load', { clipId: clip.id, duration: manifest.duration });
            if (this._view) this.setView(this._view.start, this._view.end);
            // A pause or stop while the clip was being set up cancels the autoplay (a resume asks again).
            if (this._autoplay) return this._startAt(null, 'play');
            if (autoplay) this._update({ buffering: false });
            void this._store.load(this._scheduler.segmentAt(this._pausedFrame));
            return true;
        } catch (error) {
            if (loadId !== this._loadId) return false;
            const err = error instanceof Error ? error : new Error(String(error));
            this._update({ status: 'error', error: err, buffering: false });
            this._host.emit('error', err);
            return false;
        } finally {
            settle();
        }
    }

    restart(startAt: number): Promise<boolean> {
        this.setLoop(null);
        return this._startAt(this._frameOf(startAt), 'play');
    }

    async resume(): Promise<void> {
        if (!this._manifest) {
            // Still loading: play once it is set up.
            if (this._state.status === 'loading') this._autoplay = true;
            return;
        }
        // From where playback rests once the clip is set up: a seek meanwhile moves it.
        await this._startAt(null, 'play');
    }

    pause = async (): Promise<void> => {
        this._playId += 1;
        this._autoplay = false;
        const m = this._manifest;
        if (!m || !this._scheduler) {
            if (this._state.buffering) this._update({ buffering: false });
            return;
        }
        let frame = Math.floor((this.getCurrentTime() ?? 0) * m.sampleRate);
        if (this._state.pauseMode === 'reset') frame = this._frameOf(this._state.playbackStartPoint);
        if (this._eng) {
            this._eng.pause();
            this._engPlaying = false;
            this._pendingLatency = null;
            if (this._state.pauseMode === 'reset') this._eng.seek(frame);
        }
        this._halt();
        this._pausedFrame = frame;
        this._update({ isPlaying: false, buffering: false, currentTime: frame / m.sampleRate, startedAt: null, ended: false });
    };

    stop = (): void => {
        this._playId += 1;
        this._autoplay = false;
        if (this._eng) {
            this._eng.pause();
            this._eng.seek(0);
            this._engPlaying = false;
            this._pendingLatency = null;
        }
        this._halt();
        this._pausedFrame = 0;
        this._update({ isPlaying: false, buffering: false, currentTime: 0, startedAt: null, ended: false });
    };

    seek = async (time: number): Promise<void> => {
        const m = this._manifest;
        if (!m) return;
        const frame = this._frameOf(clampTime(time, m.duration));
        if (this._state.isPlaying) {
            this._seekStartedAt = performance.now();
            await this._startAt(frame, 'seek');
            return;
        }
        this._pausedFrame = frame;
        this._eng?.seek(frame);
        this._update({ currentTime: frame / m.sampleRate, playbackStartPoint: frame / m.sampleRate, ended: false });
        if (this._scheduler) void this._store?.load(this._scheduler.segmentAt(frame), true);
    };

    /** Loop a range in seconds (null clears). Snapped to zero crossings when the boundary segments are loaded. */
    setLoop = (range: LoopRange | null): void => {
        const m = this._manifest;
        const scheduler = this._scheduler;
        if (!m || !scheduler) {
            this._update({ loop: range });
            return;
        }
        const snapped = range ? this._snap(range) : null;
        const frames = snapped ? { start: this._frameOf(snapped.start), end: Math.min(m.frames, this._frameOf(snapped.end)) } : null;
        this._update({ loop: snapped });
        const ctx = this._engine?.context;
        if (frames) void this._store?.load(scheduler.segmentAt(frames.start)); // pre-load the wrap target
        if (this._eng) {
            const position = this.getCurrentTime() ?? 0;
            this._eng.setLoop(frames);
            if (snapped && this._engPlaying && position >= snapped.end) void this.seek(snapped.start);
            else if (this._engPlaying) this._pump();
            return;
        }
        if (!scheduler.running || !ctx) {
            scheduler.setLoop(frames);
            return;
        }
        const position = this.getCurrentTime() ?? 0;
        scheduler.setLoop(frames);
        if (snapped && position >= snapped.end) {
            void this.seek(snapped.start);
            return;
        }
        scheduler.reanchor(this._alignedTime(ctx.currentTime + LOOKAHEAD));
        this._pump();
    };

    /** The knob moved: smoothed gains in the engine; B is fetched only while it is wanted. */
    setMix(mix: number): void {
        this._mix = mix;
        if (!this._stemB || this._stemB.status !== 'ready') return;
        // Prefetch as soon as the knob moves, keep B for 10 s after it is back at 0.
        this._bWantedUntil = performance.now() + 10000;
        if (mix > 0 && !this._bOverviewAsked) {
            this._bOverviewAsked = true;
            void this._loadOverviewB(this._loadId);
        }
        this._applyMix();
        if (this._eng && this._manifest) {
            const frame = this._engPlaying ? this._eng.position() : this._pausedFrame;
            this._feedEngine(this._wantedEngine(frame));
        }
    }

    private _mixLaw(): MixLaw {
        return this._host.options.mixLaw ?? this._stemB?.mixLaw ?? 'crossfade';
    }

    private _applyMix(): void {
        const stem = this._stemB;
        if (!this._eng) return;
        if (!stem || stem.status !== 'ready') {
            this._eng.setMix(1, 0);
            return;
        }
        const [a, b] = mixGains(this._mix, this._mixLaw());
        this._eng.setMix(a, b * Math.pow(10, (stem.gainDb ?? 0) / 20));
    }

    private _bWanted(): boolean {
        return !!this._storeB && (this._mix > 0 || performance.now() < this._bWantedUntil);
    }

    /** Re-read the manifest; a stem that became ready is attached without a reload. */
    async refreshManifest(): Promise<void> {
        const m = this._manifest;
        const files = this._files;
        const ctx = this._engine?.context;
        if (!m || !files || !ctx) return;
        const loadId = this._loadId;
        try {
            const response = await fetch(files.manifestUrl, files.init(files.manifestUrl, { cache: 'no-store' }));
            if (!response.ok) return;
            const next: unknown = await response.json();
            assertManifest(next);
            if (loadId !== this._loadId || (next.revision ?? 1) <= (m.revision ?? 1)) return;
            // Another recording (or another grid) behind the URL is no newer revision of this clip: keep what plays.
            if (next.id !== m.id || next.sampleRate !== m.sampleRate || next.channels !== m.channels || !SegmentedSource._sameGrid(next.segments.list, m.segments.list)) {
                console.warn('[AudioPlayer] manifest refresh ignored: it describes another recording than the one playing');
                return;
            }
            files.check(next);
            this._manifest = { ...m, revision: next.revision, stems: SegmentedSource._stemsFor(next, m) };
            this._applyStems(this._manifest);
        } catch (error) {
            if (loadId === this._loadId) console.warn('[AudioPlayer] manifest refresh failed', error);
        }
    }

    /**
     * A refreshed manifest's stems that belong to the clip playing: made from this A
     * (`aSourceId`, when given) and, when ready, on its grid. One that does not is not
     * taken: the entry the clip had under that key stays.
     */
    private static _stemsFor(next: AudioManifest, current: AudioManifest): ManifestStems | undefined {
        if (!next.stems) return undefined;
        const out: ManifestStems = {};
        for (const [key, stem] of Object.entries(next.stems)) {
            const fits = (stem.aSourceId === undefined || stem.aSourceId === current.id)
                && (stem.status !== 'ready' || (!!stem.segments && SegmentedSource._sameGrid(stem.segments.list, current.segments.list)));
            if (fits) {
                out[key] = stem;
            } else {
                console.warn(`[AudioPlayer] manifest refresh: stem ${JSON.stringify(key)} was not made from the recording playing; not taken`);
                if (current.stems?.[key]) out[key] = current.stems[key];
            }
        }
        return out;
    }

    /** Whether two segment lists cut the timeline in the same places. */
    private static _sameGrid(a: ManifestSegment[], b: ManifestSegment[]): boolean {
        return a.length === b.length && a.every((s, i) => s.startFrame === b[i].startFrame && s.frames === b[i].frames);
    }

    /**
     * The stem the knob should blend with: the one asked for; else 'b' when it is
     * ready, else the first ready one; else 'b' or the first listed (not ready:
     * no blend, but its status shows, e.g. 'processing' with polling).
     */
    private _pickStem(manifest: AudioManifest): string | null {
        const stems = manifest.stems ?? {};
        if (this._wantStem && stems[this._wantStem]) return this._wantStem;
        const ready = readyStemKeys(manifest);
        if (ready.includes(DEFAULT_STEM_KEY)) return DEFAULT_STEM_KEY;
        return ready[0] ?? (stems[DEFAULT_STEM_KEY] ? DEFAULT_STEM_KEY : Object.keys(stems)[0] ?? null);
    }

    /**
     * Choose which stem the knob blends with. One stem is active at a time;
     * switching lets go of the previous one's segments and overview. Returns
     * false when no manifest is loaded or it has no such stem. null: the default choice.
     */
    setStem(key: string | null): boolean {
        const m = this._manifest;
        if (!m) return false;
        if (key !== null && !m.stems?.[key]) {
            console.warn(`[AudioPlayer] the manifest has no stem ${JSON.stringify(key)}`);
            return false;
        }
        this._wantStem = key;
        const ctx = this._engine?.context;
        // Still being set up: _applyStems() picks it up.
        if (!ctx || !this._store) return true;
        if (this._pickStem(m) === this._stemKey) return true;
        this._releaseStem();
        this._applyStems(m);
        return true;
    }

    /** Let go of the active stem: its store, its segments in the engine, its overview. */
    private _releaseStem(): void {
        this._eng?.resetB();
        this._storeB?.dispose();
        this._storeB = null;
        this._stemB = null;
        this._stemKey = null;
        this._bOverviewAsked = false;
        this._window = null;
        const prepared = this._state.prepared;
        if (prepared && (prepared.peaksB || prepared.bandsB || prepared.spectrogram?.levels.some((l) => l.b))) {
            const spectrogram = prepared.spectrogram
                ? { ...prepared.spectrogram, referenceSum: prepared.spectrogram.referenceMax, levels: prepared.spectrogram.levels.map((l) => ({ ...l, b: null })) }
                : null;
            this._publish({ peaksB: null, bandsB: null, spectrogram }, 'spectrogram');
        }
    }

    private _applyStems(manifest: AudioManifest): void {
        const key = this._pickStem(manifest);
        if (key !== this._stemKey && this._stemKey !== null) this._releaseStem();
        const stem = key ? manifest.stems![key] : null;
        const was = this._stemB;
        this._stemB = stem;
        this._stemKey = key;
        if (this._pollTimer) clearInterval(this._pollTimer);
        this._pollTimer = null;
        if (stem?.status === 'processing') {
            // Poll until the server job is done (or the clip changes).
            const every = this._options.pollStemsMs ?? 0;
            if (every > 0) this._pollTimer = setInterval(() => void this.refreshManifest(), every);
        }
        // A new store for a stem that became ready, and for a ready one that was replaced
        // (a newer revision re-processed it): the old B's segments are let go everywhere.
        const replaced = !!was && was.status === 'ready' && stem?.status === 'ready' && SegmentedSource._stemSignature(was) !== SegmentedSource._stemSignature(stem);
        if (replaced) this._eng?.resetB();
        const files = this._files;
        if (stem?.status === 'ready' && stem.segments && files && (was?.status !== 'ready' || !this._storeB || replaced)) {
            const shim = { ...manifest, segments: stem.segments } as AudioManifest;
            this._storeB?.dispose();
            this._storeB = new SegmentStore(files, shim, {
                maxBytes: Math.max(1, this._options.cacheSeconds ?? 60) * manifest.sampleRate * manifest.channels * 4,
            });
            this._storeB.onError((index, error, failures) => {
                // A source that cannot be read (SourceError) is let go at once: retries would not help.
                if (error instanceof SourceError || failures >= SEGMENT_FAILURES_MAX) this._failStemB(index, error);
            });
            this._storeB.onLoad((index) => {
                if (this._eng && this._bWanted()) this._feedEngine(this._wantedEngine(this._engPlaying ? this._eng.position() : this._pausedFrame));
                if (this._visible.includes(index)) this._host.emit('sourceupdate', { clipId: this._clipId, what: 'segment' });
            });
            this._bOverviewAsked = false;
            if (this._mix > 0) {
                this._bOverviewAsked = true;
                void this._loadOverviewB(this._loadId);
            }
        }
        this.capabilities = SegmentedSource._caps(this.capabilities.canPreservePitch, stem?.status === 'ready', SegmentedSource._stemList(manifest));
        this._update({
            capabilities: this.capabilities,
            manifest,
            stem: key,
            mixLaw: this._mixLaw(),
            // A stem that is not ready is no stem B, unless the host opted into the 'processing' flow.
            statusB: stem?.status === 'ready' ? (this._storeB ? 'ready' : 'idle') : stem?.status === 'processing' && (this._options.pollStemsMs ?? 0) > 0 ? 'processing' : 'unavailable',
        });
        this._applyMix();
        if (stem?.status === 'ready' && was?.status !== 'ready' && was) this._host.emit('bload', { clipId: this._clipId ?? '' });
    }

    /**
     * A segment of A keeps failing. Where the playhead needs it, playback cannot go
     * on: pause with an error (a seek elsewhere still plays; the store retries slowly).
     */
    private _onSegmentError(index: number, error: Error, failures: number): void {
        const m = this._manifest;
        const scheduler = this._scheduler;
        if (!m || !scheduler) return;
        if (error instanceof SourceError) {
            this._failSource(error);
            return;
        }
        if (failures < SEGMENT_FAILURES_MAX || !this._state.isPlaying) return;
        const frame = Math.floor((this.getCurrentTime() ?? 0) * m.sampleRate);
        if (scheduler.segmentAt(Math.min(m.frames - 1, frame)) !== index && this._waiting !== index) return;
        const err = new Error(`Segment ${index} failed ${failures} times: ${error.message}`);
        void this.pause();
        this._update({ error: err });
        this._host.emit('error', err);
    }

    /**
     * A's source cannot be played as its manifest says (a SourceError: the server
     * ignores Range requests, the file changed): no segment will load, so playback
     * stops with the error at once, and every later start fails with it.
     */
    private _failSource(error: Error): void {
        if (this._state.isPlaying) void this.pause();
        else if (this._state.buffering) this._update({ buffering: false });
        this._update({ error });
        this._host.emit('error', error);
    }

    /** Stem B keeps failing: let it go, A plays on alone and statusB says why. */
    private _failStemB(index: number, error: Error): void {
        console.warn(`[AudioPlayer] stem B segment ${index} keeps failing; playing A alone`, error);
        this._releaseStem();
        this._applyMix();
        this.capabilities = SegmentedSource._caps(this.capabilities.canPreservePitch, false, this.capabilities.stems);
        this._update({ capabilities: this.capabilities, statusB: 'error' });
    }

    /** What tells two versions of a stem apart (a re-processed stem gets new files). */
    private static _stemSignature(stem: ManifestStem): string {
        return `${stem.id ?? ''}|${stem.updatedAt}|${stem.segments?.source.url ?? ''}`;
    }

    /** The manifest's stems, for `capabilities.stems` (ready ones, in manifest order). */
    private static _stemList(manifest: AudioManifest): StemSummary[] {
        return readyStemKeys(manifest).map((key) => ({ key, label: manifest.stems![key].label ?? null }));
    }

    /** The active stem's peaks, bands and spectrogram, for the blended overview (loaded when the mix first asks). */
    private async _loadOverviewB(loadId: number): Promise<void> {
        const stem = this._stemB;
        const key = this._stemKey;
        const files = this._files;
        if (!stem || stem.status !== 'ready' || !files) return;
        const get = async (url?: string) => {
            if (!url) return null;
            const href = files.resolve(url);
            const response = await fetch(href, files.init(href));
            return response.ok ? response.arrayBuffer() : null;
        };
        try {
            const [peaks, bands, spectro] = await Promise.all([get(stem.peaks?.url), get(stem.bands?.url), get(stem.spectrogram?.url)]);
            if (loadId !== this._loadId || key !== this._stemKey) return;
            const prepared = this._state.prepared ?? { peaks: null, bands: null, spectrogram: null };
            const patch: Partial<PreparedOverview> = { correlated: (stem.correlation?.global ?? 1) >= 0.5 };
            if (peaks) patch.peaksB = peaksToPyramid(decodePeaksFile(peaks), new Map());
            if (bands) patch.bandsB = decodeBandsFile(bands);
            if (spectro && prepared.spectrogram) {
                const fileB = decodeSpectrogramFile(spectro);
                const a = prepared.spectrogram;
                const b = toSpectralPyramid(fileB);
                if (b && b.levels.length === a.levels.length) {
                    patch.spectrogram = {
                        ...a,
                        referenceSum: a.referenceMax + fileB.referenceMax,
                        referenceMax: Math.max(a.referenceMax, fileB.referenceMax),
                        levels: a.levels.map((level, i) => ({ ...level, b: b.levels[i].a })),
                    };
                }
            }
            this._publish(patch, 'spectrogram');
        } catch (error) {
            if (loadId === this._loadId) console.warn('[AudioPlayer] stem B overview unavailable', error);
        }
    }

    setSourceB = async (): Promise<boolean> => false;

    /** Native playbackRate: pitch follows the speed (capabilities.canPreservePitch is false). */
    setSpeed = async (value: number): Promise<void> => {
        this._update({ processing: { ...this._state.processing, speed: value }, pendingSpeed: null });
        if (this._eng) {
            // Realtime in the engine: the stretcher keeps the pitch; the blend in and out of it is smoothed.
            this._eng.setRate(value);
            return;
        }
        const scheduler = this._scheduler;
        const ctx = this._engine?.context;
        if (!scheduler) return;
        if (scheduler.running && ctx) {
            scheduler.reanchor(this._alignedTime(ctx.currentTime + LOOKAHEAD));
            scheduler.setRate(value);
            this._pump();
        } else {
            scheduler.setRate(value);
        }
    };

    /**
     * The timeline's visible range. Views up to WINDOW_MAX_SECONDS get their
     * segments (with a quarter of the view as margin) decoded for the exact
     * waveform preview and the live spectrogram; see getWindowAudio().
     */
    setView(start: number, end: number): void {
        this._view = { start, end };
        const m = this._manifest;
        const scheduler = this._scheduler;
        const store = this._store;
        if (!m || !scheduler || !store) return;
        const span = end - start;
        if (!(span > 0) || span > WINDOW_MAX_SECONDS) {
            this._visible = [];
            return;
        }
        const from = this._frameOf(Math.max(0, start - span / 4));
        const to = this._frameOf(Math.min(m.duration, end + span / 4));
        let first = scheduler.segmentAt(from);
        let last = scheduler.segmentAt(Math.max(from, to - 1));
        // Too many segments for the window: keep those nearest the view's centre.
        while (last - first + 1 > WINDOW_MAX_SEGMENTS) {
            const centre = this._frameOf((start + end) / 2);
            const segs = m.segments.list;
            if (centre - segs[first].startFrame > segs[last].startFrame + segs[last].frames - centre) first += 1;
            else last -= 1;
        }
        const visible: number[] = [];
        for (let i = first; i <= last; i += 1) visible.push(i);
        this._visible = visible;
        for (const i of visible) if (!store.has(i)) void store.load(i, true);
    }

    /** Decoded audio of the window around the view, once all its segments are in; null otherwise. */
    getWindowAudio(): WindowAudio | null {
        const m = this._manifest;
        const store = this._store;
        if (!m || !store || this._visible.length === 0) return null;
        const key = `${this._clipId}:${this._visible.join(',')}`;
        const wantB = !!this._storeB && this._bWanted() && this._visible.every((i) => this._storeB!.has(i));
        if (this._window?.key === `${key}|${wantB ? 'b' : ''}`) return this._window;
        const buffers = this._visible.map((i) => store.get(i));
        if (buffers.some((b) => !b)) return null;
        const segs = this._visible.map((i) => m.segments.list[i]);
        const length = segs.reduce((n, s) => n + s.frames, 0);
        const first = buffers[0]!;
        const buffer = new AudioBuffer({ length, numberOfChannels: first.numberOfChannels, sampleRate: first.sampleRate });
        let offset = 0;
        buffers.forEach((b, k) => {
            for (let c = 0; c < buffer.numberOfChannels; c += 1) buffer.copyToChannel(b!.getChannelData(c).subarray(0, segs[k].frames), c, offset);
            offset += segs[k].frames;
        });
        let bufferB: AudioBuffer | null = null;
        const storeB = this._storeB;
        if (storeB && this._bWanted()) {
            const bs = this._visible.map((i) => storeB.get(i));
            if (bs.every(Boolean)) {
                bufferB = new AudioBuffer({ length, numberOfChannels: first.numberOfChannels, sampleRate: first.sampleRate });
                let o = 0;
                bs.forEach((b, k) => {
                    for (let c = 0; c < bufferB!.numberOfChannels; c += 1) bufferB!.copyToChannel(b!.getChannelData(Math.min(c, b!.numberOfChannels - 1)).subarray(0, segs[k].frames), c, o);
                    o += segs[k].frames;
                });
            } else {
                for (const i of this._visible) if (!storeB.has(i)) void storeB.load(i);
            }
        }
        this._window = { buffer, bufferB, startFrame: segs[0].startFrame, sampleRate: m.sampleRate, key: `${key}|${bufferB ? 'b' : ''}` };
        return this._window;
    }

    /** Forget the active stem entirely (a new clip, or unload): store, poll, overview flags. */
    private _clearStem(): void {
        if (this._pollTimer) clearInterval(this._pollTimer);
        this._pollTimer = null;
        this._storeB?.dispose();
        this._storeB = null;
        this._stemB = null;
        this._stemKey = null;
        this._bOverviewAsked = false;
        this._bWantedUntil = 0;
    }

    unload(): void {
        this._loadId += 1;
        this._playId += 1;
        this._abort?.abort();
        this._abort = null;
        this._clearStem();
        this._disposeEngine();
        this._halt();
        this._store?.dispose();
        this._store = null;
        this._scheduler = null;
        this._manifest = null;
        this._files = null;
        this._clipId = null;
        this._window = null;
        this._visible = [];
    }

    dispose(): void {
        this.unload();
        this._disposed = true;
        this._view = null;
    }

    reactivate(): void {
        this._disposed = false;
    }

    // ---- prepared overview ---------------------------------------------------------------

    private _publish(patch: Partial<PreparedOverview>, what: 'peaks' | 'bands' | 'spectrogram'): void {
        const prepared = this._state.prepared ?? { peaks: null, bands: null, spectrogram: null };
        this._update({ prepared: { ...prepared, ...patch } });
        this._host.emit('sourceupdate', { clipId: this._clipId, what });
    }

    /** A file of the clip, or (`from`) a byte range of it: `partial` false when the server sent all of it. */
    private async _fetchFile(files: FileAccess, url: string, from?: number, to?: number): Promise<{ buffer: ArrayBuffer; partial: boolean }> {
        const range = from === undefined ? undefined : `bytes=${from}-${to === undefined ? '' : to}`;
        const response = await fetch(url, files.init(url, { range }));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return { buffer: await response.arrayBuffer(), partial: response.status === 206 };
    }

    /** Header + coarse levels in one Range request, then the finest level. */
    private async _loadPeaks(loadId: number): Promise<void> {
        const m = this._manifest;
        const files = this._files;
        if (!m || !files) return;
        const url = files.resolve(m.peaks.url);
        const finest = [...m.peaks.levels].sort((a, b) => a.framesPerPeak - b.framesPerPeak)[0];
        try {
            const first = m.peaks.levels.length > 1 && finest
                ? await this._fetchFile(files, url, 0, finest.byteOffset - 1)
                : await this._fetchFile(files, url);
            if (loadId !== this._loadId) return;
            this._peaks = decodePeaksFile(first.buffer);
            this._stats.coarse = first.buffer.byteLength;
            this._publish({ peaks: peaksToPyramid(this._peaks, this._merged) }, 'peaks');
            const missing = this._peaks.levels.findIndex((level) => !level.channels);
            if (missing < 0 || !finest) return;
            const rest = await this._fetchFile(files, url, finest.byteOffset, finest.byteOffset + finest.byteLength - 1);
            if (loadId !== this._loadId || !this._peaks) return;
            this._stats.fine = rest.buffer.byteLength;
            const level = this._peaks.levels[missing];
            level.channels = readLevel(rest.buffer, rest.partial ? 0 : finest.byteOffset, level.peaks, this._peaks.channels);
            this._publish({ peaks: peaksToPyramid(this._peaks, this._merged) }, 'peaks');
        } catch (error) {
            if (loadId === this._loadId) console.warn('[AudioPlayer] peaks unavailable; the waveform stays empty', error);
        }
    }

    private async _loadBands(loadId: number): Promise<void> {
        const m = this._manifest;
        const files = this._files;
        if (!m?.bands || !files) return; // v1 manifest: no high-pass approximation
        try {
            const { buffer } = await this._fetchFile(files, files.resolve(m.bands.url));
            if (loadId !== this._loadId) return;
            this._stats.bands = buffer.byteLength;
            this._publish({ bands: decodeBandsFile(buffer) }, 'bands');
        } catch (error) {
            if (loadId === this._loadId) console.warn('[AudioPlayer] bands unavailable; the high-pass preview is skipped outside the decoded window', error);
        }
    }

    /** Header + coarse levels first (one Range request), then the finest level. */
    private async _loadSpectrogram(loadId: number): Promise<void> {
        const m = this._manifest;
        const spec = m?.spectrogram;
        const files = this._files;
        if (!m || !spec || !files) return;
        const url = files.resolve(spec.url);
        const finest = [...spec.levels].sort((a, b) => a.framesPerColumn - b.framesPerColumn)[0];
        try {
            const first = spec.levels.length > 1 && finest
                ? await this._fetchFile(files, url, 0, finest.byteOffset - 1)
                : await this._fetchFile(files, url);
            if (loadId !== this._loadId) return;
            this._spectro = decodeSpectrogramFile(first.buffer);
            this._stats.spectroCoarse = first.buffer.byteLength;
            this._stats.spectroReadyMs = performance.now() - this._loadStartedAt;
            this._publish({ spectrogram: toSpectralPyramid(this._spectro) }, 'spectrogram');
            const missing = this._spectro.levels.findIndex((level) => !level.a);
            if (missing < 0 || !finest) return;
            const rest = await this._fetchFile(files, url, finest.byteOffset, finest.byteOffset + finest.byteLength - 1);
            if (loadId !== this._loadId || !this._spectro) return;
            this._stats.spectroFine = rest.buffer.byteLength;
            const offset = rest.partial ? 0 : finest.byteOffset;
            this._spectro.levels[missing].a = new Uint8Array(rest.buffer, offset, finest.byteLength);
            this._publish({ spectrogram: toSpectralPyramid(this._spectro) }, 'spectrogram');
        } catch (error) {
            if (loadId === this._loadId) console.warn('[AudioPlayer] spectrogram overview unavailable', error);
        }
    }

    // ---- playback ---------------------------------------------------------------------------

    private _frameOf(seconds: number): number {
        const m = this._manifest;
        return m ? Math.max(0, Math.min(m.frames, Math.round(seconds * m.sampleRate))) : 0;
    }

    /** A context time on a sample frame, so consecutive segments land on frames too. */
    private _alignedTime(t: number): number {
        const rate = this._engine?.context?.sampleRate ?? 48000;
        return Math.ceil(t * rate) / rate;
    }

    /** Play from `at` (a frame), or with null from where playback rests, read once the clip is set up. */
    private async _startAt(at: number | null, reason: 'play' | 'seek'): Promise<boolean> {
        const loadId = this._loadId;
        // Taken before the wait: a pause, stop or newer start while the clip is set up wins.
        const playId = ++this._playId;
        await this._settling;
        if (loadId !== this._loadId || playId !== this._playId) return false;
        const m = this._manifest;
        const store = this._store;
        const scheduler = this._scheduler;
        const engine = this._engine;
        if (!m || !store || !scheduler || !engine?.context) return false;
        if (store.broken) {
            this._failSource(store.broken);
            return false;
        }
        let frame = at ?? this._pausedFrame;
        if (this._eng) return this._startEngine(frame, reason, playId);
        const ctx = engine.context;
        const loop = this._state.loop;
        if (loop && frame >= this._frameOf(loop.end)) frame = this._frameOf(loop.start);
        if (frame >= m.frames) frame = 0;
        scheduler.stop();
        this._waiting = null;
        this._pausedFrame = frame;
        const t = frame / m.sampleRate;
        if (reason === 'play') this._playStartedAt = performance.now();
        this._update({
            isPlaying: true, buffering: true, currentTime: t, playbackStartPoint: t, ended: false,
            playRequestId: reason === 'play' ? this._state.playRequestId + 1 : this._state.playRequestId,
        });
        const index = scheduler.segmentAt(frame);
        // A seek far away: drop loads that no longer matter.
        store.cancelExcept(new Set(this._wanted(frame)));
        const [buffer, resumed] = await Promise.all([store.load(index, true), engine.resume()]);
        if (playId !== this._playId || this._disposed) return false;
        if (!buffer || !resumed) {
            this._update({ isPlaying: false, buffering: false });
            return false;
        }
        scheduler.start(frame, this._alignedTime(ctx.currentTime + LOOKAHEAD));
        this._pump();
        const latency = performance.now() - (reason === 'seek' && this._seekStartedAt !== null ? this._seekStartedAt : this._playStartedAt);
        if (reason === 'seek') {
            this._stats.seekLatencies.push(latency);
            this._seekStartedAt = null;
        } else if (this._stats.startLatencyMs === null) {
            this._stats.startLatencyMs = latency;
        }
        this._timer ??= setInterval(() => this._pump(), PUMP_MS);
        this._update({ buffering: false, startedAt: ctx.currentTime + LOOKAHEAD });
        return true;
    }

    /** Stop the audio and the pump, keep the clip. */
    private _halt(): void {
        this._scheduler?.stop();
        this._waiting = null;
        if (this._timer) clearInterval(this._timer);
        this._timer = null;
    }

    /** Segments that matter now, most important first: playing, next, loop start, on screen, prefetch. */
    private _wanted(frame: number): number[] {
        const scheduler = this._scheduler;
        const m = this._manifest;
        if (!scheduler || !m) return [];
        const ctx = this._engine?.context;
        const out: number[] = [];
        const add = (i: number) => {
            if (i >= 0 && i < m.segments.list.length && !out.includes(i)) out.push(i);
        };
        if (ctx && scheduler.running) for (const i of scheduler.activeSegments(ctx.currentTime)) add(i);
        const current = scheduler.segmentAt(frame);
        add(current);
        // Ahead along the play path: wraps to the loop start inside a loop.
        const loop = this._state.loop;
        const loopFrames = loop ? { start: this._frameOf(loop.start), end: this._frameOf(loop.end) } : null;
        let cursor = scheduler.running ? scheduler.cursorFrame : frame;
        const ahead = Math.max(1, this._options.prefetchSegments ?? 2);
        const path: number[] = [];
        for (let k = 0; k <= ahead && path.length <= ahead; k += 1) {
            if (loopFrames && cursor >= loopFrames.end) cursor = loopFrames.start;
            if (cursor >= m.frames) {
                if (!loopFrames) break;
                cursor = loopFrames.start;
            }
            const i = scheduler.segmentAt(cursor);
            path.push(i);
            const seg = m.segments.list[i];
            cursor = seg.startFrame + seg.frames;
        }
        add(path[0] ?? current);
        add(path[1] ?? -1);
        if (loopFrames) add(scheduler.segmentAt(loopFrames.start));
        for (const i of this._visible) add(i);
        for (const i of path) add(i);
        return out;
    }

    private _pump(): void {
        if (this._eng) {
            this._pumpEngine();
            return;
        }
        const scheduler = this._scheduler;
        const store = this._store;
        const m = this._manifest;
        const ctx = this._engine?.context;
        if (!scheduler || !store || !m || !ctx || !scheduler.running) return;
        const now = ctx.currentTime;
        const horizon = now + (this._options.scheduleAheadSeconds ?? 2);
        const needed = scheduler.pump(horizon, (i) => store.get(i));
        if (needed !== null) {
            this._waiting = needed;
            void store.load(needed, true);
            if (scheduler.starvedAt(now) && !this._state.buffering) {
                this._stats.underruns += 1;
                this._update({ buffering: true });
            }
        } else {
            this._waiting = null;
        }
        const frame = scheduler.positionAt(now);
        const wanted = store.withinBudget(this._wanted(frame));
        for (const i of wanted) if (!store.has(i)) void store.load(i);
        store.evict(wanted, 2);
        if (scheduler.endedAt(now)) {
            this._halt();
            this._pausedFrame = 0;
            this._update({ isPlaying: false, buffering: false, ended: true, currentTime: m.duration, startedAt: null });
            this._host.emit('timeupdate', m.duration);
            this._host.emit('ended', { clipId: this._state.clipId });
            return;
        }
        const t = frame / m.sampleRate;
        this._update({ currentTime: t });
        this._host.emit('timeupdate', t);
    }

    private _onSegment(index: number): void {
        if (this._eng && this._manifest) {
            const frame = this._engPlaying ? this._eng.position() : this._pausedFrame;
            if (this._wantedEngine(frame).includes(index)) this._feedEngine([index]);
        }
        const scheduler = this._scheduler;
        const ctx = this._engine?.context;
        if (scheduler && ctx && scheduler.running && this._waiting === index) {
            if (scheduler.starvedAt(ctx.currentTime)) {
                // The audio ran dry: continue from where it stopped, a moment from now.
                scheduler.reanchor(this._alignedTime(ctx.currentTime + LOOKAHEAD));
                this._update({ buffering: false });
            }
            this._pump();
        }
        if (this._visible.includes(index)) this._host.emit('sourceupdate', { clipId: this._clipId, what: 'segment' });
    }

    // ---- engine path ------------------------------------------------------------------------

    private async _createEngine(ctx: AudioContext, output: AudioNode, manifest: AudioManifest, loadId: number): Promise<void> {
        this._disposeEngine();
        if (this._options.engine === false) return;
        // The engine runs at the clip's rate (the stretcher too) and resamples its output
        // to the context's when they differ: a 44.1 or 16 kHz clip keeps realtime speed.
        // The player's `stretcher`: 'native' turns the stretch off (an offline strategy is for whole clips).
        const stretch = this._host.options.stretcher !== 'native';
        const loaded = await loadStreamEngine(ctx, stretch);
        // Another clip was asked for while the module loaded: that load makes its own engine.
        if (!loaded || loadId !== this._loadId) return;
        const starts = [...manifest.segments.list.map((s) => s.startFrame), manifest.frames];
        let engine: StreamEngine;
        try {
            engine = new StreamEngine(ctx, { channels: manifest.channels, starts, stretch, sampleRate: manifest.sampleRate });
        } catch (error) {
            console.warn('[AudioPlayer] stream engine unavailable; using the scheduler', error);
            return;
        }
        engine.node.connect(output);
        engine.setRate(this._state.processing.speed);
        this._eng = engine;
        this._applyMix();
        engine.onReport = (report) => this._onReport(report);
        engine.onEnded = () => this._onEngineEnded();
        engine.onStretch = (state) => {
            this.capabilities = SegmentedSource._caps(state.ready, this.capabilities.canMixStemB, this.capabilities.stems);
            this._update({ capabilities: this.capabilities });
        };
        engine.onError = (error) => this._onEngineError(engine, error);
        this._eng = engine;
    }

    /** The processor died (it is silent for good): carry on with the scheduler from the same place. */
    private _onEngineError(engine: StreamEngine, error: Error): void {
        if (this._eng !== engine) return;
        console.warn('[AudioPlayer] stream engine failed; playing on with the scheduler', error);
        const m = this._manifest;
        const wasPlaying = this._engPlaying;
        const frame = Math.floor(wasPlaying ? engine.position() : this._pausedFrame);
        this._disposeEngine();
        this._pausedFrame = frame;
        const loop = this._state.loop;
        this._scheduler?.setLoop(loop ? { start: this._frameOf(loop.start), end: Math.min(m?.frames ?? 0, this._frameOf(loop.end)) } : null);
        this._scheduler?.setRate(this._state.processing.speed);
        if (m && wasPlaying) void this._startAt(frame, 'play');
    }

    private _disposeEngine(): void {
        if (!this._eng) return;
        this._eng.pause();
        this._eng.dispose();
        this._eng = null;
        this._engPlaying = false;
        this._lastReport = null;
        if (this.capabilities.canPreservePitch) {
            this.capabilities = SegmentedSource._caps(false, this.capabilities.canMixStemB, this.capabilities.stems);
            this._update({ capabilities: this.capabilities });
        }
    }


    /** `playId`: the start's, taken by _startAt before it waited for the clip's setup. */
    private async _startEngine(frame: number, reason: 'play' | 'seek', playId: number): Promise<boolean> {
        const m = this._manifest!;
        const engine = this._eng!;
        const ctxEngine = this._engine!;
        const loop = this._state.loop;
        if (loop && frame >= this._frameOf(loop.end)) frame = this._frameOf(loop.start);
        if (frame >= m.frames) frame = 0;
        this._pausedFrame = frame;
        const t = frame / m.sampleRate;
        if (reason === 'play') this._playStartedAt = performance.now();
        this._update({
            isPlaying: true, buffering: true, currentTime: t, playbackStartPoint: t, ended: false,
            playRequestId: reason === 'play' ? this._state.playRequestId + 1 : this._state.playRequestId,
        });
        const wanted = this._wantedEngine(frame);
        this._store?.cancelExcept(new Set(wanted));
        if (!(await ctxEngine.resume()) || playId !== this._playId || this._disposed) {
            if (playId === this._playId) this._update({ isPlaying: false, buffering: false });
            return false;
        }
        // Transport goes at once; the engine holds the playhead until the audio is there.
        if (this._engPlaying) engine.seek(frame);
        else engine.play(frame);
        this._engPlaying = true;
        this._pendingLatency = { t0: reason === 'seek' && this._seekStartedAt !== null ? this._seekStartedAt : this._playStartedAt, reason };
        this._seekStartedAt = null;
        this._feedEngine(wanted);
        this._timer ??= setInterval(() => this._pump(), PUMP_MS);
        return true;
    }

    private _onReport(report: EngineReport): void {
        this._lastReport = report;
        const pending = this._pendingLatency;
        if (pending && this._eng?.current && report.playing && !report.stalled) {
            const latency = performance.now() - pending.t0;
            if (pending.reason === 'seek') this._stats.seekLatencies.push(latency);
            else if (this._stats.startLatencyMs === null) this._stats.startLatencyMs = latency;
            this._pendingLatency = null;
            this._update({ buffering: false, startedAt: this._engine?.context?.currentTime ?? null });
        } else if (this._engPlaying && report.stalled !== this._state.buffering && !pending) {
            this._update({ buffering: report.stalled });
        }
    }

    private _onEngineEnded(): void {
        const m = this._manifest;
        if (!m || !this._engPlaying) return;
        this._engPlaying = false;
        this._halt();
        this._pausedFrame = 0;
        this._eng?.seek(0);
        this._update({ isPlaying: false, buffering: false, ended: true, currentTime: m.duration, startedAt: null });
        this._host.emit('timeupdate', m.duration);
        this._host.emit('ended', { clipId: this._state.clipId });
    }

    /** Segments the engine should hold: playing (+ the one before, for the stretcher's history), ahead, loop, on screen. */
    private _wantedEngine(frame: number): number[] {
        const m = this._manifest;
        if (!m) return [];
        const starts = [...m.segments.list.map((s) => s.startFrame), m.frames];
        const loop = this._state.loop;
        const out = engineWindow(starts, frame, {
            loop: loop ? { start: this._frameOf(loop.start), end: this._frameOf(loop.end) } : null,
            ahead: this._options.prefetchSegments ?? 2,
            historyFrames: Math.max(this._eng?.stretch.latencyFrames ?? 0, 0.25 * m.sampleRate),
            speed: this._state.processing.speed,
        });
        for (const i of this._visible) if (!out.includes(i)) out.push(i);
        return out;
    }

    /** Hand the engine what it should hold and is in memory; fetch the rest; drop the others. */
    private _feedEngine(wanted: number[]): void {
        const engine = this._eng;
        const store = this._store;
        if (!engine || !store) return;
        // The playhead's segment first, alone: the others would share its bandwidth on a seek.
        const first = wanted[0];
        if (first !== undefined && !engine.holds('a', first) && !store.has(first)) {
            void store.load(first, true);
            return;
        }
        // Fetch only what the store can keep: more would be evicted and fetched again.
        const fetchable = new Set(store.withinBudget(wanted.filter((i) => !engine.holds('a', i))));
        for (const i of wanted) {
            if (engine.holds('a', i)) continue;
            const buffer = store.get(i);
            if (buffer) {
                const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c).slice());
                engine.feed('a', i, channels);
            } else if (fetchable.has(i)) {
                void store.load(i, i === wanted[0]);
            }
        }
        // Stem B only while the mix wants it: the playhead's segments first.
        const storeB = this._storeB;
        if (!storeB || !this._bWanted()) return;
        const fetchableB = new Set(storeB.withinBudget(wanted.filter((i) => !engine.holds('b', i))));
        for (const i of wanted) {
            if (engine.holds('b', i)) continue;
            const buffer = storeB.get(i);
            if (buffer) {
                const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c).slice());
                engine.feed('b', i, channels);
            } else if (fetchableB.has(i)) {
                void storeB.load(i, i === wanted[0]);
            }
        }
    }

    private _pumpEngine(): void {
        const engine = this._eng;
        const store = this._store;
        const m = this._manifest;
        if (!engine || !store || !m || !this._engPlaying) return;
        const frame = engine.position();
        const wanted = this._wantedEngine(frame);
        this._feedEngine(wanted);
        for (const i of engine.held('a')) if (!wanted.includes(i)) engine.drop('a', i);
        store.evict(wanted, 2);
        // B: the same window while wanted; all of it let go once the knob has rested at 0.
        const keepB = this._bWanted() ? wanted : [];
        for (const i of engine.held('b')) if (!keepB.includes(i)) engine.drop('b', i);
        this._storeB?.evict(keepB, keepB.length ? 2 : 0);
        const t = frame / m.sampleRate;
        this._update({ currentTime: t });
        this._host.emit('timeupdate', t);
    }

    private _snap(range: LoopRange): LoopRange {
        const store = this._store;
        const scheduler = this._scheduler;
        const m = this._manifest;
        if (!store || !scheduler || !m) return range;
        const snapOne = (t: number) => {
            const index = scheduler.segmentAt(this._frameOf(t));
            const buffer = store.get(index);
            if (!buffer) return t;
            const segStart = m.segments.list[index].startFrame / m.sampleRate;
            return segStart + findZeroCrossing(buffer, t - segStart);
        };
        const start = snapOne(range.start);
        const end = snapOne(range.end);
        return end > start ? { start, end } : range;
    }
}
