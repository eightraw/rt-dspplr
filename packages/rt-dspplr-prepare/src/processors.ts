import { spawn, type ChildProcess } from 'node:child_process';
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
// processor. An error has two texts: the detailed one (exit code and stderr,
// HTTP status and body) for the server's log, and a short `publicMessage`
// without server details, which is all a published manifest records.
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
    /** Stable id, recorded in the stem's `processor` (with version and params) to spot a stale stem. Published. */
    id: string;
    /** Published with the id. */
    version: string;
    /** Published in the manifest as given: put nothing here that the public should not see. */
    params?: Record<string, unknown>;
    /** Default timeout for this processor (ms). The stem's own `timeoutMs` wins. */
    timeoutMs?: number;
    run(input: StemProcessorInput): Promise<StemProcessorOutput>;
}

export class StemProcessorError extends Error {
    /** A short reason without server details (no stderr, URLs or response bodies): what the manifest records. */
    readonly publicMessage: string;

    constructor(readonly processorId: string, message: string, readonly cause?: unknown, publicMessage = 'processor failed') {
        super(`stem processor "${processorId}": ${message}`);
        this.name = 'StemProcessorError';
        this.publicMessage = publicMessage;
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
            const error = new StemProcessorError(processor.id, `timed out after ${timeoutMs} ms`, undefined, 'processor timed out');
            controller.abort(error);
            reject(error);
        }, timeoutMs);
        const onCancel = () => {
            const reason = controller.signal.reason;
            reject(reason instanceof StemProcessorError ? reason : new StemProcessorError(processor.id, 'cancelled', reason, 'processor cancelled'));
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
            throw new StemProcessorError(processor.id, 'returned no { path | stream | channels }', undefined, 'processor failed: no output');
        }
        if ('path' in output && !fs.existsSync(output.path)) {
            throw new StemProcessorError(processor.id, `output file ${output.path} does not exist`, undefined, 'processor failed: no output');
        }
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

/** A file name option (`outName`): one plain name, never a path. */
function plainFileName(name: string, option: string): string {
    if (!name || name === '.' || name === '..' || /[\\/]/.test(name) || /[\u0000-\u001f\u007f]/.test(name)) {
        throw new Error(`${option} must be a plain file name, got ${JSON.stringify(name)}`);
    }
    return name;
}

/**
 * Stop a spawned process and everything it started: its process group on
 * POSIX (it was spawned detached, as the group's leader), its process tree on
 * Windows (taskkill /T).
 */
function killTree(child: ChildProcess): void {
    const pid = child.pid;
    if (pid === undefined) return;
    if (process.platform === 'win32') {
        // Not child.kill() first: once the parent is gone, taskkill cannot find its tree.
        spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true })
            .on('error', () => child.kill('SIGKILL'));
        return;
    }
    try {
        process.kill(-pid, 'SIGKILL');
    } catch {
        child.kill('SIGKILL');
    }
}

/** Spawn a process; reject with its exit code and the end of stderr; kill it and its children on abort. */
function runProcess(command: string, args: string[], options: { signal: AbortSignal; cwd?: string; env?: NodeJS.ProcessEnv; id: string; onAbort?: () => void }): Promise<void> {
    return new Promise((resolve, reject) => {
        let stderr = '';
        const child = spawn(command, args, {
            cwd: options.cwd,
            env: options.env ?? process.env,
            stdio: ['ignore', 'ignore', 'pipe'],
            windowsHide: true,
            // Its own process group, so that a timeout or cancel also stops what it started.
            detached: process.platform !== 'win32',
        });
        child.stderr?.on('data', (d: Buffer) => {
            stderr = (stderr + d.toString()).slice(-4000);
        });
        const abort = () => {
            options.onAbort?.();
            killTree(child);
        };
        if (options.signal.aborted) abort();
        else options.signal.addEventListener('abort', abort, { once: true });
        child.on('error', (error) => {
            options.signal.removeEventListener('abort', abort);
            reject(new StemProcessorError(options.id, `cannot start ${command}: ${error.message}`, error, 'processor failed: could not start'));
        });
        child.on('close', (code, sig) => {
            options.signal.removeEventListener('abort', abort);
            if (options.signal.aborted) return reject(new StemProcessorError(options.id, 'cancelled', options.signal.reason, 'processor cancelled'));
            if (code === 0) return resolve();
            const tail = stderr.trim() ? `: ${stderr.trim().split('\n').slice(-5).join(' | ')}` : '';
            reject(new StemProcessorError(options.id, `${command} exited with ${code ?? sig}${tail}`, undefined,
                code !== null ? `processor failed: exit code ${code}` : `processor failed: signal ${sig}`));
        });
    });
}

