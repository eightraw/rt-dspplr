import type { MixLaw } from '../controls';

/** DSP settings the waveform preview mirrors (linear output gain). */
export interface WaveformProcessing {
    highPassHz: number;
    compression: number;
    /** Linear gain, 0 = muted. */
    outputGain: number;
    mix: number;
    mixLaw?: MixLaw;
}
