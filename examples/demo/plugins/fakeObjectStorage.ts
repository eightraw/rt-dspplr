// Example glue: a tiny S3-style object store backed by a local folder.
// The folder is the bucket; this Vite plugin lists it, serves objects with the
// headers an object store sends (ETag, Last-Modified, Accept-Ranges, real 206
// ranges, 304 on If-None-Match), accepts uploads in dev, and pushes an HMR
// event whenever the folder changes so the page updates without a reload.

import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Connect, Plugin, ViteDevServer } from 'vite'

export interface FakeObjectStorageOptions {
    /** Absolute path of the folder that plays the bucket. */
    dir: string
    /** Bucket name, used in URLs: /storage/<bucket>/<key>. */
    bucket: string
    /** Upper bound for a single PUT body, bytes. */
    maxUploadBytes?: number
}

export interface StorageObjectMetadata {
    label?: string
    recorded_at?: string
    [key: string]: unknown
}

export interface StorageObjectInfo {
    key: string
    size: number
    lastModified: string
    etag: string
    contentType: string
    url: string
    metadata: StorageObjectMetadata | null
    keyB: string | null
    urlB: string | null
}

const AUDIO_CONTENT_TYPES: Record<string, string> = {
    '.wav': 'audio/wav',
    '.wave': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.oga': 'audio/ogg',
    '.opus': 'audio/ogg',
    '.m4a': 'audio/mp4',
    '.mp4': 'audio/mp4',
    '.aac': 'audio/aac',
    '.flac': 'audio/flac',
    '.webm': 'audio/webm',
}

const IGNORED_NAMES = new Set(['.gitkeep', 'readme.md'])
const MARKER_B = '.b.'
const DEFAULT_MAX_UPLOAD_BYTES = 200 * 1024 * 1024
const CHANGE_DEBOUNCE_MS = 150

function isAudioFile(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(AUDIO_CONTENT_TYPES, path.extname(name).toLowerCase())
}

function contentTypeFor(name: string): string {
    const ext = path.extname(name).toLowerCase()
    if (ext === '.json') return 'application/json'
    return AUDIO_CONTENT_TYPES[ext] ?? 'application/octet-stream'
}

function isMainObject(name: string): boolean {
    const lower = name.toLowerCase()
    if (lower.startsWith('.') || IGNORED_NAMES.has(lower)) return false
    if (lower.includes(MARKER_B)) return false
    if (lower.endsWith('.json')) return false
    if (lower.endsWith('.part')) return false
    return isAudioFile(lower)
}

function toKey(root: string, absPath: string): string {
    return path.relative(root, absPath).split(path.sep).join('/')
}

/** Resolves a URL key to an absolute path inside root, or null if it escapes. */
function resolveKey(root: string, rawKey: string): string | null {
    let key: string
    try {
        key = decodeURIComponent(rawKey)
    } catch {
        return null
    }
    if (!key || key.includes('\0')) return null
    const abs = path.resolve(root, key)
    const rel = path.relative(root, abs)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
    return abs
}

function encodeKey(key: string): string {
    return key.split('/').map(encodeURIComponent).join('/')
}

// An S3-style ETag for a single-part upload is the quoted MD5 of the content.
// Cache by (size, mtime) so listing and serving do not re-hash every time.
const etagCache = new Map<string, { size: number; mtimeMs: number; etag: string }>()

async function computeEtag(absPath: string, stat: fs.Stats): Promise<string> {
    const cached = etagCache.get(absPath)
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
        return cached.etag
    }
    const hash = crypto.createHash('md5')
    await new Promise<void>((resolve, reject) => {
        const stream = fs.createReadStream(absPath)
        stream.on('data', (chunk) => hash.update(chunk))
        stream.on('end', () => resolve())
        stream.on('error', reject)
    })
    const etag = `"${hash.digest('hex')}"`
    etagCache.set(absPath, { size: stat.size, mtimeMs: stat.mtimeMs, etag })
    return etag
}

