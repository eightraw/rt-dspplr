import { ffmpegDecoder, prepareAudio, type PrepareOptions, type StemSpec } from './index';

// rtd-prepare <input.wav> <outDir> [--segment 10] [--rate 48000|auto|keep] [--peak 256] [--concurrency N]
//             [--stem <key>=<file.wav>]... [--label <key>=<text>]... [--quiet]
//             [--decoder ffmpeg | docker:<image>]   (experimental: non-WAV input through ffmpeg)

const USAGE = 'usage: rtd-prepare <input.wav> <outDir> [--segment <seconds>] [--rate <hz>|auto|keep] [--peak <framesPerPeak>] [--concurrency <threads>] '
    + '[--stem <key>=<file>]... [--label <key>=<text>]... [--decoder ffmpeg|docker:<image>] [--quiet]';

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
    const rate = flags.rate === undefined || flags.rate === 'auto' ? 'auto' : flags.rate === 'keep' ? 'keep' : Number(flags.rate);
    const options: PrepareOptions = {
        outDir,
        segmentSeconds: flags.segment ? Number(flags.segment) : undefined,
        targetRate: rate as PrepareOptions['targetRate'],
        framesPerPeak: flags.peak ? Number(flags.peak) : undefined,
        concurrency: flags.concurrency ? Number(flags.concurrency) : undefined,
        ...(Object.keys(stems).length ? { stems } : {}),
    };
    if (flags.decoder === 'ffmpeg') options.decoder = ffmpegDecoder();
    else if (flags.decoder?.startsWith('docker:')) {
        options.decoder = ffmpegDecoder({ command: ['docker', 'run', '--rm', '-i', '--network', 'none', flags.decoder.slice(7), 'ffmpeg'] });
    } else if (flags.decoder) {
        console.error(`unknown --decoder ${flags.decoder}`);
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
            sourceSampleRate: manifest.sourceSampleRate,
            channels: manifest.channels,
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
