/** Required credit for custom menus and non-DOM interfaces. */
export const PLAYER_ATTRIBUTION = Object.freeze({
    label: 'RT-DSPPLR by SAIT Digital',
    url: 'https://github.com/eightraw/rt-dspplr',
    /** The package version playing. */
    version: typeof __RTD_VERSION__ === 'string' ? __RTD_VERSION__ : '',
});

/** An info mark, drawn in the text colour, for the menu's one entry. */
const INFO_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" style="flex:none;display:block"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 10.6v6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="7.4" r="1.15" fill="currentColor"/></svg>';

/**
 * When the ⓘ button shows. 'always' (default): on every device. 'touch': only
 * on devices with a touch screen (phones, tablets, touch laptops), where a
 * finger has no right-click; with a mouse alone the menu opens by right-click.
 */
export type InfoButtonMode = 'always' | 'touch';

export interface AttributionOptions {
    button?: InfoButtonMode;
}

interface AttributionBinding {
    open(position?: { x: number; y: number }): void;
    close(): void;
    dispose(): void;
}

/**
 * Put the author menu on a player's interface element: right-click, the
 * context-menu key / Shift+F10, and a tappable About button. Players call this
 * from mount(); every player sharing one element shares one menu, which stays
 * until the last of them releases it (the first one's options apply). No
 * stylesheet is required. Right-click anywhere on the element opens the menu.
 *
 * The button lives inside the element. An element inside it marked
 * `data-rtd-credit` gets the button as its child; without one the button sits
 * over the element's top-right corner (the element becomes `position: relative`
 * while bound if it was static), offset by `--rtd-credit-top` / `--rtd-credit-right`
 * and stacked by `--rtd-credit-z` (default 3).
 */
export function bindAttribution(root: HTMLElement, options: AttributionOptions = {}): () => void {
    const existing = bindings.get(root);
    const entry = existing ?? { binding: createBinding(root, options), count: 0 };
    entry.count += 1;
    bindings.set(root, entry);
    let released = false;
    return () => {
        if (released) return;
        released = true;
        entry.count -= 1;
        if (entry.count > 0) return;
        bindings.delete(root);
        entry.binding.dispose();
    };
}

const BUTTON_CSS = 'box-sizing:border-box;place-items:center;flex:none;width:28px;height:28px;margin:0;padding:0;border:0;border-radius:50%;background:transparent;color:var(--rtd-text-muted,#6b7280);cursor:pointer;transition:color .15s,background-color .15s;';
const OVERLAY_CSS = 'position:absolute;top:var(--rtd-credit-top,6px);right:var(--rtd-credit-right,6px);z-index:var(--rtd-credit-z,3);';

