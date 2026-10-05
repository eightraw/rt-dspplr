// The React card on a prepared recording: the same <AudioPlayer> as the main
// demo, driven through useAudioPlayer() and load({ manifest }).
import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { AudioPlayer, useAudioPlayer } from '@saitdigital/rt-dspplr/react';

function ManifestCard({ manifest, title }: { manifest: string; title: string }) {
    const player = useAudioPlayer({ prewarmSpeeds: false });
    const { load } = player;
    useEffect(() => {
        void load({ manifest });
    }, [load, manifest]);
    return (
        <AudioPlayer
            player={player}
            title={title}
            meta="manifest mode · segments on demand"
            display="both"
        />
    );
}

/** Render the card into `host`; returns a function that unmounts it. */
export function mountCard(host: HTMLElement, manifest: string, title: string): () => void {
    const box = host.appendChild(document.createElement('div'));
    const root = createRoot(box);
    root.render(<ManifestCard manifest={manifest} title={title} />);
    return () => {
        root.unmount();
        box.remove();
    };
}
