import { SourceError } from './fileAccess';
import type { ManifestSource } from './manifest';
import { base64Bytes, decodeOpusRun, decodePcmRun, decodeStreamRun, openRunStream, type DecodedRun } from './sourceRuns';
import createRunWorker from './run.worker.ts?inline-worker';

// ---------------------------------------------------------------------------
// Decodes runs of a prepared clip's source (manifest v4). WAV is converted on
// the spot; MP3, FLAC and Opus go to one shared worker with their codec's
// WebAssembly, each codec in a chunk of its own fetched the first time a clip
// of that codec plays. Without a worker (a Content-Security-Policy without
// blob: in worker-src) the same code runs on the main thread. A run can also
// be decoded as its bytes arrive (openRun): a stream in the same worker.
// ---------------------------------------------------------------------------

type Codec = 'mp3' | 'flac' | 'opus';

const CHUNKS: Record<Codec, () => Promise<{ default: { notice: string; wasm: string } }>> = {
    mp3: () => import('../../vendor/rtdDecodeMp3'),
    flac: () => import('../../vendor/rtdDecodeFlac'),
    opus: () => import('../../vendor/rtdDecodeOpus'),
};

const modules = new Map<Codec, Promise<WebAssembly.Module>>();
function moduleOf(codec: Codec): Promise<WebAssembly.Module> {
    let m = modules.get(codec);
    if (!m) {
        m = CHUNKS[codec]().then(({ default: chunk }) => WebAssembly.compile(base64Bytes(chunk.wasm) as unknown as BufferSource));
        // A failed load is retried on the next run.
        m.catch(() => modules.delete(codec));
        modules.set(codec, m);
    }
    return m;
}

/**
 * Fetch and compile the source's decoder now (a clip's manifest is in), not when its first run
 * has arrived: the run's audio then waits for nothing but its own bytes.
 */
export function warmDecoder(source: ManifestSource): void {
    if (source.codec !== 'wav') void moduleOf(source.codec).catch(() => {});
}

let worker: Worker | null = null;
let workerFailed = false;
const sent = new Set<Codec>();
const waiting = new Map<number, { resolve: (run: DecodedRun) => void; reject: (error: Error) => void }>();
/** The pushes of each open stream waiting for their answers, in order. */
const pushes = new Map<number, Array<{ resolve: (out: StreamOut) => void; reject: (error: Error) => void }>>();
let nextId = 1;

/** What a push of a stream completed: the frames' planes, and the decoded format (0 until known). */
export interface StreamOut {
    planes: Float32Array[][];
    sampleRate: number;
    channels: number;
}

function theWorker(): Worker | null {
    if (worker || workerFailed) return worker;
    try {
        worker = createRunWorker();
        worker.onmessage = (event: MessageEvent<{ id: number; channels?: Float32Array[]; sampleRate?: number; error?: string } | (Partial<StreamOut> & { stream: number; error?: string })>) => {
            if ('stream' in event.data) {
                const { stream, planes, sampleRate, channels, error } = event.data;
                const p = pushes.get(stream)?.shift();
                if (!p) return;
                if (error !== undefined || !planes) p.reject(new Error(error ?? 'decode failed'));
                else p.resolve({ planes, sampleRate: sampleRate ?? 0, channels: channels ?? 0 });
                return;
            }
            const { id, channels, sampleRate, error } = event.data;
            const w = waiting.get(id);
            if (!w) return;
            waiting.delete(id);
            if (error !== undefined || !channels) w.reject(new Error(error ?? 'decode failed'));
            else w.resolve({ channels, sampleRate: sampleRate ?? 0 });
        };
        worker.onerror = (event) => {
            event.preventDefault?.();
            // The worker is gone: what it had is retried on the main thread.
            worker?.terminate();
            worker = null;
            workerFailed = true;
            sent.clear();
            for (const w of waiting.values()) w.reject(new Error('decode worker failed'));
            waiting.clear();
            for (const queue of pushes.values()) for (const p of queue) p.reject(new Error('decode worker failed'));
            pushes.clear();
        };
    } catch (error) {
        console.warn('[AudioPlayer] decode worker unavailable; decoding on the main thread', error);
        workerFailed = true;
        worker = null;
    }
    return worker;
}

const headers = new WeakMap<ManifestSource, Uint8Array | null>();
function headerOf(source: ManifestSource): Uint8Array | undefined {
    let h = headers.get(source);
    if (h === undefined) {
        h = source.header ? base64Bytes(source.header) : null;
        headers.set(source, h);
    }
    return h ?? undefined;
}