function createBinding(root: HTMLElement, options: AttributionOptions): AttributionBinding {
    const doc = root.ownerDocument;
    const win = doc.defaultView;
    if (!win) throw new Error('The player interface element must belong to a window.');

    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'rtd-attribution-button';
    // Drawn, not typed: a font's own ⓘ sits off centre and changes size from one font to the next.
    button.innerHTML = INFO_ICON.replace('width="18" height="18"', 'width="20" height="20"');
    button.setAttribute('aria-label', 'About this player');
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    button.title = PLAYER_ATTRIBUTION.label;
    const hover = (on: boolean) => {
        button.style.color = on ? 'var(--rtd-text,#1b1f24)' : 'var(--rtd-text-muted,#6b7280)';
        button.style.backgroundColor = on ? 'var(--rtd-surface-hover,rgba(127,127,127,.14))' : 'transparent';
    };
    button.addEventListener('pointerenter', () => hover(true));
    button.addEventListener('pointerleave', () => hover(false));

    let menu: HTMLDivElement | null = null;
    let previousFocus: HTMLElement | null = null;
    let disposed = false;

    // 'touch': shown wherever any pointer is coarse, a finger. Asking only about the
    // primary pointer would hide it on an iPad with a trackpad, where a finger still
    // cannot right-click (iOS sends no contextmenu on a long press).
    const touchOnly = options.button === 'touch' ? win.matchMedia('(any-pointer: coarse)') : null;
    const showButton = () => {
        const hidden = !!touchOnly && !touchOnly.matches;
        button.style.display = hidden ? 'none' : 'inline-grid';
        // A slot can fold away with it (the card's does, so no empty gap is left in its row).
        const slot = button.parentElement;
        if (slot && slot !== root) slot.toggleAttribute('data-rtd-credit-hidden', hidden);
    };
    touchOnly?.addEventListener('change', showButton);

    // Keep the button inside the player: in the marked slot when the interface has one (and
    // follow it when the interface re-renders it), otherwise over the root's corner.
    let placement: 'slot' | 'overlay' | null = null;
    let positioned: string | null = null;
    function place() {
        if (disposed) return;
        const slot = root.querySelector<HTMLElement>('[data-rtd-credit]');
        const parent = slot ?? root;
        const moved = button.parentNode !== parent;
        if (moved) parent.append(button);
        const next = slot ? 'slot' : 'overlay';
        if (next !== placement) {
            placement = next;
            button.style.cssText = BUTTON_CSS + (next === 'overlay' ? OVERLAY_CSS : 'position:relative;');
        } else if (!moved) {
            return;
        }
        showButton();
        if (next === 'overlay' && positioned === null && win!.getComputedStyle(root).position === 'static') {
            positioned = root.style.position;
            root.style.position = 'relative';
        }
    }
    // Only elements coming and going can move the slot; text changes (a running clock) cannot.
    const observer = new win.MutationObserver((records) => {
        for (const record of records) {
            for (const node of record.addedNodes) if (node.nodeType === 1) return place();
            for (const node of record.removedNodes) if (node.nodeType === 1) return place();
        }
    });
    place();
    observer.observe(root, { childList: true, subtree: true });

    function close() {
        menu?.remove();
        menu = null;
        button.setAttribute('aria-expanded', 'false');
        doc.removeEventListener('pointerdown', outside, true);
        doc.removeEventListener('keydown', menuKey, true);
        doc.removeEventListener('focusin', focusOutside, true);
        win!.removeEventListener('resize', close);
        win!.removeEventListener('scroll', close, true);
        win!.removeEventListener('blur', close);
    }
    function outside(event: PointerEvent) {
        if (!menu?.contains(event.target as Node) && !button.contains(event.target as Node)) close();
    }
    function focusOutside(event: FocusEvent) {
        if (!menu?.contains(event.target as Node)) close();
    }
    function menuKey(event: KeyboardEvent) {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close();
            if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
        }
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) event.preventDefault();
    }
    function open(position?: { x: number; y: number }) {
        if (disposed || !root.isConnected) return;
        const focused = doc.activeElement as HTMLElement | null;
        if (!menu?.contains(focused)) previousFocus = focused;
        close();
        menu = doc.createElement('div');
        menu.className = 'rtd-attribution-menu';
        menu.setAttribute('role', 'menu');
        menu.setAttribute('aria-label', 'About this player');
        // The menu lives in the player's own element, so a modal <dialog> or a focus trap
        // around the player holds it too (outside them it would be inert, or lose its focus
        // at once); as a popover it is drawn in the top layer, so nothing clips it. Without
        // popovers it goes to the body, or to the player's dialog (the rest of the page is
        // inert under a modal one).
        const popover = typeof menu.showPopover === 'function';
        const host = popover ? root : root.closest('dialog') ?? doc.body;
        if (host !== root) {
            // Outside the player it does not inherit the player's theme: copy it.
            const theme = win!.getComputedStyle(root);
            for (const token of ['bg', 'border', 'text', 'text-muted', 'surface-hover', 'font', 'popover-shadow']) {
                const value = theme.getPropertyValue(`--rtd-${token}`);
                if (value) menu.style.setProperty(`--rtd-${token}`, value);
            }
        }
        // Inside the player it would inherit the player's text styles: reset the ones that show.
        menu.style.cssText += ';position:fixed;inset:auto;margin:0;box-sizing:border-box;width:max-content;min-width:240px;max-width:calc(100vw - 16px);padding:6px;border:1px solid var(--rtd-border,#d1d5db);border-radius:12px;background:var(--rtd-bg,#fff);color:var(--rtd-text,#1b1f24);box-shadow:var(--rtd-popover-shadow,0 12px 32px rgba(0,0,0,.28));font:500 13px/1.35 var(--rtd-font,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif);letter-spacing:normal;word-spacing:normal;text-align:left;text-indent:0;text-transform:none;text-shadow:none;white-space:normal;cursor:auto;pointer-events:auto;z-index:2147483647;';
        // One entry, as a context menu draws its items: an icon, the credit, and under it
        // the version and where the project lives.
        const link = doc.createElement('a');
        link.setAttribute('role', 'menuitem');
        link.href = PLAYER_ATTRIBUTION.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.style.cssText = 'display:flex;align-items:center;gap:14px;padding:10px 14px;border-radius:8px;color:inherit;text-decoration:none;outline:none;';
        link.innerHTML = INFO_ICON;
        const text = doc.createElement('span');
        text.style.cssText = 'display:flex;flex-direction:column;gap:2px;min-width:0;';
        const title = doc.createElement('span');
        title.textContent = PLAYER_ATTRIBUTION.label;
        title.style.cssText = 'overflow-wrap:anywhere;';
        const detail = doc.createElement('span');
        detail.textContent = [PLAYER_ATTRIBUTION.version && `v${PLAYER_ATTRIBUTION.version}`, PLAYER_ATTRIBUTION.url.replace(/^https?:\/\//, '')]
            .filter(Boolean).join(' · ');
        detail.style.cssText = 'font-size:11px;font-weight:400;color:var(--rtd-text-muted,#6b7280);overflow-wrap:anywhere;';
        text.append(title, detail);
        link.append(text);
        const lit = (on: boolean) => {
            link.style.background = on ? 'var(--rtd-surface-hover,rgba(127,127,127,.14))' : 'transparent';
        };
        link.addEventListener('pointerenter', () => lit(true));
        link.addEventListener('pointerleave', () => lit(doc.activeElement === link));
        link.addEventListener('focus', () => lit(true));
        link.addEventListener('blur', () => lit(false));
        link.addEventListener('click', () => {
            close();
            previousFocus?.focus({ preventScroll: true });
        });
        menu.append(link);
        host.append(menu);
        if (popover) {
            menu.setAttribute('popover', 'manual');
            menu.showPopover();
        }
        // A hidden button ('touch' mode with a mouse) has no box: open by the player instead.
        const anchor = (button.offsetParent ? button : root).getBoundingClientRect();
        const bounds = menu.getBoundingClientRect();
        menu.style.left = `${Math.max(8, Math.min(position?.x ?? anchor.left, win!.innerWidth - bounds.width - 8))}px`;
        menu.style.top = `${Math.max(8, Math.min(position?.y ?? anchor.bottom, win!.innerHeight - bounds.height - 8))}px`;
        button.setAttribute('aria-expanded', 'true');
        link.focus({ preventScroll: true });
        doc.addEventListener('pointerdown', outside, true);
        doc.addEventListener('keydown', menuKey, true);
        doc.addEventListener('focusin', focusOutside, true);
        win!.addEventListener('resize', close);
        win!.addEventListener('scroll', close, true);
        win!.addEventListener('blur', close);
    }
    // Right-click on the player is the credit's: caught first, on the player's element
    // only, whatever is under the pointer. The rest of the page keeps its own menus.
    function context(event: MouseEvent) {
        event.preventDefault();
        event.stopPropagation();
        open(event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : undefined);
    }
    function keyboard(event: KeyboardEvent) {
        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
        event.preventDefault();
        event.stopPropagation();
        const rect = (event.target as HTMLElement).getBoundingClientRect();
        open({ x: rect.left, y: rect.bottom });
    }
    button.addEventListener('click', () => menu ? close() : open());
    root.addEventListener('contextmenu', context, true);
    root.addEventListener('keydown', keyboard, true);
    return {
        open, close,
        dispose() {
            if (disposed) return;
            disposed = true;
            close();
            observer.disconnect();
            touchOnly?.removeEventListener('change', showButton);
            button.remove();
            if (positioned !== null) root.style.position = positioned;
            root.removeEventListener('contextmenu', context, true);
            root.removeEventListener('keydown', keyboard, true);
        },
    };
}

const bindings = new WeakMap<HTMLElement, { binding: AttributionBinding; count: number }>();
