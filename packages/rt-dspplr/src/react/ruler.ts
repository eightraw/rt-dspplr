// Tick positions for the time ruler under the waveform. The major step
// adapts to the visible window; each major interval has two minor ticks.

export interface RulerTick {
    /** Position inside the visible window, 0..100 (%). */
    left: number;
    major: boolean;
    /** Label for major ticks, '' for minor ones. */
    label: string;
}

const SUBDIVISIONS = 3;

export function majorStepFor(visibleSeconds: number): number {
    if (visibleSeconds <= 0.5) return 0.05;
    if (visibleSeconds <= 1) return 0.1;
    if (visibleSeconds <= 2.5) return 0.25;
    if (visibleSeconds <= 5) return 0.5;
    if (visibleSeconds <= 10) return 1;
    if (visibleSeconds <= 30) return 2;
    if (visibleSeconds <= 60) return 5;
    return 10;
}

function label(seconds: number, step: number): string {
    // Work in integer centiseconds so 1.0 s never prints as 0:00.99.
    const centis = Math.round(seconds * 100);
    const m = Math.floor(centis / 6000);
    const s = Math.floor(centis / 100) % 60;
    const base = `${m}:${String(s).padStart(2, '0')}`;
    return step < 1 ? `${base}.${String(centis % 100).padStart(2, '0')}` : base;
}

/** Ticks for the window [offset, offset + viewSize] (fractions of `duration`). */
export function computeTicks(duration: number, offset: number, viewSize: number): RulerTick[] {
    const visible = duration * viewSize;
    if (!(duration > 0) || !(visible > 0)) return [];
    const step = majorStepFor(visible);
    const minor = step / SUBDIVISIONS;
    const start = offset * duration;
    const end = start + visible + minor / 1000;
    const firstIndex = Math.floor(start / minor + 1e-9);
    const ticks: RulerTick[] = [];
    for (let i = 0; i < 400; i += 1) {
        const index = firstIndex + i;
        // Derived from the index, never accumulated, so float error cannot drift.
        const t = Math.round(index * minor * 1e6) / 1e6;
        if (t > end) break;
        if (t < start - 1e-9) continue;
        const major = index % SUBDIVISIONS === 0;
        ticks.push({ left: ((t - start) / visible) * 100, major, label: major ? label(t, step) : '' });
    }
    return ticks;
}
