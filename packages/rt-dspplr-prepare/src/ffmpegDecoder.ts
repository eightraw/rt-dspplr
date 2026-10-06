import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { wavDecoder, type AudioDecoder } from './decoder';

// ---------------------------------------------------------------------------
// EXPERIMENTAL: a decoder hook that lets ffmpeg read any format (MP3, FLAC,
// Ogg/Opus, M4A...). The library does not depend on ffmpeg: you pass this
// decoder explicitly, with whatever command runs ffmpeg on your machine.
//
// The source bytes are piped to ffmpeg's stdin; ffmpeg writes 32-bit float
// WAV to stdout (its streamed WAV header says "size unknown"), which the
// built-in streaming WAV reader decodes. Memory stays bounded on both sides.
//
//   prepareAudio('talk.mp3', { outDir, decoder: ffmpegDecoder() })                 // ffmpeg on PATH
//   prepareAudio('talk.mp3', { outDir, decoder: ffmpegDecoder({ command:          // ffmpeg in Docker
//       ['docker', 'run', '--rm', '-i', '--network', 'none', 'my-ffmpeg-image', 'ffmpeg'] }) })
// ---------------------------------------------------------------------------

export interface FfmpegDecoderOptions {
    /** The command that runs ffmpeg; its arguments are appended. Default ['ffmpeg']. */
    command?: string[];
    /** Extra arguments before `-i` (e.g. ['-f', 'mp3'] when the input cannot be probed). */
    inputArgs?: string[];
}

export function ffmpegDecoder(options: FfmpegDecoderOptions = {}): AudioDecoder {
    const command = options.command ?? ['ffmpeg'];
    return (bytes, decoderOptions) => {
        const args = [
            ...command.slice(1),
            '-hide_banner', '-nostdin', '-loglevel', 'error',
            ...(options.inputArgs ?? []),
            // The bytes are untrusted: they may not make ffmpeg open anything else
            // (a file, a URL, the entries of a playlist or a concat list).
            '-protocol_whitelist', 'pipe',
            '-i', 'pipe:0',
            '-map', '0:a:0', '-vn',
            '-f', 'wav', '-acodec', 'pcm_f32le', 'pipe:1',
        ];
        const child = spawn(command[0], args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        let stderr = '';
        child.stderr.on('data', (chunk) => {
            if (stderr.length < 4000) stderr += String(chunk);
        });
        let spawnError: Error | null = null;
        child.on('error', (error) => { spawnError = error; });
        const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
        const kill = () => {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        };
        // Cancelled: ffmpeg is stopped at once, not when it runs out of input.
        const signal = decoderOptions?.signal;
        if (signal?.aborted) kill();
        else signal?.addEventListener('abort', kill, { once: true });
        void exited.then(() => signal?.removeEventListener('abort', kill));

        // Feed the source; ffmpeg may stop reading early (it has what it needs, failed, or was killed).
        void (async () => {
            try {
                for await (const chunk of bytes) {
                    if (child.exitCode !== null || child.signalCode !== null || child.stdin.destroyed) break;
                    if (!child.stdin.write(chunk)) await Promise.race([once(child.stdin, 'drain'), exited]);
                }
            } catch {
                // EPIPE / aborted: the exit code tells the story
            } finally {
                child.stdin.end();
            }
        })();
        child.stdin.on('error', () => undefined);

        const inner = wavDecoder(child.stdout as AsyncIterable<Uint8Array>);
        /** The exit code, once ffmpeg has had a moment to exit by itself (then it is killed). */
        const settled = async () => {
            const timer = setTimeout(kill, 2000);
            try {
                return await exited;
            } finally {
                clearTimeout(timer);
            }
        };
        const fail = async (cause?: unknown): Promise<unknown> => {
            const code = await settled();
            if (signal?.aborted) return signal.reason ?? new Error('aborted');
            if (spawnError) return new Error(`ffmpeg could not start (${command.join(' ')}): ${(spawnError as Error).message}`);
            return new Error(`ffmpeg failed (exit ${code}): ${stderr.trim() || String(cause ?? 'no output')}`);
        };
        async function* blocks(): AsyncGenerator<Float32Array[]> {
            let complete = false;
            let frames = 0;
            try {
                try {
                    for await (const block of inner.blocks) {
                        frames += block[0]?.length ?? 0;
                        yield block;
                    }
                } catch (error) {
                    throw await fail(error);
                }
                const code = await exited;
                complete = true;
                if (code !== 0) throw await fail();
                // ffmpeg can exit 0 having decoded nothing: an MP4 or M4A whose index (moov) comes
                // after the audio cannot be read from a pipe, which cannot seek back to it.
                if (frames === 0) {
                    const hint = /partial file|moov atom not found/.test(stderr)
                        ? ' (an MP4/M4A with its index at the end cannot be read from a stream: convert it first, or write it with -movflags +faststart)'
                        : '';
                    throw new Error(`ffmpeg produced no audio${hint}: ${stderr.trim() || 'no output'}`);
                }
            } finally {
                // The consumer stopped early (it has what it needs, or it failed): ffmpeg must not run on.
                if (!complete) kill();
            }
        }
        // ffmpeg's WAV is not the input: no layout, so the source is written as a WAV of its own.
        const format = inner.format.then((f) => ({ ...f, encoding: `ffmpeg:${f.encoding}`, layout: undefined }), async (error) => { throw await fail(error); });
        // A caller whose first blocks.next() already threw never awaits the format: no unhandled rejection.
        format.catch(() => undefined);
        return { format, blocks: blocks() };
    };
}
