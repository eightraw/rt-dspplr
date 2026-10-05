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
 * Keys of named stems: an opaque, host-chosen id, 1-32 characters of ASCII
 * letters, digits, `_` and `-`, starting with a letter or digit. The library
 * never interprets a key. `a` (any case) is reserved for the source itself;
 * `b` is the default key. Keys are compared case-insensitively for collisions,
 * because a stem's files live under `<key>/` (case-insensitive file systems).
 */
export const STEM_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
/** The key used when a host names no stem (and the key of every manifest written before named stems). */
export const DEFAULT_STEM_KEY = 'b';

/** Whether `key` is a valid stem key (STEM_KEY_PATTERN, and not the reserved `a`). */
export function isStemKey(key: unknown): key is string {
    return typeof key === 'string' && STEM_KEY_PATTERN.test(key) && key.toLowerCase() !== 'a';
}

/** Throws a descriptive error when `key` is not a valid stem key. */
export function assertStemKey(key: unknown): asserts key is string {
    if (isStemKey(key)) return;
    if (typeof key === 'string' && key.toLowerCase() === 'a') throw new Error('Stem key "a" is reserved for the source');
    throw new Error(`Invalid stem key ${JSON.stringify(key)}: 1-32 of [A-Za-z0-9_-], starting with a letter or digit`);
}

/**
 * A stem on the source's frame grid: a time-aligned derivative of A (the
 * same timeline), mixed with A by the player's A/B knob. What it contains is
 * up to the host. Written by prepareAudio() / attachStem(); `status` says
 * where it stands.
 */
export interface ManifestStem {
    status: 'processing' | 'ready' | 'failed';
    /** A human name for interfaces (the card shows `label ?? key`). Never interpreted. */
    label?: string;
    error?: string;
    updatedAt: string;
    /**
     * The A this stem was made from (A's manifest id, sha256 of its source bytes):
     * a host compares it, and `processor`, to spot a stale stem and reprocess.
     */
    aSourceId?: string;
    /** The external processor that made the stem (absent for a ready-made input). */
    processor?: { id: string; version: string; params?: Record<string, unknown>; durationMs: number };
    /** sha256 of the stem's source bytes. */
    id?: string;
    source?: {
        name: string | null;
        bytes: number;
        sampleRate: number;
        channels: number;
        frames: number;
        /** Highest frequency the stem carries (from a 16 kHz input: ~8 kHz): the UI can say it lacks highs. */
        bandwidthHz: number;
    };
    /** Where the stem sat against A, measured by cross-correlation and compensated (shifted by -offsetFrames). */
    alignment?: {
        offsetFrames: number;
        offsetMs: number;
        /** Median normalised correlation peak of the windows that agree (0..1). */
        confidence: number;
        windows: number;
        agreeing: number;
    };
    /** Zero-lag correlation of A and the aligned stem: the whole clip, and per segment. */
    correlation?: { global: number; perSegment: number[] };
    /** The mix law for this pair: 'crossfade' for a correlated pair (level kept at every position). */
    mixLaw?: 'crossfade' | 'equal-power';
    /** The stem's loudness minus A's (gated RMS), information only - never applied automatically. */
    loudnessDeltaDb?: number;
    /** An explicit, opt-in trim for the stem (default 0). */
    gainDb?: number;
    loudness?: ManifestLoudness;
    segments?: AudioManifest['segments'];
    peaks?: AudioManifest['peaks'];
    bands?: AudioManifest['bands'];
    spectrogram?: AudioManifest['spectrogram'];
}

/** Named stems of a manifest (v3): key -> stem. See STEM_KEY_PATTERN. */
export type ManifestStems = Record<string, ManifestStem>;

