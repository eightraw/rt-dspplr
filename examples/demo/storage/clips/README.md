# storage/clips — the example's object-storage bucket

This folder plays the role of the bucket `clips` served by
`plugins/fakeObjectStorage.ts`. Everything in it except `.gitkeep` and this
README is ignored by git.

## What goes here

| File | Meaning |
|---|---|
| `<name>.wav`, `.mp3`, `.ogg`, `.opus`, `.m4a`, `.flac`, `.webm` | a clip; shows up in the list |
| `<name>.json` | optional metadata sidecar |
| `<name>.b.<ext>` | stem B of the same clip, for the Stem A ⇄ Stem B slider |

Sub-folders are allowed; the object key then contains `/`, as in S3.

Example sidecar `weather-en.json`:

```json
{
  "label": "Weather (US English)",
  "recorded_at": "2026-10-02T12:00:00Z",
  "language": "en-us"
}
```

`label` replaces the file name in the list, `recorded_at` sets the order
(otherwise the file's modification time is used). Other fields are shown in
the details card as-is.

## About the sample files

`npm run samples` (`scripts/make-samples.sh`, needs Docker) creates them.
They are synthetic: phrases synthesised by espeak-ng, the processed example
audio produced with ffmpeg filters (a low-pass at 4.5 kHz, quiet pink noise, gentle saturation).
Timestamps are made up.

The `*.b.wav` files are the clean synthesis before the degradation. In a real
application stem B is whatever you mix against the clip; rendered on demand,
it can come from your own service through the `loadB` option.
