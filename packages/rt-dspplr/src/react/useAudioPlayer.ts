import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
    AudioPlayerCore,
    type AudioPlayerOptions,
    type AudioPlayerState,
} from '../core/AudioPlayer';

// ---------------------------------------------------------------------------
// useAudioPlayer — React binding for the headless AudioPlayer
// ---------------------------------------------------------------------------
//
// Lifecycle notes:
// - The player is created once per component instance. Creating it is free:
//   no AudioContext, node, or worker exists until the first load/play.
// - Unmount disposes it (stops playback, releases nodes). Under React
//   StrictMode, development builds run mount -> unmount -> mount; the mount
//   effect therefore re-arms the instance with reactivate(), otherwise the
//   second mount would hold a player that refuses to play.
// - `options` are read once, on first render. Remount (e.g. change `key`) to
//   switch the stretch strategy.
// - A custom interface puts `ref` on its root element; <AudioPlayer> mounts
//   its own root. dispose() keeps mounted elements, so StrictMode's second
//   mount still has its interface.

export interface UseAudioPlayerResult extends Pick<
    AudioPlayerCore,
    | 'load'
    | 'play'
    | 'pause'
    | 'toggle'
    | 'stop'
    | 'seek'
    | 'setLoop'
    | 'setSpeed'
    | 'setHighPass'
    | 'setCompression'
    | 'setInputGain'
    | 'setOutputGain'
    | 'setMix'
    | 'setProcessing'
    | 'setPauseMode'
    | 'setSourceB'
    | 'setStem'
    | 'getCurrentTime'
    | 'on'
> {
    /** Reactive snapshot of the player state. */
    state: AudioPlayerState;
    /** The underlying headless instance (pass it to <AudioPlayer player={...} />). */
    player: AudioPlayerCore;
    /** Put on your own interface's root element: `<div ref={player.ref}>`. Not needed with <AudioPlayer>. */
    ref: (element: HTMLElement | null) => void;
}

export function useAudioPlayer(options?: AudioPlayerOptions): UseAudioPlayerResult {
    const [player] = useState(() => new AudioPlayerCore(options));

    const state = useSyncExternalStore(player.subscribe, player.getState, player.getState);

    const release = useRef<(() => void) | null>(null);
    const ref = useCallback((element: HTMLElement | null) => {
        release.current?.();
        release.current = element ? player.mount(element) : null;
    }, [player]);

    useEffect(() => {
        // Re-arm on every mount: StrictMode's simulated unmount disposed it.
        player.reactivate();
        return () => {
            player.dispose();
        };
    }, [player]);

    return useMemo(() => ({
        state,
        player,
        ref,
        load: player.load,
        play: player.play,
        pause: player.pause,
        toggle: player.toggle,
        stop: player.stop,
        seek: player.seek,
        setLoop: player.setLoop,
        setSpeed: player.setSpeed,
        setHighPass: player.setHighPass,
        setCompression: player.setCompression,
        setInputGain: player.setInputGain,
        setOutputGain: player.setOutputGain,
        setMix: player.setMix,
        setProcessing: player.setProcessing,
        setPauseMode: player.setPauseMode,
        setSourceB: player.setSourceB,
        setStem: player.setStem,
        getCurrentTime: player.getCurrentTime,
        on: player.on,
    }), [player, state, ref]);
}

/** Subscribe a component to an existing AudioPlayer instance. */
export function useAudioPlayerState(player: AudioPlayerCore): AudioPlayerState {
    return useSyncExternalStore(player.subscribe, player.getState, player.getState);
}
