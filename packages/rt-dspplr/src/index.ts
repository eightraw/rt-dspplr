// Main entry: the framework-agnostic engine.
export { PLAYER_ATTRIBUTION, type InfoButtonMode } from './attribution';

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
export {
    setAudioCacheBudget,
    clearAudioCache,
    getAudioCacheStats,
    DEFAULT_PCM_CACHE_BUDGET_BYTES,
    type PcmCacheStats,
} from './core/cache/pcmCache';

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

export type { LoopRange } from './core/engine/Track';
