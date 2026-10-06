import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { finished, pipeline } from 'node:stream/promises';
import {
    ANALYZER_VERSION,
    BANDS_VERSION,
    DEFAULT_FRAMES_PER_BAND_BIN,
    MANIFEST_FORMAT,
    MANIFEST_FORMAT_VERSION,
    PEAKS_VERSION,
    SPECTROGRAM_VERSION,
    assertManifest,
    assertStemKey,
    encodeBandsFile,
    encodePeaksFile,
    encodeSpectrogramFile,
    peaksLayout,
    spectrogramLayout,
    type AudioManifest,
    type ManifestLoudness,
    type ManifestSegment,
    type ManifestSource,
    type ManifestStem,
    type SpectrogramFile,
} from '@saitdigital/rt-dspplr/format';
import { checkFramesPerPeak, DEFAULT_FRAMES_PER_PEAK, levelsFromFinest, loudnessFrom, type FinestPeaks } from './analysis';
import { spectrogramLevels, SPECTROGRAM_RANGE_DB, SPECTROGRAM_TOP_DB } from './overviewAnalysis';
import { jobFrames, WARMUP_FRAMES, type JobResult, type JobSpec } from './jobs';
import { callConcurrency, defaultConcurrency, JobPool, type PreparePool } from './pool';
import os from 'node:os';
import { finiteBlocks, type AudioDecoder, type SourceFormat, type SourceLayout } from './decoder';
import { builtinDecoder } from './wasm/decoders';
import { type ResamplerOptions } from './resampler';
import { indexSegments, mappable, mapSource, readRange, SOURCE_CONTENT_TYPES, sourceWavSink, wavMap, type SourceMap, type WavSink } from './sourceIndex';
import { sourceReader, verifyIndex } from './sourceReader';
import { buildStem, failedStem, StemAlignmentError, type StemInput, type StemOptions } from './stem';
import { plainExtension, runProcessor, StemProcessorError, type StemProcessor } from './processors';

// ---------------------------------------------------------------------------
// prepareAudio — ingest-time preparation of a long recording for the stream
// player, in one streaming pass with bounded memory: the original file kept as
// it is with an index of it (the byte ranges of fixed-length segments, which
// the player fetches and decodes), multi-level peaks, bands, a spectrogram,
// loudness and a manifest. A format the player does not decode is kept as a
// 16-bit WAV instead.
// ---------------------------------------------------------------------------

/** Where outputs go. Keys are relative paths like `peaks.bin` or `source.mp3`. */
export interface PrepareStorage {
    putObject(key: string, data: Uint8Array, contentType: string): Promise<void>;
    /** Store a local file (the source, which may be large). Default: read whole and putObject(). */
    putFile?(key: string, file: string, contentType: string): Promise<void>;
    /** Read back an object (stems: B is correlated with A, read from its source). */
    getObject?(key: string): Promise<Uint8Array | null>;
    /** Read part of an object (attachStem reads A's source in ranges). Default: getObject() once, sliced. */
    getRange?(key: string, start: number, end: number): Promise<Uint8Array | null>;
}

/**
 * A named stem, made in the same prepare call and published in the same
 * manifest: either a ready-made stem (`input`) or an external `processor`
 * that makes it from A. Exactly one of the two.
 *
 * A stem must be a time-aligned derivative of A (same timeline, same events
 * at the same times): the player blends it with A sample by sample. Output
 * that changes timing is not a stem; publish it as a clip of its own.
 *
 * @experimental The stem processor API may change in minor releases before 1.0.
 */
export interface StemSpec extends StemOptions {
    input?: StemInput;
    processor?: StemProcessor;
    /** A human name, stored in the manifest for interfaces (the card shows `label ?? key`). Never interpreted. */
    label?: string;
    /** Processor timeout (ms). Default: the processor's own, else 30 min. */
    timeoutMs?: number;
    /**
     * The processor failed, or its output could not be read: fail the job
     * (default) or publish without this stem, a short reason recorded in its
     * entry (the detailed one goes to `job.stats.warnings`). A cancel always fails the job.
     */
    onProcessorError?: 'fail' | 'skip';
}

/** Wall-clock parts of one stem (ms). */
export interface StemTimings {
    /** The processor's run (beside A), or null for a ready-made input. */
    processorMs: number | null;
    /** How long the job waited for the processor after A was done. */
    processorWaitMs: number;
    /** Aligning, converting and writing the stem, or null when it was skipped. */
    stemMs: number | null;
}

export type PrepareStatus = 'queued' | 'processing' | 'ready' | 'failed';

export interface PrepareProgress {
    status: PrepareStatus;
    /** What is running: A's decode and analyses, a stem's processor, a stem's files. */
    stage?: 'a' | 'processor' | 'stem';
    /** The stem key of the 'processor' and 'stem' stages. */
    stem?: string;
    /** The processor's own progress (0..1) when it reports one. */
    processorFraction?: number;
    /** 0..1 by A's source bytes read (NaN when the size is unknown). */
    fraction: number;
    bytesRead: number;
    totalBytes: number | null;
    /** Frames decoded on the timeline. */
    frames: number;
    /** Whole segments decoded so far. */
    segments: number;
}

