# Changelog

## 0.3.0

- Breaking: `wheelZoom` defaults to `'modifier'`. The wheel over the waveform
  scrolls the page, Ctrl/Cmd + wheel (and a trackpad pinch) zooms, in
  proportion to the wheel's travel. `'plain'` keeps the wheel alone zooming, and
  in either mode the event is taken from the page only when the zoom changes.
- The built-in vocoder keeps the level at every speed. It was scaled by the
  speed: +6 dB at 2x, −6 dB at 0.5x, a jump on every speed change.
- The built-in vocoder's output lands on time. It was early or late by
  (fftSize/2)(1/speed − 1), about 20 ms of source time at 2x, and up to 0.1%
  slow or fast from a rounded synthesis hop: 0.6 s over ten minutes at 1.25x.
- Dropping or moving the loop while playing keeps the position. The position
  used to unfold the time spent looping into a jump towards the end of the clip,
  and pause/resume then ended the clip. A loop set behind the playhead now starts
  from its beginning, both stems together.
- Right-click yields to the interface: a handler inside the player that takes
  the event, links, text fields and selected text keep the browser's menu, Shift +
  right-click gives it anywhere, and the page around the player sees the event.
- Touch: a tap seeks, a vertical swipe scrolls the page instead of seeking, a
  sideways drag selects a loop. The docs no longer promise a pinch gesture.
- The variant of the current clip at the current speed is held by the player:
  a seek or a restart never renders it again, even when it is too large for the
  cache budget. Prewarming fits the budget beside what the cache already holds.
- Speeds are clamped to 0.25–4x (`SPEED_MIN`, `SPEED_MAX`); `speeds` outside
  the range are dropped with a warning.
- A stretch worker that never answers is replaced after a watchdog; crashes
  retire a slot only after four in a row, and a completed job resets the count.
  Transient detection runs in linear time.
- The waveform and spectrogram workers report a failure after they started
  (one warning) instead of leaving an empty picture and a request that never
  completes; the mixed waveform's RMS no longer reads a mono A with a stereo B
  3 dB too loud.
- The time ruler reaches the end of long clips: steps up to 30 min, labels
  with hours. The focus ring stays visible after a click followed by Tab.
  `<Timeline theme="auto">` redraws when the system scheme flips. The position
  and `timeupdate` keep moving in a background tab.
- `createTimeline(container, player, options)`: the card's seek bar (waveform,
  spectrogram, loops, zoom, pan, keys, ruler, overview) without React, for any
  framework. `<Timeline>` and `<AudioPlayer>` are now built on it. `TimelineCore`
  and `mountTimeline` are in `./advanced` for interfaces with their own clock.
- `vocoderStretcher({ memory: 'auto' | 'fast' | 'lean' })`. 'lean' renders a
  speed frame by frame: the same samples, bit for bit, in about 1/30 of the
  memory (10 min mono: +78 MB instead of +2.3 GB) for 5–10% more time. 'auto',
  the default, uses it for clips longer than 15 s.
- Stretch strategies can carry `options`, handed to their worker with every
  request.
- `emptyText` of `<AudioPlayer>` and `<Timeline>` is a string.
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
