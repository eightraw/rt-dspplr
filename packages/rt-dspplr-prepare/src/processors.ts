import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// ---------------------------------------------------------------------------
// Stem processors: the server-side counterpart of the player's plugins. A
// processor turns A into a stem (whatever the host runs; the library never interprets it):
//
//   prepareAudio(a, { stems: { [key]: { processor } } })
//     → is a processor configured? → run it on A (in parallel with A's own
//       segments and analyses) → align and adapt its output → stems[key] in
//       the one manifest.
//
// EXPERIMENTAL: the stem processor API may change in minor releases before 1.0.
//
// The output may be at any rate, channel count and length, and in any format
// the decoder hook can read. prepare aligns and adapts it. The adapters below
// cover the usual cases: a CLI, an HTTP service, a Docker image, a function.
// Each one gets a timeout, cancellation (AbortSignal) and errors that name the
// processor.
// ---------------------------------------------------------------------------

/** @experimental */
export interface StemProcessorInput {
    /** A as a file: the input path itself, or a temporary copy when A came as a stream. */
    path: string;
    /** A's bytes as a stream (read from `path`). */
    stream(): AsyncIterable<Uint8Array>;
    /** A's source format (before any resampling by prepare). */
    sampleRate: number;
    channels: number;
    frames: number | null;
    /** A scratch folder for this run, removed afterwards. */
    tmpDir: string;
    signal: AbortSignal;
    onProgress?: (fraction: number) => void;
}

/** @experimental */
export type StemProcessorOutput =
    | { path: string }
    | { stream: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array> }
    | { channels: Float32Array[]; sampleRate: number };

/**
 * Makes a stem from A, on the server. Its output must stay on A's timeline.
 *
 * @experimental The stem processor API may change in minor releases before 1.0.
 */
export interface StemProcessor {
    /** Stable id, recorded in the stem's `processor` (with version and params) to spot a stale stem. */
    id: string;
    version: string;
    params?: Record<string, unknown>;
    /** Default timeout for this processor (ms). The stem's own `timeoutMs` wins. */
    timeoutMs?: number;
    run(input: StemProcessorInput): Promise<StemProcessorOutput>;
}

export class StemProcessorError extends Error {
    constructor(readonly processorId: string, message: string, readonly cause?: unknown) {
        super(`stem processor "${processorId}": ${message}`);
        this.name = 'StemProcessorError';
    }
}

/**
 * Run a processor with a timeout and the job's cancellation. A processor that
 * ignores the signal is still abandoned at the deadline (its result is
 * dropped).
 */
export async function runProcessor(
    processor: StemProcessor,
    input: Omit<StemProcessorInput, 'signal'>,
    options: { signal: AbortSignal; timeoutMs?: number },
): Promise<{ output: StemProcessorOutput; durationMs: number }> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(options.signal.reason ?? new Error('cancelled'));
    if (options.signal.aborted) onAbort();
    options.signal.addEventListener('abort', onAbort, { once: true });
    const timeoutMs = options.timeoutMs ?? processor.timeoutMs ?? 30 * 60_000;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            const error = new StemProcessorError(processor.id, `timed out after ${timeoutMs} ms`);
            controller.abort(error);
            reject(error);
        }, timeoutMs);
        const onCancel = () => {
            const reason = controller.signal.reason;
            reject(reason instanceof StemProcessorError ? reason : new StemProcessorError(processor.id, 'cancelled', reason));
        };
        if (controller.signal.aborted) onCancel();
        else controller.signal.addEventListener('abort', onCancel, { once: true });
    });
    deadline.catch(() => undefined);
    const t0 = performance.now();
    try {
        const output = await Promise.race([
            Promise.resolve().then(() => processor.run({ ...input, signal: controller.signal })),
            deadline,
        ]);
        if (!output || typeof output !== 'object' || !('path' in output || 'stream' in output || 'channels' in output)) {
            throw new StemProcessorError(processor.id, 'returned no { path | stream | channels }');
        }
        if ('path' in output && !fs.existsSync(output.path)) throw new StemProcessorError(processor.id, `output file ${output.path} does not exist`);
        return { output, durationMs: Math.round(performance.now() - t0) };
    } catch (error) {
        if (error instanceof StemProcessorError) throw error;
        throw new StemProcessorError(processor.id, error instanceof Error ? error.message : String(error), error);
    } finally {
        if (timer) clearTimeout(timer);
        options.signal.removeEventListener('abort', onAbort);
    }
}