export interface PrepareOptions {
    /** Write into this folder (created). Either this or `storage`. */
    outDir?: string;
    /** Or hand every output to your own store (S3, a database...). */
    storage?: PrepareStorage;
    /** Segment length in seconds (what the player fetches at a time). Default 10. */
    segmentSeconds?: number;
    /** Finest stored peak level, frames per peak: a power of two from 16 to 65536. Default 256. */
    framesPerPeak?: number;
    /** The converter of a stem at another rate than A (A itself is never resampled: the player converts). */
    resampler?: ResamplerOptions;
    /**
     * Decoder for the input. Default: the built-in one, which reads WAV, MP3, Opus and FLAC
     * itself. WAV, MP3 and Opus are kept as they are; anything else is kept as a 16-bit WAV.
     */
    decoder?: AudioDecoder;
    /** Source size in bytes, for progress, when the input is a stream. */
    sizeHint?: number;
    /**
     * Name recorded in the manifest (`source.name`). Default: the file name of a
     * path input. Only its last path part is kept; no file is named after it.
     */
    name?: string;
    /** Write bands.bin (high-pass preview). Default true. */
    bands?: boolean;
    /** Write spectrogram.bin (overview spectrogram). Default true. */
    spectrogram?: boolean;
    /**
     * Worker threads for the analyses (peaks, bands, spectrogram). Default: cores − 1, at
     * least 1. The output does not depend on it (byte-identical for any value).
     */
    concurrency?: number;
    /**
     * Analysis threads kept between calls (createPreparePool()): what a service should pass.
     * Without it each call makes its own (`concurrency`), or none for a short input.
     */
    pool?: PreparePool;
    /** Where prepare-worker.mjs is, when the default (next to this module) does not apply. */
    workerUrl?: URL;
    /** Read size for path inputs. Default 1 MiB. */
    readChunkBytes?: number;
    signal?: AbortSignal;
    onProgress?: (progress: PrepareProgress) => void;
    /**
     * Named stems in the same manifest: `{ [key]: { input | processor, label? } }`.
     * Keys are opaque, host-chosen ids (STEM_KEY_PATTERN of `@saitdigital/rt-dspplr/format`,
     * not `a`); `b` is the player's default. Each stem's files go under
     * `<key>/r<revision>/` (`b/r1/source.wav`): a replaced stem never
     * overwrites the files of the one before.
     */
    stems?: Record<string, StemSpec>;
    /** Scratch folder for processors (default: the OS temp folder). */
    tmpDir?: string;
}

export interface PrepareStats {
    elapsedMs: number;
    outputBytes: number;
    segments: number;
    /** Analysis threads used (1 = inline on the main thread). */
    threads: number;
    /**
     * Wall-clock parts (ms): A's timeline, then the stems. The stems run side by side, so
     * `stemsPhaseMs` is the time they took together (what the job waited) and the per-stem
     * times overlap: `stemMs` is their sum, neither a share of the total nor CPU time. The other
     * totals: the longest processor (they run beside A), the summed waits for them after A.
     */
    timings: { aMs: number; processorMs: number | null; processorWaitMs: number; stemMs: number | null; stemsPhaseMs: number | null; stems: Record<string, StemTimings> };
    /**
     * e.g. a stem that was skipped (onProcessorError 'skip', onLowConfidence 'warn'),
     * with the detailed reason for the server's log (the manifest has a short one),
     * or non-finite samples that were replaced.
     */
    warnings: string[];
}

type JobEvents = { progress: PrepareProgress; status: PrepareStatus };

export interface PrepareJob {
    readonly status: PrepareStatus;
    readonly progress: PrepareProgress;
    readonly error: Error | null;
    /** Set once ready. */
    readonly stats: PrepareStats | null;
    readonly done: Promise<AudioManifest>;
    on<E extends keyof JobEvents>(event: E, listener: (payload: JobEvents[E]) => void): () => void;
    cancel(): void;
}

export type PrepareInput = string | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;

/** Stores outputs as files under `dir`. */
export function fsStorage(dir: string): PrepareStorage {
    const made = new Set<string>();
    const fileOf = async (key: string) => {
        const file = path.join(dir, ...key.split('/'));
        const parent = path.dirname(file);
        if (!made.has(parent)) {
            await fsp.mkdir(parent, { recursive: true });
            made.add(parent);
        }
        return file;
    };
    return {
        async getObject(key) {
            try {
                return await fsp.readFile(path.join(dir, ...key.split('/')));
            } catch {
                return null;
            }
        },
        async getRange(key, start, end) {
            try {
                return await readRange(path.join(dir, ...key.split('/')), start, end);
            } catch {
                return null;
            }
        },
        async putFile(key, from) {
            const file = await fileOf(key);
            if (path.resolve(from) !== path.resolve(file)) await fsp.copyFile(from, file);
        },
        async putObject(key, data) {
            const file = await fileOf(key);
            if (key === 'manifest.json') {
                // Atomic: a reader sees the old manifest or the new one, never half of one.
                const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
                await fsp.writeFile(temp, data);
                await fsp.rename(temp, file);
                return;
            }
            await fsp.writeFile(file, data);
        },
    };
}

/** Keeps outputs in a Map (tests, or to upload elsewhere yourself). */
export function memoryStorage(): PrepareStorage & { objects: Map<string, Uint8Array>; getObject(key: string): Promise<Uint8Array | null> } {
    const objects = new Map<string, Uint8Array>();
    return {
        objects,
        async getObject(key) {
            return objects.get(key) ?? null;
        },
        async putObject(key, data) {
            objects.set(key, data.slice());
        },
    };
}


/** Stores a local file under `key` (putFile, else read whole and putObject). Returns its size. */
export async function storeFile(storage: PrepareStorage, key: string, file: string, contentType: string): Promise<number> {
    if (storage.putFile) await storage.putFile(key, file, contentType);
    else await storage.putObject(key, await fsp.readFile(file), contentType);
    return (await fsp.stat(file)).size;
}

/** Reads ranges of a stored object (getRange, else the whole object once). */
export function storedRanges(storage: PrepareStorage, key: string): (start: number, end: number) => Promise<Uint8Array> {
    let whole: Promise<Uint8Array | null> | null = null;
    return async (start, end) => {
        const bytes = storage.getRange ? await storage.getRange(key, start, end) : (await (whole ??= storage.getObject?.(key) ?? Promise.resolve(null)))?.subarray(start, end);
        if (!bytes) throw new Error(`${key} cannot be read back`);
        return bytes;
    };
}

/** A name fit for the manifest's `source.name`: the last part of a path, without control characters; null when nothing is left. */
export function fileNameOnly(name: string | null | undefined): string | null {
    if (typeof name !== 'string') return null;
    const base = (name.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255);
    return base && base !== '.' && base !== '..' ? base : null;
}

/**
 * The manifest's bytes, checked with the player's own assertManifest() on
 * what JSON makes of it (a non-finite number becomes null): a manifest the
 * player would refuse is never published.
 */
export function manifestBytes(manifest: AudioManifest): Uint8Array {
    const text = JSON.stringify(manifest, null, 1);
    try {
        assertManifest(JSON.parse(text));
    } catch (error) {
        throw new Error(`the manifest does not validate, so it was not written: ${error instanceof Error ? error.message : String(error)}`);
    }
    return new TextEncoder().encode(text);
}

/**
 * A file written chunk by chunk, with backpressure. An error of the stream
 * (ENOSPC, EACCES...) rejects the write or the end that meets it; it never
 * goes unhandled, and a wait for 'drain' never outlives it.
 */
