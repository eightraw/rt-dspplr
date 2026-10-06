// Decodes runs of a source off the main thread. The page sends each codec's
// compiled WebAssembly module once, then runs; the planes come back transferred.
import { decodeOpusRun, decodeStreamRun } from './sourceRuns';

type Codec = 'mp3' | 'flac' | 'opus';
interface Request {
    id: number;
    codec: Codec;
    module?: WebAssembly.Module;
    header?: Uint8Array;
    bytes: ArrayBuffer;
}

const modules = new Map<Codec, WebAssembly.Module>();
const scope = self as unknown as { onmessage: ((event: MessageEvent<Request>) => void) | null; postMessage(message: unknown, transfer?: Transferable[]): void };

scope.onmessage = (event) => {
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
