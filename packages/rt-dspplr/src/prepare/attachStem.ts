import fsp from 'node:fs/promises';
import path from 'node:path';
import { ANALYZER_VERSION, MANIFEST_FORMAT_VERSION, assertManifest, type AudioManifest, type ManifestStem } from '../core/stream/manifest';
import { defaultConcurrency, JobPool } from './pool';
import { fsStorage, type PrepareOptions, type PrepareStorage } from './prepareAudio';
import { buildStem, failedStem, StemAlignmentError, type StemInput, type StemOptions } from './stem';

// ---------------------------------------------------------------------------
// attachStem: the secondary utility. It adds (or replaces) stem B on a folder
// that was already prepared. The main flow is one call,
// prepareAudio(a, { stems: { b } }), so the published manifest has B from the
// start. Both go through the same buildStem() (stem.ts). Only the manifest
// handling differs here: the folder's manifest is read, B is written next to
// A, and the manifest is rewritten last and atomically, with revision + 1.
// ---------------------------------------------------------------------------

/** A prepared folder, or storage that can also read back what it wrote. */
export type StemTarget = string | { storage: PrepareStorage & { getObject(key: string): Promise<Uint8Array | null> } };

export type { StemInput } from './stem';

export interface AttachStemOptions extends StemOptions {
    /** Analysis threads (as prepareAudio). */
    concurrency?: number;
    workerUrl?: URL;
    /** prepare options for B's files (bands, spectrogram, resampler…). */
    prepare?: PrepareOptions;
    signal?: AbortSignal;
    onProgress?: (stage: 'aligning' | 'writing' | 'done', fraction: number) => void;
}

function storageOf(target: StemTarget): { storage: PrepareStorage; read(key: string): Promise<Uint8Array | null> } {
    if (typeof target === 'string') {
        return {
            storage: fsStorage(target),
            async read(key) {
                try {
                    return await fsp.readFile(path.join(target, ...key.split('/')));
                } catch {
                    return null;
                }
            },
        };
    }
    return { storage: target.storage, read: (key) => target.storage.getObject(key) };
}

async function readManifest(read: (key: string) => Promise<Uint8Array | null>): Promise<AudioManifest> {
    const bytes = await read('manifest.json');
    if (!bytes) throw new Error('attachStem: no manifest.json at the target');
    const manifest: unknown = JSON.parse(new TextDecoder().decode(bytes));
    assertManifest(manifest);
    return manifest;
}

async function writeManifest(storage: PrepareStorage, manifest: AudioManifest): Promise<void> {
    await storage.putObject('manifest.json', new TextEncoder().encode(JSON.stringify(manifest, null, 1)), 'application/json');
}

async function writeStem(storage: PrepareStorage, read: (key: string) => Promise<Uint8Array | null>, stem: 'b', entry: ManifestStem): Promise<void> {
    const current = await readManifest(read);
    await writeManifest(storage, {
        ...current,
        formatVersion: Math.max(current.formatVersion, MANIFEST_FORMAT_VERSION),
        analyzerVersion: ANALYZER_VERSION,
        revision: (current.revision ?? 1) + 1,
        stems: { ...current.stems, [stem]: entry },
    });
}

/**
 * Set a stem's status in the manifest. This is only for hosts that publish a
 * manifest before its B exists, and that turn on polling in the player
 * (`segmented.pollStemsMs`).
 */
export async function markStem(target: StemTarget, stem: 'b', status: ManifestStem['status'], error?: string): Promise<AudioManifest> {
    const { storage, read } = storageOf(target);
    const manifest = await readManifest(read);
    const previous = manifest.stems?.[stem];
    const next: AudioManifest = {
        ...manifest,
        formatVersion: Math.max(manifest.formatVersion, MANIFEST_FORMAT_VERSION),
        revision: (manifest.revision ?? 1) + 1,
        stems: { ...manifest.stems, [stem]: { ...(status === 'ready' ? previous : {}), status, ...(error ? { error } : {}), updatedAt: new Date().toISOString() } },
    };
    await writeManifest(storage, next);
    return next;
}

/**
 * Put B on a prepared folder's grid (see stem.ts). Rejects when B does not
 * line up. With onLowConfidence 'warn' it does not reject: stems.b records the
 * refusal and the folder stays A-only.
 */
export async function attachStem(target: StemTarget, stem: 'b', input: StemInput, options: AttachStemOptions = {}): Promise<ManifestStem> {
    const { storage, read } = storageOf(target);
    const manifest = await readManifest(read);
    const prepare: PrepareOptions = { ...options.prepare, concurrency: options.concurrency ?? options.prepare?.concurrency, workerUrl: options.workerUrl ?? options.prepare?.workerUrl };
    const pool = new JobPool(prepare.concurrency ?? defaultConcurrency(), prepare.workerUrl);
    try {
        const entry = await buildStem({
            storage,
            read,
            manifest,
            stem,
            input,
            options,
            prepare,
            pool,
            signal: options.signal ?? new AbortController().signal,
            onProgress: options.onProgress,
        });
        await writeStem(storage, read, stem, entry);
        options.onProgress?.('done', 1);
        return entry;
    } catch (error) {
        if (error instanceof StemAlignmentError && options.onLowConfidence === 'warn') {
            const entry = failedStem(manifest, error);
            await writeStem(storage, read, stem, entry);
            console.warn(`[attachStem] ${entry.error}; kept A only`);
            return entry;
        }
        throw error;
    } finally {
        await pool.close();
    }
}