function fileSink(file: string): { write(chunk: Uint8Array): Promise<void>; end(): Promise<void>; destroy(): void } {
    const ws = fs.createWriteStream(file);
    let failed: Error | null = null;
    ws.on('error', (error) => { failed ??= error; });
    return {
        async write(chunk) {
            if (failed) throw failed;
            // once() rejects when 'error' comes first.
            if (!ws.write(chunk)) await once(ws, 'drain');
        },
        async end() {
            if (failed) throw failed;
            ws.end();
            await finished(ws);
        },
        destroy: () => ws.destroy(),
    };
}

async function* readableToIterable(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
    const reader = stream.getReader();
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            if (value) yield value;
        }
    } finally {
        reader.releaseLock();
    }
}

export function prepareAudio(input: PrepareInput, options: PrepareOptions = {}): PrepareJob {
    const listeners: { [E in keyof JobEvents]: Set<(payload: JobEvents[E]) => void> } = { progress: new Set(), status: new Set() };
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) forwardAbort();
    else options.signal?.addEventListener('abort', forwardAbort, { once: true });
    let progress: PrepareProgress = { status: 'queued', fraction: 0, bytesRead: 0, totalBytes: options.sizeHint ?? null, frames: 0, segments: 0 };
    let error: Error | null = null;
    let stats: PrepareStats | null = null;

    const emit = <E extends keyof JobEvents>(event: E, payload: JobEvents[E]) => {
        for (const listener of [...listeners[event]]) {
            try {
                (listener as (p: JobEvents[E]) => void)(payload);
            } catch (e) {
                console.error('[prepareAudio] listener threw', e);
            }
        }
    };
    const setProgress = (patch: Partial<PrepareProgress>) => {
        const statusChanged = patch.status !== undefined && patch.status !== progress.status;
        progress = { ...progress, ...patch };
        if (progress.totalBytes) progress.fraction = Math.min(1, progress.bytesRead / progress.totalBytes);
        else progress.fraction = NaN;
        if (patch.status === 'ready') progress.fraction = 1;
        options.onProgress?.(progress);
        emit('progress', progress);
        if (statusChanged) emit('status', progress.status);
    };

    const done = (async (): Promise<AudioManifest> => {
        await Promise.resolve(); // 'queued' until the caller had a chance to subscribe
        const t0 = performance.now();
        setProgress({ status: 'processing' });
        try {
            const result = await run(input, options, controller.signal, setProgress);
            stats = { elapsedMs: performance.now() - t0, outputBytes: result.outputBytes, segments: result.manifest.segments.list.length, threads: result.threads, timings: result.timings, warnings: result.warnings };
            setProgress({ status: 'ready' });
            return result.manifest;
        } catch (e) {
            error = e instanceof Error ? e : new Error(String(e));
            setProgress({ status: 'failed' });
            throw error;
        } finally {
            options.signal?.removeEventListener('abort', forwardAbort);
        }
    })();
    done.catch(() => undefined);

    return {
        get status() { return progress.status; },
        get progress() { return progress; },
        get error() { return error; },
        get stats() { return stats; },
        done,
        on(event, listener) {
            listeners[event].add(listener as never);
            return () => listeners[event].delete(listener as never);
        },
        cancel() {
            controller.abort(new Error('prepareAudio cancelled'));
        },
    };
}

/** The stems option, checked: valid keys, no case-insensitive collision, exactly one of input/processor. */
function checkStemSpecs(stems: PrepareOptions['stems']): Array<[string, StemSpec]> {
    if (stems === undefined) return [];
    if (typeof stems !== 'object' || stems === null || Array.isArray(stems)) throw new Error('stems must be an object: { [key]: { input | processor } }');
    const seen = new Map<string, string>();
    const out: Array<[string, StemSpec]> = [];
    for (const [key, spec] of Object.entries(stems)) {
        if (spec === undefined) continue;
        assertStemKey(key);
        const lower = key.toLowerCase();
        if (seen.has(lower)) throw new Error(`stems.${key} collides with stems.${seen.get(lower)} (stem keys are case-insensitive: their files share a folder)`);
        seen.set(lower, key);
        if (!spec || !spec.input === !spec.processor) throw new Error(`stems.${key} needs exactly one of \`input\` (a ready stem) or \`processor\``);
        if (spec.label !== undefined && (typeof spec.label !== 'string' || spec.label.length === 0 || spec.label.length > 120)) {
            throw new Error(`stems.${key}.label must be a string of 1-120 characters`);
        }
        out.push([key, spec]);
    }
    return out;
}

