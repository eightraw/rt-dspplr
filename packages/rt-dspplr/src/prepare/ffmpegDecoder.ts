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
    return (bytes) => {
        const args = [
            ...command.slice(1),
            '-hide_banner', '-nostdin', '-loglevel', 'error',
            ...(options.inputArgs ?? []),
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

        // Feed the source; ffmpeg may stop reading early (it has what it needs, or failed).
        void (async () => {
            try {
                for await (const chunk of bytes) {
                    if (!child.stdin.write(chunk)) await once(child.stdin, 'drain');
                }
            } catch {
                // EPIPE / aborted: the exit code tells the story
            } finally {
                child.stdin.end();
            }
        })();
        child.stdin.on('error', () => undefined);

        const inner = wavDecoder(child.stdout as AsyncIterable<Uint8Array>);
        const fail = async (cause?: unknown) => {
            const code = await exited;
            if (spawnError) return new Error(`ffmpeg could not start (${command.join(' ')}): ${(spawnError as Error).message}`);
            return new Error(`ffmpeg failed (exit ${code}): ${stderr.trim() || String(cause ?? 'no output')}`);
        };
        async function* blocks(): AsyncGenerator<Float32Array[]> {
            try {
                for await (const block of inner.blocks) yield block;
            } catch (error) {
                throw await fail(error);
            }
            const code = await exited;
            if (code !== 0) throw await fail();
        }
        return {
            format: inner.format.then((f) => ({ ...f, encoding: `ffmpeg:${f.encoding}` }), async (error) => { throw await fail(error); }),
            blocks: blocks(),
        };
    };
}