async function walk(dir: string): Promise<string[]> {
    let entries: fs.Dirent[]
    try {
        entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
        return []
    }
    const out: string[] = []
    for (const entry of entries) {
        const abs = path.join(dir, entry.name)
        if (entry.isDirectory()) {
            if (!entry.name.startsWith('.')) out.push(...await walk(abs))
        } else if (entry.isFile()) {
            out.push(abs)
        }
    }
    return out
}

async function readSidecar(absAudioPath: string): Promise<StorageObjectMetadata | null> {
    const ext = path.extname(absAudioPath)
    const sidecar = absAudioPath.slice(0, absAudioPath.length - ext.length) + '.json'
    try {
        const raw = await fsp.readFile(sidecar, 'utf8')
        const parsed = JSON.parse(raw) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as StorageObjectMetadata
        }
        return null
    } catch {
        return null
    }
}

async function listObjects(root: string, bucket: string): Promise<StorageObjectInfo[]> {
    const files = await walk(root)
    const fileSet = new Set(files)
    const objects: StorageObjectInfo[] = []

    for (const abs of files) {
        const name = path.basename(abs)
        if (!isMainObject(name)) continue

        let stat: fs.Stats
        try {
            stat = await fsp.stat(abs)
        } catch {
            continue
        }

        const ext = path.extname(abs)
        const base = abs.slice(0, abs.length - ext.length)
        let absB: string | null = null
        for (const candidateExt of Object.keys(AUDIO_CONTENT_TYPES)) {
            const candidate = `${base}.b${candidateExt}`
            if (fileSet.has(candidate)) {
                absB = candidate
                break
            }
        }

        const key = toKey(root, abs)
        const etag = await computeEtag(abs, stat)
        const version = etag.replace(/"/g, '').slice(0, 12)
        const keyB = absB ? toKey(root, absB) : null
        let versionB = ''
        if (absB) {
            try {
                const statB = await fsp.stat(absB)
                versionB = (await computeEtag(absB, statB)).replace(/"/g, '').slice(0, 12)
            } catch {
                versionB = ''
            }
        }

        objects.push({
            key,
            size: stat.size,
            lastModified: stat.mtime.toISOString(),
            etag,
            contentType: contentTypeFor(name),
            // `v` only busts the client's decoded-buffer cache when a file is
            // replaced under the same name; the server ignores it.
            url: `/storage/${bucket}/${encodeKey(key)}?v=${version}`,
            metadata: await readSidecar(abs),
            keyB,
            urlB: keyB ? `/storage/${bucket}/${encodeKey(keyB)}?v=${versionB}` : null,
        })
    }

    const sortTime = (object: StorageObjectInfo): number => {
        const recordedAt = typeof object.metadata?.recorded_at === 'string' ? Date.parse(object.metadata.recorded_at) : NaN
        return Number.isFinite(recordedAt) ? recordedAt : Date.parse(object.lastModified)
    }
    objects.sort((a, b) => sortTime(b) - sortTime(a) || a.key.localeCompare(b.key))
    return objects
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body)
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Content-Length', Buffer.byteLength(payload))
    res.setHeader('Cache-Control', 'no-store')
    res.end(payload)
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
    // Real object stores answer with an XML <Error>; JSON is friendlier for an
    // example and the player only looks at the status code anyway.
    sendJson(res, status, { code, message })
}

type ByteRange = { start: number; end: number }

/** Parses a single `bytes=` range. undefined = header absent/ignored, null = unsatisfiable. */
function parseRange(header: string | undefined, size: number): ByteRange | null | undefined {
    if (!header) return undefined
    const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
    if (!match) {
        // Multi-range or malformed: serving the whole object is allowed by RFC 9110.
        return undefined
    }
    const [, startRaw, endRaw] = match
    if (startRaw === '' && endRaw === '') return undefined

    let start: number
    let end: number
    if (startRaw === '') {
        const suffix = Number(endRaw)
        if (suffix === 0) return null
        start = Math.max(0, size - suffix)
        end = size - 1
    } else {
        start = Number(startRaw)
        end = endRaw === '' ? size - 1 : Math.min(Number(endRaw), size - 1)
    }
    if (start >= size || start > end) return null
    return { start, end }
}

function contentDisposition(filename: string): string {
    const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
    return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

async function serveObject(
    req: IncomingMessage,
    res: ServerResponse,
    absPath: string,
    url: URL,
): Promise<void> {
    let stat: fs.Stats
    try {
        stat = await fsp.stat(absPath)
    } catch {
        sendError(res, 404, 'NoSuchKey', 'The specified key does not exist.')
        return
    }
    if (!stat.isFile()) {
        sendError(res, 404, 'NoSuchKey', 'The specified key does not exist.')
        return
    }

    const etag = await computeEtag(absPath, stat)
    const lastModified = stat.mtime.toUTCString()
    const size = stat.size

    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('ETag', etag)
    res.setHeader('Last-Modified', lastModified)
    res.setHeader('Content-Type', contentTypeFor(absPath))
    if (url.searchParams.has('download')) {
        res.setHeader('Content-Disposition', contentDisposition(path.basename(absPath)))
    }

    const ifNoneMatch = req.headers['if-none-match']
    if (ifNoneMatch && ifNoneMatch.split(',').map((value) => value.trim()).includes(etag)) {
        res.statusCode = 304
        res.end()
        return
    }

    const ifRange = req.headers['if-range']
    const rangeAllowed = !ifRange || ifRange === etag || ifRange === lastModified
    const range = rangeAllowed ? parseRange(req.headers.range, size) : undefined

    if (range === null) {
        res.statusCode = 416
        res.setHeader('Content-Range', `bytes */${size}`)
        res.setHeader('Content-Length', 0)
        res.end()
        return
    }

    const start = range ? range.start : 0
    const end = range ? range.end : size - 1
    const length = size === 0 ? 0 : end - start + 1

    res.statusCode = range ? 206 : 200
    if (range) res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
    res.setHeader('Content-Length', length)

    if (req.method === 'HEAD' || length === 0) {
        res.end()
        return
    }

    const stream = fs.createReadStream(absPath, { start, end })
    stream.on('error', () => res.destroy())
    res.on('close', () => stream.destroy())
    stream.pipe(res)
}

async function receiveUpload(
    req: IncomingMessage,
    res: ServerResponse,
    root: string,
    absPath: string,
    maxBytes: number,
    onStored: () => void,
): Promise<void> {
    const name = path.basename(absPath)
    const lower = name.toLowerCase()
    if (lower.startsWith('.') || !(isAudioFile(lower) || lower.endsWith('.json'))) {
        sendError(res, 400, 'InvalidObjectName', 'Only audio files and .json sidecars can be uploaded.')
        return
    }

    const declared = Number(req.headers['content-length'] ?? 0)
    if (declared > maxBytes) {
        sendError(res, 413, 'EntityTooLarge', `Upload is larger than ${maxBytes} bytes.`)
        return
    }

    await fsp.mkdir(path.dirname(absPath), { recursive: true })
    const tempPath = `${absPath}.${process.pid}.${Date.now()}.part`
    const out = fs.createWriteStream(tempPath)
    let received = 0
    let aborted = false

    await new Promise<void>((resolve) => {
        req.on('data', (chunk: Buffer) => {
            received += chunk.length
            if (received > maxBytes && !aborted) {
                aborted = true
                req.unpipe(out)
                out.destroy()
                sendError(res, 413, 'EntityTooLarge', `Upload is larger than ${maxBytes} bytes.`)
                resolve()
            }
        })
        req.on('error', () => {
            aborted = true
            out.destroy()
            resolve()
        })
        out.on('finish', () => resolve())
        out.on('error', () => {
            aborted = true
            resolve()
        })
        req.pipe(out)
    })

    if (aborted) {
        await fsp.rm(tempPath, { force: true })
        if (!res.writableEnded) sendError(res, 400, 'IncompleteBody', 'Upload was interrupted.')
        return
    }

    await fsp.rename(tempPath, absPath)
    const stat = await fsp.stat(absPath)
    const etag = await computeEtag(absPath, stat)
    res.setHeader('ETag', etag)
    sendJson(res, 200, { key: toKey(root, absPath), size: stat.size, etag })
    onStored()
}

function createMiddleware(
    options: Required<FakeObjectStorageOptions>,
    allowUpload: boolean,
    onStored: () => void,
): Connect.NextHandleFunction {
    const objectPrefix = `/storage/${options.bucket}/`

    return (req, res, next) => {
        const rawUrl = req.url ?? '/'
        const url = new URL(rawUrl, 'http://localhost')

        if (url.pathname === '/api/storage/list') {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
                sendError(res, 405, 'MethodNotAllowed', 'Use GET.')
                return
            }
            listObjects(options.dir, options.bucket)
                .then((objects) => sendJson(res, 200, {
                    bucket: options.bucket,
                    uploadsEnabled: allowUpload,
                    objects,
                }))
                .catch((error: unknown) => sendError(res, 500, 'InternalError', String(error)))
            return
        }

        if (!url.pathname.startsWith(objectPrefix)) {
            next()
            return
        }

        const absPath = resolveKey(options.dir, url.pathname.slice(objectPrefix.length))
        if (!absPath) {
            sendError(res, 400, 'InvalidObjectName', 'Object key is not valid.')
            return
        }

        if (req.method === 'GET' || req.method === 'HEAD') {
            serveObject(req, res, absPath, url).catch((error: unknown) => {
                if (!res.headersSent) sendError(res, 500, 'InternalError', String(error))
                else res.destroy()
            })
            return
        }

        if (req.method === 'PUT') {
            if (!allowUpload) {
                sendError(res, 405, 'MethodNotAllowed', 'Uploads are only available in the dev server.')
                return
            }
            receiveUpload(req, res, options.dir, absPath, options.maxUploadBytes, onStored).catch((error: unknown) => {
                if (!res.headersSent) sendError(res, 500, 'InternalError', String(error))
            })
            return
        }

        sendError(res, 405, 'MethodNotAllowed', 'Use GET, HEAD or PUT.')
    }
}

export function fakeObjectStoragePlugin(userOptions: FakeObjectStorageOptions): Plugin {
    const options: Required<FakeObjectStorageOptions> = {
        maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
        ...userOptions,
        dir: path.resolve(userOptions.dir),
    }

    fs.mkdirSync(options.dir, { recursive: true })

    function attachWatcher(server: ViteDevServer): () => void {
        let timer: ReturnType<typeof setTimeout> | null = null
        const changedKeys = new Set<string>()

        const flush = () => {
            timer = null
            const keys = [...changedKeys]
            changedKeys.clear()
            server.ws.send({
                type: 'custom',
                event: 'storage:changed',
                data: { bucket: options.bucket, keys, at: new Date().toISOString() },
            })
        }

        const schedule = (key?: string) => {
            if (key) changedKeys.add(key)
            if (timer) clearTimeout(timer)
            timer = setTimeout(flush, CHANGE_DEBOUNCE_MS)
        }

        const onFsEvent = (file: string) => {
            const abs = path.resolve(file)
            const rel = path.relative(options.dir, abs)
            if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return
            if (abs.endsWith('.part')) return
            etagCache.delete(abs)
            schedule(toKey(options.dir, abs))
        }

        // The storage folder lives under the project root, so Vite's own
        // chokidar watcher already sees it; add() covers STORAGE_DIR outside it.
        server.watcher.add(options.dir)
        server.watcher.on('add', onFsEvent)
        server.watcher.on('change', onFsEvent)
        server.watcher.on('unlink', onFsEvent)

        return schedule
    }

    return {
        name: 'fake-object-storage',

        configureServer(server) {
            const notify = attachWatcher(server)
            server.middlewares.use(createMiddleware(options, true, () => notify()))
        },

        configurePreviewServer(server) {
            // No HMR socket in preview: the page falls back to polling.
            server.middlewares.use(createMiddleware(options, false, () => undefined))
        },
    }
}