async function run(
    input: PrepareInput,
    options: PrepareOptions,
    signal: AbortSignal,
    setProgress: (patch: Partial<PrepareProgress>) => void,
): Promise<{ manifest: AudioManifest; outputBytes: number; threads: number; timings: PrepareStats['timings']; warnings: string[] }> {
    if (signal.aborted) throw signal.reason ?? new Error('prepareAudio cancelled');
    const storage = options.storage ?? (options.outDir ? fsStorage(options.outDir) : null);
    if (!storage) throw new Error('prepareAudio needs `outDir` or `storage`');
    const segmentSeconds = options.segmentSeconds ?? 10;
    if (!(segmentSeconds > 0)) throw new Error('segmentSeconds must be > 0');
    const framesPerPeak = checkFramesPerPeak(options.framesPerPeak ?? DEFAULT_FRAMES_PER_PEAK);
    const stemSpecs = checkStemSpecs(options.stems);
    const warnings: string[] = [];
    const tStart = performance.now();

    // Scratch folder: A's bytes when A is a stream, a WAV of a format the player cannot read, processors' output.
    let tmpDir: string | null = null;
    const scratch = async () => (tmpDir ??= await fsp.mkdtemp(path.join(options.tmpDir ?? os.tmpdir(), 'rtd-prepare-')));

    // Source bytes: hashed (content id) and counted (progress) on the way to the decoder.
    let source: AsyncIterable<Uint8Array>;
    // The manifest records a file name, never a path; no file is ever named after it.
    let name = options.name === undefined ? null : fileNameOnly(options.name);
    let aPath: string | null = null;
    if (typeof input === 'string') {
        const stat = await fsp.stat(input);
        setProgress({ totalBytes: stat.size, stage: 'a' });
        if (options.name === undefined) name = fileNameOnly(path.basename(input));
        aPath = input;
        source = fs.createReadStream(input, { highWaterMark: options.readChunkBytes ?? 1 << 20 });
    } else if (typeof (input as ReadableStream).getReader === 'function') {
        source = readableToIterable(input as ReadableStream<Uint8Array>);
    } else {
        source = input as AsyncIterable<Uint8Array>;
    }
    // The original is kept as it is (the player reads it): a stream input is copied to the scratch
    // folder on the way, under a fixed name (with the name's extension when it is a plain one, for
    // decoders and processors that go by it).
    let tee: ReturnType<typeof fileSink> | null = null;
    if (!aPath) {
        aPath = path.join(await scratch(), `a${plainExtension(name ?? '')}`);
        tee = fileSink(aPath);
    }
    let aBytesDone!: () => void;
    const aBytesRead = new Promise<void>((resolve) => { aBytesDone = resolve; });
    const hash = createHash('sha256');
    let bytesRead = 0;
    const sourceIterator = source[Symbol.asyncIterator]();
    let sourceDone = false;
    const take = async (): Promise<Uint8Array | null> => {
        if (signal.aborted) throw signal.reason ?? new Error('aborted');
        const r = await sourceIterator.next();
        if (r.done) {
            sourceDone = true;
            return null;
        }
        const bytes = r.value instanceof Uint8Array ? r.value : new Uint8Array(r.value as ArrayBufferLike);
        hash.update(bytes);
        bytesRead += bytes.length;
        if (tee) await tee.write(bytes);
        return bytes;
    };
    // The decoder's view of the bytes. It may stop before their end (a WAV's chunks after its data,
    // a tag after the last MP3 frame): its return() does not stop them, drain() reads the rest
    // into the copy and the content id.
    const tapped: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator]: () => ({
            next: async () => {
                const bytes = sourceDone ? null : await take();
                return bytes ? { value: bytes, done: false } : { value: undefined, done: true };
            },
            return: async () => ({ value: undefined, done: true }),
        }),
    };
    const drain = async () => {
        while (!sourceDone) await take();
        if (tee) await tee.end();
        aBytesDone();
    };

    // The processor is stopped when the job ends for any reason (cancel, A failed).
    const processorStop = new AbortController();
    const stopProcessor = () => processorStop.abort(signal.reason ?? new Error('prepare ended'));
    signal.addEventListener('abort', stopProcessor, { once: true });
    // The caller's pool, kept; else one for this call (none for a short input).
    const inputBytes = typeof input === 'string' ? await fsp.stat(input).then((st) => st.size, () => null) : options.sizeHint ?? null;
    const pool = (options.pool as JobPool | undefined) ?? new JobPool(callConcurrency(options.concurrency, inputBytes), options.workerUrl);
    let blocks: AsyncIterator<Float32Array[]> | null = null;
    const nonFinite = { replaced: 0 };
    let wav: WavSink | null = null;
    try {
        const decoder = options.decoder ?? builtinDecoder;
        const decoded = decoder(tapped, { signal });
        // When the first block already fails, the format is never awaited: that rejection is not an unhandled one.
        decoded.format.catch(() => undefined);
        blocks = finiteBlocks(decoded.blocks, nonFinite, decoded.format)[Symbol.asyncIterator]();
        // The format is known once the decoder has read the header, i.e. on the first block.
        const next = await blocks.next();
        const format: SourceFormat = await decoded.format;
        const channels = format.channels;
        // The timeline is the source's own rate: nothing is resampled (the player converts).
        const rate = format.sampleRate;
        const framesPerSegment = framesPerSegmentOf(segmentSeconds, rate);

        // ---- the processors run beside A's own work, all at once ------------------------------
        type ProcessorRun = { output: Awaited<ReturnType<typeof runProcessor>>['output']; durationMs: number } | { error: unknown; durationMs: number };
        const processorRuns = new Map<string, Promise<ProcessorRun>>();
        for (const [key, spec] of stemSpecs) {
            if (!spec.processor) continue;
            const processor = spec.processor;
            const start = async (): Promise<ProcessorRun> => {
                const t0 = performance.now();
                try {
                    const dir = await fsp.mkdtemp(path.join(await scratch(), 'p-'));
                    const file = aPath!;
                    const r = await runProcessor(processor, {
                        path: file,
                        stream: () => fs.createReadStream(file, { highWaterMark: 1 << 20 }),
                        sampleRate: format.sampleRate,
                        channels: format.channels,
                        frames: format.frames,
                        tmpDir: dir,
                        onProgress: (fraction) => setProgress({ processorFraction: fraction, stem: key }),
                    }, { signal: processorStop.signal, timeoutMs: spec.timeoutMs });
                    return r;
                } catch (error) {
                    return { error, durationMs: Math.round(performance.now() - t0) };
                }
            };
            // A path input: at once. A stream input: once its bytes are all in the scratch copy.
            const run = tee ? aBytesRead.then(start) : start();
            run.catch(() => undefined);
            processorRuns.set(key, run);
        }

        async function* decodedBlocks(): AsyncGenerator<Float32Array[]> {
            let n = next;
            while (!n.done) {
                yield n.value;
                n = await blocks!.next();
            }
        }
        // A format the player does not decode is written as a WAV on the way; the others are
        // checked against their index (the first and last segments, kept as they go by).
        if (!mappable(format.layout)) wav = await sourceWavSink(path.join(await scratch(), 'source.wav'), channels, rate);
        const checks = segmentChecks();
        const timeline = await writeTimeline({
            source: decodedBlocks(),
            channels,
            rate,
            storage,
            options,
            pool,
            framesPerPeak,
            segmentSeconds,
            signal,
            onFrames: (frames) => setProgress({ bytesRead, frames, segments: Math.floor(frames / framesPerSegment), ...(stemSpecs.length ? { stage: 'a' } : {}) }),
            onBlock: wav ? (block) => wav!.write(block) : undefined,
            onSegment: wav ? undefined : checks.keep,
        });
        await drain();
        const { totalFrames, loudness, bands, spectrogram } = timeline;
        let outputBytes = timeline.outputBytes;

        // ---- the source: kept as it is with its index, or as a WAV ----------------------------
        const aFile = aPath;
        const stored = await storeSource({
            storage,
            prefix: '',
            what: 'A',
            // Non-finite samples were replaced in what was analysed: the file that holds them is not kept.
            file: nonFinite.replaced ? null : aFile,
            layout: format.layout,
            sampleRate: rate,
            channels,
            sourceFrames: totalFrames,
            frames: totalFrames,
            framesPerSegment,
            offset: 0,
            timeline: { rate, channels },
            checks: checks.list(),
            wav,
            wavFile: path.join(await scratch(), 'source.wav'),
            rewrite: async (sink) => {
                for await (const block of finiteBlocks(decoder(fs.createReadStream(aFile, { highWaterMark: 1 << 20 }), { signal }).blocks, { replaced: 0 })) await sink.write(block);
            },
            onWarning: (message) => warnings.push(message),
        });
        wav = null; // ended by storeSource
        outputBytes += stored.bytes;
        const aMs = Math.round(performance.now() - tStart);
        const manifest: AudioManifest = {
            format: MANIFEST_FORMAT,
            formatVersion: MANIFEST_FORMAT_VERSION,
            analyzerVersion: ANALYZER_VERSION,
            revision: 1,
            id: `sha256:${hash.digest('hex')}`,
            createdAt: new Date().toISOString(),
            duration: totalFrames / rate,
            sampleRate: rate,
            sourceSampleRate: rate,
            channels,
            frames: totalFrames,
            source: { name, bytes: bytesRead, encoding: format.encoding, bitsPerSample: format.bitsPerSample, frames: format.frames ?? totalFrames },
            segments: { framesPerSegment, source: stored.source, list: stored.list },
            peaks: timeline.peaks,
            loudness,
            ...(bands ? { bands } : {}),
            ...(spectrogram ? { spectrogram } : {}),
        };

        if (nonFinite.replaced) warnings.push(`A: ${nonFinite.replaced} non-finite samples replaced (NaN → 0, ±Infinity → ±1)`);

        // ---- stems: processed (or given), aligned, adapted, on A's grid, side by side ----
        // Each stem's files depend on it and A only, so they are the same bytes in any order.
        // The first stem that fails the job stops the others (stemStop) and is the error reported.
        const stemTimings: Record<string, StemTimings> = {};
        const stems: Record<string, ManifestStem> = {};
        const cancelled = (error?: unknown) => signal.reason ?? error ?? new Error('prepareAudio cancelled');
        const stemStop = new AbortController();
        const stemSignal = AbortSignal.any([signal, stemStop.signal]);
        // One reader of A for all the stems, from the local copy of what was stored.
        const readA = sourceReader(manifest.segments, channels, (start, end) => readRange(stored.file, start, end));
        const stemsStart = performance.now();
        for (const [key] of stemSpecs) stemTimings[key] = { processorMs: null, processorWaitMs: 0, stemMs: null };
        const oneStem = async ([key, spec]: [string, StemSpec]): Promise<ManifestStem | null> => {
            const timing = stemTimings[key];
            stemTimings[key] = timing;
            const labelled = (entry: ManifestStem): ManifestStem => (spec.label ? Object.assign({ status: entry.status, label: spec.label }, entry) : entry);
            let stem: ManifestStem | null = null;
            let input: StemInput | null = spec.input ?? null;
            let provenance: ManifestStem['processor'];
            /**
             * A processor stem that could not be made: the job fails, or with 'skip' the
             * stem is published as failed with a short reason (the detail goes to the warnings).
             * A cancel is never turned into a skipped stem.
             */
            const processorFailed = (error: unknown, publicMessage: string): ManifestStem => {
                if (signal.aborted) throw cancelled(error);
                if (spec.onProcessorError !== 'skip') throw error;
                warnings.push(`stems.${key} skipped: ${error instanceof Error ? error.message : String(error)}`);
                return labelled(failedStem(manifest, publicMessage, provenance ? { processor: provenance } : {}));
            };
            const processorRun = processorRuns.get(key);
            if (processorRun) {
                setProgress({ stage: 'processor', stem: key });
                const tw = performance.now();
                const r = await processorRun;
                if (signal.aborted) throw cancelled();
                timing.processorWaitMs = Math.round(performance.now() - tw);
                timing.processorMs = r.durationMs;
                const p = spec.processor!;
                provenance = { id: p.id, version: p.version, ...(p.params ? { params: p.params } : {}), durationMs: r.durationMs };
                if ('error' in r) {
                    stem = processorFailed(r.error, r.error instanceof StemProcessorError ? r.error.publicMessage : 'processor failed');
                } else if ('stream' in r.output) {
                    // Read more than once (alignment, then writing) and maybe kept: spooled to the scratch folder first.
                    const file = path.join(await scratch(), `${key}.stream`);
                    const out = r.output.stream;
                    const iterable = typeof (out as ReadableStream).getReader === 'function' ? readableToIterable(out as ReadableStream<Uint8Array>) : (out as AsyncIterable<Uint8Array>);
                    try {
                        await pipeline(iterable, fs.createWriteStream(file), { signal });
                        input = file;
                    } catch (error) {
                        stem = processorFailed(error, 'processor failed: output could not be read');
                    }
                } else if ('path' in r.output) {
                    input = r.output.path;
                } else {
                    input = r.output;
                }
            }
            if (!stem && input) {
                setProgress({ stage: 'stem', stem: key });
                const t0 = performance.now();
                try {
                    stem = labelled(await buildStem({
                        storage,
                        readA,
                        manifest,
                        stem: key,
                        revision: manifest.revision ?? 1,
                        input,
                        options: spec,
                        prepare: options,
                        pool,
                        signal: stemSignal,
                        scratch,
                        processor: provenance,
                        onProgress: (stage, fraction) => {
                            if (stage === 'writing') setProgress({ stage: 'stem', stem: key, frames: Math.round(fraction * totalFrames) });
                        },
                        onWarning: (message) => warnings.push(message),
                    }));
                } catch (error) {
                    if (signal.aborted) throw cancelled(error);
                    if (error instanceof StemAlignmentError) {
                        if ((spec.onLowConfidence ?? 'fail') !== 'warn') throw error;
                        stem = labelled(failedStem(manifest, error, provenance ? { processor: provenance } : {}));
                        warnings.push(`stems.${key} skipped: ${stem.error}`);
                    } else if (spec.processor) {
                        // The processor ran, but what it returned cannot be decoded or used.
                        stem = processorFailed(error, 'processor failed: output could not be read');
                    } else {
                        throw error;
                    }
                }
                timing.stemMs = Math.round(performance.now() - t0);
                outputBytes += [stem.peaks?.bytes ?? 0, stem.bands?.bytes ?? 0, stem.spectrogram?.bytes ?? 0, stem.segments?.source.bytes ?? 0].reduce((x, y) => x + y, 0);
            }
            return stem;
        };
        const settled = await Promise.all(stemSpecs.map((entry) => oneStem(entry).then(
            (stem) => ({ stem }),
            (error: unknown) => {
                stemStop.abort(error);
                return { error };
            },
        )));
        if (signal.aborted) throw cancelled();
        const failed = settled.find((r): r is { error: unknown } => 'error' in r);
        if (failed) throw failed.error;
        stemSpecs.forEach(([key], i) => {
            const stem = (settled[i] as { stem: ManifestStem | null }).stem;
            if (stem) stems[key] = stem;
        });
        if (Object.keys(stems).length) manifest.stems = stems;
        const stemsPhaseMs = stemSpecs.length ? Math.round(performance.now() - stemsStart) : null;
        const all = Object.values(stemTimings);
        const processorMs = all.some((t) => t.processorMs !== null) ? Math.max(...all.map((t) => t.processorMs ?? 0)) : null;
        const processorWaitMs = all.reduce((n, t) => n + t.processorWaitMs, 0);
        const stemMs = all.some((t) => t.stemMs !== null) ? all.reduce((n, t) => n + (t.stemMs ?? 0), 0) : null;

        const bytes = manifestBytes(manifest);
        // A job cancelled at the last moment publishes nothing.
        if (signal.aborted) throw cancelled();
        // Written last: a manifest's presence means every file it lists is in place.
        await storage.putObject('manifest.json', bytes, 'application/json');
        outputBytes += bytes.length;
        return { manifest, outputBytes, threads: timeline.threads, timings: { aMs, processorMs, processorWaitMs, stemMs, stemsPhaseMs, stems: stemTimings }, warnings };
    } finally {
        signal.removeEventListener('abort', stopProcessor);
        processorStop.abort(new Error('prepare ended'));
        // A failed or cancelled job: let go of the decoder and the source file.
        await blocks?.return?.(undefined).catch(() => undefined);
        await sourceIterator.return?.(undefined)?.catch(() => undefined);
        if (source && typeof (source as fs.ReadStream).destroy === 'function') (source as fs.ReadStream).destroy();
        if (!options.pool) await pool.close();
        tee?.destroy();
        await wav?.close();
        if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
}

