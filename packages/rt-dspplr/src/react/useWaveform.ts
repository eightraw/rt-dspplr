import { useEffect, useMemo, useRef, useState } from 'react';
import type { AudioPlayerState } from '../core/AudioPlayer';
import { outputGainDbToGain } from '../core/controls';
import { WaveformAnalyzer } from '../core/waveform/WaveformAnalyzer';
import type { WaveformPeakPyramid } from '../core/waveform/pyramid';
import type { WaveformProcessing } from '../core/waveform/types';

/**
 * Peak pyramids of the current clip, recomputed in a worker as the DSP
 * changes. With `enabled` false no worker is started (a spectrogram draws
 * the clip instead).
 */
export function useWaveform(state: AudioPlayerState, enabled = true): WaveformPeakPyramid | null {
    const [pyramids, setPyramids] = useState<{ source: WaveformPeakPyramid | null; processed: WaveformPeakPyramid | null }>({
        source: null,
        processed: null,
    });
    const analyzerRef = useRef<WaveformAnalyzer | null>(null);
    const { highPassHz, compression, outputGainDb, mix } = state.processing;
    const { mixLaw } = state;
    const processing = useMemo<WaveformProcessing>(() => ({
        highPassHz,
        compression,
        outputGain: outputGainDbToGain(outputGainDb),
        mix,
        mixLaw,
    }), [highPassHz, compression, outputGainDb, mix, mixLaw]);
    const processingRef = useRef(processing);
    processingRef.current = processing;

    useEffect(() => {
        if (!enabled) return undefined;
        const analyzer = new WaveformAnalyzer(({ source, processed }) => setPyramids({ source, processed }));
        analyzerRef.current = analyzer;
        return () => {
            analyzer.dispose();
            if (analyzerRef.current === analyzer) analyzerRef.current = null;
        };
    }, [enabled]);

    useEffect(() => {
        // While the next clip loads the buffer is briefly null: the previous
        // waveform stays until the new one is analysed.
        if (!state.buffer) return;
        analyzerRef.current?.setBuffers(state.buffer, state.bufferB, processingRef.current);
    }, [state.buffer, state.bufferB, state.clipId, enabled]);

    useEffect(() => {
        analyzerRef.current?.setProcessing(processing);
    }, [processing]);

    return pyramids.processed ?? pyramids.source;
}
