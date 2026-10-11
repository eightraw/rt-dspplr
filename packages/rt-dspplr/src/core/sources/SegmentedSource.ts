import type { AudioPlayerState, ClipInfo } from '../AudioPlayer';
import type AudioEngine from '../engine/AudioEngine';
import type { LoopRange } from '../engine/Track';
import { findZeroCrossing } from '../engine/zeroCrossing';
import type { SpectralPyramid } from '../spectrogram/protocol';
import type { WaveformPeakLevel, WaveformPeakPyramid } from '../waveform/pyramid';
import { decodeBandsFile, type BandsFile } from '../stream/bandsFile';
import { FileAccess, SourceError } from '../stream/fileAccess';
import { DEFAULT_STEM_KEY, parseManifest, readyStemKeys, type AudioManifest, type ManifestSegment, type ManifestStem, type ManifestStems } from '../stream/manifest';
import { mixGains, type MixLaw } from '../controls';
import { decodePeaksFile, peaksToPyramid, readLevel, type PeaksFile } from '../stream/peaksFile';
import { decodeEntriesFile } from '../stream/entriesFile';
import { SegmentScheduler } from '../stream/SegmentScheduler';
import { SegmentStore, type SegmentStoreStats } from '../stream/SegmentStore';
import { warmDecoder } from '../stream/RunDecoder';
import { LinkPriority } from '../stream/linkPriority';
import { loadStreamEngine, StreamEngine, type EngineReport, type EngineStem } from '../engine/StreamEngine';
import { engineWindow } from '../engine/engineWindow';
import { decodeSpectrogramFile, toSpectralPyramid, type SpectrogramFile } from '../stream/spectrogramFile';
import type { PlaybackSource, SourceCapabilities, SourceHost, StemSummary } from './types';

