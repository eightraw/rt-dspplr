import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
    ANALYZER_VERSION,
    MANIFEST_FORMAT,
    MANIFEST_FORMAT_VERSION,
    type AudioManifest,
    type ManifestLoudness,
    type ManifestSegment,
} from '../core/stream/manifest';
import { encodePeaksFile, peaksLayout, PEAKS_VERSION } from '../core/stream/peaksFile';
import { wavHeader16 } from '../core/stream/wavFormat';
import { DEFAULT_FRAMES_PER_PEAK, levelsFromFinest, loudnessFrom, type FinestPeaks } from './analysis';
import { encodeBandsFile, BANDS_VERSION, DEFAULT_FRAMES_PER_BAND_BIN } from '../core/stream/bandsFile';
import { encodeSpectrogramFile, spectrogramLayout, SPECTROGRAM_VERSION, type SpectrogramFile } from '../core/stream/spectrogramFile';
import { spectrogramLevels, SPECTROGRAM_RANGE_DB, SPECTROGRAM_TOP_DB } from './overviewAnalysis';
import { jobFrames, WARMUP_FRAMES, type JobResult, type JobSpec } from './jobs';
import { defaultConcurrency, JobPool } from './pool';
import os from 'node:os';
import { wavDecoder, type AudioDecoder, type SourceFormat } from './decoder';
import { type ResamplerOptions } from './resampler';
import { resampleInParallel, resamplerInfo } from './parallelResample';
import { buildStem, failedStem, StemAlignmentError, type StemInput, type StemOptions } from './stem';
import { runProcessor, type StemProcessor } from './processors';
import type { ManifestStem } from '../core/stream/manifest';

// ---------------------------------------------------------------------------
// prepareAudio — ingest-time preparation of a long recording for the stream
// player: fixed-length 16-bit WAV segments, multi-level peaks, loudness and a
// manifest, in one streaming pass with bounded memory.
// ---------------------------------------------------------------------------

/** Where outputs go. Keys are relative paths like `seg/000000.wav`. */
export interface PrepareStorage {
    putObject(key: string, data: Uint8Array, contentType: string): Promise<void>;
    /** Read back an object (needed for stems: B is correlated with A's written segments). */
    getObject?(key: string): Promise<Uint8Array | null>;
}

/**
 * Stem B, made in the same prepare call and published in the same manifest:
 * either a ready-made B (`input`) or an external `processor` that makes it
 * from A. Exactly one of the two.
 */
export interface StemSpec extends StemOptions {
    input?: StemInput;
    processor?: StemProcessor;
    /** Processor timeout (ms). Default: the processor's own, else 30 min. */
    timeoutMs?: number;
    /** The processor failed: fail the job (default) or publish A only, the error recorded in stems.b. */
    onProcessorError?: 'fail' | 'skip';
}

export type PrepareStatus = 'queued' | 'processing' | 'ready' | 'failed';

export interface PrepareProgress {
    status: PrepareStatus;
    /** What is running: A's segments and analyses, the stem processor, stem B. */
    stage?: 'a' | 'processor' | 'b';
    /** The processor's own progress (0..1) when it reports one. */
    processorFraction?: number;
    /** 0..1 by source bytes read (NaN when the size is unknown); with a stem B, A and B count half each. */
    fraction: number;
    bytesRead: number;
    totalBytes: number | null;
    /** Frames written on the playback timeline. */
    frames: number;
    segments: number;
}

