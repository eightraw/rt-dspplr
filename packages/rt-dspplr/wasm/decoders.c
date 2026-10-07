// ---------------------------------------------------------------------------
// FLAC, MP3 and Opus decoding, compiled to WebAssembly by
// build/build-decoders.mjs: dr_flac and dr_mp3 (David Reid; public domain or
// MIT-0), libopus, libogg and opusfile (Xiph.Org; BSD-3-Clause). See
// THIRD_PARTY_NOTICES.md.
//
// prepare's module has all of it; the player's modules one codec each
// (-DRTD_NO_FLAC, -DRTD_NO_MP3, -DRTD_NO_OPUSFILE, -DRTD_NO_OPUS).
//
// One instance decodes one stream. JS appends the source's bytes as they come
// (rtd_in_reserve + rtd_in_commit, rtd_in_end at the end) and keeps enough of
// them ahead of the decoder that it never runs dry mid-frame: the decoders
// pull their input and cannot wait for more. Should a read still find
// too little, the stream is reported broken (RTD_STARVED), never cut short.
// A run of an MP3 (frames from the middle) and a run of a FLAC (its header,
// then frames) go through the same calls. Opus runs are decoded packet by
// packet (rtd_opus_raw_*: JS takes the packets out of the Ogg pages).
// ---------------------------------------------------------------------------

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#ifndef RTD_NO_FLAC
// wasm32 has 64-bit integer ops: the 64-bit bit cache reads the stream about twice as fast.
#define DRFLAC_64BIT
#define DR_FLAC_IMPLEMENTATION
#define DR_FLAC_NO_STDIO
#define DR_FLAC_NO_OGG
#define DR_FLAC_NO_CRC
#include "dr_flac.h"
#endif

#ifndef RTD_NO_MP3
#define DR_MP3_IMPLEMENTATION
#define DR_MP3_NO_STDIO
#include "dr_mp3.h"
#endif

#if !defined(RTD_NO_OPUS) && !defined(RTD_NO_OPUSFILE)
#include <opusfile.h>
#endif
#ifndef RTD_NO_OPUS
#include <opus.h>
#endif

#define EXPORT(name) __attribute__((export_name(#name)))

enum { RTD_FLAC = 1, RTD_MP3 = 2, RTD_OPUS = 3 };
enum { RTD_END = 0, RTD_ERROR = -1, RTD_STARVED = -2 };

static struct {
    uint8_t* buf;     // the bytes not yet dropped
    size_t cap;
    size_t len;       // bytes in buf
    size_t pos;       // the decoder's cursor in buf
    uint64_t dropped; // bytes dropped before buf[0]
    int ended;        // no more bytes will come
    int starved;      // a read wanted bytes that had not come yet
    int kind;
#ifndef RTD_NO_FLAC
    drflac* flac;
#endif
#ifndef RTD_NO_MP3
    drmp3 mp3;
#endif
#if !defined(RTD_NO_OPUS) && !defined(RTD_NO_OPUSFILE)
    OggOpusFile* opus;
#endif
    int channels;
    int rate;
    int bits;
    float* interleaved;
    float* planes;
    size_t blockFrames;
} s;

EXPORT(rtd_in_reserve) uint8_t* rtd_in_reserve(size_t n) {
    // Drop what the decoder has read, once it is most of the buffer, so it never grows past
    // what is ahead of the decoder plus one chunk.
    if (s.pos > 0 && s.pos >= s.len / 2) {
        memmove(s.buf, s.buf + s.pos, s.len - s.pos);
        s.dropped += s.pos;
        s.len -= s.pos;
        s.pos = 0;
    }
    if (s.len + n > s.cap) {
        size_t cap = s.cap ? s.cap : 1 << 20;
        while (cap < s.len + n) cap *= 2;
        uint8_t* buf = (uint8_t*)realloc(s.buf, cap);
        if (!buf) return 0;
        s.buf = buf;
        s.cap = cap;
    }
    return s.buf + s.len;
}
EXPORT(rtd_in_commit) void rtd_in_commit(size_t n) { s.len += n; }
EXPORT(rtd_in_end) void rtd_in_end(void) { s.ended = 1; }
/** Bytes the decoder has not read yet. */
EXPORT(rtd_in_ahead) double rtd_in_ahead(void) { return (double)(s.len - s.pos); }

static size_t on_read(void* user, void* out, size_t n) {
    (void)user;
    size_t have = s.len - s.pos;
    if (n > have) {
        if (!s.ended) s.starved = 1;
        n = have;
    }
    memcpy(out, s.buf + s.pos, n);
    s.pos += n;
    return n;
}

