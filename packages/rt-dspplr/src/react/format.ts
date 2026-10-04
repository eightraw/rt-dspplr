// Display helpers for the React UI.

export { clamp, formatClock, spokenTime } from '../core/timeline/format';

/** "1×", "1.25×". */
export function formatSpeed(speed: number): string {
    return `${Number(speed.toFixed(2))}×`;
}

export function fileNameFromUrl(url: string | null): string | null {
    if (!url) return null;
    try {
        const base = typeof window !== 'undefined' ? window.location.href : 'http://localhost/';
        const parsed = new URL(url, base);
        if (parsed.protocol === 'blob:' || parsed.protocol === 'data:') return null;
        const segment = parsed.pathname.split('/').filter(Boolean).pop();
        return segment ? decodeURIComponent(segment) : null;
    } catch {
        return null;
    }
}
