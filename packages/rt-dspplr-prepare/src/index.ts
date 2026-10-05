// @saitdigital/rt-dspplr-prepare — Node only. Ingest-time preparation of long
// recordings for the RT-DSPPLR player (`player.play({ manifest })`): fixed
// segments, overview peaks, bands and spectrogram, and named stems, under one
// manifest. The formats are those of `@saitdigital/rt-dspplr/format` (one
// implementation, imported, not copied); see docs/manifest.md.
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
    type StemTimings,
} from './prepareAudio';
export { ffmpegDecoder, type FfmpegDecoderOptions } from './ffmpegDecoder';
export { wavDecoder, UnsupportedFormatError, type AudioDecoder, type DecodedStream, type SourceFormat } from './decoder';
export { attachStem, markStem, type AttachStemOptions, type StemTarget } from './attachStem';
export { StemAlignmentError, type StemInput, type StemOptions } from './stem';
export {
    commandProcessor,
    dockerProcessor,
    functionProcessor,
    httpProcessor,
    StemProcessorError,
    type StemProcessor,
    type StemProcessorInput,
    type StemProcessorOutput,
    type CommandProcessorOptions,
    type DockerProcessorOptions,
    type HttpProcessorOptions,
} from './processors';
export type { ResamplerOptions } from './resampler';
// The manifest's types, for convenience; validation and the binary formats are in
// `@saitdigital/rt-dspplr/format`.
export type { AudioManifest, ManifestStem, ManifestStems } from '@saitdigital/rt-dspplr/format';
