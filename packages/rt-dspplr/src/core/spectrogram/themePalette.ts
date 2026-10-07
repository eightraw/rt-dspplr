import { DEFAULT_SPECTROGRAM_PALETTE, type SpectrogramPalette } from './paint';

/**
 * The palette a view paints with: the theme's, then the options' over it. A
 * palette given without a `colormap` turns the theme's colormap off, so its
 * own colours show.
 */
export function resolvePalette(themed: SpectrogramPalette, given?: Partial<SpectrogramPalette>): SpectrogramPalette {
    if (!given) return themed;
    return { ...themed, ...('colormap' in given ? {} : { colormap: null }), ...given };
}

/**
 * The spectrogram's colours from the theme where the canvas sits: the
 * `--rtd-spectrogram-*` custom properties of styles.css (light and dark), so
 * the picture follows the card's theme like the waveform does. A property
 * that is not set falls back to the default (dark) palette. Any CSS colour,
 * var() included (the computed value has it resolved);
 * `--rtd-spectrogram-colormap` names a colormap ('magma', 'magma_r', …).
 */
export function themePalette(el: Element): SpectrogramPalette {
    const view = el.ownerDocument.defaultView;
    const style = view ? view.getComputedStyle(el) : null;
    const read = (name: string, fallback: string) => style?.getPropertyValue(name).trim() || fallback;
    const d = DEFAULT_SPECTROGRAM_PALETTE;
    return {
        background: read('--rtd-spectrogram-bg', d.background),
        colorA: read('--rtd-spectrogram-a', d.colorA),
        colorB: read('--rtd-spectrogram-b', d.colorB),
        colorMix: read('--rtd-spectrogram-mix', d.colorMix),
        peak: read('--rtd-spectrogram-peak', d.peak),
        colormap: (read('--rtd-spectrogram-colormap', '') || null) as SpectrogramPalette['colormap'],
    };
}
