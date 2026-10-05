import { AudioPlayerCore, type AudioPlayerOptions, type AudioPlayerState } from '../AudioPlayer';
import type { SegmentedOptions } from '../sources/SegmentedSource';

// ---------------------------------------------------------------------------
// Deprecated: the stream player is now the segmented source of the one player
// core. `createAudioPlayer().play({ manifest })` does the same; these names
// stay as thin aliases for code written against the first experiment.
// ---------------------------------------------------------------------------

/** @deprecated Use `ManifestClip` (`{ manifest }`) with createAudioPlayer(). */
export interface StreamClip {
    manifest: string;
    id?: string;
}

/** @deprecated */
export type StreamClipInput = string | StreamClip;

/** @deprecated Use AudioPlayerOptions; the segmented options moved under `segmented`. */
export interface StreamPlayerOptions extends AudioPlayerOptions, SegmentedOptions {}

/** @deprecated Use AudioPlayerState (it carries manifest, buffering, prepared, capabilities). */
export type StreamPlayerState = AudioPlayerState;

/** @deprecated Use AudioPlayerCore. */
export const StreamPlayerCore = AudioPlayerCore;
/** @deprecated Use AudioPlayerCore. */
export type StreamPlayerCore = AudioPlayerCore;

/**
 * @deprecated Use `createAudioPlayer()` and `play({ manifest })`. Kept as an
 * alias: the segmented options may be passed at the top level as before.
 */
export function createStreamPlayer(options: StreamPlayerOptions = {}): AudioPlayerCore {
    const { cacheSeconds, prefetchSegments, decode, scheduleAheadSeconds, ...rest } = options;
    return new AudioPlayerCore({
        ...rest,
        segmented: { cacheSeconds, prefetchSegments, decode, scheduleAheadSeconds, ...rest.segmented },
    });
}
