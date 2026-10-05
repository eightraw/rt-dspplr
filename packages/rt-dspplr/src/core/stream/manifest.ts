// ---------------------------------------------------------------------------
// The prepared-audio manifest: what `prepareAudio()` writes and the stream
// player reads. JSON, versioned. See docs/long-audio-experiment.md.
// ---------------------------------------------------------------------------

export const MANIFEST_FORMAT = 'rtd-audio-manifest';
/**
 * Version of the manifest layout. 2 added the optional `bands` and
 * `spectrogram` outputs; 3 added `stems` (a server-processed stem B on the
 * same grid) and `revision`. Older manifests still play.
 */
export const MANIFEST_FORMAT_VERSION = 3;
/**
 * Version of the analysis that produced segments, peaks and loudness. Hosts
 * re-run prepare when it changes (e.g. a new peak level layout).
 */
export const ANALYZER_VERSION = '1.2.0';

export interface ManifestSegment {
    index: number;
    /** First frame of the segment on the playback timeline. */
    startFrame: number;
    frames: number;
    /** Relative to the manifest's URL. */
    url: string;
    bytes: number;
    sha256?: string;
}

export interface ManifestPeakLevel {
    framesPerPeak: number;
    peaks: number;
    /** Byte range of this level inside peaks.bin (all channels). */
    byteOffset: number;
    byteLength: number;
}

export interface ManifestLoudness {
    /** Highest absolute sample, linear and dBFS. */
    peak: number;
    peakDb: number;
    /** Plain RMS over the whole file, all channels. */
    rmsDb: number;
    /**
     * RMS of 400 ms blocks with an absolute gate at -70 dBFS and a relative
     * gate 10 dB below: a K-weighting-free cousin of integrated loudness (not LUFS).
     */
    gatedRmsDb: number;
    perChannel: Array<{ peakDb: number; rmsDb: number }>;
}

/**
 * A second stem on the main stem's frame grid: the output of heavy processing
 * of A (denoise, restoration…), mixed with A as dry/wet. Written by
 * attachStem(), possibly long after A; `status` says where it stands.
 */
export interface ManifestStem {
    status: 'processing' | 'ready' | 'failed';
    error?: string;
    updatedAt: string;
    /**
     * The A this stem was made from (A's manifest id, sha256 of its source bytes):
     * a host compares it, and `processor`, to spot a stale B and reprocess.
     */
    aSourceId?: string;
    /** The external processor that made B (absent for a ready-made B input). */
    processor?: { id: string; version: string; params?: Record<string, unknown>; durationMs: number };
    /** sha256 of B's source bytes. */
    id?: string;
    source?: {
        name: string | null;
        bytes: number;
        sampleRate: number;
        channels: number;
        frames: number;
        /** Highest frequency B carries (a 16 kHz speech enhancer: ~8 kHz): the UI can say B lacks highs. */
        bandwidthHz: number;
    };
    /** Where B sat against A, measured by cross-correlation and compensated (B was shifted by -offsetFrames). */
    alignment?: {
        offsetFrames: number;
        offsetMs: number;
        /** Median normalised correlation peak of the windows that agree (0..1). */
        confidence: number;
        windows: number;
        agreeing: number;
    };
    /** Zero-lag correlation of A and aligned B: the whole clip, and per segment. */
    correlation?: { global: number; perSegment: number[] };
    /** The mix law for this pair: 'crossfade' for correlated dry/wet (level kept at every position). */
    mixLaw?: 'crossfade' | 'equal-power';
    /** B's loudness minus A's (gated RMS), information only — never applied automatically. */
    loudnessDeltaDb?: number;
    /** An explicit, opt-in trim for B (default 0). */
    gainDb?: number;
    loudness?: ManifestLoudness;
    segments?: AudioManifest['segments'];
    peaks?: AudioManifest['peaks'];
    bands?: AudioManifest['bands'];
    spectrogram?: AudioManifest['spectrogram'];
}

export interface AudioManifest {
    /** Bumped on every rewrite of the manifest (a stem attached…). */
    revision?: number;
    /** v3: further stems on the same grid. */
    stems?: { b?: ManifestStem };
    format: typeof MANIFEST_FORMAT;
    formatVersion: number;
    analyzerVersion: string;
    /** `sha256:<hex>` of the source file's bytes: a content id, stable across hosts. */
    id: string;
    createdAt: string;
    /** Seconds on the playback timeline (frames / sampleRate). */
    duration: number;
    /** Playback sample rate (of segments and peaks). */
    sampleRate: number;
    /** Sample rate of the original. */
    sourceSampleRate: number;
    channels: number;
    /** Frames on the playback timeline. */
    frames: number;
    source: {
        name: string | null;
        bytes: number;
        encoding: string;
        bitsPerSample: number;
        frames: number;
    };
    /** Present when the playback rate differs from the source rate. */
    resample: {
        from: number;
        to: number;
        method: string;
        passbandHz: number;
        stopbandHz: number;
        stopbandDb: number;
    } | null;
    segments: {
        codec: 'wav-pcm16';
        framesPerSegment: number;
        list: ManifestSegment[];
    };
    peaks: {
        url: string;
        bytes: number;
        format: 'rtd-peaks';
        version: number;
        encoding: 'int16-min-max-rms';
        levels: ManifestPeakLevel[];
    };
    loudness: ManifestLoudness;
    /** v2: low-frequency energy track for the high-pass preview (bands.bin). */
    bands?: {
        url: string;
        bytes: number;
        format: 'rtd-bands';
        version: number;
        framesPerBin: number;
        bins: number;
        cutoffsHz: number[];
    };
    /** v2: overview spectrogram (spectrogram.bin). */
    spectrogram?: {
        url: string;
        bytes: number;
        format: 'rtd-spectrogram';
        version: number;
        rows: number;
        minHz: number;
        maxHz: number;
        topDb: number;
        rangeDb: number;
        levels: Array<{ framesPerColumn: number; columns: number; byteOffset: number; byteLength: number }>;
    };
}

/** Throws when `value` is not a manifest this version can play. */
export function assertManifest(value: unknown): asserts value is AudioManifest {
    const m = value as Partial<AudioManifest> | null;
    if (!m || typeof m !== 'object' || m.format !== MANIFEST_FORMAT) {
        throw new Error('Not an rtd audio manifest');
    }
    if (typeof m.formatVersion !== 'number' || m.formatVersion > MANIFEST_FORMAT_VERSION) {
        throw new Error(`Unsupported manifest version ${String(m.formatVersion)} (this player reads ${MANIFEST_FORMAT_VERSION})`);
    }
    if (!(m.sampleRate! > 0) || !(m.channels! > 0) || !(m.frames! >= 0) || !m.segments?.list || !m.peaks?.url) {
        throw new Error('Manifest is missing required fields');
    }
    if (m.segments.codec !== 'wav-pcm16') {
        throw new Error(`Unsupported segment codec ${String(m.segments.codec)}`);
    }
}
