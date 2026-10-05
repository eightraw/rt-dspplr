import { ffmpegDecoder, prepareAudio, type PrepareOptions } from './index';

// rtd-prepare <input.wav> <outDir> [--segment 10] [--rate 48000|auto|keep] [--peak 256] [--quiet]
//             [--decoder ffmpeg | docker:<image>]   (experimental: non-WAV input through ffmpeg)

const USAGE = 'usage: rtd-prepare <input.wav> <outDir> [--segment <seconds>] [--rate <hz>|auto|keep] [--peak <framesPerPeak>] [--concurrency <threads>] '
    + '[--decoder ffmpeg|docker:<image>] [--quiet]';

export async function main(argv: string[]): Promise<number> {
    const positional: string[] = [];
    const flags: Record<string, string> = {};
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--quiet' || a === '-q') flags.quiet = '1';
        else if (a === '--help' || a === '-h') flags.help = '1';
        else if (a.startsWith('--')) flags[a.slice(2)] = argv[++i] ?? '';
        else positional.push(a);
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
        process.stderr.write(`\r${p.status} ${(p.fraction * 100).toFixed(1)}%  ${p.segments} segments  rss ${(process.memoryUsage().rss / 2 ** 20).toFixed(0)} MB   `);
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
        }, null, 1));
        return 0;
    } catch (error) {
        clearInterval(sampler);
        console.error(`\nrtd-prepare: ${error instanceof Error ? error.message : String(error)}`);
        return 1;
    }
}
