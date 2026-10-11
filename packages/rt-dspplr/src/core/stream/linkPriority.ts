// ---------------------------------------------------------------------------
// What the playhead waits for, across a clip's segment stores (A's and the
// stem's): their urgent fetches. Everything else fetched for the clip - the
// other segments, the overview files - gives way while one is on its way and
// carries on from the byte it had come to after (SegmentStore, SegmentedSource):
// a start or a seek has the link to itself.
// ---------------------------------------------------------------------------

export class LinkPriority {
    private readonly _urgent = new Set<object>();
    private _waiters: Array<() => void> = [];

    /** Whether a fetch the playhead waits for is on its way (other than `self`'s). */
    busy(self?: object): boolean {
        for (const token of this._urgent) if (token !== self) return true;
        return false;
    }

    /** `token`'s fetch is one the playhead waits for (true), or no longer (false: done, or let go). */
    set(token: object, urgent: boolean): void {
        if (this._urgent.has(token) === urgent) return;
        if (urgent) this._urgent.add(token);
        else this._urgent.delete(token);
        const waiters = this._waiters;
        this._waiters = [];
        for (const wake of waiters) wake();
    }

    /** Resolves once nothing the playhead waits for is on its way (but `self`'s), or `signal` aborts. */
    async idle(self?: object, signal?: AbortSignal): Promise<void> {
        while (this.busy(self) && !signal?.aborted) {
            await new Promise<void>((resolve) => {
                this._waiters.push(resolve);
                signal?.addEventListener('abort', () => resolve(), { once: true });
            });
        }
    }
}