export interface PrepareOptions {
    /** Write into this folder (created). Either this or `storage`. */
    outDir?: string;
    /** Or hand every output to your own store (S3, a database...). */
    storage?: PrepareStorage;
    /** Segment length in seconds. Default 10. */
    segmentSeconds?: number;
    /**
     * Playback sample rate. Default 'auto': keep rates up to 48 kHz, take
     * anything above (88.2, 96, 192 kHz...) down to 48 kHz. A number forces
     * that rate; 'keep' never resamples.
     */
    targetRate?: number | 'auto' | 'keep';
    /** Finest stored peak level, frames per peak. Default 256. */
    framesPerPeak?: number;
    resampler?: ResamplerOptions;
    /** Decoder for non-WAV inputs. Default: the built-in streaming WAV reader. */
    decoder?: AudioDecoder;
    /** Source size in bytes, for progress, when the input is a stream. */
    sizeHint?: number;
    /** Name recorded in the manifest. Default: the file name of a path input. */
    name?: string;
    /** Per-segment sha256 in the manifest. Default true. */
    segmentHashes?: boolean;
    /** Write bands.bin (high-pass preview). Default true. */
    bands?: boolean;
    /** Write spectrogram.bin (overview spectrogram). Default true. */
    spectrogram?: boolean;
    /**
     * Worker threads for the analyses (peaks, bands, spectrogram). Default: cores − 1, at
     * least 1. The output does not depend on it (byte-identical for any value).
     */
    concurrency?: number;
    /** Where prepare-worker.mjs is, when the default (next to this module) does not apply. */
    workerUrl?: URL;
    /** Read size for path inputs. Default 1 MiB. */
    readChunkBytes?: number;
    signal?: AbortSignal;
    onProgress?: (progress: PrepareProgress) => void;
    /** Stem B (dry/wet partner of A) in the same manifest. */
    stems?: { b?: StemSpec };
    /** Scratch folder for processors (default: the OS temp folder). */
    tmpDir?: string;
}