/** Frames of a segment of `seconds` at `rate` (at least one). */
export function framesPerSegmentOf(seconds: number, rate: number): number {
    return Math.max(1, Math.round(seconds * rate));
}

/**
 * Keeps three of a timeline's segments as they go by (writeTimeline's onSegment), to check its
 * index against: the first, the latest whose index is a power of two (past the middle), the last.
 */
export function segmentChecks(): { keep: (index: number, planes: Float32Array[], frames: number) => void; list: () => Array<{ index: number; planes: Float32Array[] }> } {
    let first: { index: number; planes: Float32Array[] } | null = null;
    let middle: { index: number; planes: Float32Array[] } | null = null;
    let last: { index: number; planes: Float32Array[]; buffers: Float32Array[] } | null = null;
    return {
        keep(index, planes, frames) {
            if (index === 0) first = { index, planes: planes.map((p) => p.slice(0, frames)) };
            else if ((index & (index - 1)) === 0) middle = { index, planes: planes.map((p) => p.slice(0, frames)) };
            else {
                // The latest one, in buffers of its own (reused: the arrays given are).
                if (!last || last.buffers[0].length < frames) last = { index, planes: [], buffers: planes.map((p) => new Float32Array(p.length)) };
                last.index = index;
                last.planes = last.buffers.map((b, c) => {
                    b.set(planes[c].subarray(0, frames));
                    return b.subarray(0, frames);
                });
            }
        },
        list: () => [first, middle, last].filter((c): c is { index: number; planes: Float32Array[] } => c !== null).map(({ index, planes }) => ({ index, planes })),
    };
}

