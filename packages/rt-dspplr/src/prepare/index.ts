// `@saitdigital/rt-dspplr/prepare` — Node only. Ingest-time preparation of long
// recordings for the stream player (`createStreamPlayer`). See
// docs/long-audio-experiment.md for the formats.
export {
    prepareAudio,
    fsStorage,
    memoryStorage,
    chooseTargetRate,
    type PrepareInput,
    type PrepareJob,
    type PrepareOptions,
    type PrepareProgress,
    type PrepareStats,
    type PrepareStatus,
    type PrepareStorage,
    type StemSpec,
} from './prepareAudio';
export { ffmpegDecoder, type FfmpegDecoderOptions } from './ffmpegDecoder';
export { wavDecoder, UnsupportedFormatError, type AudioDecoder, type DecodedStream, type SourceFormat } from './decoder';
export { StreamingResampler, designResampler, type ResamplerOptions, type ResamplerInfo } from './resampler';
export { PeakAnalyzer, levelLadder, DEFAULT_FRAMES_PER_PEAK, LEVEL_STEP, MAX_COARSEST_PEAKS } from './analysis';
export {
    ANALYZER_VERSION,
    MANIFEST_FORMAT,
    MANIFEST_FORMAT_VERSION,
    assertManifest,
    type AudioManifest,
    type ManifestLoudness,
    type ManifestPeakLevel,
    type ManifestSegment,
} from '../core/stream/manifest';
export { encodePeaksFile, decodePeaksFile, peaksLayout, PEAKS_MAGIC, PEAKS_VERSION, type PeaksFile, type PeakLevelData, type PeakChannelData } from '../core/stream/peaksFile';
export { parseWavHeader, parseWavFile, decodeInterleaved, wavHeader16, WavFormatError, type WavFormat } from '../core/stream/wavFormat';
export { BandEnergyAnalyzer, OverviewSpectrogramAnalyzer, lowPassSection, SPECTROGRAM_ROWS, SPECTROGRAM_TOP_DB, SPECTROGRAM_RANGE_DB } from './overviewAnalysis';
export { encodeBandsFile, decodeBandsFile, highPassEnergyRatio, DEFAULT_BAND_CUTOFFS, type BandsFile } from '../core/stream/bandsFile';
export { encodeSpectrogramFile, decodeSpectrogramFile, toSpectralPyramid, type SpectrogramFile } from '../core/stream/spectrogramFile';
export { attachStem, markStem, type AttachStemOptions, type StemTarget } from './attachStem';
export { buildStem, crossCorrelate, StemAlignmentError, type StemInput, type StemOptions, type BuildStemContext } from './stem';
export { commandProcessor, dockerProcessor, functionProcessor, httpProcessor, runProcessor, StemProcessorError, type StemProcessor, type StemProcessorInput, type StemProcessorOutput, type CommandProcessorOptions, type DockerProcessorOptions, type HttpProcessorOptions } from './processors';
export { resampleInParallel, OUT_CHUNK } from './parallelResample';
export { resampleRange, resampleInputRange } from './resampler';
export { writeTimeline, type TimelineInput, type TimelineOutput } from './prepareAudio';
export type { ManifestStem } from '../core/stream/manifest';
