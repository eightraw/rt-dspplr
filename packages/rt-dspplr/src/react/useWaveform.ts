import { useEffect, useState } from 'react';
import type { AudioPlayerCore } from '../core/AudioPlayer';
import { followWaveform } from '../core/waveform/followWaveform';
import type { WaveformPeakPyramid } from '../core/waveform/pyramid';

/**
 * The waveform of the player's clip, following the DSP: the peaks worker over
 * a whole clip, or a prepared clip's stored peaks (approximate preview) with
 * the exact preview of its decoded window. With `enabled` false nothing is
 * computed (a spectrogram draws the clip instead).
 */
export function useWaveform(core: AudioPlayerCore, enabled = true): WaveformPeakPyramid | null {
    const [pyramid, setPyramid] = useState<WaveformPeakPyramid | null>(null);
    useEffect(() => {
        if (!enabled) return undefined;
        return followWaveform(core, setPyramid);
    }, [core, enabled]);
    return pyramid;
}
