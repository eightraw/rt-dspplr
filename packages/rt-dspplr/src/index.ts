// Main entry: the framework-agnostic engine.
export { PLAYER_ATTRIBUTION, type InfoButtonMode } from './attribution';

export {
    AudioPlayerCore,
    createAudioPlayer,
    type AudioInput,
    type ClipInfo,
    type ClipInput,
    type ClipSource,
    type ManifestClip,
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
    SPEED_MIN,
    SPEED_MAX,
    HIGH_PASS_DEFAULT_HZ,
    HIGH_PASS_MAX_HZ,
    COMPRESSION_DEFAULT,
    INPUT_DEFAULT_DB,
    INPUT_MAX_DB,
    INPUT_MIN_DB,
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
    type VocoderStretcher,
    type VocoderStretcherOptions,
} from './core/stretch/strategies';
export type { VocoderMemory } from './core/stretch/OfflineStretchCore';
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
    COLORMAPS,
    DEFAULT_SPECTROGRAM_PALETTE,
    colormapStops,
    type ColormapName,
    type SpectrogramPalette,
    type SpectrogramColorMode,
} from './core/spectrogram/paint';

export {
    createTimeline,
    type TimelineOptions,
    type TimelineView,
} from './core/timeline/createTimeline';

export type { LoopRange } from './core/engine/Track';

// Prepared long recordings: `play({ manifest })` on any player. Prepare them with
// `@saitdigital/rt-dspplr-prepare` (Node) or its `rtd-prepare` CLI. The formats
// themselves (validation, binary files) are in `@saitdigital/rt-dspplr/format`.
export type { SourceKind, SourceCapabilities, StemSummary } from './core/sources/types';
export type { PreparedOverview, WindowAudio, StreamStats, SegmentedOptions } from './core/sources/SegmentedSource';
export type {
    AudioManifest,
    ManifestSegment,
    ManifestPeakLevel,
    ManifestLoudness,
    ManifestStem,
    ManifestStems,
} from './core/stream/manifest';
export type { TimelinePlayer } from './core/timeline/TimelineCore';

// DSP plugins ("bring your own effect"): player.effects.add(plugin, …).
// EXPERIMENTAL: the plugin API may change in minor releases before 1.0.
export {
    validateParam,
    resolveParams,
    paramToUnit,
    unitToParam,
    type DspPlugin,
    type PluginParam,
    type PluginParams,
    type PluginInstance,
    type PluginRealtime,
    type PluginPreview,
    type PluginPreviewProcess,
    type EffectState,
    type PreviewCoverage,
} from './core/effects/types';
export { highPassPlugin, dynamicsPlugin } from './core/effects/builtins';