/** A plain function as a processor. @experimental */
export function functionProcessor(
    fn: (input: StemProcessorInput) => Promise<StemProcessorOutput> | StemProcessorOutput,
    meta: { id: string; version: string; params?: Record<string, unknown>; timeoutMs?: number },
): StemProcessor {
    return { ...meta, run: async (input) => fn(input) };
}

const fill = (args: string[], vars: Record<string, string>) =>
    args.map((a) => a.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] : m)));

/** Spawn a process; reject with its exit code and the end of stderr; kill it on abort. */
function runProcess(command: string, args: string[], options: { signal: AbortSignal; cwd?: string; env?: NodeJS.ProcessEnv; id: string; onAbort?: () => void }): Promise<void> {
    return new Promise((resolve, reject) => {
        let stderr = '';
        const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
        child.stderr?.on('data', (d: Buffer) => {
            stderr = (stderr + d.toString()).slice(-4000);
        });
        const abort = () => {
            options.onAbort?.();
            child.kill('SIGKILL');
        };
        options.signal.addEventListener('abort', abort, { once: true });
        child.on('error', (error) => {
            options.signal.removeEventListener('abort', abort);
            reject(new StemProcessorError(options.id, `cannot start ${command}: ${error.message}`, error));
        });
        child.on('close', (code, sig) => {
            options.signal.removeEventListener('abort', abort);
            if (options.signal.aborted) return reject(new StemProcessorError(options.id, 'cancelled', options.signal.reason));
            if (code === 0) return resolve();
            reject(new StemProcessorError(options.id, `${command} exited with ${code ?? sig}${stderr.trim() ? `: ${stderr.trim().split('\n').slice(-5).join(' | ')}` : ''}`));
        });
    });
}

export interface CommandProcessorOptions {
    command: string;
    /** Placeholders: {in} (A's file), {out} (B's file to write), {tmp}, {sampleRate}, {channels}. */
    args: string[];
    id?: string;
    version?: string;
    params?: Record<string, unknown>;
    /** File name of {out} in the scratch folder. Default 'b.wav'. */
    outName?: string;
    timeoutMs?: number;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
}

/** Any CLI (an ffmpeg filter chain, a script…) that reads {in} and writes {out}. @experimental */
export function commandProcessor(options: CommandProcessorOptions): StemProcessor {
    const id = options.id ?? `command:${path.basename(options.command)}`;
    return {
        id,
        version: options.version ?? '0',
        params: options.params ?? { command: options.command, args: options.args },
        timeoutMs: options.timeoutMs,
        async run(input) {
            const out = path.join(input.tmpDir, options.outName ?? 'b.wav');
            const args = fill(options.args, { in: input.path, out, tmp: input.tmpDir, sampleRate: String(input.sampleRate), channels: String(input.channels) });
            await runProcess(options.command, args, { signal: input.signal, cwd: options.cwd, env: options.env, id });
            if (!fs.existsSync(out)) throw new StemProcessorError(id, `${options.command} did not write ${out}`);
            return { path: out };
        },
    };
}

export interface DockerProcessorOptions {
    image: string;
    /** Arguments after the image. Placeholders: {in} (/in/<A's file>), {out} (/work/<outName>), {sampleRate}, {channels}. */
    args: string[];
    /** Container network. Default 'none'. */
    network?: string;
    /** Run the image's entrypoint with these args, or override it. */
    entrypoint?: string;
    id?: string;
    version?: string;
    params?: Record<string, unknown>;
    outName?: string;
    timeoutMs?: number;
    /** The docker CLI. Default 'docker'. */
    docker?: string;
    /** Extra `docker run` flags (e.g. ['--gpus', 'all']). */
    runArgs?: string[];
}