export interface CommandProcessorOptions {
    command: string;
    /** Placeholders: {in} (A's file), {out} (B's file to write), {tmp}, {sampleRate}, {channels}. */
    args: string[];
    /** Published in the manifest. Default 'command' (not the command's name or path). */
    id?: string;
    /** Published in the manifest. Default '0'. */
    version?: string;
    /** Published in the manifest. Default {}: the command and its arguments are not. */
    params?: Record<string, unknown>;
    /** File name of {out} in the scratch folder. Default 'b.wav'. */
    outName?: string;
    timeoutMs?: number;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
}

/** Any CLI (an ffmpeg filter chain, a script…) that reads {in} and writes {out}. @experimental */
export function commandProcessor(options: CommandProcessorOptions): StemProcessor {
    const id = options.id ?? 'command';
    const outName = plainFileName(options.outName ?? 'b.wav', 'outName');
    return {
        id,
        version: options.version ?? '0',
        params: options.params ?? {},
        timeoutMs: options.timeoutMs,
        async run(input) {
            const out = path.join(input.tmpDir, outName);
            const args = fill(options.args, { in: input.path, out, tmp: input.tmpDir, sampleRate: String(input.sampleRate), channels: String(input.channels) });
            await runProcess(options.command, args, { signal: input.signal, cwd: options.cwd, env: options.env, id });
            if (!fs.existsSync(out)) throw new StemProcessorError(id, `${options.command} did not write ${out}`, undefined, 'processor failed: no output');
            return { path: out };
        },
    };
}

export interface DockerProcessorOptions {
    image: string;
    /** Arguments after the image. Placeholders: {in} (/in/a.<A's extension>), {out} (/work/<outName>), {sampleRate}, {channels}. */
    args: string[];
    /** Container network. Default 'none'. */
    network?: string;
    /** Run the image's entrypoint with these args, or override it. */
    entrypoint?: string;
    /** Published in the manifest. Default 'docker' (not the image's name). */
    id?: string;
    /** Published in the manifest. Default '0'. */
    version?: string;
    /** Published in the manifest. Default {}: the image and its arguments are not. */
    params?: Record<string, unknown>;
    outName?: string;
    timeoutMs?: number;
    /** The command that runs docker; its arguments are appended. Default 'docker'. */
    docker?: string | string[];
    /** Extra `docker run` flags (e.g. ['--gpus', 'all']). */
    runArgs?: string[];
}

