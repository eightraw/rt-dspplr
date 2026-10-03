// ---------------------------------------------------------------------------
// Message protocol between StretchService and any stretch worker
// ---------------------------------------------------------------------------
//
// Every StretchStrategy worker (the built-in phase vocoder, the optional
// Rubber Band one, or a custom one) speaks this protocol, so StretchService
// does not care which algorithm runs behind it.

export interface StretchWorkerRequest {
    type: 'stretch';
    requestId: number;
    sampleRate: number;
    /** Playback speed; output duration is input duration / speed. */
    speed: number;
    transientSensitivity: number;
    /** One Float32 PCM ArrayBuffer per channel (transferred). */
    channels: ArrayBuffer[];
}

export interface StretchWorkerResponse {
    type: 'stretch-complete';
    requestId: number;
    sampleRate: number;
    /** Valid frames per channel. Channel buffers are exactly this long. */
    length: number;
    channels: ArrayBuffer[];
}

export interface StretchWorkerError {
    type: 'stretch-error';
    requestId: number;
    message: string;
}

export type StretchWorkerMessage = StretchWorkerResponse | StretchWorkerError;

/** Signature of a pure stretch implementation: channels in, channels out. */
export type StretchImplementation = (
    channels: Float32Array[],
    sampleRate: number,
    speed: number,
    transientSensitivity: number,
) => Float32Array[] | Promise<Float32Array[]>;

/**
 * Return an ArrayBuffer that holds exactly `channel`'s samples.
 *
 * Stretchers commonly return `subarray()` views into a larger scratch array
 * (an over-allocated output, or an output that still carries analysis
 * padding in front). Transferring `view.buffer` would ship the whole backing
 * store, and the receiver would see trailing zeros (and, for a non-zero
 * byteOffset, the padding as well). Only reuse the backing buffer when the
 * view covers it exactly; otherwise copy.
 */
export function exactChannelBuffer(channel: Float32Array): ArrayBuffer {
    if (channel.byteOffset === 0 && channel.byteLength === channel.buffer.byteLength) {
        return channel.buffer as ArrayBuffer;
    }
    return channel.slice().buffer as ArrayBuffer;
}

/** Run one request through an implementation and build the response. */
export async function runStretchRequest(
    request: StretchWorkerRequest,
    implementation: StretchImplementation,
): Promise<{ response: StretchWorkerResponse; transfer: ArrayBuffer[] }> {
    const source = request.channels.map((buffer) => new Float32Array(buffer));
    const stretched = await implementation(source, request.sampleRate, request.speed, request.transientSensitivity);
    const length = stretched[0]?.length ?? 0;
    const channels = stretched.map(exactChannelBuffer);
    return {
        response: {
            type: 'stretch-complete',
            requestId: request.requestId,
            sampleRate: request.sampleRate,
            length,
            channels,
        },
        transfer: channels,
    };
}

/** The part of a dedicated worker's global scope the protocol needs. */
export interface StretchWorkerScope {
    onmessage: ((event: MessageEvent) => unknown) | null;
    postMessage(message: unknown, transfer?: Transferable[]): void;
}

/**
 * Wire an implementation to a dedicated worker's global scope. Use it to write
 * a custom stretch worker: `serveStretchWorker(self as never, myStretch)`.
 */
export function serveStretchWorker(
    scope: StretchWorkerScope,
    implementation: StretchImplementation,
): void {
    scope.onmessage = (event: MessageEvent) => {
        const message = event.data as StretchWorkerRequest | null;
        if (!message || message.type !== 'stretch') {
            return;
        }

        void runStretchRequest(message, implementation)
            .then(({ response, transfer }) => {
                scope.postMessage(response, transfer);
            })
            .catch((error: unknown) => {
                const reply: StretchWorkerError = {
                    type: 'stretch-error',
                    requestId: message.requestId,
                    message: error instanceof Error ? error.message : String(error),
                };
                scope.postMessage(reply);
            });
    };
}