export interface PrepareStats {
    elapsedMs: number;
    outputBytes: number;
    segments: number;
    /** Analysis threads used (1 = inline on the main thread). */
    threads: number;
    /** Wall-clock parts (ms): A's timeline, the processor (runs beside A), the wait for it after A, stem B. */
    timings: { aMs: number; processorMs: number | null; processorWaitMs: number; stemMs: number | null };
    /** e.g. a stem B that was skipped (onProcessorError 'skip', onLowConfidence 'warn'). */
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

const pad = (n: number) => String(n).padStart(6, '0');

/** Stores outputs as files under `dir`. */
export function fsStorage(dir: string): PrepareStorage {
    const made = new Set<string>();
    return {
        async getObject(key) {
            try {
                return await fsp.readFile(path.join(dir, ...key.split('/')));
            } catch {
                return null;
            }
        },
        async putObject(key, data) {
            const file = path.join(dir, ...key.split('/'));
            const parent = path.dirname(file);
            if (!made.has(parent)) {
                await fsp.mkdir(parent, { recursive: true });
                made.add(parent);
            }
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

export function chooseTargetRate(sourceRate: number, option: PrepareOptions['targetRate']): number {
    if (typeof option === 'number' && option > 0) return Math.round(option);
    if (option === 'keep') return sourceRate;
    return sourceRate > 48000 ? 48000 : sourceRate;
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
    options.signal?.addEventListener('abort', () => controller.abort(options.signal?.reason), { once: true });
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

async function run(
    input: PrepareInput,
    options: PrepareOptions,
    signal: AbortSignal,
    setProgress: (patch: Partial<PrepareProgress>) => void,
): Promise<{ manifest: AudioManifest; outputBytes: number; threads: number; timings: PrepareStats['timings']; warnings: string[] }> {
    const storage = options.storage ?? (options.outDir ? fsStorage(options.outDir) : null);
    if (!storage) throw new Error('prepareAudio needs `outDir` or `storage`');
    const segmentSeconds = options.segmentSeconds ?? 10;
    if (!(segmentSeconds > 0)) throw new Error('segmentSeconds must be > 0');
    const framesPerPeak = Math.max(16, Math.floor(options.framesPerPeak ?? DEFAULT_FRAMES_PER_PEAK));
    const stemB = options.stems?.b;
    if (stemB && !stemB.input === !stemB.processor) throw new Error('stems.b needs exactly one of `input` (a ready B) or `processor`');
    if (stemB && !storage.getObject) throw new Error('stems.b needs a storage that can read back (getObject), or outDir');
    const warnings: string[] = [];
    const tStart = performance.now();

    // Scratch folder for a processor: A's bytes when A is a stream, the processor's output.
    let tmpDir: string | null = null;
    const scratch = async () => (tmpDir ??= await fsp.mkdtemp(path.join(options.tmpDir ?? os.tmpdir(), 'rtd-prepare-')));

    // Source bytes: hashed (content id) and counted (progress) on the way to the decoder.
    let source: AsyncIterable<Uint8Array>;
    let name = options.name ?? null;
    let aPath: string | null = null;
    if (typeof input === 'string') {
        const stat = await fsp.stat(input);
        setProgress({ totalBytes: stat.size, stage: 'a' });
        name ??= path.basename(input);
        aPath = input;
        source = fs.createReadStream(input, { highWaterMark: options.readChunkBytes ?? 1 << 20 });
    } else if (typeof (input as ReadableStream).getReader === 'function') {
        source = readableToIterable(input as ReadableStream<Uint8Array>);
    } else {
        source = input as AsyncIterable<Uint8Array>;
    }
    // A processor needs A as a file: a stream input is copied to the scratch folder on the way.
    let tee: fs.WriteStream | null = null;
    if (stemB?.processor && !aPath) {
        aPath = path.join(await scratch(), name ?? 'a.wav');
        tee = fs.createWriteStream(aPath);
    }
    let aBytesDone!: () => void;
    const aBytesRead = new Promise<void>((resolve) => { aBytesDone = resolve; });
    const hash = createHash('sha256');
    let bytesRead = 0;
    async function* tap(): AsyncGenerator<Uint8Array> {
        for await (const chunk of source) {
            if (signal.aborted) throw signal.reason ?? new Error('aborted');
            const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBufferLike);
            hash.update(bytes);
            bytesRead += bytes.length;
            if (tee && !tee.write(bytes)) await new Promise<void>((r) => tee!.once('drain', () => r()));
            yield bytes;
        }
        if (tee) await new Promise<void>((resolve, reject) => tee!.end((e?: Error | null) => (e ? reject(e) : resolve())));
        aBytesDone();
    }

    // The processor is stopped when the job ends for any reason (cancel, A failed).
    const processorStop = new AbortController();
    const stopProcessor = () => processorStop.abort(signal.reason ?? new Error('prepare ended'));
    signal.addEventListener('abort', stopProcessor, { once: true });
    const pool = new JobPool(options.concurrency ?? defaultConcurrency(), options.workerUrl);
    let blocks: AsyncIterator<Float32Array[]> | null = null;
    try {
        const decoded = (options.decoder ?? wavDecoder)(tap());
        blocks = decoded.blocks[Symbol.asyncIterator]();
        // The format is known once the decoder has read the header, i.e. on the first block.
        const next = await blocks.next();
        const format: SourceFormat = await decoded.format;
        const channels = format.channels;
        const rate = chooseTargetRate(format.sampleRate, options.targetRate);

        // ---- the processor runs beside A's own work -------------------------------------------
        type ProcessorRun = { output: Awaited<ReturnType<typeof runProcessor>>['output']; durationMs: number } | { error: unknown; durationMs: number };
        let processorRun: Promise<ProcessorRun> | null = null;
        if (stemB?.processor) {
            const processor = stemB.processor;
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
                        onProgress: (fraction) => setProgress({ processorFraction: fraction }),
                    }, { signal: processorStop.signal, timeoutMs: stemB.timeoutMs });
                    return r;
                } catch (error) {
                    return { error, durationMs: Math.round(performance.now() - t0) };
                }
            };
            // A path input: at once. A stream input: once its bytes are all in the scratch copy.
            processorRun = tee ? aBytesRead.then(start) : start();
        }

        async function* decodedBlocks(): AsyncGenerator<Float32Array[]> {
            let n = next;
            while (!n.done) {
                yield n.value;
                n = await blocks!.next();
            }
        }
        const resampled = rate !== format.sampleRate;
        const timeline = await writeTimeline({
            source: resampled ? resampleInParallel(decodedBlocks(), format.sampleRate, rate, pool, options.resampler) : decodedBlocks(),
            channels,
            rate,
            storage,
            options,
            pool,
            framesPerPeak,
            segmentSeconds,
            signal,
            onFrames: (frames) => setProgress({ bytesRead, frames, ...(stemB ? { stage: 'a' } : {}) }),
            onSegments: (count) => setProgress({ segments: count }),
        });
        const aMs = Math.round(performance.now() - tStart);
        const { segments, framesPerSegment, totalFrames, loudness, bands, spectrogram } = timeline;
        let outputBytes = timeline.outputBytes;
        const sourceFrames = format.frames ?? Math.round((totalFrames * format.sampleRate) / rate);
        const info = resampled ? resamplerInfo(format.sampleRate, rate, options.resampler) : null;
        const manifest: AudioManifest = {
            format: MANIFEST_FORMAT,
            formatVersion: MANIFEST_FORMAT_VERSION,
            analyzerVersion: ANALYZER_VERSION,
            revision: 1,
            id: `sha256:${hash.digest('hex')}`,
            createdAt: new Date().toISOString(),
            duration: totalFrames / rate,
            sampleRate: rate,
            sourceSampleRate: format.sampleRate,
            channels,
            frames: totalFrames,
            source: { name, bytes: bytesRead, encoding: format.encoding, bitsPerSample: format.bitsPerSample, frames: sourceFrames },
            resample: info ? {
                from: format.sampleRate,
                to: rate,
                method: info.method,
                passbandHz: Math.round(info.passbandHz),
                stopbandHz: Math.round(info.stopbandHz),
                stopbandDb: info.stopbandDb,
            } : null,
            segments: { codec: 'wav-pcm16', framesPerSegment, list: segments },
            peaks: timeline.peaks,
            loudness,
            ...(bands ? { bands } : {}),
            ...(spectrogram ? { spectrogram } : {}),
        };

        // ---- stem B: processed (or given), aligned, adapted, on A's grid ----------------------
        let processorMs: number | null = null;
        let processorWaitMs = 0;
        let stemMs: number | null = null;
        if (stemB) {
            let stem: ManifestStem | null = null;
            let bInput: StemInput | null = stemB.input ?? null;
            let provenance: ManifestStem['processor'];
            if (processorRun) {
                setProgress({ stage: 'processor' });
                const tw = performance.now();
                const r = await processorRun;
                processorWaitMs = Math.round(performance.now() - tw);
                processorMs = r.durationMs;
                const p = stemB.processor!;
                provenance = { id: p.id, version: p.version, ...(p.params ? { params: p.params } : {}), durationMs: r.durationMs };
                if ('error' in r) {
                    if (stemB.onProcessorError !== 'skip') throw r.error;
                    stem = failedStem(manifest, r.error, { processor: provenance });
                    warnings.push(`stems.b skipped: ${stem.error}`);
                } else if ('stream' in r.output) {
                    // Read twice (alignment, then writing): spooled to the scratch folder first.
                    const file = path.join(await scratch(), 'b.stream');
                    const out = r.output.stream;
                    const iterable = typeof (out as ReadableStream).getReader === 'function' ? readableToIterable(out as ReadableStream<Uint8Array>) : (out as AsyncIterable<Uint8Array>);
                    const ws = fs.createWriteStream(file);
                    for await (const chunk of iterable) if (!ws.write(chunk)) await new Promise<void>((res) => ws.once('drain', () => res()));
                    await new Promise<void>((res, rej) => ws.end((e?: Error | null) => (e ? rej(e) : res())));
                    bInput = file;
                } else if ('path' in r.output) {
                    bInput = r.output.path;
                } else {
                    bInput = r.output;
                }
            }
            if (!stem && bInput) {
                setProgress({ stage: 'b' });
                const t0 = performance.now();
                try {
                    stem = await buildStem({
                        storage,
                        read: (key) => storage.getObject!(key),
                        manifest,
                        stem: 'b',
                        input: bInput,
                        options: stemB,
                        prepare: options,
                        pool,
                        signal,
                        processor: provenance,
                        onProgress: (stage, fraction) => {
                            if (stage === 'writing') setProgress({ stage: 'b', frames: Math.round(fraction * totalFrames) });
                        },
                    });
                } catch (error) {
                    if (!(error instanceof StemAlignmentError) || (stemB.onLowConfidence ?? 'fail') !== 'warn') throw error;
                    stem = failedStem(manifest, error, provenance ? { processor: provenance } : {});
                    warnings.push(`stems.b skipped: ${stem.error}`);
                }
                stemMs = Math.round(performance.now() - t0);
                outputBytes += [stem.peaks?.bytes ?? 0, stem.bands?.bytes ?? 0, stem.spectrogram?.bytes ?? 0, ...(stem.segments?.list.map((x) => x.bytes) ?? [])].reduce((x, y) => x + y, 0);
            }
            if (stem) manifest.stems = { b: stem };
        }

        const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 1));
        // Written last: a manifest's presence means every file it lists is in place.
        await storage.putObject('manifest.json', manifestBytes, 'application/json');
        outputBytes += manifestBytes.length;
        return { manifest, outputBytes, threads: timeline.threads, timings: { aMs, processorMs, processorWaitMs, stemMs }, warnings };
    } finally {
        signal.removeEventListener('abort', stopProcessor);
        processorStop.abort(new Error('prepare ended'));
        // A failed or cancelled job: let go of the decoder and the source file.
        await blocks?.return?.(undefined).catch(() => undefined);
        if (source && typeof (source as fs.ReadStream).destroy === 'function') (source as fs.ReadStream).destroy();
        await pool.close();
        if (tee && !tee.closed) tee.destroy();
        if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
}

