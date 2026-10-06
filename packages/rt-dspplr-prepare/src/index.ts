// @saitdigital/rt-dspplr-prepare — Node only. Ingest-time preparation of long
// recordings for the RT-DSPPLR player (`player.play({ manifest })`): the
// original file with an index of its segments, overview peaks, bands and
// spectrogram, and named stems, under one manifest. The formats are those of `@saitdigital/rt-dspplr/format` (one
// implementation, imported, not copied); see docs/manifest.md.
export {
    prepareAudio,
    fsStorage,
    memoryStorage,
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
export { builtinDecoder, flacDecoder, mp3Decoder, opusDecoder } from './wasm/decoders';
export { wavDecoder, UnsupportedFormatError, type AudioDecoder, type DecodedStream, type DecoderOptions, type SourceFormat } from './decoder';
// The rule for `framesPerPeak` (a power of two from 16 to 65536), for hosts that check their input first.
export { checkFramesPerPeak } from './analysis';
export { attachStem, markStem, type AttachStemOptions, type StemTarget } from './attachStem';
// Analysis threads a service keeps between calls.
export { createPreparePool, type PreparePool } from './pool';
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
