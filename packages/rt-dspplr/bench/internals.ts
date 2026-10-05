// Internals the long-audio bench drives directly (not public API). Bundled by
// bench/long-audio-bench.mjs into node_modules/.cache/rtd-bench/internals.js.
export { parseWavFile } from '../src/core/stream/wavFormat';
export { WaveformAnalyzer } from '../src/core/waveform/WaveformAnalyzer';
export { approximateProcessedPyramid } from '../src/core/waveform/approxPreview';
export { resolveColumns } from '../src/core/timeline/waveEnvelope';
export { StreamEngine, loadStreamEngine, stretchAvailable } from '../src/core/engine/StreamEngine';