export interface TimelineOutput {
    segments: ManifestSegment[];
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
    /** Playback-rate planar blocks. */
    source: AsyncIterable<Float32Array[]>;
    channels: number;
    rate: number;
    storage: PrepareStorage;
    options: PrepareOptions;
    framesPerPeak: number;
    segmentSeconds: number;
    signal: AbortSignal;
    /** Path prefix of every file written ('' for the main stem, 'b/' for stem B). */
    prefix?: string;
    /** A pool shared with the caller (resampling, other stems); else one is made and closed here. */
    pool?: JobPool;
    onFrames?: (frames: number) => void;
    onSegments?: (count: number) => void;
    /** Called with each segment's 16-bit interleaved PCM once written. */
    onSegment?: (index: number, pcm: Int16Array, frames: number) => void | Promise<void>;
}

/**
 * Segments, peaks, bands and spectrogram of one stem, from its playback-rate
 * blocks: one pass writes the segments while a worker pool analyses fixed
 * jobs of the timeline (see jobs.ts).
 */
export async function writeTimeline(input: TimelineInput): Promise<TimelineOutput> {
    const { source, channels, rate, storage, options, framesPerPeak, segmentSeconds, signal, onSegment } = input;
    const prefix = input.prefix ?? '';
    const onFrames = input.onFrames ?? (() => undefined);
    const setProgress = (patch: { segments?: number }) => {
        if (patch.segments !== undefined) input.onSegments?.(patch.segments);
    };
    let lastReport = 0;
    // Analyses run as fixed jobs of the timeline on a worker pool (see jobs.ts):
    // the decode pass below only writes segments and hands the audio over.
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
        const nextWarm = final ? null : jobBuf.map((x) => x.slice(jobFill - keep, jobFill));
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
            channels: jobBuf.map((x) => (jobFill === x.length ? x : x.slice(0, jobFill))),
        };
        const running = pool.run(job).then((r) => { results[r.index] = r as JobResult; });
        const tracked = running.finally(() => inflight.delete(tracked));
        inflight.add(tracked);
        jobIndex += 1;
        jobStart += frames;
        if (nextWarm) {
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

    const framesPerSegment = Math.max(1, Math.round(segmentSeconds * rate));
    const segBuf = new Int16Array(framesPerSegment * channels);
    let segFill = 0; // frames in segBuf
    let totalFrames = 0;
    let outputBytes = 0;
    const segments: ManifestSegment[] = [];
    const withHashes = options.segmentHashes ?? true;

    const flushSegment = async () => {
        if (segFill === 0) return;
        const index = segments.length;
        const header = wavHeader16(channels, rate, segFill);
        const bytes = new Uint8Array(header.length + segFill * channels * 2);
        bytes.set(header);
        bytes.set(new Uint8Array(segBuf.buffer, 0, segFill * channels * 2), header.length);
        const url = `${prefix}seg/${pad(index)}.wav`;
        await storage.putObject(url, bytes, 'audio/wav');
        await onSegment?.(index, segBuf.subarray(0, segFill * channels), segFill);
        segments.push({
            index,
            startFrame: totalFrames - segFill,
            frames: segFill,
            url,
            bytes: bytes.length,
            ...(withHashes ? { sha256: createHash('sha256').update(bytes).digest('hex') } : {}),
        });
        outputBytes += bytes.length;
        segFill = 0;
        setProgress({ segments: segments.length });
    };

    const consume = async (block: Float32Array[]) => {
        const n = block[0]?.length ?? 0;
        if (n === 0) return;
        await feedJobs(block, n);
        let i = 0;
        while (i < n) {
            const take = Math.min(n - i, framesPerSegment - segFill);
            // 16-bit, as floatToInt16 (inlined: this loop sees every sample).
            for (let c = 0; c < channels; c += 1) {
                const x = block[c];
                let p = segFill * channels + c;
                for (let k = i; k < i + take; k += 1, p += channels) {
                    const v = Math.round(x[k] * 32768);
                    segBuf[p] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
                }
            }
            segFill += take;
            totalFrames += take;
            i += take;
            if (segFill === framesPerSegment) await flushSegment();
        }
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
        segments,
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
