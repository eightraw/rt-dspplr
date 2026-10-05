// `@saitdigital/rt-dspplr/format` — the prepared-audio formats, shared by the
// player and `@saitdigital/rt-dspplr-prepare`: the manifest (types,
// validation, stem keys), the binary overview files (peaks.bin, bands.bin,
// spectrogram.bin) and the WAV segments. Pure code: no DOM, no Node APIs, no
// workers, so it runs in browsers, Node and workers alike.
//
// The normative description is docs/manifest.md in the repository; the JSON
// Schema ships as `@saitdigital/rt-dspplr/manifest.schema.json`.
//
// One implementation, two packages: the prepare package imports this entry
// instead of carrying its own copy, so what prepare writes is what this
// version of the player reads.

// ---- the manifest ---------------------------------------------------------------------
export {
    MANIFEST_FORMAT,
    MANIFEST_FORMAT_VERSION,
    ANALYZER_VERSION,
    STEM_KEY_PATTERN,
    DEFAULT_STEM_KEY,
    assertManifest,
    manifestProblem,
    isStemKey,
    assertStemKey,
    readyStemKeys,
    type AudioManifest,
    type ManifestSegment,
    type ManifestPeakLevel,
    type ManifestLoudness,
    type ManifestStem,
    type ManifestStems,
} from './core/stream/manifest';

// ---- binary overview files ---------------------------------------------------------------
export {
    PEAKS_MAGIC,
    PEAKS_VERSION,
    encodePeaksFile,
    decodePeaksFile,
    peaksLayout,
    type PeaksFile,
    type PeakLevelData,
    type PeakChannelData,
    type PeakLevelLayout,
} from './core/stream/peaksFile';
export {
    BANDS_MAGIC,
    BANDS_VERSION,
    DEFAULT_BAND_CUTOFFS,
    DEFAULT_FRAMES_PER_BAND_BIN,
    encodeBandsFile,
    decodeBandsFile,
    highPassEnergyRatio,
    type BandsFile,
} from './core/stream/bandsFile';
export {
    SPECTROGRAM_MAGIC,
    SPECTROGRAM_VERSION,
    encodeSpectrogramFile,
    decodeSpectrogramFile,
    spectrogramLayout,
    type SpectrogramFile,
    type SpectrogramLevelLayout,
} from './core/stream/spectrogramFile';

// ---- WAV segments --------------------------------------------------------------------------
export {
    looksLikeWav,
    parseWavHeader,
    parseWavFile,
    decodeInterleaved,
    floatToInt16,
    wavHeader16,
    WavFormatError,
    type WavFormat,
    type WavEncoding,
} from './core/stream/wavFormat';

// ---- analysis kernels shared with the prepare step -------------------------------------
// The overview files are made with exactly the player's own analysis (the
// spectrogram worker's spectral code, the DSP chain's high-pass
// coefficients), so the prepared previews match what the player computes.
/** @experimental Shared with `@saitdigital/rt-dspplr-prepare`; may change in minor releases. */
export { frameRows, planBands, quantizeRows, PYRAMID_BANDS, type Band } from './core/spectrogram/spectral';
/** @experimental Shared with `@saitdigital/rt-dspplr-prepare`; may change in minor releases. */
export { computeHighPassCoefficients, HIGH_PASS_SECTION_Q, type HighPassCoefficients } from './core/dsp/highPass';