export interface StoredSource {
    source: ManifestSource;
    list: ManifestSegment[];
    /** The local file that was stored. */
    file: string;
    bytes: number;
}

/**
 * The source of a timeline, stored under `<prefix>source.<codec>` and indexed: the decoded file
 * itself when the player reads its format and its index reads back right (`checks`), else a
 * 16-bit WAV of the timeline (`wav`, written on the way, or written now by `rewrite`).
 */
export async function storeSource(a: {
    storage: PrepareStorage;
    prefix: string;
    /** Who the warnings name ('A', 'stems.b'). */
    what: string;
    /** The original file (null: there is none to keep). */
    file: string | null;
    layout: SourceLayout | undefined;
    /** The file's own rate, channels and decoded frames. */
    sampleRate: number;
    channels: number;
    sourceFrames: number;
    /** The timeline: its frames, segments, rate and channels, and where the file's sample t + offset plays. */
    frames: number;
    framesPerSegment: number;
    offset: number;
    timeline: { rate: number; channels: number };
    checks: Array<{ index: number; planes: Float32Array[] }>;
    wav: WavSink | null;
    wavFile: string;
    rewrite: (sink: WavSink) => Promise<void>;
    onWarning: (message: string) => void;
}): Promise<StoredSource> {
    let map: SourceMap | null = null;
    let file = a.file;
    let offset = a.offset;
    let list: ManifestSegment[] = [];
    if (!a.wav && file && mappable(a.layout)) {
        const original = file;
        try {
            map = await mapSource(original, a.layout, a.sampleRate, a.channels, a.sourceFrames);
            list = indexSegments(a.frames, a.framesPerSegment, map, offset);
            await verifyIndex(map.describe, list, a.timeline.channels, (start, end) => readRange(original, start, end), a.checks);
        } catch (error) {
            a.onWarning(`${a.what}: the ${a.layout.kind} file could not be indexed (${error instanceof Error ? error.message : String(error)}); kept as a 16-bit WAV instead`);
            map = null;
        }
    }
    if (!map) {
        let wav = a.wav;
        if (!wav) {
            wav = await sourceWavSink(a.wavFile, a.timeline.channels, a.timeline.rate);
            try {
                await a.rewrite(wav);
            } catch (error) {
                await wav.close();
                throw error;
            }
        }
        const frames = await wav.end();
        if (frames !== a.frames) throw new Error(`${a.what}: its WAV holds ${frames} frames, the timeline ${a.frames}`);
        map = wavMap(a.timeline.channels, a.timeline.rate, frames);
        file = wav.file;
        offset = 0;
        list = indexSegments(a.frames, a.framesPerSegment, map, offset);
    }
    const key = `${a.prefix}source.${map.describe.codec}`;
    const bytes = await storeFile(a.storage, key, file!, SOURCE_CONTENT_TYPES[map.describe.codec]);
    return { source: { url: key, bytes, ...map.describe }, list, file: file!, bytes };
}

