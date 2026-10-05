// ---------------------------------------------------------------------------
// SegmentScheduler — plays a timeline cut into consecutive segments as one
// continuous signal on an AudioContext clock (realtime or offline).
//
// It keeps a cursor (the next timeline frame to schedule) and an anchor (the
// context time at which the cursor's run started). Each pump() turns the
// cursor into AudioBufferSourceNodes, back to back: piece k starts at
//   anchor + (frames scheduled before it) / (sampleRate × rate)
// computed from an integer frame count, so with rate 1 and a frame-aligned
// anchor every boundary falls exactly on a sample frame — no gap, no overlap.
// A loop [start, end) wraps the cursor; the piece that reaches `end` is cut
// with start()'s duration argument, and the next piece starts at `start`.
//
// It does no fetching: getBuffer(index) returns a decoded segment or null,
// and pump() reports the segment it is waiting for.
// ---------------------------------------------------------------------------

export interface ScheduledSegment {
    startFrame: number;
    frames: number;
}

interface Piece {
    source: AudioBufferSourceNode;
    index: number;
    when: number;
    /** Context time the piece stops (may be cut short by a re-anchor). */
    end: number;
    frame: number;
    frames: number;
    rate: number;
}

export interface LoopFrames {
    start: number;
    end: number;
}

export class SegmentScheduler {
    private readonly _ctx: BaseAudioContext;
    private readonly _output: AudioNode;
    private readonly _segments: readonly ScheduledSegment[];
    private readonly _sampleRate: number;
    private readonly _totalFrames: number;
    private _pieces: Piece[] = [];
    private _anchorTime = 0;
    private _anchorFrame = 0;
    /** Frames scheduled since the anchor, at the current rate. */
    private _virtual = 0;
    private _cursor = 0;
    private _rate = 1;
    private _loop: LoopFrames | null = null;
    private _running = false;
    private _done = false;

    constructor(ctx: BaseAudioContext, output: AudioNode, segments: readonly ScheduledSegment[], sampleRate: number) {
        this._ctx = ctx;
        this._output = output;
        this._segments = segments;
        this._sampleRate = sampleRate;
        const last = segments[segments.length - 1];
        this._totalFrames = last ? last.startFrame + last.frames : 0;
    }

    get running(): boolean {
        return this._running;
    }

    get rate(): number {
        return this._rate;
    }

    get loop(): LoopFrames | null {
        return this._loop;
    }

    get totalFrames(): number {
        return this._totalFrames;
    }

    /** The next timeline frame to be scheduled. */
    get cursorFrame(): number {
        return this._cursor;
    }

    /** Context time at which the scheduled audio runs out. */
    get scheduledEnd(): number {
        return this._anchorTime + this._virtual / (this._sampleRate * this._rate);
    }

    /** True once everything up to the end of the timeline is scheduled (no loop). */
    get done(): boolean {
        return this._done;
    }

    /** Segment index holding `frame`. */
    segmentAt(frame: number): number {
        const segments = this._segments;
        let lo = 0;
        let hi = segments.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (segments[mid].startFrame <= frame) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    }

    setRate(rate: number): void {
        this._rate = rate > 0 ? rate : 1;
    }

    setLoop(loop: LoopFrames | null): void {
        this._loop = loop && loop.end > loop.start ? { start: Math.max(0, loop.start), end: Math.min(this._totalFrames, loop.end) } : null;
        if (this._loop) this._done = false;
    }

    /** Start (or restart) playing from timeline `frame` at context time `when`. */
    start(frame: number, when: number): void {
        this.stop();
        this._anchorTime = when;
        this._anchorFrame = Math.max(0, Math.min(this._totalFrames, Math.round(frame)));
        this._cursor = this._anchorFrame;
        this._virtual = 0;
        this._running = true;
        this._done = this._cursor >= this._totalFrames && !this._loop;
    }

