// What a card plays: the listener's own file, and optionally a second one as stem B.

export interface Source {
    a: File;
    /** Stem B: a second file of the same length, such as another take or a stem. */
    b: File | null;
}

export interface CardProps {
    source: Source | null;
    /** Files dropped onto this card. */
    onFiles: (files: File[]) => void;
}

export function sourceOf(files: File[]): Source | null {
    return files.length > 0 ? { a: files[0], b: files[1] ?? null } : null;
}

export function idOf(source: Source, withB: boolean): string {
    const key = (file: File) => `${file.name}:${file.size}:${file.lastModified}`;
    return withB && source.b ? `${key(source.a)}|${key(source.b)}` : key(source.a);
}

/** "Artist - Title.flac" gives both; any other name gives the title alone. */
export function describe(file: File): { title: string; artist: string | null } {
    const base = file.name.replace(/\.[^.]+$/, '');
    const dash = base.indexOf(' - ');
    return dash > 0
        ? { artist: base.slice(0, dash).trim(), title: base.slice(dash + 3).trim() }
        : { title: base, artist: null };
}

export function formatSize(bytes: number): string {
    return bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}