/** Seeks within the bytes still held; anything else fails (also SEEK_END: the end has not come). */
static int on_seek(int offset, int origin) {
    int64_t to;
    if (origin == 0) to = (int64_t)offset - (int64_t)s.dropped;
    else if (origin == 1) to = (int64_t)s.pos + offset;
    else return 0;
    if (to < 0) return 0;
    if ((uint64_t)to > s.len) {
        if (!s.ended) s.starved = 1;
        return 0;
    }
    s.pos = (size_t)to;
    return 1;
}
#ifndef RTD_NO_FLAC
static drflac_bool32 flac_seek(void* user, int offset, drflac_seek_origin origin) { (void)user; return on_seek(offset, origin == DRFLAC_SEEK_SET ? 0 : origin == DRFLAC_SEEK_CUR ? 1 : 2); }
static drflac_bool32 flac_tell(void* user, drflac_int64* cursor) { (void)user; *cursor = (drflac_int64)(s.dropped + s.pos); return 1; }
#endif
#ifndef RTD_NO_MP3
static drmp3_bool32 mp3_seek(void* user, int offset, drmp3_seek_origin origin) { (void)user; return on_seek(offset, origin == DRMP3_SEEK_SET ? 0 : origin == DRMP3_SEEK_CUR ? 1 : 2); }
static drmp3_bool32 mp3_tell(void* user, drmp3_int64* cursor) { (void)user; *cursor = (drmp3_int64)(s.dropped + s.pos); return 1; }
#endif
#if !defined(RTD_NO_OPUS) && !defined(RTD_NO_OPUSFILE)
static int opus_read(void* stream, unsigned char* out, int n) { return (int)on_read(stream, out, (size_t)n); }
// No seek or tell: opusfile reads the stream once, front to back (and trims the end by the last granule position).
static const OpusFileCallbacks opus_callbacks = { opus_read, 0, 0, 0 };
#endif

/**
 * Opens the stream as `kind` (RTD_FLAC, RTD_MP3 or RTD_OPUS) once its header is in; returns 0,
 * RTD_ERROR (not that format, not built in, or broken) or RTD_STARVED. The format is in
 * rtd_channels/rtd_rate/rtd_bits.
 */
EXPORT(rtd_open) int rtd_open(int kind, int blockFrames) {
    s.kind = kind;
    if (0) {
#ifndef RTD_NO_FLAC
    } else if (kind == RTD_FLAC) {
        s.flac = drflac_open(on_read, flac_seek, flac_tell, 0, 0);
        if (s.starved) return RTD_STARVED;
        if (!s.flac) return RTD_ERROR;
        s.channels = s.flac->channels;
        s.rate = (int)s.flac->sampleRate;
        s.bits = s.flac->bitsPerSample;
#endif
#ifndef RTD_NO_MP3
    } else if (kind == RTD_MP3) {
        int ok = drmp3_init(&s.mp3, on_read, mp3_seek, mp3_tell, 0, 0, 0);
        if (s.starved) return RTD_STARVED;
        if (!ok) return RTD_ERROR;
        s.channels = (int)s.mp3.channels;
        s.rate = (int)s.mp3.sampleRate;
        s.bits = 0;
#endif
#if !defined(RTD_NO_OPUS) && !defined(RTD_NO_OPUSFILE)
    } else if (kind == RTD_OPUS) {
        int error = 0;
        s.opus = op_open_callbacks(&s, &opus_callbacks, 0, 0, &error);
        if (s.starved) return RTD_STARVED;
        if (!s.opus) return RTD_ERROR;
        s.channels = op_channel_count(s.opus, -1);
        s.rate = 48000;
        s.bits = 0;
#endif
    } else {
        return RTD_ERROR;
    }
    if (s.channels <= 0 || s.rate <= 0) return RTD_ERROR;
    s.blockFrames = (size_t)blockFrames;
    s.interleaved = (float*)malloc(s.blockFrames * s.channels * sizeof(float));
    s.planes = (float*)malloc(s.blockFrames * s.channels * sizeof(float));
    return s.interleaved && s.planes ? 0 : RTD_ERROR;
}
EXPORT(rtd_channels) int rtd_channels(void) { return s.channels; }
EXPORT(rtd_rate) int rtd_rate(void) { return s.rate; }
EXPORT(rtd_bits) int rtd_bits(void) { return s.bits; }
/** Frames in the stream when the header says (FLAC's STREAMINFO), else −1. */
EXPORT(rtd_total_frames) double rtd_total_frames(void) {
#ifndef RTD_NO_FLAC
    if (s.kind == RTD_FLAC && s.flac->totalPCMFrameCount > 0) return (double)s.flac->totalPCMFrameCount;
#endif
    return -1;
}
/** An MP3's decoder delay (LAME header): the raw decode's samples before the stream's first. 0 without the header. */
EXPORT(rtd_mp3_delay) int rtd_mp3_delay(void) {
#ifndef RTD_NO_MP3
    if (s.kind == RTD_MP3) return (int)s.mp3.delayInPCMFrames;
#endif
    return 0;
}

