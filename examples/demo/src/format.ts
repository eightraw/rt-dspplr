// Small display formatters for the clip list.

export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatDuration(seconds: number | undefined): string {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return '…';
    const m = Math.floor(seconds / 60);
    const s = seconds - m * 60;
    return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

export function formatTimestamp(iso: unknown): string | null {
    if (typeof iso !== 'string') return null;
    const time = Date.parse(iso);
    if (!Number.isFinite(time)) return null;
    return new Date(time).toLocaleString(undefined, {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
}

export function displayName(key: string, label: unknown): string {
    if (typeof label === 'string' && label.trim()) return label.trim();
    const slash = key.lastIndexOf('/');
    return slash >= 0 ? key.slice(slash + 1) : key;
}
