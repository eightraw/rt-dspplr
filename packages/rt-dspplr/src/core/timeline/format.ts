// Time and number formatting shared by the timeline and the React interface.

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
    // Rounded to the tenth it is read in before it is split: 119.96 s is 2 minutes, not 1 minute 60 seconds.
    const tenths = Math.round(safe * 10);
    const m = Math.floor(tenths / 600);
    const s = (tenths - m * 600) / 10;
    const sec = `${s} second${s === 1 ? '' : 's'}`;
    return m > 0 ? `${m} minute${m === 1 ? '' : 's'} ${sec}` : sec;
}

export function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}
