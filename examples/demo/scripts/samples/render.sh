#!/bin/sh
# Runs inside the container (see make-samples.sh). Synthesises short neutral
# phrases with espeak-ng and writes, per phrase:
#   <name>.b.wav         stem B: the clean synthesis, to mix against the degraded clip
#   <name>.<wav|ogg>     processed example version: 300-3400 Hz band,
#                        hiss, hard clipping, mono 16 kHz
#   <name>.json          sidecar metadata (label, timestamp, language, text)
# The B file is the clean synthesis before the degradation.
set -eu

OUT=/out
TMP=$(mktemp -d)
NOW=$(date -u +%s)
PAD=0.35

# name|voice|ext|minutes_ago|label|b(1/0)|text
cat > "$TMP/phrases.txt" <<'LIST'
weather-en|en-us|wav|42|Weather (US English)|1|Weather for tomorrow. Cloudy in the morning, light showers after noon, wind from the north west at five meters per second. High of twelve degrees.
counting-en|en-us|ogg|35|Counting (US English)|1|One, two, three, four, five, six, seven, eight, nine, ten. Sound check complete.
tongue-twister-en|en-us|wav|27|Tongue twister (US English)|1|She sells sea shells by the sea shore. The shells she sells are surely sea shells.
weather-gb|en-gb|ogg|19|Weather (UK English)|1|Tomorrow will be cloudy, with light rain in the afternoon. A north westerly wind at five metres per second. Highs of twelve degrees.
countdown-gb|en-gb|wav|11|Countdown (UK English)|1|Ten, nine, eight, seven, six, five, four, three, two, one. Level check finished.
pangram-gb|en-gb|wav|4|Pangram (UK English), no stem B|0|The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs.
LIST

while IFS='|' read -r name voice ext ago label has_b text; do
    [ -n "$name" ] || continue
    echo "  $name ($voice) -> $name.$ext"

    espeak-ng -v "$voice" -s 150 -p 45 -w "$TMP/$name.raw.wav" "$text"

    # Clean reference: mono 16 kHz, a little silence on both sides so the
    # degraded version (with hiss there) stays sample-aligned with it.
    ffmpeg -nostdin -loglevel error -y -i "$TMP/$name.raw.wav" \
        -af "aresample=16000,adelay=${PAD}s:all=1,apad=pad_dur=${PAD},volume=0.9" \
        -ac 1 -ar 16000 -c:a pcm_s16le "$TMP/$name.clean.wav"

    # Processed example: band-pass 300-3400 Hz (2 poles each side twice), drive into
    # a hard clipper, band-limited hiss under everything.
    ffmpeg -nostdin -loglevel error -y \
        -i "$TMP/$name.clean.wav" \
        -f lavfi -i "anoisesrc=color=white:amplitude=0.05:sample_rate=16000:seed=7" \
        -filter_complex "\
[0:a]highpass=f=300,highpass=f=300,lowpass=f=3400,lowpass=f=3400,volume=2.6,asoftclip=type=hard:threshold=0.55[v];\
[1:a]highpass=f=300,lowpass=f=3400,volume=0.9[n];\
[v][n]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.97:level=disabled" \
        -ac 1 -ar 16000 "$TMP/$name.processed.wav"

    if [ "$ext" = "ogg" ]; then
        ffmpeg -nostdin -loglevel error -y -i "$TMP/$name.processed.wav" -c:a libopus -b:a 24k "$OUT/$name.ogg"
    else
        cp "$TMP/$name.processed.wav" "$OUT/$name.wav"
    fi

    if [ "$has_b" = "1" ]; then
        cp "$TMP/$name.clean.wav" "$OUT/$name.b.wav"
    else
        rm -f "$OUT/$name.b.wav"
    fi

    recorded=$(date -u -d "@$((NOW - ago * 60))" +%Y-%m-%dT%H:%M:%SZ)
    cat > "$OUT/$name.json" <<JSON
{
  "label": "$label",
  "recorded_at": "$recorded",
  "language": "$voice",
  "source": "synthetic: espeak-ng + ffmpeg (scripts/make-samples.sh)",
  "text": "$text"
}
JSON
done < "$TMP/phrases.txt"

rm -rf "$TMP"
