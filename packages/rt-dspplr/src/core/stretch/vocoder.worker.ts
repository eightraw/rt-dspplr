// Built-in stretch worker: the dependency-free phase vocoder from
// OfflineStretchCore. Bundled into a self-contained string at library build
// time and started from a Blob URL (see build/inline-plugin.ts).

import { serveStretchWorker } from './protocol';
import { stretchMultichannel } from './OfflineStretchCore';

serveStretchWorker(self as never, (channels, sampleRate, speed, transientSensitivity, options) => stretchMultichannel(channels, {
    sampleRate,
    rate: 1 / speed,
    transientSensitivity,
    memory: options.memory === 'fast' || options.memory === 'lean' ? options.memory : 'auto',
}));
