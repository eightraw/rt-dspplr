// "Auto" toggle behaviour for the example:
//   1. A clip ends naturally (ended false -> true, no active loop):
//      play the next newer clip (the one above it in the newest-first list).
//   2. Nothing newer yet: wait. When a new file lands in the bucket, it is
//      played as soon as the list updates.
// A manual pick is always respected: auto-advance continues from whatever is
// playing now.

import { useEffect, useRef } from 'react';
import type { AudioPlayerState } from '@saitdigital/rt-dspplr';
import type { Clip } from './types';

type Phase = 'idle' | 'waiting';

function keyOf(id: string | null): string | null {
    if (!id) return null;
    const hash = id.lastIndexOf('#');
    return hash >= 0 ? id.slice(0, hash) : id;
}

export function useAutoAdvance(
    enabled: boolean,
    state: AudioPlayerState,
    clips: Clip[],
    playClip: (clip: Clip) => void,
): void {
    const previousEndedRef = useRef(state.ended);
    const phaseRef = useRef<Phase>('idle');
    const knownIdsRef = useRef<Set<string>>(new Set(clips.map((c) => c.id)));

    // 1. Natural end.
    useEffect(() => {
        const wasEnded = previousEndedRef.current;
        previousEndedRef.current = state.ended;
        if (!enabled || wasEnded || !state.ended || state.loop) {
            return;
        }

        const key = keyOf(state.clipId);
        const index = clips.findIndex((c) => c.object.key === key);
        const next = index > 0 ? clips[index - 1] : null;
        if (next) {
            phaseRef.current = 'idle';
            playClip(next);
            return;
        }

        phaseRef.current = 'waiting';
    }, [state.clipId, state.ended, state.loop, enabled, clips, playClip]);

    // 2. Waiting for a new arrival.
    useEffect(() => {
        const known = knownIdsRef.current;
        const fresh = clips.filter((c) => !known.has(c.id));
        knownIdsRef.current = new Set(clips.map((c) => c.id));

        if (!enabled || phaseRef.current !== 'waiting' || fresh.length === 0) {
            return;
        }
        // Several files can land at once: play the oldest of the new ones
        // first, the rest follow through step 1.
        const target = fresh[fresh.length - 1];
        phaseRef.current = 'idle';
        playClip(target);
    }, [enabled, clips, playClip]);

    // Any manual start leaves the waiting phase.
    useEffect(() => {
        if (state.isPlaying) {
            phaseRef.current = 'idle';
        }
    }, [state.isPlaying, state.playRequestId]);

    useEffect(() => {
        if (!enabled) {
            phaseRef.current = 'idle';
        }
    }, [enabled]);
}
