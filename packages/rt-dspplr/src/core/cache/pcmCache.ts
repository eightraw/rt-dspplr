// ---------------------------------------------------------------------------
// PcmCache — byte-bounded LRU for reusable decoded and stretched buffers
// ---------------------------------------------------------------------------
//
// The budget is BYTES, not entries. A decoded AudioBuffer holds raw Float32
// PCM per channel (~22 MiB per minute of 48 kHz stereo). This budget only
// limits cache references, NOT total tab memory. Active tracks, worker PCM,
// waveform data, downloads and decode scratch can retain additional memory.
//
// Both kinds of buffers share the same budget:
//   - decoded source buffers (BufferLoader, keyed by URL), and
//   - pre-rendered speed variants (StretchService, keyed by source + speed).
// A speed variant of a clip is 1/speed of its size, so the default set of
// three variants (1.25x, 1.5x, 2x) is ~2x the source. Counting them separately
// would make the real footprint about three times the advertised budget.
//
// Eviction only drops the cache's reference. A buffer that is still attached
// to a playing track stays alive until the track lets go of it.

export const DEFAULT_PCM_CACHE_BUDGET_BYTES = 150 * 1024 * 1024;

interface CacheEntry {
    buffer: AudioBuffer;
    bytes: number;
    onEvict?: () => void;
}

export interface PcmCacheStats {
    budgetBytes: number;
    /** Bytes retained by this cache only; excludes active/worker/scratch memory. */
    usedBytes: number;
    entries: number;
    decodedEntries: number;
    variantEntries: number;
}

export function audioBufferBytes(buffer: AudioBuffer): number {
    return buffer.length * buffer.numberOfChannels * 4;
}

class PcmCache {
    private _entries = new Map<string, CacheEntry>();
    private _usedBytes = 0;
    private _budgetBytes = DEFAULT_PCM_CACHE_BUDGET_BYTES;

    get budgetBytes(): number {
        return this._budgetBytes;
    }

    setBudget(bytes: number): void {
        this._budgetBytes = Number.isFinite(bytes) && bytes >= 0 ? Math.floor(bytes) : DEFAULT_PCM_CACHE_BUDGET_BYTES;
        this._evictOverBudget(null);
    }

    get(key: string): AudioBuffer | null {
        const entry = this._entries.get(key);
        if (!entry) return null;
        // Reinsert to move it to the most-recently-used end.
        this._entries.delete(key);
        this._entries.set(key, entry);
        return entry.buffer;
    }

    set(key: string, buffer: AudioBuffer, onEvict?: () => void): void {
        this.delete(key, false);

        const bytes = audioBufferBytes(buffer);
        // A single buffer larger than the whole budget is not cached at all,
        // rather than evicting everything else just to evict it right after.
        if (bytes > this._budgetBytes) {
            return;
        }

        this._entries.set(key, { buffer, bytes, onEvict });
        this._usedBytes += bytes;
        this._evictOverBudget(key);
    }

    delete(key: string, notify = true): void {
        const entry = this._entries.get(key);
        if (!entry) return;
        this._entries.delete(key);
        this._usedBytes -= entry.bytes;
        if (notify) entry.onEvict?.();
    }

    clear(): void {
        for (const key of [...this._entries.keys()]) {
            this.delete(key);
        }
    }

    stats(): PcmCacheStats {
        let decodedEntries = 0;
        let variantEntries = 0;
        for (const key of this._entries.keys()) {
            if (key.startsWith('variant:')) variantEntries += 1;
            else decodedEntries += 1;
        }
        return {
            budgetBytes: this._budgetBytes,
            usedBytes: this._usedBytes,
            entries: this._entries.size,
            decodedEntries,
            variantEntries,
        };
    }

    private _evictOverBudget(protectedKey: string | null): void {
        while (this._usedBytes > this._budgetBytes) {
            const oldestKey = this._entries.keys().next().value as string | undefined;
            if (!oldestKey || oldestKey === protectedKey) break;
            this.delete(oldestKey);
        }
    }
}

/** Process-wide cache shared by every player instance on the page. */
export const pcmCache = new PcmCache();

let nextBufferId = 1;
const bufferIds = new WeakMap<AudioBuffer, number>();

/** Stable per-object id, used to key speed variants of a source buffer. */
export function audioBufferId(buffer: AudioBuffer): number {
    let id = bufferIds.get(buffer);
    if (id === undefined) {
        id = nextBufferId++;
        bufferIds.set(buffer, id);
    }
    return id;
}

/** Set the shared budget for decoded audio + speed variants, in bytes. */
export function setAudioCacheBudget(bytes: number): void {
    pcmCache.setBudget(bytes);
}

/** Drop every cached decoded buffer and speed variant. */
export function clearAudioCache(): void {
    pcmCache.clear();
}

export function getAudioCacheStats(): PcmCacheStats {
    return pcmCache.stats();
}
