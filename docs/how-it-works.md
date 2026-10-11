# How it works

RT-DSPPLR plays a recording, and versions of it, in a web page. A short file is simply fetched
and decoded whole. A long one (minutes to hours) is **prepared once on a server**, and the
browser then fetches only what it plays. This page walks through both halves.

```
 ON THE SERVER, once per recording           rtd-prepare / prepareAudio() (Node)
 ────────────────────────────────────────────────────────────────────────────────
  the recording (A) + versions of it (stems)
      │  WAV, MP3, FLAC, Ogg Opus: built-in WebAssembly decoders; anything else: ffmpeg
      ▼
  1. decode, block by block, and analyse on a pool of threads
       waveform for every zoom level ........................... peaks.bin
       low-frequency energy, for the high-pass preview ........... bands.bin
       spectrogram overview ................................. spectrogram.bin
       loudness, a content id
     each stem: decoded, aligned to A (its offset measured; refused if it does
     not line up), its own peaks, bands and spectrogram
      ▼
  2. index the original file (it is kept as it is)
       a grid of segments of about 192 KB each (1 to 10 s); for each segment:
         the bytes of the file to fetch (a "run", warm-up included), how many
         decoded samples belong to it (tail) and come before it (skip)
       entry points inside the segments, about every 0.5 s ...... entries.bin
      ▼
  3. check: segments are decoded the way the player will (whole, in pieces as
     if arriving, from entry points) and compared sample for sample; anything
     that does not match is left out, or the source is written as a 16-bit WAV
      ▼
  4. publish: manifest.json (13 to 17 KB for 30 minutes) + the .bin files
     + the original file
 ═══════════════════════════ plain HTTP, Range requests ═════════════════════════
 IN THE BROWSER                                          @saitdigital/rt-dspplr
 ────────────────────────────────────────────────────────────────────────────────
  player.play({ manifest })
   1. manifest.json; the codec's decoder (WebAssembly) starts loading at once
   2. the first picture: the coarsest waveform and spectrograms (A's and the
      stem's), a few KB in one go: the whole timeline is on screen
   3. the segment under the playhead, first and alone, by Range request:
        WAV                 its samples as the bytes arrive
        MP3, FLAC, Opus     decoded in a worker frame by frame as they arrive
      the engine starts as soon as half a second is in
   4. a seek fetches from the playhead, not from its segment's start:
        WAV                 from that very frame
        MP3, FLAC, Opus     from the entry point just before it (entries.bin)
      the engine plays the segment from there; the whole segment follows
      behind and takes its place (the same samples)
   5. in the background, giving way whenever the playhead waits for something
      and picking up from the byte where they stopped: the next 20 s, the
      stem's segment at the playhead, finer pictures, entries.bin, the decoded
      close-up of a zoomed-in view
      │
      ▼
  ┌─ the engine: one AudioWorklet ─────────────────────────────────────────────┐
  │  A and the stem read at the same sample → the slider's mix                 │
  │  speed ≠ 1×: each track split into its tonal part (Signalsmith Stretch)    │
  │              and its noise and attacks (a short overlap-add)               │
  │  converted to the sound card's sample rate                                 │
  └────────────────────────────────────────────────────────────────────────────┘
      ▼
  effects: input gain → high-pass → compressor → your plugins → output gain
           → ceiling (−0.01 dBFS)
      ▼
  speakers

  On screen: the waveform (peaks, with the effects drawn in) and the
  spectrogram (the overview, sharpened from decoded audio when zoomed in), both
  showing the mix as you hear it. About 60 s of decoded audio is kept in memory.
```

## On the server

**Nothing is converted.** WAV, MP3, FLAC and Ogg Opus files are kept byte for byte; the player
fetches parts of the original. Only a format the browser-side decoders do not read (AAC, say) is
written once as a 16-bit WAV.

**The index.** The timeline is cut into segments of about 192 KB of the file each (at least 1 s,
2 s for MP3 and 3 s for Opus, at most 10 s; `--segment` sets another length). For each, the manifest says which bytes of the file to fetch. Compressed formats
need a little before the segment's first sample to decode it correctly — the *warm-up*:

| Format | Where a run may start | Warm-up |
|---|---|---|
| WAV | any frame | none |
| FLAC | any FLAC frame (about 0.1 s) | none: every frame decodes on its own |
| MP3 | any MP3 frame (26 ms) | a few frames, as far back as the bit reservoir reaches (6 to 54 frames) |
| Ogg Opus | any Ogg page | 0.5 s of pre-roll, after which the decoder gives the continuous decode's samples |

`skip` (samples of warm-up before the segment's first) and `tail` (samples from it to the end of
the run) let the player place samples while the run is still arriving. **Entry points**
(`entries.bin`) are the same thing inside a segment, every half second, so a seek does not have
to fetch the segment from its start.

**Versions (stems).** A stem is any recording that lines up with the original in time: a
denoised take, an isolated vocal, the two parts of a separation. Prepare measures its offset
against A by cross-correlation and refuses one that does not line up. Stems sit on A's grid, so
the player reads A and a stem from the same sample.

**Checked before it is published.** Prepare decodes some segments the way the player will —
whole, in pieces as if arriving over the network, and from entry points — and compares them with
what it analysed. MP3 and FLAC must match exactly, Opus within float rounding. If they do not,
the part that failed is left out (the player then decodes such segments whole, or fetches from
segment starts), or the source is written as a WAV.

**The manifest** holds each segment list as columns of numbers, not one object per segment, and
no white space: 13 to 17 KB for 30 minutes with a stem, which is what the player fetches before
anything plays. Its format is specified in [manifest.md](manifest.md).

## In the browser

**Order of loading.** Audio comes first. The manifest, then the coarsest pictures (a few KB, all
at once), then the segment under the playhead. Everything else — the next segments, finer
pictures, the stem, entries — is fetched behind it: whenever the playhead waits for something,
those fetches let go of the connection and later ask for the rest from the byte they had
reached, so nothing is downloaded twice.

**Playing while downloading.** A WAV's samples are usable as soon as their bytes arrive. MP3,
FLAC and Opus are decoded in a worker as their bytes arrive (MP3 frame by frame, Opus packet by
packet, FLAC frame by frame with its largest frame kept ahead). The engine plays as far as the
samples reach and starts once half a second is in.

**Seeking.** A seek into a segment that is not in yet fetches from the playhead: a WAV from that
frame, MP3, FLAC and Opus from the entry point just before it. The engine plays the segment from
there, and the whole segment arrives behind it and takes its place. If the jump lands near a
segment's end, the next segment is fetched at once too.

**Versions under one slider.** The original and a stem are read at the same sample index in one
AudioWorklet, so moving the slider never puts them out of step, and changing the stem keeps the
playhead. The stem's segment at the playhead is fetched ahead, so the first move of the slider
plays at once.

**Speed.** At other speeds each track is split, as it plays, into its tonal part and its noise
and attacks. Signalsmith Stretch stretches the tonal part, a short overlap-add the rest: held
notes stay smooth and drum hits do not double.

**If something goes wrong.** A run that does not decode as expected is decoded again whole, and
the engine gets the right samples in place of the ones it had. A segment that fails to download
is retried with growing pauses. A server that ignores Range requests is read whole once (up to
64 MB). The playhead waits rather than skipping when the network falls behind.

## What it costs

Measured with 30-minute recordings and a stem, over a connection held to the speed shown with
80 ms of latency, in Chromium on a desktop:

| | 2 Mbit/s | 10 Mbit/s |
|---|---|---|
| from `play()` to sound | 0.35 to 0.52 s | 0.24 to 0.26 s |
| a seek, anywhere | 0.11 to 0.18 s | 0.10 to 0.11 s |
| the slider to the stem right after a seek | 0.06 to 0.25 s | 0.05 to 0.06 s |
| manifest | 13 to 17 KB | |
| browser memory for an hour | about 360 MB (decoded whole: 2.8 GB) | |
| prepare | an hour of MP3 in about 23 s on two cores | |

## Short files

A clip without preparation (`play({ src })`) is fetched and decoded whole, then plays through
the same engine, with the same speed, mix and effects. That is instant for a voice note and
heavy for an hour (3.9 s and 2.8 GB of memory): prepare long recordings.
