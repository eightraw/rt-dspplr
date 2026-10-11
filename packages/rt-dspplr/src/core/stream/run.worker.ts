// Decodes runs of a source off the main thread. The page sends each codec's
// compiled WebAssembly module once, then runs; the planes come back transferred.
// A run decoded as it arrives is a stream: opened, its bytes pushed in order,
// each push answered with the planes they completed, in the same order.
import { decodeOpusRun, decodeStreamRun, openRunStream, type RunStream } from './sourceRuns';

type Codec = 'mp3' | 'flac' | 'opus';
interface Request {
    id: number;
    codec: Codec;
    module?: WebAssembly.Module;
    header?: Uint8Array;
    bytes: ArrayBuffer;
}
type StreamRequest =
    | { stream: number; open: true; codec: Codec; module?: WebAssembly.Module; header?: Uint8Array }
    | { stream: number; bytes: ArrayBuffer; end: boolean }
    | { stream: number; close: true };

const modules = new Map<Codec, WebAssembly.Module>();
/** Open streams; each push waits for the one before it (and for the opening). */
const streams = new Map<number, Promise<RunStream>>();
const scope = self as unknown as { onmessage: ((event: MessageEvent<Request | StreamRequest>) => void) | null; postMessage(message: unknown, transfer?: Transferable[]): void };

function onStream(message: StreamRequest): void {
    const id = message.stream;
    if ('close' in message) {
        streams.delete(id);
        return;
    }
    if ('open' in message) {
        if (message.module) modules.set(message.codec, message.module);
        const wasm = modules.get(message.codec);
        const opening = wasm ? openRunStream(wasm, message.codec, message.header) : Promise.reject(new Error(`no ${message.codec} decoder`));
        opening.catch(() => {});
        streams.set(id, opening);
        return;
    }
    const before = streams.get(id);
    if (!before) return;
    const after = before.then((stream) => {
        const planes = stream.push(new Uint8Array(message.bytes), message.end);
        scope.postMessage({ stream: id, planes, sampleRate: stream.sampleRate, channels: stream.channels }, planes.flat().map((c) => c.buffer));
        return stream;
    });
    // A failed push fails the ones after it too: the stream is unusable.
    after.catch((error: unknown) => scope.postMessage({ stream: id, error: error instanceof Error ? error.message : String(error) }));
    streams.set(id, after);
}

scope.onmessage = (event) => {
    if ('stream' in event.data) {
        onStream(event.data);
        return;
    }
    const { id, codec, module, header, bytes } = event.data;
    if (module) modules.set(codec, module);
    const wasm = modules.get(codec);
    if (!wasm) {
        scope.postMessage({ id, error: `no ${codec} decoder` });
        return;
    }
    const data = new Uint8Array(bytes);
    const running = codec === 'opus' ? decodeOpusRun(wasm, header!, data) : decodeStreamRun(wasm, codec, data, header);
    running.then(
        (run) => scope.postMessage({ id, channels: run.channels, sampleRate: run.sampleRate }, run.channels.map((c) => c.buffer)),
        (error: unknown) => scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) }),
    );
};