/** A `--mount` value: comma-separated key=value pairs, so a path with a comma or a quote could add options of its own. */
function bindMount(src: string, dst: string, readonly: boolean): string {
    if (/[,"\u0000-\u001f\u007f]/.test(src)) {
        throw new Error(`refusing to mount ${JSON.stringify(src)}: commas, quotes and control characters cannot be passed safely to --mount`);
    }
    return `type=bind,src=${src},dst=${dst}${readonly ? ',readonly' : ''}`;
}

/** A file's extension when it is a plain one (a decoder may go by it), else '.wav'. */
export function plainExtension(file: string): string {
    const ext = path.extname(file);
    return /^\.[A-Za-z0-9]{1,10}$/.test(ext) ? ext : '.wav';
}

/**
 * A Docker image as a processor. The container sees A alone, read-only, at
 * /in/a.<ext> (a hard link or a copy of A in a folder of its own), and a
 * scratch folder at /work; nothing else of the host. No network by default,
 * no privilege escalation (`no-new-privileges`). @experimental
 */
export function dockerProcessor(options: DockerProcessorOptions): StemProcessor {
    const id = options.id ?? 'docker';
    const [docker, ...dockerArgs] = typeof options.docker === 'string' ? [options.docker] : options.docker?.length ? options.docker : ['docker'];
    const outName = plainFileName(options.outName ?? 'b.wav', 'outName');
    return {
        id,
        version: options.version ?? '0',
        params: options.params ?? {},
        timeoutMs: options.timeoutMs,
        async run(input) {
            const name = `rtd-stem-${randomUUID().slice(0, 12)}`;
            const inDir = path.resolve(input.tmpDir, 'in');
            const workDir = path.resolve(input.tmpDir, 'work');
            const inName = `a${plainExtension(input.path)}`;
            const mounts = ['--mount', bindMount(inDir, '/in', true), '--mount', bindMount(workDir, '/work', false)];
            await fsp.mkdir(inDir);
            await fsp.mkdir(workDir);
            // Only A goes in: a hard link costs nothing; across devices it is a copy.
            await fsp.link(input.path, path.join(inDir, inName)).catch(() => fsp.copyFile(input.path, path.join(inDir, inName)));
            const args = [
                ...dockerArgs,
                'run', '--rm', '--name', name, '--network', options.network ?? 'none',
                '--security-opt', 'no-new-privileges',
                ...mounts,
                ...(options.entrypoint ? ['--entrypoint', options.entrypoint] : []),
                ...(options.runArgs ?? []),
                options.image,
                ...fill(options.args, { in: `/in/${inName}`, out: `/work/${outName}`, sampleRate: String(input.sampleRate), channels: String(input.channels) }),
            ];
            await runProcess(docker, args, {
                signal: input.signal,
                id,
                env: { ...process.env, MSYS_NO_PATHCONV: '1' },
                // Killing the client does not stop the container: kill it by name.
                onAbort: () => { spawn(docker, [...dockerArgs, 'kill', name], { stdio: 'ignore', windowsHide: true }).on('error', () => undefined); },
            });
            const out = path.join(workDir, outName);
            if (!fs.existsSync(out)) throw new StemProcessorError(id, `the container did not write /work/${outName}`, undefined, 'processor failed: no output');
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
    /** Largest response body accepted, in bytes. Default 4 GiB (the largest WAV the reader takes). */
    maxResponseBytes?: number;
    /** Published in the manifest. Default 'http' (not the service's host). */
    id?: string;
    /** Published in the manifest. Default '0'. */
    version?: string;
    /** Published in the manifest. Default {}: the URL is not. */
    params?: Record<string, unknown>;
}

const DEFAULT_MAX_RESPONSE_BYTES = 2 ** 32;
/** Bytes of an error response read for the log. */
const ERROR_BODY_BYTES = 4096;

/** A URL fit for a log line: no user name, password, query string or fragment. */
export function redactUrl(url: string): string {
    try {
        const u = new URL(url);
        return `${u.protocol}//${u.host}${u.pathname}${u.search ? '?<redacted>' : ''}`;
    } catch {
        return '<invalid URL>';
    }
}

/** The multipart part header of A. Quotes, backslashes and line breaks are replaced: they would end the header. */
export function multipartHead(boundary: string, field: string, fileName: string): string {
    const clean = (s: string) => s.replace(/["\\\u0000-\u001f\u007f]/g, '_');
    return `--${boundary}\r\nContent-Disposition: form-data; name="${clean(field)}"; filename="${clean(fileName)}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
}

/** The start of a response body as text (at most `limit` bytes are read; the rest is cancelled). */
async function bodyStart(body: ReadableStream<Uint8Array> | null, limit: number): Promise<string> {
    if (!body) return '';
    const reader = body.getReader();
    const parts: Uint8Array[] = [];
    let n = 0;
    try {
        while (n < limit) {
            const { done, value } = await reader.read();
            if (done) break;
            parts.push(value);
            n += value.length;
        }
    } catch {
        // the status is what matters
    } finally {
        reader.cancel().catch(() => undefined);
    }
    return new TextDecoder().decode(Buffer.concat(parts).subarray(0, limit));
}

/** An HTTP service as a processor: A goes in the request, the stem comes back in the response body. @experimental */
export function httpProcessor(options: HttpProcessorOptions): StemProcessor {
    const id = options.id ?? 'http';
    const limit = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (!(limit > 0)) throw new Error('maxResponseBytes must be > 0');
    // Error texts name the service without its credentials or query string.
    const where = redactUrl(options.url);
    const scrub = (text: string) => {
        let out = text.split(options.url).join(where);
        try { out = out.split(new URL(options.url).href).join(where); } catch { /* not a URL: nothing to scrub */ }
        return out;
    };
    return {
        id,
        version: options.version ?? '0',
        params: options.params ?? {},
        timeoutMs: options.timeoutMs,
        async run(input) {
            let body: NonNullable<RequestInit["body"]>;
            const headers: Record<string, string> = { ...options.headers };
            if (options.field) {
                // multipart/form-data, streamed: the file is never held in memory.
                const boundary = `----rtd${randomUUID().replace(/-/g, '')}`;
                const file = input.path;
                const head = Buffer.from(multipartHead(boundary, options.field, path.basename(file)));
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
                if (input.signal.aborted) throw error;
                throw new StemProcessorError(id, scrub(`request to ${where} failed: ${error instanceof Error ? error.message : String(error)}`), error, 'processor failed: request failed');
            }
            if (!response.ok || !response.body) {
                const text = scrub((await bodyStart(response.body, ERROR_BODY_BYTES)).slice(0, 300));
                throw new StemProcessorError(id, `${where} answered ${response.status}${text ? `: ${text}` : ''}`, undefined, `processor failed: HTTP ${response.status}`);
            }
            const tooLarge = (bytes: string) => new StemProcessorError(id, `${where} sent ${bytes} bytes, more than maxResponseBytes (${limit})`, undefined, 'processor failed: response too large');
            const declared = Number(response.headers.get('content-length'));
            if (declared > limit) {
                await response.body.cancel().catch(() => undefined);
                throw tooLarge(String(declared));
            }
            const out = path.join(input.tmpDir, 'b.http');
            let received = 0;
            await pipeline(
                Readable.fromWeb(response.body as never),
                async function* capped(source: AsyncIterable<Buffer>) {
                    for await (const chunk of source) {
                        received += chunk.length;
                        if (received > limit) throw tooLarge(`over ${limit}`);
                        yield chunk;
                    }
                },
                fs.createWriteStream(out),
                { signal: input.signal },
            );
            return { path: out };
        },
    };
}