#if !defined(RTD_NO_OPUS) && !defined(RTD_NO_OPUSFILE)
/** Up to s.blockFrames frames of Opus into s.interleaved; −1 on a hole or an error, −2 when the channel count changes. */
static int64_t opus_frames(void) {
    size_t got = 0;
    while (got < s.blockFrames) {
        int link = -1;
        int n = op_read_float(s.opus, s.interleaved + got * s.channels, (int)((s.blockFrames - got) * s.channels), &link);
        if (n == 0) break;
        if (n < 0) return -1;
        if (op_channel_count(s.opus, link) != s.channels) return -2;
        got += (size_t)n;
    }
    return (int64_t)got;
}
#endif

/**
 * Decodes up to one block into rtd_planes() (channel c at c × blockFrames); returns the frames,
 * RTD_END at the end of the stream, RTD_ERROR or RTD_STARVED.
 */
EXPORT(rtd_read) int rtd_read(void) {
    uint64_t got = 0;
    if (0) {
#if !defined(RTD_NO_OPUS) && !defined(RTD_NO_OPUSFILE)
    } else if (s.kind == RTD_OPUS) {
        int64_t n = opus_frames();
        if (s.starved) return RTD_STARVED;
        if (n < 0) return RTD_ERROR;
        got = (uint64_t)n;
#endif
#ifndef RTD_NO_FLAC
    } else if (s.kind == RTD_FLAC) {
        got = drflac_read_pcm_frames_f32(s.flac, s.blockFrames, s.interleaved);
        if (s.starved) return RTD_STARVED;
        // dr_flac stops early on a broken frame; the stream's own count tells the two apart.
        if (got == 0 && s.flac->totalPCMFrameCount > 0 && s.flac->currentPCMFrame < s.flac->totalPCMFrameCount) return RTD_ERROR;
#endif
#ifndef RTD_NO_MP3
    } else if (s.kind == RTD_MP3) {
        got = drmp3_read_pcm_frames_f32(&s.mp3, s.blockFrames, s.interleaved);
        if (s.starved) return RTD_STARVED;
#endif
    } else {
        return RTD_ERROR;
    }
    if (got == 0) return RTD_END;
    const int C = s.channels;
    const size_t B = s.blockFrames;
    for (int c = 0; c < C; c += 1) {
        float* dst = s.planes + (size_t)c * B;
        const float* src = s.interleaved + c;
        for (uint64_t i = 0; i < got; i += 1) dst[i] = src[i * C];
    }
    return (int)got;
}
EXPORT(rtd_planes) float* rtd_planes(void) { return s.planes; }

#ifndef RTD_NO_OPUS
// ---- Opus packets (a run of an Ogg Opus file: JS takes the packets out of its pages) ---------

static struct {
    OpusDecoder* decoder;
    int channels;
    uint8_t* packet;
    int packetCap;
    float* pcm; // interleaved, up to 120 ms at 48 kHz
} o;

/** A decoder for `channels` (1 or 2) at 48 kHz with the header's output gain (Q7.8 dB, as opusfile applies it). */
EXPORT(rtd_opus_raw_open) int rtd_opus_raw_open(int channels, int gainQ8) {
    int error = 0;
    o.decoder = opus_decoder_create(48000, channels, &error);
    if (error != OPUS_OK || !o.decoder) return RTD_ERROR;
    if (gainQ8 != 0 && opus_decoder_ctl(o.decoder, OPUS_SET_GAIN(gainQ8)) != OPUS_OK) return RTD_ERROR;
    o.channels = channels;
    o.pcm = (float*)malloc(5760 * (size_t)channels * sizeof(float));
    return o.pcm ? 0 : RTD_ERROR;
}
/** Room for a packet of `n` bytes; JS writes it there and calls rtd_opus_raw_decode(n). */
EXPORT(rtd_opus_raw_packet) uint8_t* rtd_opus_raw_packet(int n) {
    if (n > o.packetCap) {
        uint8_t* p = (uint8_t*)realloc(o.packet, (size_t)n);
        if (!p) return 0;
        o.packet = p;
        o.packetCap = n;
    }
    return o.packet;
}
/** Decodes the packet into rtd_opus_raw_pcm() (interleaved); returns its frames, or RTD_ERROR. */
EXPORT(rtd_opus_raw_decode) int rtd_opus_raw_decode(int n) {
    int got = opus_decode_float(o.decoder, o.packet, n, o.pcm, 5760, 0);
    return got < 0 ? RTD_ERROR : got;
}
EXPORT(rtd_opus_raw_pcm) float* rtd_opus_raw_pcm(void) { return o.pcm; }
#endif
