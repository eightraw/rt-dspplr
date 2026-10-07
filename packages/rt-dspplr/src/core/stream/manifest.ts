// ---------------------------------------------------------------------------
// The prepared-audio manifest: what `prepareAudio()` writes and the stream
// player reads. JSON, versioned. Specified in docs/manifest.md.
// ---------------------------------------------------------------------------

export const MANIFEST_FORMAT = 'rtd-audio-manifest';
/**
 * Version of the manifest layout. 4: the audio is the original file itself
 * (`segments.source`) and the segments are an index into it - byte ranges the
 * player fetches and decodes; nothing is cut up or saved again. Versions 1-3
 * (16-bit WAV segment files) are not read.
 */
export const MANIFEST_FORMAT_VERSION = 4;
/**
 * Version of the analysis that produced segments, peaks and loudness. Hosts
 * re-run prepare when it changes (e.g. a new peak level layout).
 */
export const ANALYZER_VERSION = '2.0.0';

/** Codecs of a source the player decodes itself. */
export const SOURCE_CODECS = ['wav', 'mp3', 'flac', 'opus'] as const;
export type SourceCodec = (typeof SOURCE_CODECS)[number];

/**
 * The audio of a timeline: one file, as it was given (or, for a format the
 * player does not read, one WAV made from it). The segments are byte ranges of it.
 */
export interface ManifestSource {
    /** The file, relative to the manifest's URL (or absolute). */
    url: string;
    bytes: number;
    codec: SourceCodec;
    /** What it decodes to: for A, the timeline's rate and channels. */
    sampleRate: number;
    channels: number;
    /** wav: the layout of its samples. */
    pcm?: { encoding: 'int' | 'float'; bitsPerSample: number; blockAlign: number };
    /** flac and opus: the stream's header, put before a run of frames or pages to decode it (base64). */
    header?: string;
}

/**
 * A stretch of the timeline and the bytes of the source that hold it. The bytes
 * [range[0], range[1]) are fetched and decoded as one run: it starts a little
 * early (a decoder's warm-up), and `tail` counts the run's samples from the
 * segment's first one to the run's end - counted from the end because a
 * decoder may give nothing for the run's first frame. `lead` frames of
 * silence come first (a stem that starts after A), `trail` frames of silence
 * last (a stem that ends before A); a segment the source does not reach is
 * silence (`range` null).
 */
