import type { AudioPlayerEvent, AudioPlayerEventMap, AudioPlayerOptions, AudioPlayerState, AudioInput, ClipInfo } from '../AudioPlayer';
import type AudioEngine from '../engine/AudioEngine';
import type { LoopRange } from '../engine/Track';

// ---------------------------------------------------------------------------
// One player core, pluggable sources.
//
// AudioPlayerCore owns what every clip shares: the state store and events,
// the interface element (author menu), the output DSP chain, and the public
// API. A PlaybackSource owns how a clip's audio is obtained and scheduled:
//
//   BufferSource     the whole clip decoded into an AudioBuffer: pitch-
//                    preserving speed variants, stem B, zero-crossing loops
//   SegmentedSource  a prepared manifest: peaks, bands and spectrogram first,
//                    segments fetched around the playhead
//
// A source writes its part of the state through the host and reports what it
// can do through `capabilities`, which the core puts in the state.
// ---------------------------------------------------------------------------

export type SourceKind = 'buffer' | 'segmented';

/** A named stem of a prepared clip (see the manifest's `stems`). */
export interface StemSummary {
    /** The host-chosen key (opaque; `b` when the host named none). */
    key: string;
    /** The manifest's human label, if any: interfaces show `label ?? key`. */
    label: string | null;
}

export interface SourceCapabilities {
    kind: SourceKind;
    /** Speed changes keep the pitch (a stretch worker). False: playbackRate, pitch follows speed. */
    canPreservePitch: boolean;
    /** A second stem (stem B) can be mixed in. */
    canMixStemB: boolean;
    /**
     * Prepared clips: the manifest's ready stems, in manifest order. The knob
     * blends A with one of them at a time (`state.stem`, `player.setStem()`).
     * Empty for whole clips, whose stem B is `srcB` / `loadB`.
     */
    stems: readonly StemSummary[];
    /** The waveform previews the DSP exactly over the whole clip (false: approximated outside the decoded window). */
    exactWaveformPreview: boolean;
    /** A spectrogram can be drawn (prepared overview or computed from the decoded clip). */
    spectrogram: boolean;
    /** Loop edges always land on zero crossings (false: only where the audio is in memory). */
    loopSnapping: boolean;
}

export interface SourceOutput {
    engine: AudioEngine;
    ctx: AudioContext;
    /** Sources connect their audio here (the head of the output chain). */
    input: AudioNode;
}

export interface SourceHost {
    readonly options: AudioPlayerOptions;
    getState(): AudioPlayerState;
    update(patch: Partial<AudioPlayerState>): void;
    emit<E extends AudioPlayerEvent>(event: E, payload: AudioPlayerEventMap[E]): void;
    /** The shared engine and output chain, built on first use. */
    ensureOutput(): Promise<SourceOutput | null>;
}

export interface PlaybackSource {
    readonly kind: SourceKind;
    readonly capabilities: SourceCapabilities;
    /** Load a clip; with autoplay, start it. Resolves false on failure or when superseded. */
    load(clip: ClipInfo, startAt: number | undefined, autoplay: boolean): Promise<boolean>;
    /** Whether `clip` is the one loaded and ready (play() then restarts instead of reloading). */
    isLoaded(clip: ClipInfo): boolean;
    restart(startAt: number): Promise<boolean>;
    resume(): Promise<void>;
    pause(): Promise<void>;
    stop(): void;
    seek(time: number): Promise<void>;
    setLoop(range: LoopRange | null): void;
    setSpeed(speed: number): Promise<void>;
    /** The mix value changed (the core has stored it). */
    setMix(mix: number): void;
    setSourceB(input: AudioInput | null): Promise<boolean>;
    /** Volume (linear gain before the post-FX chain), smoothed so a move never clicks. */
    setVolume(value: number): void;
    getCurrentTime(): number | null;
    /** Stop and forget the clip (another source takes over). */
    unload(): void;
    dispose(): void;
    reactivate(): void;
}