/**
 * A run of `source` (the bytes of a segment's range), decoded: planar, its warm-up included.
 * A run that decodes to another rate or channel count than the manifest says is refused
 * (SourceError): played as it is, it would run at the wrong speed or on the wrong channels.
 */
export async function decodeRun(source: ManifestSource, bytes: ArrayBuffer): Promise<Float32Array[]> {
    if (source.codec === 'wav') return decodePcmRun(new Uint8Array(bytes), source);
    const run = await decodeCoded(source, source.codec, bytes);
    const channels = run.channels.length;
    // An empty run says nothing of its format (segmentFromRun reports it short).
    if (channels > 0 && run.channels[0].length > 0 && (run.sampleRate !== source.sampleRate || channels !== source.channels)) {
        throw new SourceError(`the ${source.codec} source decodes to ${run.sampleRate} Hz, ${channels} channel(s); its manifest says ${source.sampleRate} Hz, ${source.channels}`);
    }
    return run.channels;
}

async function decodeCoded(source: ManifestSource, codec: Codec, bytes: ArrayBuffer): Promise<DecodedRun> {
    const module = await moduleOf(codec);
    const header = headerOf(source);
    const w = theWorker();
    if (w) {
        // Should the worker die with this run in it (its bytes transferred), the run fails and the
        // segment store fetches it again - on the main thread, then.
        return new Promise<DecodedRun>((resolve, reject) => {
            const id = nextId++;
            waiting.set(id, { resolve, reject });
            const first = !sent.has(codec);
            sent.add(codec);
            w.postMessage({ id, codec, module: first ? module : undefined, header: header ? header.slice() : undefined, bytes }, [bytes]);
        });
    }
    const data = new Uint8Array(bytes);
    return codec === 'opus' ? decodeOpusRun(module, header!, data) : decodeStreamRun(module, codec, data, header);
}

/**
 * A run of a source decoded as its bytes arrive: push() its bytes in order (`end` with the
 * last; a whole buffer's bytes are transferred), each answered with the planes of the frames
 * they completed. A failure rejects that push and every later one; close() when done with it.
 */
export interface RunDecoding {
    push(bytes: Uint8Array, end: boolean): Promise<StreamOut>;
    close(): void;
}

/** Resolves once the source's decoder is in (at once when it is, or for WAV): see SegmentStore. */
export async function decoderReady(source: ManifestSource): Promise<void> {
    if (source.codec !== 'wav') await moduleOf(source.codec);
}

/** A run of an MP3, FLAC or Opus `source`, to be decoded as its bytes arrive. */
export async function openRun(source: ManifestSource): Promise<RunDecoding> {
    if (source.codec === 'wav') throw new Error('a WAV run is read as it arrives without a decoder');
    const codec = source.codec;
    const module = await moduleOf(codec);
    const header = headerOf(source);
    const w = theWorker();
    if (!w) {
        const stream = await openRunStream(module, codec, header);
        let failed: unknown = null;
        return {
            push: async (bytes, end) => {
                if (failed) throw failed;
                try {
                    return { planes: stream.push(bytes, end), sampleRate: stream.sampleRate, channels: stream.channels };
                } catch (error) {
                    failed = error;
                    throw error;
                }
            },
            close: () => {},
        };
    }
    const id = nextId++;
    const queue: Array<{ resolve: (out: StreamOut) => void; reject: (error: Error) => void }> = [];
    pushes.set(id, queue);
    const first = !sent.has(codec);
    sent.add(codec);
    w.postMessage({ stream: id, open: true, codec, module: first ? module : undefined, header: header ? header.slice() : undefined });
    return {
        push: (bytes, end) => new Promise<StreamOut>((resolve, reject) => {
            // The worker died, or the stream was closed: nothing would answer.
            if (pushes.get(id) !== queue) {
                reject(new Error('decode worker failed'));
                return;
            }
            queue.push({ resolve, reject });
            // Transferred: a view of part of a buffer is copied first.
            const own = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
            w.postMessage({ stream: id, bytes: own.buffer, end }, [own.buffer]);
        }),
        close: () => {
            if (pushes.get(id) === queue) pushes.delete(id);
            for (const p of queue.splice(0)) p.reject(new Error('closed'));
            if (worker === w) w.postMessage({ stream: id, close: true });
        },
    };
}