    /**
     * Continue from wherever the audio is at context time `at`, with the current
     * rate and loop: what was scheduled stops at `at` and new pieces take over
     * at the same instant, so the sound continues without a gap.
     */
    reanchor(at: number): void {
        if (!this._running) return;
        const frame = this.positionAt(at);
        for (const piece of this._pieces) {
            if (piece.when >= at) {
                this._kill(piece);
                piece.end = piece.when;
                piece.frames = 0;
            } else if (piece.end > at) {
                try {
                    piece.source.stop(at);
                } catch {
                    // already stopped
                }
                piece.frames = Math.round((at - piece.when) * this._sampleRate * piece.rate);
                piece.end = at;
            }
        }
        this._anchorTime = at;
        this._anchorFrame = frame;
        this._cursor = frame;
        this._virtual = 0;
        this._done = false;
        if (this._loop && frame >= this._loop.end) this._cursor = this._loop.start;
    }

    /**
     * Schedule pieces until the audio reaches context time `horizon`. Returns
     * the index of the segment it needs next and does not have, or null.
     */
    pump(horizon: number, getBuffer: (index: number) => AudioBuffer | null): number | null {
        while (this._running && !this._done && this.scheduledEnd < horizon) {
            if (this._loop && this._cursor >= this._loop.end) this._cursor = this._loop.start;
            if (this._cursor >= this._totalFrames) {
                if (this._loop) {
                    this._cursor = this._loop.start;
                } else {
                    this._done = true;
                    break;
                }
            }
            const index = this.segmentAt(this._cursor);
            const segment = this._segments[index];
            const buffer = getBuffer(index);
            if (!buffer) return index;
            const segmentEnd = segment.startFrame + segment.frames;
            let end = segmentEnd;
            if (this._loop && this._cursor < this._loop.end) end = Math.min(end, this._loop.end);
            const frames = end - this._cursor;
            if (frames <= 0) {
                this._cursor = end;
                continue;
            }
            const when = this.scheduledEnd;
            const source = this._ctx.createBufferSource();
            source.buffer = buffer;
            source.playbackRate.value = this._rate;
            source.connect(this._output);
            const offset = (this._cursor - segment.startFrame) / this._sampleRate;
            if (end < segmentEnd || buffer.length > segment.frames) source.start(when, offset, frames / this._sampleRate);
            else source.start(when, offset);
            const piece: Piece = {
                source,
                index,
                when,
                end: when + frames / (this._sampleRate * this._rate),
                frame: this._cursor,
                frames,
                rate: this._rate,
            };
            source.onended = () => {
                try {
                    source.disconnect();
                } catch {
                    // no-op
                }
            };
            this._pieces.push(piece);
            this._virtual += frames;
            this._cursor = end;
        }
        this._prune();
        return null;
    }

    /** Timeline frame playing at context time `t` (holds at the end of what is scheduled). */
    positionAt(t: number): number {
        // Pieces are in start order; pieces of a run cut by reanchor() end where the new run starts.
        for (let i = this._pieces.length - 1; i >= 0; i -= 1) {
            const p = this._pieces[i];
            if (p.when <= t && p.frames > 0) return this._map(p, t);
        }
        return this._anchorFrame;
    }

    /** Segments with a piece that has not finished at context time `t`. */
    activeSegments(t: number): number[] {
        const out: number[] = [];
        for (const p of this._pieces) if (p.end > t && !out.includes(p.index)) out.push(p.index);
        return out;
    }

    /** True when every scheduled piece has played and nothing more will be. */
    endedAt(t: number): boolean {
        return this._running && this._done && t >= this.scheduledEnd;
    }

    /** True when the audio ran out before the next segment arrived. */
    starvedAt(t: number): boolean {
        return this._running && !this._done && t >= this.scheduledEnd;
    }

    stop(): void {
        for (const piece of this._pieces) this._kill(piece);
        this._pieces = [];
        this._running = false;
    }

    private _map(p: Piece, t: number): number {
        const elapsed = Math.min(p.frames, Math.max(0, (t - p.when) * this._sampleRate * p.rate));
        return p.frame + elapsed;
    }

    private _kill(piece: Piece): void {
        try {
            piece.source.stop();
        } catch {
            // never started or already stopped
        }
        try {
            piece.source.disconnect();
        } catch {
            // no-op
        }
    }

    private _prune(): void {
        const now = this._ctx.currentTime;
        // Keep the newest finished piece: it maps the position while starved.
        while (this._pieces.length > 1 && this._pieces[0].end < now - 1) this._pieces.shift();
    }
}
