// Example glue for the long-audio page: lists the recordings in a folder and
// whether each has been prepared (<name>/manifest.json next to <name>.wav).
// The files themselves are served by a second fakeObjectStorage bucket.
// Each item also reports its stem B (made with A by prepare-all.mjs) from the manifest.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { Plugin } from 'vite'

export interface LongStemInfo {
    status: string
    error?: string
    /** id@version of the processor that made B (absent: a ready-made B). */
    processor?: string
    offsetMs?: number
    confidence?: number
    correlation?: number
    mixLaw?: string
    loudnessDeltaDb?: number
    bandwidthHz?: number
    sourceRate?: number
    sourceChannels?: number
}

export interface LongAudioItem {
    name: string
    sourceUrl: string | null
    sourceBytes: number | null
    manifestUrl: string | null
    duration: number | null
    sampleRate: number | null
    sourceSampleRate: number | null
    channels: number | null
    segments: number | null
    preparedBytes: number | null
    stemB: LongStemInfo | null
}

async function dirBytes(dir: string): Promise<number> {
    let total = 0
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name)
        total += entry.isDirectory() ? await dirBytes(abs) : (await fsp.stat(abs)).size
    }
    return total
}

export function longAudioListPlugin(options: { dir: string; bucket: string }): Plugin {
    const dir = path.resolve(options.dir)
    fs.mkdirSync(dir, { recursive: true })
    const list = async (): Promise<LongAudioItem[]> => {
        const entries = await fsp.readdir(dir, { withFileTypes: true })
        const names = new Set<string>()
        for (const e of entries) {
            if (e.isFile() && e.name.toLowerCase().endsWith('.wav')) names.add(e.name.slice(0, -4))
            if (e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'manifest.json'))) names.add(e.name)
        }
        const items: LongAudioItem[] = []
        for (const name of [...names].sort()) {
            const wav = path.join(dir, `${name}.wav`)
            const manifestPath = path.join(dir, name, 'manifest.json')
            const hasWav = fs.existsSync(wav)
            let manifest: Record<string, unknown> | null = null
            try {
                manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'))
            } catch {
                manifest = null
            }
            type Stem = { status: string; error?: string; processor?: { id: string; version: string; durationMs: number }; alignment?: { offsetMs: number; confidence: number }; correlation?: { global: number }; mixLaw?: string; loudnessDeltaDb?: number; source?: { bandwidthHz: number; sampleRate: number; channels: number } }
            const stem = (manifest?.stems as { b?: Stem } | undefined)?.b
            const segments = (manifest?.segments as { list?: unknown[] } | undefined)?.list
            items.push({
                name,
                sourceUrl: hasWav ? `/storage/${options.bucket}/${encodeURIComponent(name)}.wav` : null,
                sourceBytes: hasWav ? (await fsp.stat(wav)).size : null,
                manifestUrl: manifest ? `/storage/${options.bucket}/${encodeURIComponent(name)}/manifest.json` : null,
                duration: (manifest?.duration as number) ?? null,
                sampleRate: (manifest?.sampleRate as number) ?? null,
                sourceSampleRate: (manifest?.sourceSampleRate as number) ?? null,
                channels: (manifest?.channels as number) ?? null,
                segments: segments?.length ?? null,
                preparedBytes: manifest ? await dirBytes(path.join(dir, name)) : null,
                stemB: stem ? {
                    status: stem.status, error: stem.error, processor: stem.processor ? `${stem.processor.id}@${stem.processor.version}` : undefined,
                    offsetMs: stem.alignment?.offsetMs, confidence: stem.alignment?.confidence,
                    correlation: stem.correlation?.global, mixLaw: stem.mixLaw, loudnessDeltaDb: stem.loudnessDeltaDb,
                    bandwidthHz: stem.source?.bandwidthHz, sourceRate: stem.source?.sampleRate, sourceChannels: stem.source?.channels,
                } : null,
            })
        }
        return items
    }
    const middleware = (req: { url?: string }, res: import('node:http').ServerResponse, next: () => void) => {
        if (!req.url?.startsWith('/api/long/list')) return next()
        list().then((items) => {
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.setHeader('Cache-Control', 'no-store')
            res.end(JSON.stringify({ dir, items }))
        }).catch((error: unknown) => {
            res.statusCode = 500
            res.end(String(error))
        })
    }
    return {
        name: 'long-audio-list',
        configureServer(server) { server.middlewares.use(middleware) },
        configurePreviewServer(server) { server.middlewares.use(middleware) },
    }
}
