# Gallery

Five interfaces built on `useAudioPlayer()` and `<Timeline>` from
`@saitdigital/rt-dspplr`. They are the animations in the
[project README](../../README.md). They are examples to copy from, not part
of the package.

```bash
npm ci
npm run gallery     # from the repository root
```

Open **http://localhost:5175** and choose an audio file, or drop it on the
page. Drop a file on one card to change that card only. Drop two files at once
and the second becomes stem B in the stem comparison. No audio ships with the
gallery.

| Design | File | What it shows |
|---|---|---|
| Voice message | [VoiceNote.tsx](src/designs/VoiceNote.tsx) | Bars, the duration, a speed button that cycles 1×, 1.5×, 2×. Zoom is off, so the wheel scrolls the page. |
| Now playing | [NowPlaying.tsx](src/designs/NowPlaying.tsx) | Cover and background lit by the output level from `player.analyser`. Zoom is off. |
| Stem comparison | [StudioAB.tsx](src/designs/StudioAB.tsx) | The spectrogram of both stems with the waveform over it, A/B and the mix slider, crossfade or separation, a loop, a level meter. |
| Editorial | [Editorial.tsx](src/designs/Editorial.tsx) | A large timecode, text links, a four-second loop, a high-pass the waveform shows as you hear it. |
| Listening exercise | [Lesson.tsx](src/designs/Lesson.tsx) | A phrase in a loop, slower speeds, `pauseMode: 'reset'` for "repeat", gentle high-pass and compression. |

Each design is one component and one stylesheet. [shared.tsx](src/shared.tsx)
holds the small helpers they share: loading a file, the live position, the
output level and file drops. A design needs only the package to work. Every
design keeps the player's author credit, the ⓘ button in its corner.