export interface TimelineOutput {
    framesPerSegment: number;
    totalFrames: number;
    outputBytes: number;
    peaks: AudioManifest['peaks'];
    loudness: ManifestLoudness;
    bands: AudioManifest['bands'];
    spectrogram: AudioManifest['spectrogram'];
    threads: number;
}

export interface TimelineInput {
    /** Planar blocks at the timeline's rate. */
    source: AsyncIterable<Float32Array[]>;
    channels: number;
    rate: number;
    storage: PrepareStorage;
    options: PrepareOptions;
    framesPerPeak: number;
    segmentSeconds: number;
    signal: AbortSignal;
    /** Path prefix of every file written ('' for A, '<key>/r<n>/' for a stem). */
    prefix?: string;
    /** A pool shared with the caller (resampling, other stems); else one is made and closed here. */
    pool?: JobPool;
    onFrames?: (frames: number) => void;
    /** Each block as it passes, before the next is read (the WAV of a source the player cannot read). */
    onBlock?: (block: Float32Array[]) => Promise<void>;
    /** Each segment's frames once complete: planar, in arrays reused once the call returns. */
    onSegment?: (index: number, planes: Float32Array[], frames: number) => void | Promise<void>;
}

/**
 * Peaks, loudness, bands and spectrogram of one timeline, from its blocks: one pass hands the
 * audio to a worker pool, which analyses fixed jobs of the timeline (see jobs.ts).
 */
