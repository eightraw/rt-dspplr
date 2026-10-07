import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ANALYZER_VERSION, MANIFEST_FORMAT_VERSION, assertManifest, assertStemKey, type AudioManifest, type ManifestStem } from '@saitdigital/rt-dspplr/format';
import { checkConcurrency, defaultConcurrency, JobPool, type PreparePool } from './pool';
import { fsStorage, manifestBytes, storedRanges, type PrepareOptions, type PrepareStorage } from './prepareAudio';
import { sourceReader } from './sourceReader';
import { buildStem, failedStem, StemAlignmentError, type StemInput, type StemOptions } from './stem';

// ---------------------------------------------------------------------------
// attachStem: the secondary utility. It adds (or replaces) a named stem on a
// folder that was already prepared. The main flow is one call,
// prepareAudio(a, { stems: { [key]: … } }), so the published manifest has its
// stems from the start. Both go through the same buildStem() (stem.ts). Only
// the manifest handling differs here: the folder's manifest is read (A is read
// from its source, in ranges when the storage can: getRange), the stem
// is written under <key>/r<revision>/ next to A (a new folder for every
// version: the files of the stem it replaces are left in place, untouched,
// for players and caches that still hold the older manifest), and the
// manifest is rewritten last and atomically, with revision + 1. One writer
// per folder at a time.
// ---------------------------------------------------------------------------

/** A prepared folder, or storage that can also read back what it wrote. */
export type StemTarget = string | { storage: PrepareStorage & { getObject(key: string): Promise<Uint8Array | null> } };

export type { StemInput } from './stem';

/** @experimental The stem API may change in minor releases before 1.0. */
export interface AttachStemOptions extends StemOptions {
    /** A human name stored with the stem (the card shows `label ?? key`). */
    label?: string;
    /** Analysis threads (as prepareAudio). */
    concurrency?: number;
    /** Analysis threads kept between calls (createPreparePool()), as prepareAudio's `pool`. */
    pool?: PreparePool;
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
    await storage.putObject('manifest.json', manifestBytes(manifest), 'application/json');
}

async function writeStem(storage: PrepareStorage, read: (key: string) => Promise<Uint8Array | null>, stem: string, entry: ManifestStem): Promise<void> {
    const current = await readManifest(read);
    await writeManifest(storage, {
        ...current,
        formatVersion: Math.max(current.formatVersion, MANIFEST_FORMAT_VERSION),
        analyzerVersion: ANALYZER_VERSION,
        revision: (current.revision ?? 1) + 1,
        stems: { ...withoutKey(current.stems, stem), [stem]: entry },
    });
}

/**
 * Set a stem's status in the manifest. This is only for hosts that publish a
 * manifest before the stem exists, and that turn on polling in the player
 * (`segmented.pollStemsMs`). 'ready' is refused unless the stem already is
 * ready with its files: a stem becomes ready through attachStem().
 */
export async function markStem(target: StemTarget, stem: string, status: ManifestStem['status'], error?: string): Promise<AudioManifest> {
    assertStemKey(stem);
    const { storage, read } = storageOf(target);
    const manifest = await readManifest(read);
    const previous = manifest.stems?.[stem];
    if (status === 'ready' && !(previous?.status === 'ready' && previous.segments && previous.peaks)) {
        throw new Error(`markStem: stems.${stem} has no ready files to mark 'ready' (${previous ? `it is ${previous.status}` : 'no such stem'}); attachStem() publishes a ready stem`);
    }
    const next: AudioManifest = {
        ...manifest,
        formatVersion: Math.max(manifest.formatVersion, MANIFEST_FORMAT_VERSION),
        revision: (manifest.revision ?? 1) + 1,
        stems: { ...withoutKey(manifest.stems, stem), [stem]: { ...(status === 'ready' ? previous : {}), ...(previous?.label ? { label: previous.label } : {}), status, ...(error ? { error } : {}), updatedAt: new Date().toISOString() } },
    };
    await writeManifest(storage, next);
    return next;
}

/** The stems without `key` in any letter case (a replaced stem keeps one entry). */
function withoutKey(stems: AudioManifest['stems'], key: string): AudioManifest['stems'] {
    return Object.fromEntries(Object.entries(stems ?? {}).filter(([k]) => k.toLowerCase() !== key.toLowerCase()));
}

/**
 * Put a stem on a prepared folder's grid, under `stems[key]` (see stem.ts).
 * Rejects when it does not line up. With onLowConfidence 'warn' it does not
 * reject: the entry records the refusal and the folder plays without it.
 *
 * @experimental The stem API may change in minor releases before 1.0.
 */
export async function attachStem(target: StemTarget, stem: string, input: StemInput, options: AttachStemOptions = {}): Promise<ManifestStem> {
    assertStemKey(stem);
    if (options.label !== undefined && (typeof options.label !== 'string' || options.label.length === 0 || options.label.length > 120)) {
        throw new Error(`stems.${stem}.label must be a string of 1-120 characters`);
    }
    const labelled = (entry: ManifestStem): ManifestStem => (options.label ? Object.assign({ status: entry.status, label: options.label }, entry) : entry);
    const signal = options.signal ?? new AbortController().signal;
    // Cancelled (before it started, or before the manifest is rewritten): nothing is published.
    const notCancelled = () => { if (signal.aborted) throw signal.reason ?? new Error('attachStem cancelled'); };
    notCancelled();
    const { storage, read } = storageOf(target);
    const manifest = await readManifest(read);
    const prepare: PrepareOptions = { ...options.prepare, concurrency: options.concurrency ?? options.prepare?.concurrency, workerUrl: options.workerUrl ?? options.prepare?.workerUrl, pool: options.pool ?? options.prepare?.pool };
    const pool = (prepare.pool as JobPool | undefined) ?? new JobPool(prepare.concurrency !== undefined ? checkConcurrency(prepare.concurrency) : defaultConcurrency(), prepare.workerUrl);
    let tmpDir: string | null = null;
    try {
        const entry = labelled(await buildStem({
            storage,
            readA: sourceReader(manifest.segments, manifest.channels, storedRanges(storage, manifest.segments.source.url)),
            scratch: async () => (tmpDir ??= await fsp.mkdtemp(path.join(prepare.tmpDir ?? os.tmpdir(), 'rtd-stem-'))),
            manifest,
            stem,
            // A new folder for this version (the manifest that publishes it gets at least this revision).
            revision: (manifest.revision ?? 1) + 1,
            input,
            options,
            prepare,
            pool,
            signal,
            onProgress: options.onProgress,
            onWarning: (message) => console.warn(`[attachStem] ${message}`),
        }));
        notCancelled();
        await writeStem(storage, read, stem, entry);
        options.onProgress?.('done', 1);
        return entry;
    } catch (error) {
        if (error instanceof StemAlignmentError && options.onLowConfidence === 'warn' && !signal.aborted) {
            const entry = labelled(failedStem(manifest, error));
            await writeStem(storage, read, stem, entry);
            console.warn(`[attachStem] ${entry.error}; kept A only`);
            return entry;
        }
        throw error;
    } finally {
        if (!prepare.pool) await pool.close();
        if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
}
