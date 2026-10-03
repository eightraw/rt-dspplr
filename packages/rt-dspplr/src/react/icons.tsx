// Inline icons for <AudioPlayer />, drawn for this package on a 24 px grid
// with a 1.75 px stroke. They inherit `currentColor`.

import type { ReactNode } from 'react';

function Svg({ children, filled = false }: { children: ReactNode; filled?: boolean }) {
    return (
        <svg
            className="rtd-icon"
            viewBox="0 0 24 24"
            width="24"
            height="24"
            fill={filled ? 'currentColor' : 'none'}
            stroke={filled ? 'none' : 'currentColor'}
            strokeWidth={1.75}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
        >
            {children}
        </svg>
    );
}

/** Rounded play triangle, optically centred. */
export function IconPlay() {
    return (
        <Svg filled>
            <path d="M8.5 5.6c0-.8.9-1.3 1.6-.9l9 5.9c.6.4.6 1.4 0 1.8l-9 5.9c-.7.4-1.6-.1-1.6-.9z" />
        </Svg>
    );
}

export function IconPause() {
    return (
        <Svg filled>
            <rect x="6.5" y="5" width="3.8" height="14" rx="1.2" />
            <rect x="13.7" y="5" width="3.8" height="14" rx="1.2" />
        </Svg>
    );
}

/** Three horizontal faders: "sound settings". */
export function IconSliders() {
    return (
        <Svg>
            <path d="M4 7h9" />
            <path d="M17 7h3" />
            <circle cx="15" cy="7" r="2" />
            <path d="M4 17h3" />
            <path d="M11 17h9" />
            <circle cx="9" cy="17" r="2" />
        </Svg>
    );
}

/** Two stacked chevrons pointing right: "continue with the next clip". */
export function IconNext() {
    return (
        <Svg>
            <path d="m6 7 5 5-5 5" />
            <path d="m13 7 5 5-5 5" />
        </Svg>
    );
}

/** Small spinner arc, used while stem B loads. */
export function IconSpinner() {
    return (
        <Svg>
            <path className="rtd-spin" d="M12 4a8 8 0 1 1-8 8" />
        </Svg>
    );
}

/** Bar plus left-pointing triangle: "back to the start". */
export function IconToStart() {
    return (
        <Svg>
            <path d="M6.5 6v12" />
            <path d="M17.5 6.8v10.4a.8.8 0 0 1-1.2.7l-7.6-5.2a.8.8 0 0 1 0-1.4l7.6-5.2a.8.8 0 0 1 1.2.7z" />
        </Svg>
    );
}
