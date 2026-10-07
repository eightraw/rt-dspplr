// The device pixel ratio of the window an element is in (an iframe's own, not
// the top window's), and a watch for its changes: the window moved to a screen
// of another density, or the page zoomed. A ResizeObserver sees neither while
// the CSS size stays the same, and a canvas sized for the old ratio blurs.

export function pixelRatio(el: Element): number {
    return el.ownerDocument.defaultView?.devicePixelRatio || 1;
}

/** Call `onChange` whenever the pixel ratio of `el`'s window changes. Returns a stop function. */
export function watchPixelRatio(el: Element, onChange: () => void): () => void {
    const win = el.ownerDocument.defaultView;
    if (!win?.matchMedia) return () => undefined;
    let query: MediaQueryList | null = null;
    const changed = () => {
        arm();
        onChange();
    };
    // A query for the current ratio stops matching once, at the change: then a new one is armed.
    function arm() {
        query?.removeEventListener?.('change', changed);
        query = win!.matchMedia(`(resolution: ${win!.devicePixelRatio || 1}dppx)`);
        query.addEventListener?.('change', changed);
    }
    arm();
    return () => {
        query?.removeEventListener?.('change', changed);
        query = null;
    };
}
