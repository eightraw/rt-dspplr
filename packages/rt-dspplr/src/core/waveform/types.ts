import type { MixLaw } from '../controls';
import type { PreviewStage } from '../effects/preview';

/** DSP settings the waveform preview mirrors (linear output gain). */
export interface WaveformProcessing {
    /** Linear gain before all processing (it drives the compressor), 0 = muted. */
    inputGain: number;
    highPassHz: number;
    compression: number;
    /** Linear gain after all processing, before the ceiling, 0 = muted. */
    outputGain: number;
    mix: number;
    mixLaw?: MixLaw;
    /**
     * Sample-level stages in chain order (the built-in high-pass and third-party
     * plugins' process() previews), when a plugin has one. Without it the
     * high-pass runs on its own path.
     */
    stages?: PreviewStage[] | null;
    /** Identifies the effect settings (for change detection). */
    key?: string;
}
