import type { ManifestSource } from './manifest';
import { base64Bytes, decodeOpusRun, decodePcmRun, decodeStreamRun, type DecodedRun } from './sourceRuns';
import createRunWorker from './run.worker.ts?inline-worker';

// ---------------------------------------------------------------------------
// Decodes runs of a prepared clip's source (manifest v4). WAV is converted on
// the spot; MP3, FLAC and Opus go to one shared worker with their codec's
// WebAssembly, each codec in a chunk of its own fetched the first time a clip
// of that codec plays. Without a worker (a Content-Security-Policy without
// blob: in worker-src) the same code runs on the main thread.
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

let worker: Worker | null = null;
let workerFailed = false;
const sent = new Set<Codec>();
const waiting = new Map<number, { resolve: (run: DecodedRun) => void; reject: (error: Error) => void }>();
let nextId = 1;

function theWorker(): Worker | null {
    if (worker || workerFailed) return worker;
    try {
        worker = createRunWorker();
        worker.onmessage = (event: MessageEvent<{ id: number; channels?: Float32Array[]; sampleRate?: number; error?: string }>) => {
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

/** A run of `source` (the bytes of a segment's range), decoded: planar, its warm-up included. */
export async function decodeRun(source: ManifestSource, bytes: ArrayBuffer): Promise<Float32Array[]> {
    if (source.codec === 'wav') return decodePcmRun(new Uint8Array(bytes), source);
    const codec = source.codec;
    const module = await moduleOf(codec);
    const header = headerOf(source);
    const w = theWorker();
    if (w) {
        // Should the worker die with this run in it (its bytes transferred), the run fails and the
        // segment store fetches it again - on the main thread, then.
        return new Promise<Float32Array[]>((resolve, reject) => {
            const id = nextId++;
            waiting.set(id, { resolve: (run) => resolve(run.channels), reject });
            const first = !sent.has(codec);
            sent.add(codec);
            w.postMessage({ id, codec, module: first ? module : undefined, header: header ? header.slice() : undefined, bytes }, [bytes]);
        });
    }
    const data = new Uint8Array(bytes);
    const run = codec === 'opus' ? await decodeOpusRun(module, header!, data) : await decodeStreamRun(module, codec, data, header);
    return run.channels;
}
