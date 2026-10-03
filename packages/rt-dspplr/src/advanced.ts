// Advanced building blocks. This surface may change between minor releases before 1.0.
// Main entry: the framework-agnostic engine.

export {
    AudioPlayerCore,
    createAudioPlayer,
    type AudioInput,
    type ClipInfo,
    type ClipInput,
    type ClipSource,
    type LoaderB,
    type StatusB,
    type LoadOptions,
    type PauseMode,
    type PlayerStatus,
    type AudioPlayerEvent,
    type AudioPlayerEventMap,
    type AudioPlayerOptions,
    type AudioPlayerState,
} from './core/AudioPlayer';

export {
    DEFAULT_PROCESSING,
    DEFAULT_SPEEDS,
    HIGH_PASS_DEFAULT_HZ,
    HIGH_PASS_MAX_HZ,
    COMPRESSION_DEFAULT,
    OUTPUT_DEFAULT_DB,
    OUTPUT_MAX_DB,
    OUTPUT_MIN_DB,
    LIMITER_CEILING_DB,
    MIX_DEFAULT,
    dialToHighPassHz,
    highPassHzToDial,
    dialToOutputGainDb,
    outputGainDbToDial,
    outputGainDbToGain,
    formatHighPassLabel,
    formatPercentLabel,
    formatOutputGainLabel,
    formatMixLabel,
    mixGains,
    formatSpeedLabel,
    findSpeedIndex,
    type MixLaw,
    type ProcessingState,
} from './core/controls';

export {
    vocoderStretcher,
    nativeStretcher,
    type StretchStrategy,
} from './core/stretch/strategies';
export {
    serveStretchWorker,
    type StretchImplementation,
    type StretchWorkerRequest,
    type StretchWorkerResponse,
    type StretchWorkerError,
    type StretchWorkerMessage,
    type StretchWorkerScope,
} from './core/stretch/protocol';
export { StretchService, StretchUnavailableError, type StretchPriority } from './core/stretch/StretchService';
export { stretchChannel, stretchMultichannel, type StretchOptions } from './core/stretch/OfflineStretchCore';

export {
    setAudioCacheBudget,
    clearAudioCache,
    getAudioCacheStats,
    DEFAULT_PCM_CACHE_BUDGET_BYTES,
    type PcmCacheStats,
} from './core/cache/pcmCache';

export { WaveformAnalyzer, type WaveformPyramids } from './core/waveform/WaveformAnalyzer';
export {
    buildPeakPyramid,
    pickPeakPyramidLevel,
    type WaveformPeakLevel,
    type WaveformPeakPyramid,
} from './core/waveform/pyramid';
export type { WaveformProcessing } from './core/waveform/types';

// Lower-level building blocks, for custom graphs.
export {
    AudioEngine,
    Track,
    Mixer,
    findZeroCrossing,
    type EngineStatus,
    type AudioEngineOptions,
    type LoopRange,
    type TrackOptions,
    type TrackPlayState,
    type TrackState,
    type MixerState,
} from './core/engine';
export {
    DSPChain,
    createDynamicsWorklet,
    createHighPass,
    createCompressor,
    createOutputGain,
    createLimiter,
    type DSPNodeDescriptor,
    type DynamicsWorkletNode,
    type DynamicsWorkletOptions,
    type HighPassNode,
    type CompressorNode,
    type OutputGainNode,
    type LimiterNode,
} from './core/dsp';
export { BufferLoader, type BufferLoaderOptions, type LoadProgress, type LoadResult, type LoadStatus } from './core/loader/BufferLoader';

export {
    createSpectrogram,
    type SpectrogramOptions,
    type SpectrogramView,
} from './core/spectrogram/SpectrogramView';
export {
    DEFAULT_SPECTROGRAM_PALETTE,
    type SpectrogramPalette,
    type SpectrogramColorMode,
} from './core/spectrogram/paint';
export { SpectrogramAnalyzer, type SpectrogramData, type SpectrogramRequest } from './core/spectrogram/SpectrogramAnalyzer';
export { paintSpectrogram, type SpectrogramLook } from './core/spectrogram/paint';
export { sampleSpectralPyramid } from './core/spectrogram/sample';
export type { SpectralPyramid, SpectralLevel } from './core/spectrogram/protocol';