export async function writeTimeline(input: TimelineInput): Promise<TimelineOutput> {
    const { source, channels, rate, storage, options, framesPerPeak, segmentSeconds, signal, onBlock, onSegment } = input;
    const prefix = input.prefix ?? '';
    const onFrames = input.onFrames ?? (() => undefined);
    let lastReport = 0;
    const wantBands = options.bands !== false;
    const wantSpectrogram = options.spectrogram !== false;
    const hop = rate >= 44100 ? 4096 : 2048; // OverviewSpectrogramAnalyzer's default hop
    const J = jobFrames(framesPerPeak, DEFAULT_FRAMES_PER_BAND_BIN, hop);
    const ownPool = !input.pool;
    const pool = input.pool ?? new JobPool(options.concurrency ?? defaultConcurrency(), options.workerUrl);
    const results: JobResult[] = [];
    const inflight = new Set<Promise<void>>();
    let jobIndex = 0;
    let jobStart = 0;
    let warm = 0;
    let jobBuf = Array.from({ length: channels }, () => new Float32Array(WARMUP_FRAMES + J));
    let jobFill = 0; // frames in jobBuf, warm-up included

    const dispatch = async (final: boolean) => {
        const frames = jobFill - warm;
        if (frames <= 0 && !(final && jobIndex === 0)) return;
        const keep = Math.min(WARMUP_FRAMES, jobFill);
        // The next job's warm-up: the end of this one (copied before the transfer).
        // Inline (no worker): the job has run when pool.run() returns, so its buffers are reused.
        const reuse = !pool.threaded;
        const nextWarm = final || reuse ? null : jobBuf.map((x) => x.slice(jobFill - keep, jobFill));
        const job: JobSpec = {
            index: jobIndex,
            startFrame: jobStart,
            frames,
            warmup: warm,
            final,
            sampleRate: rate,
            framesPerPeak,
            bands: wantBands,
            spectrogram: wantSpectrogram,
            channels: jobBuf.map((x) => (jobFill === x.length ? x : x.subarray(0, jobFill))),
        };
        const running = pool.run(job).then((r) => { results[r.index] = r as JobResult; });
        const tracked = running.finally(() => inflight.delete(tracked));
        inflight.add(tracked);
        jobIndex += 1;
        jobStart += frames;
        if (!final && reuse) {
            for (const x of jobBuf) x.copyWithin(0, jobFill - keep, jobFill);
            warm = keep;
            jobFill = keep;
        } else if (nextWarm) {
            jobBuf = Array.from({ length: channels }, () => new Float32Array(WARMUP_FRAMES + J));
            nextWarm.forEach((w, c) => jobBuf[c].set(w));
            warm = keep;
            jobFill = keep;
        }
        // Bounded memory: no more audio in flight than the pool can work on.
        while (inflight.size > pool.size) await Promise.race(inflight);
    };

    const feedJobs = async (block: Float32Array[], n: number) => {
        let i = 0;
        while (i < n) {
            const take = Math.min(n - i, warm + J - jobFill);
            for (let c = 0; c < channels; c += 1) jobBuf[c].set(block[c].subarray(i, i + take), jobFill);
            jobFill += take;
            i += take;
            if (jobFill === warm + J) await dispatch(false);
        }
    };

    const framesPerSegment = framesPerSegmentOf(segmentSeconds, rate);
    // Segments are gathered only for onSegment.
    const segPlanes = onSegment ? Array.from({ length: channels }, () => new Float32Array(framesPerSegment)) : null;
    let segIndex = 0;
    let segFill = 0;
    let totalFrames = 0;
    let outputBytes = 0;

    const flushSegment = async () => {
        if (!segPlanes || segFill === 0) return;
        await onSegment!(segIndex, segPlanes, segFill);
        segIndex += 1;
        segFill = 0;
    };

    const consume = async (block: Float32Array[]) => {
        const n = block[0]?.length ?? 0;
        if (n === 0) return;
        await feedJobs(block, n);
        if (onBlock) await onBlock(block);
        if (segPlanes) {
            let i = 0;
            while (i < n) {
                const take = Math.min(n - i, framesPerSegment - segFill);
                for (let c = 0; c < channels; c += 1) segPlanes[c].set(block[c].subarray(i, i + take), segFill);
                segFill += take;
                i += take;
                if (segFill === framesPerSegment) await flushSegment();
            }
        }
        totalFrames += n;
        const now = performance.now();
        if (now - lastReport > 200) {
            lastReport = now;
            onFrames(totalFrames);
        }
    };

    try {
        for await (const block of source) {
            if (signal.aborted) throw signal.reason ?? new Error('aborted');
            await consume(block);
        }
        await flushSegment();
        await dispatch(true);
        await Promise.all(inflight);
    } finally {
        if (ownPool) await pool.close();
        else await Promise.allSettled(inflight);
    }
    onFrames(totalFrames);
    if (totalFrames === 0) throw new Error('The input holds no audio: it decoded to 0 frames');

    // ---- stitch the jobs, in timeline order --------------------------------------------------
    const ordered = results.filter(Boolean);
    const cat16 = (parts: Int16Array[]) => { const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
    const cat64 = (parts: Float64Array[]) => { const out = new Float64Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
    const finest: FinestPeaks = {
        min: Array.from({ length: channels }, (_, c) => cat16(ordered.map((r) => r.peaks.min[c]))),
        max: Array.from({ length: channels }, (_, c) => cat16(ordered.map((r) => r.peaks.max[c]))),
        sumSq: Array.from({ length: channels }, (_, c) => cat64(ordered.map((r) => r.peaks.sumSq[c]))),
        frames: cat64(ordered.map((r) => r.peaks.frames)),
    };
    const levels = levelsFromFinest(channels, framesPerPeak, totalFrames, finest);
    // Loudness: per channel from the finest sums; 400 ms blocks as whole finest bins.
    const peakPerChannel = Array.from({ length: channels }, (_, c) => Math.max(0, ...ordered.map((r) => r.peaks.peak[c])));
    const sqPerChannel = finest.sumSq.map((s) => s.reduce((a, b) => a + b, 0));
    const blockBins = Math.max(1, Math.round((0.4 * rate) / framesPerPeak));
    const loudnessBlocks: number[] = [];
    for (let b = 0; b < finest.frames.length; b += blockBins) {
        let sq = 0;
        let fr = 0;
        for (let i = b; i < Math.min(finest.frames.length, b + blockBins); i += 1) {
            fr += finest.frames[i];
            for (let c = 0; c < channels; c += 1) sq += finest.sumSq[c][i];
        }
        if (fr >= (blockBins * framesPerPeak) / 4) loudnessBlocks.push(sq / (fr * channels));
    }
    const loudness = loudnessFrom(peakPerChannel, sqPerChannel, loudnessBlocks, totalFrames, channels);

    const peaksBytes = encodePeaksFile({ version: PEAKS_VERSION, sampleRate: rate, channels, frames: totalFrames, levels });
    await storage.putObject(`${prefix}peaks.bin`, peaksBytes, 'application/octet-stream');
    outputBytes += peaksBytes.length;
    const layout = peaksLayout(channels, levels).levels;

    let bands: AudioManifest['bands'];
    if (wantBands) {
        const parts = ordered.map((r) => r.bands!);
        const meanSquares = new Float32Array(parts.reduce((n, p) => n + p.meanSquares.length, 0));
        let o = 0;
        for (const p of parts) { meanSquares.set(p.meanSquares, o); o += p.meanSquares.length; }
        const file = {
            sampleRate: rate,
            framesPerBin: parts[0]?.framesPerBin ?? DEFAULT_FRAMES_PER_BAND_BIN,
            bins: parts.reduce((n, p) => n + p.bins, 0),
            cutoffs: parts[0]?.cutoffs ?? [],
            meanSquares,
        };
        const bytes = encodeBandsFile(file);
        await storage.putObject(`${prefix}bands.bin`, bytes, 'application/octet-stream');
        outputBytes += bytes.length;
        bands = { url: `${prefix}bands.bin`, bytes: bytes.length, format: 'rtd-bands', version: BANDS_VERSION, framesPerBin: file.framesPerBin, bins: file.bins, cutoffsHz: file.cutoffs };
    }
    let spectrogram: AudioManifest['spectrogram'];
    if (wantSpectrogram) {
        const parts = ordered.map((r) => r.spectrogram!);
        const first = parts[0];
        const columns = parts.reduce((n, p) => n + p.columns, 0);
        const a = new Uint8Array(columns * first.rows);
        let o = 0;
        for (const p of parts) { a.set(p.a.subarray(0, p.columns * p.rows), o); o += p.columns * p.rows; }
        const file: SpectrogramFile = {
            sampleRate: rate,
            rows: first.rows,
            frames: totalFrames,
            minHz: first.minHz,
            maxHz: first.maxHz,
            topDb: SPECTROGRAM_TOP_DB,
            rangeDb: SPECTROGRAM_RANGE_DB,
            referenceMax: Math.max(...parts.map((p) => p.reference)),
            levels: spectrogramLevels(a, columns, first.rows, first.hop),
        };
        const bytes = encodeSpectrogramFile(file);
        await storage.putObject(`${prefix}spectrogram.bin`, bytes, 'application/octet-stream');
        outputBytes += bytes.length;
        spectrogram = {
            url: `${prefix}spectrogram.bin`, bytes: bytes.length, format: 'rtd-spectrogram', version: SPECTROGRAM_VERSION,
            rows: file.rows, minHz: file.minHz, maxHz: file.maxHz, topDb: file.topDb, rangeDb: file.rangeDb,
            levels: spectrogramLayout(file.rows, file.levels).levels.map((l) => ({ framesPerColumn: l.hop, columns: l.columns, byteOffset: l.byteOffset, byteLength: l.byteLength })),
        };
    }


    return {
        framesPerSegment,
        totalFrames,
        outputBytes,
        peaks: {
            url: `${prefix}peaks.bin`,
            bytes: peaksBytes.length,
            format: 'rtd-peaks',
            version: PEAKS_VERSION,
            encoding: 'int16-min-max-rms',
            levels: layout.map(({ framesPerPeak: fpp, peaks, byteOffset, byteLength }) => ({ framesPerPeak: fpp, peaks, byteOffset, byteLength })),
        },
        loudness,
        bands,
        spectrogram,
        threads: pool.threaded ? pool.size : 1,
    };
}