export interface ManifestSegment {
    index: number;
    /** First frame of the segment on the playback timeline. */
    startFrame: number;
    frames: number;
    range: [number, number] | null;
    tail: number;
    lead?: number;
    trail?: number;
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
        /** Share of the measured windows that agree on the offset (agreeing / windows, 0..1). */
        confidence: number;
        /** Windows measured (where A and the stem both sound). */
        windows: number;
        /** Windows whose correlation peak sits at the offset (±2 frames). */
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
    /** Sample rate of the original (the timeline's: nothing is resampled). */
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
    segments: {
        framesPerSegment: number;
        source: ManifestSource;
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
// Optional fields: absent, or of the schema's type.
const optNum = (v: unknown) => v === undefined || isNum(v);
const optInt = (v: unknown, min = 0) => v === undefined || isInt(v, min);
const optStr = (v: unknown) => v === undefined || isStr(v);
const optObj = (v: unknown) => v === undefined || isObj(v);
const optNums = (v: unknown) => v === undefined || (Array.isArray(v) && v.every(isNum));

/** The trim a stem may carry, in dB (the schema's range). */
export const STEM_GAIN_DB_MIN = -60;
export const STEM_GAIN_DB_MAX = 12;

// What a manifest may describe: the player allocates from these numbers, so a
// manifest outside them is refused (and prepare refuses such inputs).
/** The longest segment, in seconds: a segment is decoded and held whole. */
export const MAX_SEGMENT_SECONDS = 60;
/** Sample rates of a timeline and of a source, Hz. */
export const MIN_SAMPLE_RATE = 8000;
export const MAX_SAMPLE_RATE = 384000;
/** Channels of a timeline and of a source (Web Audio's limit for a node). */
export const MAX_CHANNELS = 32;
/** The rate every Opus stream decodes at. */
const OPUS_RATE = 48000;

const isRate = (v: unknown): v is number => isInt(v, MIN_SAMPLE_RATE) && v <= MAX_SAMPLE_RATE;
const isChannels = (v: unknown): v is number => isInt(v, 1) && v <= MAX_CHANNELS;

function checkSource(src: unknown, where: string): string | null {
    if (!isObj(src) || !isStr(src.url) || !isInt(src.bytes) || !(SOURCE_CODECS as readonly unknown[]).includes(src.codec) || !isInt(src.sampleRate, 1) || !isInt(src.channels, 1)) {
        return `${where} needs url, bytes, codec (${SOURCE_CODECS.join(', ')}), sampleRate and channels`;
    }
    if (!isRate(src.sampleRate)) return `${where}.sampleRate must be ${MIN_SAMPLE_RATE}-${MAX_SAMPLE_RATE} Hz`;
    if (!isChannels(src.channels)) return `${where}.channels must be 1-${MAX_CHANNELS}`;
    if (src.codec === 'opus' && src.sampleRate !== OPUS_RATE) return `${where}: an opus source decodes at ${OPUS_RATE} Hz, not ${src.sampleRate}`;
    if (src.codec === 'wav') {
        const p = src.pcm;
        if (!isObj(p) || (p.encoding !== 'int' && p.encoding !== 'float') || !isInt(p.bitsPerSample, 8) || !isInt(p.blockAlign, 1)) {
            return `${where}.pcm needs encoding ('int' | 'float'), bitsPerSample and blockAlign`;
        }
    }
    if ((src.codec === 'flac' || src.codec === 'opus') && !isStr(src.header)) return `${where}.header is needed for ${src.codec}`;
    return null;
}

/** `sampleRate`: the timeline's, for the longest segment (MAX_SEGMENT_SECONDS). */
function checkSegments(s: unknown, where: string, sampleRate: number): string | null {
    if (!isObj(s)) return `${where} is missing`;
    if (!isInt(s.framesPerSegment, 1)) return `${where}.framesPerSegment must be a positive integer`;
    const most = MAX_SEGMENT_SECONDS * sampleRate;
    if (s.framesPerSegment > most) return `${where}.framesPerSegment is over ${MAX_SEGMENT_SECONDS} s (${most} frames)`;
    const source = checkSource(s.source, `${where}.source`);
    if (source) return source;
    const bytes = (s.source as ManifestSource).bytes;
    if (!Array.isArray(s.list)) return `${where}.list must be an array`;
    for (const [i, seg] of s.list.entries()) {
        if (!isObj(seg) || !isInt(seg.index) || !isInt(seg.startFrame) || !isInt(seg.frames) || !isInt(seg.tail) || !optInt(seg.lead) || !optInt(seg.trail)) {
            return `${where}.list[${i}] needs index, startFrame, frames and tail (lead and trail counts)`;
        }
        if (seg.frames > most) return `${where}.list[${i}] is over ${MAX_SEGMENT_SECONDS} s (${seg.frames} frames)`;
        if ((seg.lead ?? 0) + (seg.trail ?? 0) > seg.frames) return `${where}.list[${i}]: lead + trail exceed its frames`;
        const r = seg.range;
        if (r !== null && !(Array.isArray(r) && r.length === 2 && isInt(r[0]) && isInt(r[1]) && r[1] > r[0] && r[1] <= bytes)) {
            return `${where}.list[${i}].range must be null or [start, end) within the source`;
        }
    }
    return null;
}

/**
 * Segments that tile the timeline: in order from frame 0, back to back, none
 * empty, ending at `frames` (docs/manifest.md; the schema cannot say it).
 */
function checkTiling(list: ManifestSegment[], frames: number, where: string): string | null {
    if (list.length === 0) return `${where}.list is empty`;
    let next = 0;
    for (const [i, seg] of list.entries()) {
        if (seg.index !== i) return `${where}.list[${i}].index must be ${i}`;
        if (seg.startFrame !== next) return `${where}.list[${i}] must start at frame ${next} (segments tile the timeline)`;
        if (seg.frames < 1) return `${where}.list[${i}] is empty`;
        next += seg.frames;
    }
    if (next !== frames) return `${where} cover ${next} frames, the timeline has ${frames}`;
    return null;
}

/** A ready stem's segments sit on A's grid: the same frames in the same places. */
function checkGrid(list: ManifestSegment[], grid: ManifestSegment[], where: string): string | null {
    if (list.length !== grid.length) return `${where} has ${list.length} segments, A has ${grid.length} (stems are on A's grid)`;
    for (const [i, seg] of list.entries()) {
        if (seg.startFrame !== grid[i].startFrame || seg.frames !== grid[i].frames) return `${where}.list[${i}] is off A's grid`;
    }
    return null;
}

function checkPeaks(p: unknown, where: string): string | null {
    if (!isObj(p) || !isStr(p.url) || !isInt(p.bytes) || p.format !== 'rtd-peaks' || !isInt(p.version, 1) || !Array.isArray(p.levels)) {
        return `${where} needs url, bytes, format 'rtd-peaks', version and levels`;
    }
    if (p.encoding !== undefined && p.encoding !== 'int16-min-max-rms') return `${where}.encoding must be 'int16-min-max-rms'`;
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
    if (format === 'rtd-bands' && !(optInt(b.framesPerBin, 1) && optInt(b.bins) && optNums(b.cutoffsHz))) {
        return `${where}: framesPerBin must be a positive integer, bins a count, cutoffsHz numbers`;
    }
    if (format === 'rtd-spectrogram') {
        if (!(optInt(b.rows, 1) && optNum(b.minHz) && optNum(b.maxHz) && optNum(b.topDb) && optNum(b.rangeDb))) {
            return `${where}: rows must be a positive integer; minHz, maxHz, topDb and rangeDb numbers`;
        }
        if (b.levels !== undefined) {
            if (!Array.isArray(b.levels)) return `${where}.levels must be an array`;
            for (const [i, l] of b.levels.entries()) {
                if (!isObj(l) || !optInt(l.framesPerColumn, 1) || !optInt(l.columns) || !optInt(l.byteOffset) || !optInt(l.byteLength)) {
                    return `${where}.levels[${i}]: framesPerColumn must be a positive integer; columns, byteOffset and byteLength counts`;
                }
            }
        }
    }
    return null;
}

function checkLoudness(l: unknown, where: string): string | null {
    if (!isObj(l) || !isNum(l.peak) || !isNum(l.peakDb) || !isNum(l.rmsDb) || !isNum(l.gatedRmsDb) || !Array.isArray(l.perChannel)) {
        return `${where} needs peak, peakDb, rmsDb, gatedRmsDb and perChannel`;
    }
    for (const [i, c] of l.perChannel.entries()) {
        if (!isObj(c) || !optNum(c.peakDb) || !optNum(c.rmsDb)) return `${where}.perChannel[${i}] needs numeric peakDb and rmsDb`;
    }
    return null;
}

/** The optional descriptive fields of a stem, as the schema types them. */
function checkStemFields(stem: Record<string, unknown>, where: string): string | null {
    if (!optStr(stem.error) || !optStr(stem.aSourceId) || !optStr(stem.id)) return `${where}: error, aSourceId and id must be strings`;
    const p = stem.processor;
    if (p !== undefined && !(isObj(p) && isStr(p.id) && isStr(p.version) && optObj(p.params) && optNum(p.durationMs))) {
        return `${where}.processor needs id and version (params an object, durationMs a number)`;
    }
    const src = stem.source;
    if (src !== undefined && !(isObj(src) && (src.name === undefined || src.name === null || isStr(src.name)) && optInt(src.bytes)
        && optInt(src.sampleRate, 1) && optInt(src.channels, 1) && optInt(src.frames) && optNum(src.bandwidthHz))) {
        return `${where}.source has a field of the wrong type`;
    }
    const al = stem.alignment;
    if (al !== undefined && !(isObj(al) && (al.offsetFrames === undefined || Number.isInteger(al.offsetFrames)) && optNum(al.offsetMs)
        && optNum(al.confidence) && optInt(al.windows) && optInt(al.agreeing))) {
        return `${where}.alignment: offsetFrames must be an integer, windows and agreeing counts`;
    }
    const co = stem.correlation;
    if (co !== undefined && !(isObj(co) && optNum(co.global) && optNums(co.perSegment))) return `${where}.correlation must hold numbers`;
    if (!optNum(stem.loudnessDeltaDb)) return `${where}.loudnessDeltaDb must be a number`;
    if (stem.loudness !== undefined) return checkLoudness(stem.loudness, `${where}.loudness`);
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
    if (m.formatVersion !== MANIFEST_FORMAT_VERSION) {
        return `Unsupported manifest version ${String(m.formatVersion)} (this player reads version ${MANIFEST_FORMAT_VERSION}: prepare the recording again)`;
    }
    if (!isStr(m.analyzerVersion) || !isStr(m.id) || !isStr(m.createdAt)) return 'Manifest is missing required fields (analyzerVersion, id, createdAt)';
    if (!isNum(m.duration) || m.duration < 0 || !isInt(m.sampleRate, 1) || !isInt(m.sourceSampleRate, 1) || !isInt(m.channels, 1) || !isInt(m.frames)) {
        return 'Manifest is missing required fields (duration, sampleRate, sourceSampleRate, channels, frames)';
    }
    if (!isRate(m.sampleRate) || !isRate(m.sourceSampleRate)) return `sampleRate and sourceSampleRate must be ${MIN_SAMPLE_RATE}-${MAX_SAMPLE_RATE} Hz`;
    if (!isChannels(m.channels)) return `channels must be 1-${MAX_CHANNELS}`;
    if (m.revision !== undefined && !isInt(m.revision, 1)) return 'revision must be a positive integer';
    const src = m.source;
    if (!isObj(src) || !(src.name === null || isStr(src.name)) || !isInt(src.bytes) || !isStr(src.encoding) || !isInt(src.bitsPerSample, 1) || !isInt(src.frames)) {
        return 'Manifest is missing required fields (source)';
    }
    const problem = checkSegments(m.segments, 'segments', m.sampleRate) ?? checkPeaks(m.peaks, 'peaks') ?? checkLoudness(m.loudness, 'loudness')
        ?? checkBlock(m.bands, 'bands', 'rtd-bands') ?? checkBlock(m.spectrogram, 'spectrogram', 'rtd-spectrogram');
    if (problem) return problem;
    const a = (m.segments as AudioManifest['segments']).source;
    if (a.sampleRate !== m.sampleRate || a.channels !== m.channels) {
        return `segments.source decodes to ${a.sampleRate} Hz, ${a.channels} channel(s); the timeline is ${m.sampleRate} Hz, ${m.channels}`;
    }
    const grid = (m.segments as AudioManifest['segments']).list;
    const tiling = checkTiling(grid, m.frames, 'segments');
    if (tiling) return tiling;
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
            // Characters as the schema counts them (code points, not UTF-16 units).
            if (stem.label !== undefined && !(isStr(stem.label) && stem.label.length > 0 && [...stem.label].length <= 120)) return `${where}.label must be a string of 1-120 characters`;
            if (stem.gainDb !== undefined && !(isNum(stem.gainDb) && stem.gainDb >= STEM_GAIN_DB_MIN && stem.gainDb <= STEM_GAIN_DB_MAX)) {
                return `${where}.gainDb must be a number from ${STEM_GAIN_DB_MIN} to ${STEM_GAIN_DB_MAX}`;
            }
            if (stem.mixLaw !== undefined && stem.mixLaw !== 'crossfade' && stem.mixLaw !== 'equal-power') return `${where}.mixLaw must be 'crossfade' or 'equal-power'`;
            const fields = checkStemFields(stem, where);
            if (fields) return fields;
            // The blocks are checked whenever present; a ready stem must have segments and peaks.
            if (stem.status === 'ready' && (stem.segments === undefined || stem.peaks === undefined)) return `${where} is ready but has no segments or peaks`;
            const p = (stem.segments === undefined ? null : checkSegments(stem.segments, `${where}.segments`, m.sampleRate))
                ?? (stem.peaks === undefined ? null : checkPeaks(stem.peaks, `${where}.peaks`))
                ?? checkBlock(stem.bands, `${where}.bands`, 'rtd-bands') ?? checkBlock(stem.spectrogram, `${where}.spectrogram`, 'rtd-spectrogram');
            if (p) return p;
            if (stem.status === 'ready') {
                const segments = stem.segments as AudioManifest['segments'];
                const g = checkGrid(segments.list, grid, `${where}.segments`);
                if (g) return g;
                // Played under A: at A's rate, on A's channels or on all of them from one.
                const s = segments.source;
                if (s.sampleRate !== m.sampleRate || (s.channels !== m.channels && s.channels !== 1)) {
                    return `${where}.segments.source decodes to ${s.sampleRate} Hz, ${s.channels} channel(s); a stem is at A's rate (${m.sampleRate} Hz) with A's channels (${m.channels}) or 1`;
                }
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