// ---------------------------------------------------------------------------
// SegmentedSource — a prepared long recording (made by ./prepare): manifest,
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
    /** Segments fetched ahead of the playhead. Default: as many as hold 20 s (at least 2). */
    prefetchSegments?: number;
    /**
     * Fetch the blend stem's segment at the playhead while stem A plays, and its overview once
     * A's is in, so the first move of the knob is heard and drawn at once (default true). false:
     * a stem's segments and overview are fetched only once the knob moves.
     */
    prefetchStem?: boolean;
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
/** What the playhead reads before it plays on after a start or a seek: the engine's margin (0.5 s) and some to spare. */
const PLAYHEAD_SECONDS = 0.75;
/** The decoded window covers the view and a quarter of it each side: at most this many seconds of segments. */
const WINDOW_MAX_COVER_SECONDS = WINDOW_MAX_SECONDS * 1.5;
/** Failures in a row after which a segment counts as broken (the store keeps retrying, slowly). */
const SEGMENT_FAILURES_MAX = 4;
/** Seconds of audio fetched ahead of the playhead by default (see prefetchSegments). */
const PREFETCH_SECONDS = 20;

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
    /** The clip's fetches the playhead waits for, A's and the stem's: the rest give way to them. */
    private _priority = new LinkPriority();
    private _stemB: ManifestStem | null = null;
    /** Key of the stem the knob blends with (null: none); and the one the host asked for. */
    private _stemKey: string | null = null;
    private _wantStem: string | null = null;
    private _mix = 0;
    /** B is wanted while the mix is above 0, and for a while after the knob last moved. */
    private _bWantedUntil = 0;
    private _bOverviewAsked = false;
    /** Settles once A's overview files are all in (or have failed): the stem's overview follows them. */
    private _overviewA: Promise<void> = Promise.resolve();
    /** Settles once the overview's first levels (A's and the stem's) are in: the decoded window waits for them. */
    private _overviewFirst: Promise<void> = Promise.resolve();
    private _overviewFirstIn = true;
    /** The segments the engine reads around the playhead, as last worked out (see _onPart). */
    private _engineWindow: number[] = [];
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
    /** The active stem's spectrogram (as far as it has come), merged into A's at every publish. */
    private _spectroB: SpectrogramFile | null = null;
    /** The stem's spectrogram could not be read: A's is published alone. */
    private _spectroBFailed = false;
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
        // nothing of its stem carries over to the new one. (Its engine is replaced by the new clip's.)
        this._disposeEngine(true);
        this._clearStem();
        this._store?.dispose();
        this._store = null;
        this._scheduler = null;
        this._manifest = null;
        this._files = null;
        this._peaks = null;
        this._spectro = null;
        this._spectroB = null;
        this._spectroBFailed = false;
        // The knob as the player has it: it may have been set while a whole clip was loaded,
        // which went to the other source.
        this._mix = this._state.processing.mix;
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
            const manifest = parseManifest(await response.json());
            files.check(manifest);
            if (loadId !== this._loadId) return false;
            this._manifest = manifest;
            this._files = files;
            warmDecoder(manifest.segments.source);
            this._overviewA = this._loadOverview(loadId);
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
            this._priority = new LinkPriority();
            this._store = new SegmentStore(files, manifest, {
                maxBytes: Math.max(1, cacheSeconds) * manifest.sampleRate * manifest.channels * 4,
                priority: this._priority,
            });
            this._store.onLoad((index) => this._onSegment(index));
            this._store.onPartial((index) => this._onPart('a', index));
            this._store.onError((index, error, failures) => this._onSegmentError(index, error, failures));
            void this._loadEntries(loadId, manifest.segments, this._store);
            this._scheduler = new SegmentScheduler(out.ctx, out.input, manifest.segments.list, manifest.sampleRate);
            this._scheduler.setRate(this._state.processing.speed);
            await this._createEngine(out.ctx, out.input, manifest, loadId);
            if (loadId !== this._loadId) return false;
            // A loop set while the clip was set up is in the state only: the scheduler and the engine get it now.
            const loopWhileLoading = this._state.loop;
            if (loopWhileLoading) this.setLoop(loopWhileLoading);
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
        const was = this._mix;
        this._mix = mix;
        // Towards the stem or back to A alone: the picture's levels change with it.
        if ((was > 0) !== (mix > 0)) this._publishSpectrogram();
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
            const next = parseManifest(await response.json());
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
        this._spectroB = null;
        this._spectroBFailed = false;
        const prepared = this._state.prepared;
        if (prepared && (prepared.peaksB || prepared.bandsB)) this._publish({ peaksB: null, bandsB: null }, 'spectrogram');
        // A's levels alone again.
        this._publishSpectrogram();
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
            warmDecoder(stem.segments.source);
            this._storeB?.dispose();
            this._storeB = new SegmentStore(files, shim, {
                maxBytes: Math.max(1, this._options.cacheSeconds ?? 60) * manifest.sampleRate * manifest.channels * 4,
                priority: this._priority,
            });
            this._storeB.onError((index, error, failures) => {
                // A source that cannot be read (SourceError) is let go at once: retries would not help.
                if (error instanceof SourceError || failures >= SEGMENT_FAILURES_MAX) this._failStemB(index, error);
            });
            this._storeB.onPartial((index) => this._onPart('b', index));
            void this._loadEntries(this._loadId, stem.segments, this._storeB);
            this._storeB.onLoad((index) => {
                if (this._eng && this._bWanted()) this._feedEngine(this._wantedEngine(this._engPlaying ? this._eng.position() : this._pausedFrame));
                if (this._visible.includes(index)) this._host.emit('sourceupdate', { clipId: this._clipId, what: 'segment' });
            });
            this._bOverviewAsked = false;
            // Its overview once A's is in: at once when the knob is already towards it, ahead of it by default.
            if (this._mix > 0 || this._options.prefetchStem !== false) {
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
        // Behind A's overview (B's spectrogram is merged into A's levels) and, file by file, behind the audio.
        await this._overviewA;
        const get = async (file?: { url: string; bytes?: number; levels?: Array<{ byteOffset: number; byteLength: number }> }) => {
            if (!file) return null;
            const href = files.resolve(file.url);
            const bytes = file.bytes ?? Math.max(0, ...(file.levels ?? []).map((l) => l.byteOffset + l.byteLength));
            if (!(bytes > 0)) {
                await this._audioIdle();
                const response = await fetch(href, files.init(href));
                return response.ok ? response.arrayBuffer() : null;
            }
            const got = await this._fetchBehindAudio(loadId, files, href, 0, bytes - 1);
            return got?.buffer ?? null;
        };
        try {
            const peaks = await get(stem.peaks);
            const bands = await get(stem.bands);
            const spectro = await get(stem.spectrogram);
            if (loadId !== this._loadId || key !== this._stemKey) return;
            const patch: Partial<PreparedOverview> = { correlated: (stem.correlation?.global ?? 1) >= 0.5 };
            if (peaks) patch.peaksB = peaksToPyramid(decodePeaksFile(peaks), new Map());
            if (bands) patch.bandsB = decodeBandsFile(bands);
            this._publish(patch, 'spectrogram');
            if (spectro) {
                this._spectroB = decodeSpectrogramFile(spectro);
                this._spectroBFailed = false;
                this._publishSpectrogram();
            }
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
        // Too many segments for the window (its seconds, whatever the segments' length): keep
        // those nearest the view's centre.
        const maxSegments = Math.max(1, Math.ceil((WINDOW_MAX_COVER_SECONDS * m.sampleRate) / Math.max(1, m.segments.framesPerSegment)) + 1);
        while (last - first + 1 > maxSegments) {
            const centre = this._frameOf((start + end) / 2);
            const segs = m.segments.list;
            if (centre - segs[first].startFrame > segs[last].startFrame + segs[last].frames - centre) first += 1;
            else last -= 1;
        }
        const visible: number[] = [];
        for (let i = first; i <= last; i += 1) visible.push(i);
        this._visible = visible;
        const fetch = () => {
            if (this._visible !== visible || this._store !== store) return;
            // Not urgent: the playhead's segments come first, and the window of a short clip is
            // all of it.
            for (const i of visible) if (!store.has(i)) void store.load(i);
        };
        // After the overview's first levels: the whole picture first, then its close-up.
        if (this._overviewFirstIn) fetch();
        else void this._overviewFirst.then(fetch);
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

    /**
     * Where seeks may start inside a source's segments (entries.bin: MP3, FLAC, Opus), handed to its
     * store: after the overview's first levels, behind the audio. Without them a seek fetches its
     * segment from the start.
     */
    private async _loadEntries(loadId: number, segments: AudioManifest['segments'], store: SegmentStore): Promise<void> {
        const entries = segments.entries;
        const files = this._files;
        if (!entries || !files) return;
        await this._overviewFirst;
        if (loadId !== this._loadId || store.broken) return;
        try {
            const got = await this._fetchBehindAudio(loadId, files, files.resolve(entries.url), 0, entries.bytes - 1);
            if (!got || loadId !== this._loadId) return;
            store.setEntries(decodeEntriesFile(got.buffer, segments.list.map((seg) => seg.range?.[0] ?? null)));
        } catch (error) {
            if (loadId === this._loadId) console.warn('[AudioPlayer] no entries inside the segments; seeks fetch from their starts', error);
        }
    }

    /** Resolves once no segment the playhead waits for is on its way (A's, or the stem's). */
    private _audioIdle(): Promise<void> {
        return this._priority.idle();
    }

    /** Whether a segment the playhead waits for is on its way (A's, or the stem's). */
    private _audioWaiting(): boolean {
        return this._priority.busy();
    }

    /**
     * Bytes `from` to `to` (inclusive) of a file, behind the audio: one request at full speed
     * while no segment the playhead waits for is on its way, broken off within one network chunk
     * when one is asked for, and carried on from where it stopped once that segment is in. So a
     * start or a seek has the link to itself, and the overview loses no time to it otherwise.
     * Null once another clip is loaded. `partial` false: the server sent the whole file (the
     * bytes sit at their file offsets).
     */
    private async _fetchBehindAudio(loadId: number, files: FileAccess, url: string, from: number, to: number): Promise<{ buffer: ArrayBuffer; partial: boolean } | null> {
        const total = to - from + 1;
        const out = new Uint8Array(total);
        let got = 0;
        while (got < total) {
            await this._audioIdle();
            if (loadId !== this._loadId || files.signal?.aborted) return null;
            // Its own abort (to yield to the audio), and the load's.
            const controller = new AbortController();
            const onAbort = () => controller.abort();
            files.signal?.addEventListener('abort', onAbort, { once: true });
            try {
                const response = await fetch(url, files.init(url, { range: `bytes=${from + got}-${to}`, signal: controller.signal }));
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                if (response.status !== 206) return { buffer: await response.arrayBuffer(), partial: false };
                if (!response.body) {
                    const rest = new Uint8Array(await response.arrayBuffer());
                    out.set(rest.subarray(0, total - got), got);
                    got += Math.min(rest.byteLength, total - got);
                    continue;
                }
                const reader = response.body.getReader();
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    const take = Math.min(value.byteLength, total - got);
                    out.set(value.subarray(0, take), got);
                    got += take;
                    if (got >= total) break;
                    // A segment the playhead waits for: the link is its own until it is in.
                    if (this._audioWaiting()) {
                        controller.abort();
                        break;
                    }
                }
                if (got >= total) controller.abort(); // a server that sent more than asked
            } catch (error) {
                if (!controller.signal.aborted) throw error;
            } finally {
                files.signal?.removeEventListener('abort', onAbort);
            }
            if (loadId !== this._loadId) return null;
        }
        return { buffer: out.buffer, partial: true };
    }

    /**
     * The overview files, in the order they are seen and each behind the audio: the waveform's
     * coarsest level at once (a few KB: the whole recording is drawn with it), then its finer
     * levels and the spectrogram's (coarse to fine), the bands, the finest levels last; then the
     * stem's (prefetchStem).
     */
    private async _loadOverview(loadId: number): Promise<void> {
        let firstIn!: () => void;
        this._overviewFirstIn = false;
        this._overviewFirst = new Promise<void>((resolve) => { firstIn = resolve; });
        try {
            // Together: a few KB each, and the picture needs all of them.
            await Promise.all([this._loadPeaksFirst(loadId), this._loadSpectrogramFirst(loadId), this._loadStemSpectrogramFirst(loadId)]);
        } finally {
            if (loadId === this._loadId) this._overviewFirstIn = true;
            firstIn();
        }
        await this._loadPeakLevels(loadId, false);
        await this._loadSpectrogramLevels(loadId, false);
        await this._loadBands(loadId);
        await this._loadPeakLevels(loadId, true);
        await this._loadSpectrogramLevels(loadId, true);
        if (loadId !== this._loadId) return;
        if (this._options.prefetchStem !== false && this._stemB?.status === 'ready' && !this._bOverviewAsked) {
            this._bOverviewAsked = true;
            void this._loadOverviewB(loadId);
        }
    }

    /** The peaks file's header and its coarsest level, in one request: what the timeline draws first. */
    private async _loadPeaksFirst(loadId: number): Promise<void> {
        const m = this._manifest;
        const files = this._files;
        if (!m || !files) return;
        const url = files.resolve(m.peaks.url);
        const coarsest = [...m.peaks.levels].sort((x, y) => x.byteLength - y.byteLength)[0];
        try {
            const first = coarsest
                ? await this._fetchFile(files, url, 0, coarsest.byteOffset + coarsest.byteLength - 1)
                : await this._fetchFile(files, url);
            if (loadId !== this._loadId) return;
            this._peaks = decodePeaksFile(first.buffer);
            this._stats.coarse = first.buffer.byteLength;
            this._publish({ peaks: peaksToPyramid(this._peaks, this._merged) }, 'peaks');
        } catch (error) {
            if (loadId === this._loadId) console.warn('[AudioPlayer] peaks unavailable; the waveform stays empty', error);
        }
    }

    /**
     * The spectrogram file's header and its coarsest level, in one request, ahead of the audio as
     * the waveform's: a few tens of KB, and a spectrogram view shows nothing without them.
     */
    private async _loadSpectrogramFirst(loadId: number): Promise<void> {
        const m = this._manifest;
        const spec = m?.spectrogram;
        const files = this._files;
        if (!m || !spec || !files || this._spectro) return;
        const coarsest = [...spec.levels].sort((x, y) => x.byteLength - y.byteLength)[0];
        try {
            const url = files.resolve(spec.url);
            const first = coarsest ? await this._fetchFile(files, url, 0, coarsest.byteOffset + coarsest.byteLength - 1) : await this._fetchFile(files, url);
            if (loadId !== this._loadId) return;
            this._spectro = decodeSpectrogramFile(first.buffer);
            this._stats.spectroCoarse = first.buffer.byteLength;
            this._stats.spectroReadyMs = performance.now() - this._loadStartedAt;
            this._publishSpectrogram();
        } catch (error) {
            if (loadId === this._loadId) console.warn('[AudioPlayer] spectrogram overview unavailable', error);
        }
    }

    /**
     * The overview spectrogram as published: A's levels, each with the stem's beside it. While
     * the knob is towards the stem, a level without the stem's is left out, and nothing is
     * published before the stem's first level is in: A alone would draw the wrong picture.
     */
    private _publishSpectrogram(): void {
        const a = this._spectro;
        const pyramid = a ? toSpectralPyramid(a) : null;
        if (!pyramid) return;
        const fileB = this._spectroB;
        const blended = this._stemB?.status === 'ready' && this._mix > 0 && !this._spectroBFailed;
        if (!fileB) {
            if (!blended) this._publish({ spectrogram: pyramid }, 'spectrogram');
            return;
        }
        const pb = toSpectralPyramid(fileB);
        const levels: typeof pyramid.levels = [];
        for (const level of pyramid.levels) {
            const match = pb?.levels.find((l) => l.binSize === level.binSize && l.frames === level.frames);
            if (match) levels.push({ ...level, b: match.a });
            else if (!blended) levels.push(level);
        }
        if (levels.length === 0) return;
        this._publish({
            spectrogram: {
                ...pyramid,
                referenceSum: pyramid.referenceMax + fileB.referenceMax,
                referenceMax: Math.max(pyramid.referenceMax, fileB.referenceMax),
                levels,
            },
        }, 'spectrogram');
    }

    /**
     * The stem's spectrogram header and coarsest level, right after A's (a few tens of KB): the
     * first picture of a blend is blended. Waits for the clip's setup, which picks the stem.
     */
    private async _loadStemSpectrogramFirst(loadId: number): Promise<void> {
        await this._settling;
        const stem = this._stemB;
        const spec = stem?.spectrogram;
        const files = this._files;
        if (loadId !== this._loadId || !stem || stem.status !== 'ready' || !spec || !files || this._spectroB) return;
        if (this._options.prefetchStem === false && this._mix <= 0) return;
        const key = this._stemKey;
        const coarsest = [...spec.levels].sort((x, y) => x.byteLength - y.byteLength)[0];
        try {
            const url = files.resolve(spec.url);
            const first = coarsest ? await this._fetchFile(files, url, 0, coarsest.byteOffset + coarsest.byteLength - 1) : await this._fetchFile(files, url);
            if (loadId !== this._loadId || key !== this._stemKey || this._spectroB) return;
            this._spectroB = decodeSpectrogramFile(first.buffer);
        } catch (error) {
            if (loadId !== this._loadId) return;
            this._spectroBFailed = true;
            console.warn('[AudioPlayer] the stem\'s spectrogram is unavailable; A\'s is drawn alone', error);
        }
        this._publishSpectrogram();
    }

    /** The peak levels still missing, coarse to fine, behind the audio: all but the finest, or the finest. */
    private async _loadPeakLevels(loadId: number, finest: boolean): Promise<void> {
        const m = this._manifest;
        const files = this._files;
        const peaks = this._peaks;
        if (!m || !files || !peaks) return;
        const url = files.resolve(m.peaks.url);
        const bySize = [...m.peaks.levels].sort((x, y) => x.byteLength - y.byteLength);
        const finestLevel = bySize[bySize.length - 1];
        try {
            for (const level of bySize) {
                if ((level === finestLevel) !== finest) continue;
                const target = peaks.levels.find((l) => l.framesPerPeak === level.framesPerPeak);
                if (!target || target.channels) continue;
                const got = await this._fetchBehindAudio(loadId, files, url, level.byteOffset, level.byteOffset + level.byteLength - 1);
                if (!got || loadId !== this._loadId || this._peaks !== peaks) return;
                this._stats.fine += got.buffer.byteLength;
                if (!got.partial) {
                    // The whole file came: every level is in it.
                    for (const l of decodePeaksFile(got.buffer).levels) {
                        const t = peaks.levels.find((x) => x.framesPerPeak === l.framesPerPeak);
                        if (t && !t.channels) t.channels = l.channels;
                    }
                } else {
                    target.channels = readLevel(got.buffer, 0, target.peaks, peaks.channels);
                }
                this._publish({ peaks: peaksToPyramid(peaks, this._merged) }, 'peaks');
            }
        } catch (error) {
            if (loadId === this._loadId) console.warn('[AudioPlayer] a peaks level is unavailable; the waveform stays coarser', error);
        }
    }

    private async _loadBands(loadId: number): Promise<void> {
        const m = this._manifest;
        const files = this._files;
        if (!m?.bands || !files) return; // v1 manifest: no high-pass approximation
        try {
            const got = await this._fetchBehindAudio(loadId, files, files.resolve(m.bands.url), 0, m.bands.bytes - 1);
            if (!got || loadId !== this._loadId) return;
            this._stats.bands = got.buffer.byteLength;
            this._publish({ bands: decodeBandsFile(got.buffer) }, 'bands');
        } catch (error) {
            if (loadId === this._loadId) console.warn('[AudioPlayer] bands unavailable; the high-pass preview is skipped outside the decoded window', error);
        }
    }

    /**
     * The spectrogram behind the audio: its header with the coarsest level first, then the other
     * levels coarse to fine; all but the finest, or the finest.
     */
    private async _loadSpectrogramLevels(loadId: number, finest: boolean): Promise<void> {
        const m = this._manifest;
        const spec = m?.spectrogram;
        const files = this._files;
        if (!m || !spec || !files) return;
        const url = files.resolve(spec.url);
        const bySize = [...spec.levels].sort((x, y) => x.byteLength - y.byteLength);
        const finestLevel = bySize[bySize.length - 1];
        try {
            if (!this._spectro) {
                if (finest) return;
                const coarsest = bySize[0];
                const first = coarsest
                    ? await this._fetchBehindAudio(loadId, files, url, 0, coarsest.byteOffset + coarsest.byteLength - 1)
                    : null;
                if (!first || loadId !== this._loadId) return;
                this._spectro = decodeSpectrogramFile(first.buffer);
                this._stats.spectroCoarse = first.buffer.byteLength;
                this._stats.spectroReadyMs = performance.now() - this._loadStartedAt;
                this._publishSpectrogram();
            }
            const file = this._spectro;
            for (const level of bySize) {
                if ((level === finestLevel) !== finest) continue;
                const target = file.levels.find((l) => l.hop === level.framesPerColumn && l.columns === level.columns);
                if (!target || target.a) continue;
                const got = await this._fetchBehindAudio(loadId, files, url, level.byteOffset, level.byteOffset + level.byteLength - 1);
                if (!got || loadId !== this._loadId || this._spectro !== file) return;
                if (finest) this._stats.spectroFine += got.buffer.byteLength;
                else this._stats.spectroCoarse += got.buffer.byteLength;
                if (!got.partial) {
                    for (const l of decodeSpectrogramFile(got.buffer).levels) {
                        const t = file.levels.find((x) => x.hop === l.hop && x.columns === l.columns);
                        if (t && !t.a) t.a = l.a;
                    }
                } else {
                    target.a = new Uint8Array(got.buffer, 0, level.byteLength);
                }
                this._publishSpectrogram();
            }
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
        const ahead = Math.max(1, this._aheadSegments());
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
        this._disposeEngine(true);
        // The scheduler plays at the native rate: the pitch follows the speed.
        if (this._options.engine === false) {
            this._setPitchCapability(false);
            return;
        }
        // The engine runs at the clip's rate (the stretcher too) and resamples its output
        // to the context's when they differ: a 44.1 or 16 kHz clip keeps realtime speed.
        // The player's `stretcher`: 'native' turns the stretch off (an offline strategy is for whole clips).
        const stretch = this._host.options.stretcher !== 'native';
        if (!stretch) this._setPitchCapability(false);
        const loaded = await loadStreamEngine(ctx, stretch);
        // Another clip was asked for while the module loaded: that load makes its own engine.
        if (loadId !== this._loadId) return;
        if (!loaded) {
            this._setPitchCapability(false);
            return;
        }
        const starts = [...manifest.segments.list.map((s) => s.startFrame), manifest.frames];
        let engine: StreamEngine;
        try {
            engine = new StreamEngine(ctx, { channels: manifest.channels, starts, stretch, sampleRate: manifest.sampleRate });
        } catch (error) {
            console.warn('[AudioPlayer] stream engine unavailable; using the scheduler', error);
            this._setPitchCapability(false);
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
        // A start in flight (the output resuming: _startEngine set isPlaying) counts as playing.
        const wasPlaying = this._engPlaying || this._state.isPlaying;
        const frame = Math.floor(this._engPlaying ? engine.position() : this._pausedFrame);
        this._disposeEngine();
        this._pausedFrame = frame;
        const loop = this._state.loop;
        this._scheduler?.setLoop(loop ? { start: this._frameOf(loop.start), end: Math.min(m?.frames ?? 0, this._frameOf(loop.end)) } : null);
        this._scheduler?.setRate(this._state.processing.speed);
        if (m && wasPlaying) void this._startAt(frame, 'play');
    }

    /**
     * `replaced`: another clip's engine follows. Its stretcher takes a moment to
     * start, so the pitch flag stays as this one left it until the new one reports
     * (rather than flickering with each clip).
     */
    private _disposeEngine(replaced = false): void {
        if (!this._eng) return;
        this._eng.pause();
        this._eng.dispose();
        this._eng = null;
        this._engPlaying = false;
        this._lastReport = null;
        if (!replaced) this._setPitchCapability(false);
    }

    private _setPitchCapability(pitch: boolean): void {
        if (this.capabilities.canPreservePitch === pitch) return;
        this.capabilities = SegmentedSource._caps(pitch, this.capabilities.canMixStemB, this.capabilities.stems);
        this._update({ capabilities: this.capabilities });
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
        // The stem's too: a fetch for the old playhead (a prefetch the knob never asked for)
        // would share the new one's bandwidth.
        this._storeB?.cancelExcept(new Set(this._bWanted() ? wanted : wanted.slice(0, 1)));
        // What the old playhead waited for and is still wanted (on screen, ahead) is no longer
        // urgent: it gives way to the new one's.
        this._store?.relaxExcept(new Set());
        this._storeB?.relaxExcept(new Set());
        if (!(await ctxEngine.resume()) || playId !== this._playId || this._disposed) {
            if (playId === this._playId) this._update({ isPlaying: false, buffering: false });
            return false;
        }
        // The engine failed meanwhile: _onEngineError started the scheduler in its place.
        if (this._eng !== engine) return false;
        // Transport goes at once; the engine holds the playhead until the audio is there.
        // Always a play: the processor may have stopped at the clip's end before its
        // 'ended' arrived here, and a seek would leave it stopped (a play while it plays
        // jumps, as a seek does).
        engine.play(frame);
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
    /** Segments fetched ahead of the playhead: prefetchSegments, or as many as hold PREFETCH_SECONDS. */
    private _aheadSegments(): number {
        const m = this._manifest;
        if (this._options.prefetchSegments !== undefined) return this._options.prefetchSegments;
        if (!m) return 2;
        return Math.max(2, Math.ceil((PREFETCH_SECONDS * m.sampleRate) / Math.max(1, m.segments.framesPerSegment)));
    }

    private _wantedEngine(frame: number): number[] {
        const m = this._manifest;
        if (!m) return [];
        const starts = [...m.segments.list.map((s) => s.startFrame), m.frames];
        const loop = this._state.loop;
        const out = engineWindow(starts, frame, {
            loop: loop ? { start: this._frameOf(loop.start), end: this._frameOf(loop.end) } : null,
            ahead: this._aheadSegments(),
            historyFrames: Math.max(this._eng?.stretch.latencyFrames ?? 0, 0.25 * m.sampleRate),
            speed: this._state.processing.speed,
        });
        for (const i of this._visible) if (!out.includes(i)) out.push(i);
        this._engineWindow = out;
        return out;
    }

    /**
     * A part of a segment whose bytes are still coming: to the engine, which plays as far as the
     * parts reach, when the engine reads that segment (the store keeps what has arrived: see
     * _feedArrived).
     */
    private _onPart(stem: EngineStem, index: number): void {
        if (!this._eng || !this._engineWindow.includes(index)) return;
        if (stem === 'b' && !this._bWanted()) return;
        this._feedArrived(stem, stem === 'a' ? this._store : this._storeB, index);
    }

    /**
     * The frames of segment `i` that have arrived and the engine does not hold yet: the next of
     * the fill it holds, or a fill of their own (they begin elsewhere: a seek fetched them from an
     * entry, or the engine holds none of the segment).
     */
    private _feedArrived(stem: EngineStem, store: SegmentStore | null, i: number): void {
        const engine = this._eng;
        if (!engine || !store) return;
        // The engine has the segment whole: nothing to add.
        if (engine.holds(stem, i) && engine.partial(stem, i) === null) return;
        const arrived = store.arrived(i);
        if (!arrived) return;
        const from = engine.partialFrom(stem, i);
        const to = engine.partial(stem, i);
        const slice = (a: number, b: number) => arrived.planes.map((p) => p.slice(a, b));
        if (from !== null && to !== null && from <= arrived.from && arrived.from <= to) {
            if (arrived.to > to) engine.feedPart(stem, i, to, slice(to, arrived.to), arrived.total, false);
        } else {
            engine.feedPart(stem, i, arrived.from, slice(arrived.from, arrived.to), arrived.total, true);
        }
    }

    /**
     * A segment the engine still needs, or one it holds in parts: from the store's whole buffer
     * (all of it, also over parts held: should they have come out wrong, they are replaced), or
     * as far as it has arrived and fetched (true; `at`: the playhead waits for its frames from
     * there, see SegmentStore.load).
     */
    private _feedSegment(stem: EngineStem, store: SegmentStore, i: number, fetch: boolean, urgent: boolean, at?: number): void {
        const engine = this._eng!;
        if (engine.holds(stem, i) && engine.partial(stem, i) === null) return;
        const buffer = store.get(i);
        if (buffer) {
            engine.feed(stem, i, Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c).slice()));
            return;
        }
        this._feedArrived(stem, store, i);
        if (fetch) void store.load(i, urgent, at);
    }

    /**
     * Where in segment `i` the playhead waits for frames, when it is in that segment: its frame,
     * less what the stretcher reads behind it; else undefined.
     */
    private _playheadIn(i: number): number | undefined {
        const engine = this._eng;
        const m = this._manifest;
        if (!engine || !m || !this._scheduler) return undefined;
        const frame = Math.floor(this._engPlaying ? engine.position() : this._pausedFrame);
        if (this._scheduler.segmentAt(frame) !== i) return undefined;
        const history = Math.max(engine.stretch.latencyFrames, 0.25 * m.sampleRate);
        return Math.max(0, frame - m.segments.list[i].startFrame - history);
    }

    /**
     * The segments the playhead reads before it plays on (a start or a seek waits for them): its
     * own, and the next ones the start's margin (and a little more) reaches into, at the speed.
     */
    private _playheadSegments(): number[] {
        const engine = this._eng;
        const m = this._manifest;
        const scheduler = this._scheduler;
        if (!engine || !m || !scheduler) return [];
        const frame = Math.floor(this._engPlaying ? engine.position() : this._pausedFrame);
        const ahead = Math.min(m.frames - 1, frame + Math.ceil(PLAYHEAD_SECONDS * m.sampleRate * Math.max(1, this._state.processing.speed)));
        const out: number[] = [];
        for (let i = scheduler.segmentAt(Math.min(frame, m.frames - 1)); i <= scheduler.segmentAt(ahead); i += 1) out.push(i);
        return out;
    }

    /** Hand the engine what it should hold and is in memory; fetch the rest; drop the others. */
    private _feedEngine(wanted: number[]): void {
        const engine = this._eng;
        const store = this._store;
        if (!engine || !store) return;
        // What the playhead reads first, alone (until it is in, when it arrives in parts): its
        // segment, and the next while the start's margin reaches into it; of A and, while the knob
        // is towards it, of stem B. The others would share their bandwidth on a seek, and the stem
        // would wait for A's next segments. (Not while B is only kept after the knob came back to
        // 0: A's would get half the bandwidth for a stem nobody hears.)
        const blending = this._mix > 0 ? this._storeB : null;
        const playing = this._playheadSegments().filter((i) => wanted.includes(i));
        const at = (i: number) => (i === playing[0] ? this._playheadIn(i) : undefined);
        // Missing for the playhead: the engine lacks frames of it from where the playhead reads
        // (a fill from an entry before that, to the segment's end, is all it needs; the segment
        // whole then comes behind the rest).
        const missing = (stem: EngineStem, s: SegmentStore, i: number) => {
            if (s.has(i)) return false;
            if (!engine.holds(stem, i)) return true;
            const to = engine.partial(stem, i);
            if (to === null) return false;
            return !((engine.partialFrom(stem, i) ?? 0) <= (at(i) ?? 0) && to >= this._manifest!.segments.list[i].frames);
        };
        const lacking = playing.filter((i) => missing('a', store, i) || (blending && missing('b', blending, i)));
        if (lacking.length > 0) {
            for (const i of lacking) {
                this._feedSegment('a', store, i, true, true, at(i));
                if (blending) this._feedSegment('b', blending, i, true, true, at(i));
            }
            return;
        }
        // Fetch only what the store can keep: more would be evicted and fetched again.
        const fetchable = new Set(store.withinBudget(wanted.filter((i) => !engine.holds('a', i) || engine.partial('a', i) !== null)));
        for (const i of wanted) this._feedSegment('a', store, i, fetchable.has(i), false);
        // Stem B only while the mix wants it: the playhead's segments first. Before the knob moves
        // (prefetchStem), its segment at the playhead, once A's are in: the first move plays at once.
        const storeB = this._storeB;
        if (!storeB) return;
        if (!this._bWanted()) {
            // The playhead's own segment (`wanted` may be one segment that just arrived).
            const here = this._scheduler?.segmentAt(Math.floor(this._engPlaying ? engine.position() : this._pausedFrame));
            if (this._options.prefetchStem !== false && here !== undefined && !this._priority.busy() && !storeB.has(here) && !storeB.isLoading(here)) void storeB.load(here);
            return;
        }
        const fetchableB = new Set(storeB.withinBudget(wanted.filter((i) => !engine.holds('b', i) || engine.partial('b', i) !== null)));
        // Its segments at the playhead come first once A's are in, from where the playhead reads
        // (the knob moved a moment ago: the next move should play at once).
        for (const i of wanted) {
            const here = playing.includes(i) && missing('b', storeB, i);
            this._feedSegment('b', storeB, i, fetchableB.has(i) || here, here, here ? at(i) : undefined);
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
        // B: the same window while wanted; once the knob has rested at 0, all of it is let go but
        // the segment at the playhead (prefetchStem).
        const keepB = this._bWanted() ? wanted : this._options.prefetchStem !== false && wanted.length ? [wanted[0]] : [];
        for (const i of engine.held('b')) if (!this._bWanted() || !keepB.includes(i)) engine.drop('b', i);
        this._storeB?.evict(keepB, keepB.length ? Math.min(2, keepB.length) : 0);
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
