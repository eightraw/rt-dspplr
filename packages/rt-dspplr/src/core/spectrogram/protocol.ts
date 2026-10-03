// Messages between SpectrogramAnalyzer and spectrogram.worker.ts.

export interface SpectrogramLoadMessage {
    type: 'load';
    /** One worker serves every view on the page; this says whose clip it is. */
    viewId: number;
    loadId: number;
    sampleRate: number;
    /** Mono downmix of stem A (the mean of its channels), as 16-bit samples. */
    stemA: ArrayBuffer | null;
    /** Mono downmix of stem B, when the clip has one, as 16-bit samples. */
    stemB: ArrayBuffer | null;
}

export interface SpectrogramComputeMessage {
    type: 'compute';
    viewId: number;
    requestId: number;
    loadId: number;
    /** Window of the clip, in seconds. */
    start: number;
    end: number;
    columns: number;
    rows: number;
    minHz: number;
    maxHz: number;
    fftSize: number;
    /**
     * Multi-resolution: an FFT length per band of the frequency axis, each band
     * starting at `fromHz` and running to the next, blended across a quarter
     * octave at each edge. Without it `fftSize` serves every row.
     */
    bands?: { fftSize: number; fromHz: number }[];
}

/**
 * Build the clip's spectral pyramid: every frame of the clip once, on a
 * logarithmic axis of `rows`, quantized to 8 bits over `rangeDb` below its
 * loudest bin, then halved level by level as the waveform's peaks are. The
 * worker drops the view's audio once it has answered.
 */
export interface SpectrogramPyramidMessage {
    type: 'pyramid';
    viewId: number;
    requestId: number;
    loadId: number;
    rows: number;
    minHz: number;
    maxHz: number;
    rangeDb: number;
}

export interface SpectralLevel {
    /** Samples per frame at this level. */
    binSize: number;
    frames: number;
    /** Frame-major: `frames × rows` levels, row 0 = the highest frequency. */
    a: Uint8Array;
    b: Uint8Array | null;
}

export interface SpectralPyramid {
    sampleRate: number;
    totalSamples: number;
    rows: number;
    minHz: number;
    maxHz: number;
    /** A stored level of 255 is `topDb`, 0 is `topDb - rangeDb` and below. */
    topDb: number;
    rangeDb: number;
    referenceSum: number;
    referenceMax: number;
    levels: SpectralLevel[];
}

export interface SpectrogramPyramidResponse {
    type: 'pyramid';
    viewId: number;
    requestId: number;
    loadId: number;
    pyramid: SpectralPyramid;
}

/** Frees what the worker holds for a view. */
export interface SpectrogramUnloadMessage {
    type: 'unload';
    viewId: number;
}

export interface SpectrogramResponse {
    type: 'spectrogram';
    viewId: number;
    requestId: number;
    loadId: number;
    start: number;
    end: number;
    columns: number;
    rows: number;
    /** Linear magnitude per pixel, row-major, row 0 = the highest frequency. */
    magA: Float32Array;
    magB: Float32Array | null;
    /** Loudest bin of |A| + |B| over the whole clip: the reference when the stems add up. */
    referenceSum: number;
    /** Loudest bin of either stem alone: the reference for a crossfade. */
    referenceMax: number;
}