/** A Docker image as a processor: A mounted read-only at /in, the scratch folder at /work. No network by default. @experimental */
export function dockerProcessor(options: DockerProcessorOptions): StemProcessor {
    const id = options.id ?? `docker:${options.image}`;
    const docker = options.docker ?? 'docker';
    return {
        id,
        version: options.version ?? options.image,
        params: options.params ?? { image: options.image, args: options.args, network: options.network ?? 'none' },
        timeoutMs: options.timeoutMs,
        async run(input) {
            const outName = options.outName ?? 'b.wav';
            const name = `rtd-stem-${randomUUID().slice(0, 12)}`;
            const inDir = path.dirname(path.resolve(input.path));
            const args = [
                'run', '--rm', '--name', name, '--network', options.network ?? 'none',
                '--mount', `type=bind,src=${inDir},dst=/in,readonly`,
                '--mount', `type=bind,src=${path.resolve(input.tmpDir)},dst=/work`,
                ...(options.entrypoint ? ['--entrypoint', options.entrypoint] : []),
                ...(options.runArgs ?? []),
                options.image,
                ...fill(options.args, { in: `/in/${path.basename(input.path)}`, out: `/work/${outName}`, sampleRate: String(input.sampleRate), channels: String(input.channels) }),
            ];
            await runProcess(docker, args, {
                signal: input.signal,
                id,
                env: { ...process.env, MSYS_NO_PATHCONV: '1' },
                // Killing the client does not stop the container: kill it by name.
                onAbort: () => { spawn(docker, ['kill', name], { stdio: 'ignore', windowsHide: true }).on('error', () => undefined); },
            });
            const out = path.join(input.tmpDir, outName);
            if (!fs.existsSync(out)) throw new StemProcessorError(id, `the container did not write /work/${outName}`);
            return { path: out };
        },
    };
}

export interface HttpProcessorOptions {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    /** Send A as multipart/form-data under this field name. Default: A's bytes as the raw body. */
    field?: string;
    timeoutMs?: number;
    id?: string;
    version?: string;
    params?: Record<string, unknown>;
}

/** An HTTP service as a processor: A goes in the request, the stem comes back in the response body. @experimental */
export function httpProcessor(options: HttpProcessorOptions): StemProcessor {
    const id = options.id ?? `http:${new URL(options.url).host}`;
    return {
        id,
        version: options.version ?? '0',
        params: options.params ?? { url: options.url, method: options.method ?? 'POST', field: options.field ?? null },
        timeoutMs: options.timeoutMs,
        async run(input) {
            let body: NonNullable<RequestInit["body"]>;
            const headers: Record<string, string> = { ...options.headers };
            if (options.field) {
                // multipart/form-data, streamed: the file is never held in memory.
                const boundary = `----rtd${randomUUID().replace(/-/g, '')}`;
                const file = input.path;
                const field = options.field;
                const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${path.basename(file)}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
                const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
                async function* multipart() {
                    yield head;
                    for await (const chunk of fs.createReadStream(file, { highWaterMark: 1 << 20 })) yield chunk as Buffer;
                    yield tail;
                }
                body = Readable.toWeb(Readable.from(multipart())) as unknown as NonNullable<RequestInit["body"]>;
                headers['content-type'] = `multipart/form-data; boundary=${boundary}`;
                headers['content-length'] = String(head.length + (await fsp.stat(file)).size + tail.length);
            } else {
                body = Readable.toWeb(fs.createReadStream(input.path)) as unknown as NonNullable<RequestInit["body"]>;
                headers['content-type'] ??= 'application/octet-stream';
            }
            let response: Response;
            try {
                response = await fetch(options.url, { method: options.method ?? 'POST', headers, body, signal: input.signal, duplex: 'half' } as RequestInit);
            } catch (error) {
                throw new StemProcessorError(id, `request to ${options.url} failed: ${error instanceof Error ? error.message : String(error)}`, error);
            }
            if (!response.ok || !response.body) {
                const text = await response.text().catch(() => '');
                throw new StemProcessorError(id, `${options.url} answered ${response.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
            }
            const out = path.join(input.tmpDir, 'b.http');
            await pipeline(Readable.fromWeb(response.body as never), fs.createWriteStream(out), { signal: input.signal });
            return { path: out };
        },
    };
}
