// ---------------------------------------------------------------------------
// entries.bin — where a run may start inside each segment (MP3, FLAC, Opus).
//
// A seek fetches its segment from an entry near the playhead instead of from
// the segment's start: the segment's frames from `at` on are the source's bytes
// from `byte` to the end of the segment's range, decoded, after `skip` samples
// of warm-up (an MP3's bit reservoir and overlap, an Opus decoder's pre-roll;
// none for FLAC). prepare writes it about every half second; a WAV needs none
// (any frame is an entry).
//
// Little-endian:
//   0  char[4] "RTDE"
//   4  u16     version (1)
//   6  u16     reserved
//   8  u32     segments (N, as the manifest's segments.list)
//  12  u32[N]  entries per segment
//  then, segment by segment, entries in order of `at`, 3 × u32 each:
//      at    the segment's frame its first sample lands on (after lead)
//      byte  where its run starts, from the segment's range start
//      skip  decoded samples before that frame
// ---------------------------------------------------------------------------

export const ENTRIES_MAGIC = 'RTDE';
export const ENTRIES_VERSION = 1;

/** An entry of a segment, its byte as an offset in the source file. */
export interface SegmentEntry {
    at: number;
    byte: number;
    skip: number;
}

/** entries.bin of a source whose segments' ranges start at `starts` (bytes; null: no range). */
export function encodeEntriesFile(entries: SegmentEntry[][], starts: Array<number | null>): Uint8Array {
    const n = entries.length;
    const total = entries.reduce((sum, list) => sum + list.length, 0);
    const bytes = new Uint8Array(12 + 4 * n + 12 * total);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < 4; i += 1) bytes[i] = ENTRIES_MAGIC.charCodeAt(i);
    view.setUint16(4, ENTRIES_VERSION, true);
    view.setUint32(8, n, true);
    entries.forEach((list, i) => view.setUint32(12 + 4 * i, list.length, true));
    let o = 12 + 4 * n;
    entries.forEach((list, i) => {
        const start = starts[i] ?? 0;
        for (const e of list) {
            view.setUint32(o, e.at, true);
            view.setUint32(o + 4, e.byte - start, true);
            view.setUint32(o + 8, e.skip, true);
            o += 12;
        }
    });
    return bytes;
}

/** The entries of entries.bin, segment by segment, their bytes as offsets in the source (`starts`: the segments' range starts). */
export function decodeEntriesFile(buffer: ArrayBuffer, starts: Array<number | null>): SegmentEntry[][] {
    const view = new DataView(buffer);
    if (buffer.byteLength < 12 || String.fromCharCode(...new Uint8Array(buffer, 0, 4)) !== ENTRIES_MAGIC) throw new Error('Not an rtd entries file');
    const version = view.getUint16(4, true);
    if (version !== ENTRIES_VERSION) throw new Error(`rtd entries file version ${version} is not supported`);
    const n = view.getUint32(8, true);
    if (n !== starts.length) throw new Error(`the entries file has ${n} segments, the manifest ${starts.length}`);
    let o = 12 + 4 * n;
    const out: SegmentEntry[][] = [];
    for (let i = 0; i < n; i += 1) {
        const count = view.getUint32(12 + 4 * i, true);
        if (o + 12 * count > buffer.byteLength) throw new Error('the entries file is cut short');
        const start = starts[i] ?? 0;
        const list: SegmentEntry[] = [];
        for (let k = 0; k < count; k += 1) {
            list.push({ at: view.getUint32(o, true), byte: start + view.getUint32(o + 4, true), skip: view.getUint32(o + 8, true) });
            o += 12;
        }
        out.push(list);
    }
    return out;
}
