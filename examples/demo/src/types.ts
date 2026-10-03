// Shapes returned by the example's object-storage plugin (plugins/fakeObjectStorage.ts).

/** Optional sidecar `<name>.json` next to an audio object. */
export interface StorageObjectMetadata {
    label?: string;
    recorded_at?: string;
    [key: string]: unknown;
}

/** One entry of GET /api/storage/list. */
export interface StorageObject {
    key: string;
    size: number;
    lastModified: string;
    etag: string;
    contentType: string;
    url: string;
    metadata: StorageObjectMetadata | null;
    keyB: string | null;
    urlB: string | null;
}

export interface StorageListResponse {
    bucket: string;
    uploadsEnabled: boolean;
    objects: StorageObject[];
}

/** A playable list entry: a storage object plus a stable id. */
export interface Clip {
    id: string;
    url: string;
    urlB: string | null;
    object: StorageObject;
}
