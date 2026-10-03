// Display helpers for the React UI.

/** "m:ss" or, with `tenths`, "m:ss.t". Hours are folded into minutes. */
export function formatClock(seconds: number, tenths = false): string {
    const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
    if (tenths) {
        const total = Math.floor(safe * 10 + 1e-6);
        const m = Math.floor(total / 600);
        const s = Math.floor(total / 10) % 60;
        return `${m}:${String(s).padStart(2, '0')}.${total % 10}`;
    }
    const total = Math.floor(safe + 1e-6);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Spoken form for aria-valuetext: "1 minute 5 seconds". */
export function spokenTime(seconds: number): string {
    const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
    const m = Math.floor(safe / 60);
    const s = Math.round((safe - m * 60) * 10) / 10;
    const sec = `${s} second${s === 1 ? '' : 's'}`;
    return m > 0 ? `${m} minute${m === 1 ? '' : 's'} ${sec}` : sec;
}

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

export function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}
