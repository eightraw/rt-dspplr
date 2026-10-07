import type { AudioManifest } from './manifest';

// ---------------------------------------------------------------------------
// What a manifest may make the player fetch, and with what. A manifest names
// its files relative to its own URL, or absolute (a CDN). The player fetches
// only http(s) URLs (and blob: URLs named by a blob: manifest, a package made
// in the page), and sends the host's fetchOptions headers and credentials
// only to the manifest's own origin and to the origins the host lists in
// fetchOptionsOrigins: a manifest the host does not fully control cannot
// carry them anywhere else. Every request also carries the load's signal.
// ---------------------------------------------------------------------------

/**
 * A source that cannot be read as its manifest says (its server ignores Range
 * requests, the file changed, it decodes to another rate): a retry cannot help.
 */
export class SourceError extends Error {
    override name = 'SourceError';
}

/**
 * One signal for several: aborted when any of them is. AbortSignal.any where
 * there is one (Safari before 17.4 has not); else a controller whose listeners
 * go once it aborts.
 */
export function anySignal(signals: Array<AbortSignal | null | undefined>): AbortSignal | undefined {
    const list = signals.filter((s): s is AbortSignal => !!s);
    if (list.length <= 1) return list[0];
    const any = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
    if (any) return any.call(AbortSignal, list);
    const controller = new AbortController();
    const already = list.find((s) => s.aborted);
    if (already) {
        controller.abort(already.reason);
        return controller.signal;
    }
    const onAbort = (event: Event) => {
        for (const s of list) s.removeEventListener('abort', onAbort);
        controller.abort((event.target as AbortSignal).reason);
    };
    for (const s of list) s.addEventListener('abort', onAbort);
    return controller.signal;
}

type FileBlocks = Partial<Pick<AudioManifest, 'segments' | 'peaks' | 'bands' | 'spectrogram'>>;

/** Every file URL a manifest names, with where it is named (for errors). */
function namedFiles(manifest: AudioManifest): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    const blocks = (m: FileBlocks, where: string) => {
        if (m.segments) out.push([`${where}segments.source.url`, m.segments.source.url]);
        if (m.peaks) out.push([`${where}peaks.url`, m.peaks.url]);
        if (m.bands) out.push([`${where}bands.url`, m.bands.url]);
        if (m.spectrogram) out.push([`${where}spectrogram.url`, m.spectrogram.url]);
    };
    blocks(manifest, '');
    for (const [key, stem] of Object.entries(manifest.stems ?? {})) blocks(stem, `stems.${key}.`);
    return out;
}

export class FileAccess {
    /** The manifest's URL: what its files are relative to. */
    readonly manifestUrl: string;
    /** The load's signal, with the host's when it gave one. */
    readonly signal: AbortSignal | undefined;
    private readonly _options: RequestInit;
    private readonly _origins: Set<string>;
    private readonly _blob: boolean;

    constructor(manifestUrl: string, options: { fetchOptions?: RequestInit; fetchOptionsOrigins?: readonly string[]; signal?: AbortSignal } = {}) {
        this.manifestUrl = manifestUrl;
        this._options = options.fetchOptions ?? {};
        this.signal = anySignal([options.signal, this._options.signal]);
        const base = new URL(manifestUrl);
        this._blob = base.protocol === 'blob:';
        this._origins = new Set(base.origin === 'null' ? [] : [base.origin]);
        for (const entry of options.fetchOptionsOrigins ?? []) {
            try {
                const origin = new URL(entry).origin;
                if (origin !== 'null') this._origins.add(origin);
            } catch {
                console.warn(`[AudioPlayer] fetchOptionsOrigins: ${JSON.stringify(entry)} is not a URL`);
            }
        }
    }

    /** The absolute URL of a file the manifest names (`what`: where, for the error); throws for anything but http(s). */
    resolve(url: string, what = 'a file'): string {
        let resolved: URL;
        try {
            resolved = new URL(url, this.manifestUrl);
        } catch {
            throw new Error(`Manifest: ${what} ${JSON.stringify(url)} does not resolve against the manifest's URL`);
        }
        const scheme = resolved.protocol;
        if (scheme === 'http:' || scheme === 'https:' || (scheme === 'blob:' && this._blob)) return resolved.href;
        throw new Error(`Manifest: ${what} must be an http(s) URL, not ${scheme} (${JSON.stringify(url)})`);
    }

    /** Throws when a file the manifest names is not one the player fetches (see resolve()). */
    check(manifest: AudioManifest): void {
        for (const [what, url] of namedFiles(manifest)) this.resolve(url, what);
    }

    /** Whether the host's headers and credentials go to `url` (the manifest's origin, or one the host listed). */
    trusts(url: string): boolean {
        try {
            return this._origins.has(new URL(url).origin);
        } catch {
            return false;
        }
    }

    /**
     * fetch() options for `url`: the host's, without its headers and credentials
     * where it does not trust the origin; a Range header; the load's signal
     * unless `signal` is given.
     */
    init(url: string, extra: { range?: string; signal?: AbortSignal; cache?: RequestCache } = {}): RequestInit {
        const { headers, credentials, signal: _hostSignal, ...rest } = this._options;
        const trusted = this.trusts(url);
        const init: RequestInit = { ...rest, signal: extra.signal ?? this.signal };
        // Elsewhere, 'include' becomes the default: cookies only for the page's own origin.
        const cred = trusted ? credentials : credentials === 'include' ? 'same-origin' : credentials;
        if (cred) init.credentials = cred;
        if (extra.cache) init.cache = extra.cache;
        const h = new Headers(trusted ? headers : undefined);
        if (extra.range) h.set('Range', extra.range);
        init.headers = h;
        return init;
    }
}