export interface AudioManifest {
    /** Bumped on every rewrite of the manifest (a stem attached…). */
    revision?: number;
    /** v3: named stems on the same grid (`b` when the host named none). */
    stems?: ManifestStems;
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

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isInt = (v: unknown, min = 0): v is number => Number.isInteger(v) && (v as number) >= min;
const isStr = (v: unknown): v is string => typeof v === 'string';

function checkSegments(s: unknown, where: string): string | null {
    if (!isObj(s)) return `${where} is missing`;
    if (s.codec !== 'wav-pcm16') return `Unsupported segment codec ${String(s.codec)}`;
    if (!isInt(s.framesPerSegment, 1)) return `${where}.framesPerSegment must be a positive integer`;
    if (!Array.isArray(s.list)) return `${where}.list must be an array`;
    for (const [i, seg] of s.list.entries()) {
        if (!isObj(seg) || !isInt(seg.index) || !isInt(seg.startFrame) || !isInt(seg.frames) || !isStr(seg.url) || !isInt(seg.bytes)) {
            return `${where}.list[${i}] needs index, startFrame, frames, url and bytes`;
        }
    }
    return null;
}

function checkPeaks(p: unknown, where: string): string | null {
    if (!isObj(p) || !isStr(p.url) || !isInt(p.bytes) || p.format !== 'rtd-peaks' || !isInt(p.version, 1) || !Array.isArray(p.levels)) {
        return `${where} needs url, bytes, format 'rtd-peaks', version and levels`;
    }
    for (const [i, l] of p.levels.entries()) {
        if (!isObj(l) || !isInt(l.framesPerPeak, 1) || !isInt(l.peaks) || !isInt(l.byteOffset) || !isInt(l.byteLength)) {
            return `${where}.levels[${i}] needs framesPerPeak, peaks, byteOffset and byteLength`;
        }
    }
    return null;
}

function checkBlock(b: unknown, where: string, format: string): string | null {
    if (b === undefined) return null;
    if (!isObj(b) || !isStr(b.url) || !isInt(b.bytes) || b.format !== format || !isInt(b.version, 1)) {
        return `${where} needs url, bytes, format '${format}' and version`;
    }
    return null;
}

function checkLoudness(l: unknown, where: string): string | null {
    if (!isObj(l) || !isNum(l.peak) || !isNum(l.peakDb) || !isNum(l.rmsDb) || !isNum(l.gatedRmsDb) || !Array.isArray(l.perChannel)) {
        return `${where} needs peak, peakDb, rmsDb, gatedRmsDb and perChannel`;
    }
    return null;
}

/**
 * Why `value` is not a manifest this version can play, or null when it is.
 * The rules are those of `manifest.schema.json` (shipped as
 * `@saitdigital/rt-dspplr/manifest.schema.json`) for the fields the player reads;
 * see docs/manifest.md.
 */
export function manifestProblem(value: unknown): string | null {
    if (!isObj(value) || value.format !== MANIFEST_FORMAT) return 'Not an rtd audio manifest';
    const m = value;
    if (!isInt(m.formatVersion, 1)) return `Unsupported manifest version ${String(m.formatVersion)}`;
    if (m.formatVersion > MANIFEST_FORMAT_VERSION) {
        return `Unsupported manifest version ${String(m.formatVersion)} (this player reads ${MANIFEST_FORMAT_VERSION} and older)`;
    }
    if (!isStr(m.analyzerVersion) || !isStr(m.id) || !isStr(m.createdAt)) return 'Manifest is missing required fields (analyzerVersion, id, createdAt)';
    if (!isNum(m.duration) || m.duration < 0 || !isInt(m.sampleRate, 1) || !isInt(m.sourceSampleRate, 1) || !isInt(m.channels, 1) || !isInt(m.frames)) {
        return 'Manifest is missing required fields (duration, sampleRate, sourceSampleRate, channels, frames)';
    }
    if (m.revision !== undefined && !isInt(m.revision, 1)) return 'revision must be a positive integer';
    const src = m.source;
    if (!isObj(src) || !(src.name === null || isStr(src.name)) || !isInt(src.bytes) || !isStr(src.encoding) || !isInt(src.bitsPerSample, 1) || !isInt(src.frames)) {
        return 'Manifest is missing required fields (source)';
    }
    if (m.resample !== null && !(isObj(m.resample) && isInt(m.resample.from, 1) && isInt(m.resample.to, 1))) return 'resample must be null or { from, to, ... }';
    const problem = checkSegments(m.segments, 'segments') ?? checkPeaks(m.peaks, 'peaks') ?? checkLoudness(m.loudness, 'loudness')
        ?? checkBlock(m.bands, 'bands', 'rtd-bands') ?? checkBlock(m.spectrogram, 'spectrogram', 'rtd-spectrogram');
    if (problem) return problem;
    if (m.stems !== undefined) {
        if (!isObj(m.stems)) return 'stems must be an object of named stems';
        const seen = new Set<string>();
        for (const [key, stem] of Object.entries(m.stems)) {
            if (!isStemKey(key)) return `Invalid stem key ${JSON.stringify(key)}`;
            if (seen.has(key.toLowerCase())) return `Stem keys collide on ${JSON.stringify(key)} (keys are case-insensitive)`;
            seen.add(key.toLowerCase());
            const where = `stems.${key}`;
            if (!isObj(stem) || !['processing', 'ready', 'failed'].includes(stem.status as string) || !isStr(stem.updatedAt)) {
                return `${where} needs status ('processing' | 'ready' | 'failed') and updatedAt`;
            }
            if (stem.label !== undefined && !(isStr(stem.label) && stem.label.length > 0 && stem.label.length <= 120)) return `${where}.label must be a string of 1-120 characters`;
            if (stem.gainDb !== undefined && !isNum(stem.gainDb)) return `${where}.gainDb must be a number`;
            if (stem.processor !== undefined && !(isObj(stem.processor) && isStr(stem.processor.id) && isStr(stem.processor.version))) return `${where}.processor needs id and version`;
            if (stem.mixLaw !== undefined && stem.mixLaw !== 'crossfade' && stem.mixLaw !== 'equal-power') return `${where}.mixLaw must be 'crossfade' or 'equal-power'`;
            if (stem.status === 'ready') {
                const p = checkSegments(stem.segments, `${where}.segments`) ?? checkPeaks(stem.peaks, `${where}.peaks`)
                    ?? checkBlock(stem.bands, `${where}.bands`, 'rtd-bands') ?? checkBlock(stem.spectrogram, `${where}.spectrogram`, 'rtd-spectrogram');
                if (p) return p;
            }
        }
    }
    return null;
}

/** Throws when `value` is not a manifest this version can play (see manifestProblem()). */
export function assertManifest(value: unknown): asserts value is AudioManifest {
    const problem = manifestProblem(value);
    if (problem) throw new Error(problem);
}

/** Keys of the manifest's stems that are ready to play, in manifest order. */
export function readyStemKeys(manifest: Pick<AudioManifest, 'stems'>): string[] {
    return Object.entries(manifest.stems ?? {}).filter(([, s]) => s.status === 'ready' && !!s.segments).map(([k]) => k);
}
