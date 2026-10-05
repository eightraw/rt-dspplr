#!/usr/bin/env bash
# Optional: realistic speech material for the long-audio experiment, made with
# espeak-ng + ffmpeg in the demo's sample toolbox image (scripts/samples/Dockerfile).
#   bash scripts/long/make-speech-docker.sh <outDir> [minutes=30] [image=rtd-samples:local]
# Writes speech-<N>min-espeak-48k-mono.wav (16-bit) and a 30 s FLAC/MP3/Opus set
# for decoder-hook and segment-codec experiments. Network-less container.
# Also writes its "server-processed" stem B: stems/speech-<N>min-espeak-48k-mono.b.wav,
# the clean speech before the noise was added, 37 ms late, 16 kHz mono (what a
# speech enhancer hands back). STEM_ONLY=1 writes only that (the noise is random,
# so the main file is kept as it is).
set -euo pipefail
OUT="${1:?outDir}"
MIN="${2:-30}"
IMAGE="${3:-rtd-samples:local}"
mkdir -p "$OUT"
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    docker build -t "$IMAGE" "$(dirname "$0")/../samples"
fi
ABS="$(cd "$OUT" && pwd -W 2>/dev/null || pwd)"
MSYS_NO_PATHCONV=1 docker run --rm --network none -e STEM_ONLY="${STEM_ONLY:-}" -v "$ABS:/out" "$IMAGE" sh -euc '
cd /tmp
cat > lines.txt <<TXT
en-us|160|40|Welcome back to the show. Today we talk about bread, starting with flour and water.
en-gb|150|55|Mix the dough for ten minutes, then let it rest in a warm place for about an hour.
ru|155|45|Добрый вечер. Сегодня поговорим о том, как устроены облака и почему идёт дождь.
en-us|175|35|The museum opens at nine, and the guided tour of the east wing starts at half past ten.
ru|140|60|Возьмите две ложки сахара, щепотку соли и немного тёплого молока.
en-gb-x-rp|165|50|In the second chapter, the author returns to the village where she grew up.
ru|170|40|Завтра будет солнечно, ветер слабый, к вечеру температура поднимется до двадцати градусов.
en-us|150|65|Thanks for listening. If you enjoyed this episode, tell a friend about it.
ru|150|50|Следующая остановка — городская библиотека. Не забывайте свои вещи.
en-gb|180|45|The recipe works with any kind of berries, fresh or frozen, so use what you have.
ru|160|55|На этом лекция окончена. Вопросы можно задать после перерыва.
en-us|155|40|Our next guest has spent twenty years building small wooden boats by hand.
TXT
i=0
: > list.txt
while IFS="|" read -r voice speed pitch text; do
  espeak-ng -v "$voice" -s "$speed" -p "$pitch" -w "s$i.wav" "$text" </dev/null
  gap=$(awk -v s=$i "BEGIN{srand(s+7); printf \"%.2f\", 0.3+rand()*2.2}")
  ffmpeg -nostdin -loglevel error -y -f lavfi -i anullsrc=r=22050:cl=mono -t "$gap" "g$i.wav"
  echo "file s$i.wav" >> list.txt; echo "file g$i.wav" >> list.txt
  i=$((i+1))
done < lines.txt
ffmpeg -loglevel error -y -f concat -safe 0 -i list.txt -ar 48000 -ac 1 base.wav
SECS=$(( '"$MIN"' * 60 ))
mkdir -p /out/stems
ffmpeg -loglevel error -y -stream_loop -1 -i base.wav   -af "highpass=f=60,volume=0.9,adelay=37,aresample=16000"   -t "$SECS" -ar 16000 -ac 1 -c:a pcm_s16le "/out/stems/speech-'"$MIN"'min-espeak-48k-mono.b.wav"
if [ -n "$STEM_ONLY" ]; then ls -l /out/stems; exit 0; fi
ffmpeg -loglevel error -y -stream_loop -1 -i base.wav -f lavfi -i "anoisesrc=color=pink:amplitude=0.006:r=48000" \
  -filter_complex "[0:a]highpass=f=60,volume=0.9[v];[v][1:a]amix=inputs=2:duration=first:normalize=0" \
  -t "$SECS" -ar 48000 -ac 1 -c:a pcm_s16le "/out/speech-'"$MIN"'min-espeak-48k-mono.wav"
mkdir -p /out/codecs
ffmpeg -loglevel error -y -i "/out/speech-'"$MIN"'min-espeak-48k-mono.wav" -t 30 /out/codecs/sample30.wav
ffmpeg -loglevel error -y -i /out/codecs/sample30.wav -c:a flac /out/codecs/sample30.flac
ffmpeg -loglevel error -y -i /out/codecs/sample30.wav -c:a libmp3lame -b:a 64k /out/codecs/sample30.mp3
ffmpeg -loglevel error -y -i /out/codecs/sample30.wav -c:a libopus -b:a 32k /out/codecs/sample30.opus
ls -l /out /out/codecs
'
