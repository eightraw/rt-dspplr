// ./react entry — React bindings. Import the stylesheet once:
//   import '@saitdigital/rt-dspplr/styles.css';

export { AudioPlayer, type AudioPlayerProps } from './AudioPlayer';
export { useAudioPlayer, useAudioPlayerState, type UseAudioPlayerResult } from './useAudioPlayer';
export { Spectrogram, type SpectrogramProps } from './Spectrogram';
export { Timeline, type TimelineProps } from './Timeline';
export type {
    AudioInput,
    ClipInput,
    ClipSource,
    ManifestClip,
    AudioPlayerCore,
    AudioPlayerOptions,
    AudioPlayerState,
} from '../core/AudioPlayer';
export type { ProcessingState } from '../core/controls';
