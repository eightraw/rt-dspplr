# Changelog

## 0.2.1

- `infoButton: 'always' | 'touch'`. With `'touch'` the ⓘ button of the author menu
  shows only on devices without right-click; with a mouse, right-click alone opens it.
- The ⓘ button lives inside the player and no longer takes a row of the host's
  layout. It goes into an element marked `data-rtd-credit`, or over the top-right
  corner of the player's element (`--rtd-credit-top`, `--rtd-credit-right`).
  `<AudioPlayer />` keeps it in its heading row, and in the compact row.
- No layout-effect warnings from the scrubber during server rendering.
- README: four inline scripts, not three; Rubber Band licensing in plain words.

## 0.2.0

- First release.
