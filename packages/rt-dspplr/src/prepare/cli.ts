import {
    AUDIO_DEMUXERS,
    checkConcurrency,
    checkDockerImage,
    checkFramesPerPeak,
    checkSegmentSeconds,
    ffmpegDecoder,
    prepareAudio,
    type PrepareOptions,
    type StemSpec,
} from './index';

// rtd-prepare <input> <outDir> [--segment 10 (0.1-60)] [--peak 256 (a power of two, 16-65536)] [--concurrency N (1-64)]
//             [--stem <key>=<file.wav>]... [--label <key>=<text>]... [--quiet]
//             [--decoder ffmpeg | docker:<image>]   (experimental: formats other than WAV, MP3, Opus and FLAC through ffmpeg)
//             [--demuxers <name,...> | any]         (what ffmpeg may read: AUDIO_DEMUXERS by default)

const USAGE = 'usage: rtd-prepare <input> <outDir> [--segment <seconds>] [--peak <framesPerPeak>] [--concurrency <threads>] '
    + '[--stem <key>=<file>]... [--label <key>=<text>]... [--decoder ffmpeg|docker:<image>] [--demuxers <name,...>|any] [--quiet]';

/** A numeric flag's value through its check: only plain decimal digits are a number, anything else is reported as given. */
function numeric<T>(flag: string, value: string | undefined, pattern: RegExp, check: (value: unknown) => T): T | undefined {
    if (value === undefined) return undefined;
    try {
        return check(pattern.test(value) ? Number(value) : value);
    } catch (error) {
        throw new Error(`--${flag}: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/** `key=value` → [key, value]; the value may contain '='. */
function pair(flag: string, value: string): [string, string] {
    const i = value.indexOf('=');
    if (i <= 0 || i === value.length - 1) throw new Error(`--${flag} needs <key>=<value>, got ${JSON.stringify(value)}`);
    return [value.slice(0, i), value.slice(i + 1)];
}

export async function main(argv: string[]): Promise<number> {
    const positional: string[] = [];
    const flags: Record<string, string> = {};
    const stems: Record<string, StemSpec> = {};
    const labels: Array<[string, string]> = [];
    try {
        for (let i = 0; i < argv.length; i += 1) {
            const a = argv[i];
            if (a === '--quiet' || a === '-q') flags.quiet = '1';
            else if (a === '--help' || a === '-h') flags.help = '1';
            else if (a === '--stem') {
                const [key, file] = pair('stem', argv[++i] ?? '');
                stems[key] = { input: file };
            } else if (a === '--label') labels.push(pair('label', argv[++i] ?? ''));
            else if (a.startsWith('--')) flags[a.slice(2)] = argv[++i] ?? '';
            else positional.push(a);
        }
        for (const [key, label] of labels) {
            if (!stems[key]) throw new Error(`--label ${key}=...: no --stem ${key}=<file>`);
            stems[key].label = label;
        }
    } catch (error) {
        console.error(`rtd-prepare: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
        return 2;
    }
    if (flags.help || positional.length !== 2) {
        console.error(USAGE);
        return flags.help ? 0 : 2;
    }
    const [input, outDir] = positional;
    let options: PrepareOptions;
    try {
        options = {
            outDir,
            segmentSeconds: numeric('segment', flags.segment, /^(?:\d+(?:\.\d*)?|\.\d+)$/, checkSegmentSeconds),
            framesPerPeak: numeric('peak', flags.peak, /^\d+$/, checkFramesPerPeak),
            concurrency: numeric('concurrency', flags.concurrency, /^\d+$/, checkConcurrency),
            ...(Object.keys(stems).length ? { stems } : {}),
        };
        // ffmpeg reads the usual audio containers only, unless told otherwise: fewer parsers for what may be an upload.
        if (flags.demuxers !== undefined && !flags.decoder) throw new Error('--demuxers goes with --decoder');
        const demuxers = flags.demuxers === undefined ? AUDIO_DEMUXERS : flags.demuxers === 'any' ? undefined : flags.demuxers.split(',');
        if (flags.decoder === 'ffmpeg') options.decoder = ffmpegDecoder({ demuxers });
        else if (flags.decoder?.startsWith('docker:')) {
            // The image goes on the docker line as it is: a name, never a flag (docker:--privileged).
            const image = checkDockerImage(flags.decoder.slice(7));
            options.decoder = ffmpegDecoder({ command: ['docker', 'run', '--rm', '-i', '--network', 'none', '--security-opt', 'no-new-privileges', image, 'ffmpeg'], demuxers });
        } else if (flags.decoder !== undefined) throw new Error(`unknown --decoder ${JSON.stringify(flags.decoder)}`);
    } catch (error) {
        console.error(`rtd-prepare: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
        return 2;
    }
    let peakRss = process.memoryUsage().rss;
    const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 100);
    const job = prepareAudio(input, options);
    let lastPrint = 0;
    job.on('progress', (p) => {
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
        if (flags.quiet || Date.now() - lastPrint < 1000) return;
        lastPrint = Date.now();
        const stage = p.stage ? ` ${p.stage}${p.stem ? ` ${p.stem}` : ''}` : '';
        process.stderr.write(`\r${p.status}${stage} ${(p.fraction * 100).toFixed(1)}%  ${p.segments} segments  rss ${(process.memoryUsage().rss / 2 ** 20).toFixed(0)} MB   `);
    });
    try {
        const manifest = await job.done;
        clearInterval(sampler);
        const maxRss = Math.max(peakRss, process.resourceUsage().maxRSS * 1024);
        if (!flags.quiet) process.stderr.write('\n');
        console.log(JSON.stringify({
            ok: true,
            outDir,
            id: manifest.id,
            duration: manifest.duration,
            sampleRate: manifest.sampleRate,
            channels: manifest.channels,
            source: manifest.segments.source.url,
            segments: manifest.segments.list.length,
            peaksBytes: manifest.peaks.bytes,
            outputBytes: job.stats?.outputBytes,
            elapsedMs: Math.round(job.stats?.elapsedMs ?? 0),
            peakRssMB: Math.round(maxRss / 2 ** 20),
            threads: job.stats?.threads,
            loudness: manifest.loudness,
            stems: Object.fromEntries(Object.entries(manifest.stems ?? {}).map(([key, s]) => [key, {
                status: s.status,
                ...(s.label ? { label: s.label } : {}),
                ...(s.alignment ? { offsetMs: s.alignment.offsetMs, confidence: s.alignment.confidence } : {}),
                ...(s.error ? { error: s.error } : {}),
            }])),
            warnings: job.stats?.warnings ?? [],
        }, null, 1));
        return 0;
    } catch (error) {
        clearInterval(sampler);
        console.error(`\nrtd-prepare: ${error instanceof Error ? error.message : String(error)}`);
        return 1;
    }
}
