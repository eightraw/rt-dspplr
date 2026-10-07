// The tonal/atonal split of the stream engine's realtime stretch, compiled to WebAssembly
// by build/build-split.mjs (zig 0.13). The engine (core/engine/splitSource.ts) keeps the
// frames in a ring and asks for spectra before grains:
//
//   spectrum(f)  the frame in `in` (channel-major, SIZE frames each, the source's frames
//                [f·HOP − SIZE, f·HOP)) → its spectra (sqrt-Hann window) in ring slot f
//   grain(f)     the masks from the median over time (frames f − HT … f + HT, slid when f
//                follows the last one) and over frequency (2·HF + 1 bins) of the mono
//                magnitude, H²/(H² + P²) for the tonal part and the rest for the atonal one,
//                the same for every channel; both parts back in time, windowed → `tonal`,
//                `atonal` (two sqrt-Hann windows at half overlap sum to one)
//
// Median filtering after Fitzgerald (2010), its use for time-scale modification after
// Driedger, Müller & Ewert (2014).
#include <math.h>
#include <stdint.h>

#define EXPORT(name) __attribute__((export_name(#name)))
#define SIZE 2048
#define BINS (SIZE / 2 + 1)
#define RING 40
#define MAXCH 2
#define MAXT 17
#define MAXF 8

static int HOP = 1024, HT = 4, HF = 8, CH = 2;
static float in_buf[MAXCH * SIZE];
static float out_tonal[MAXCH * SIZE];
static float out_atonal[MAXCH * SIZE];
static double win[SIZE];
static double cos_t[SIZE / 2], sin_t[SIZE / 2];
static uint32_t rev[SIZE];
static double spec_re[RING][MAXCH][BINS], spec_im[RING][MAXCH][BINS], spec_mag[RING][BINS];
static double zr[SIZE], zi[SIZE];
static double tsorted[BINS * MAXT];
static int tlen = 0, tframe = -1000000;
static double tmed[BINS], mask_[BINS], fsorted[2 * MAXF + 2];

EXPORT(split_in) float* split_in(void) { return in_buf; }
EXPORT(split_tonal) float* split_tonal(void) { return out_tonal; }
EXPORT(split_atonal) float* split_atonal(void) { return out_atonal; }

/** hop: SIZE/2 (sqrt-Hann at half overlap); ht: half the time median, frames; channels: 1 or 2. */
EXPORT(split_init) void split_init(int hop, int ht, int channels) {
    HOP = hop; HT = ht < (MAXT - 1) / 2 ? ht : (MAXT - 1) / 2; CH = channels < MAXCH ? channels : MAXCH;
    tlen = 0; tframe = -1000000;
    for (int i = 0; i < SIZE; i++) {
        uint32_t r = 0;
        for (int b = 0; b < 11; b++) r |= ((i >> b) & 1u) << (10 - b);
        rev[i] = r;
        win[i] = sqrt(0.5 - 0.5 * cos((2 * M_PI * i) / SIZE));
    }
    for (int k = 0; k < SIZE / 2; k++) { cos_t[k] = cos((-2 * M_PI * k) / SIZE); sin_t[k] = sin((-2 * M_PI * k) / SIZE); }
}

/** Forget the time median's sliding state (the next grain rebuilds it). */
EXPORT(split_reset) void split_reset(void) { tlen = 0; tframe = -1000000; }

static void fft(double* re, double* im) {
    for (int i = 0; i < SIZE; i++) {
        int j = (int)rev[i];
        if (i < j) { double t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (int len = 2; len <= SIZE; len <<= 1) {
        int half = len >> 1, step = SIZE / len;
        for (int i = 0; i < SIZE; i += len) {
            for (int k = 0, w = 0; k < half; k++, w += step) {
                int a = i + k, b = a + half;
                double wr = cos_t[w], wi = sin_t[w];
                double xr = re[b] * wr - im[b] * wi;
                double xi = re[b] * wi + im[b] * wr;
                re[b] = re[a] - xr; im[b] = im[a] - xi;
                re[a] += xr; im[a] += xi;
            }
        }
    }
}

static int slot_of(int f) { return ((f % RING) + RING) % RING; }

EXPORT(split_spectrum) void split_spectrum(int f) {
    int slot = slot_of(f);
    double* mag = spec_mag[slot];
    for (int b = 0; b < BINS; b++) mag[b] = 0;
    // Two real channels in one complex FFT (x + i·y), parted by symmetry.
    const float* x = in_buf;
    const float* y = CH > 1 ? in_buf + SIZE : 0;
    for (int k = 0; k < SIZE; k++) { zr[k] = x[k] * win[k]; zi[k] = y ? y[k] * win[k] : 0; }
    fft(zr, zi);
    double* xr = spec_re[slot][0];
    double* xi = spec_im[slot][0];
    if (!y) {
        for (int b = 0; b < BINS; b++) { xr[b] = zr[b]; xi[b] = zi[b]; mag[b] = hypot(xr[b], xi[b]); }
        return;
    }
    double* yr = spec_re[slot][1];
    double* yi = spec_im[slot][1];
    for (int b = 0; b < BINS; b++) {
        int m = (SIZE - b) & (SIZE - 1);
        xr[b] = (zr[b] + zr[m]) * 0.5; xi[b] = (zi[b] - zi[m]) * 0.5;
        yr[b] = (zi[b] + zi[m]) * 0.5; yi[b] = (zr[m] - zr[b]) * 0.5;
        mag[b] = (hypot(xr[b], xi[b]) + hypot(yr[b], yi[b])) * 0.5;
    }
}

static void insert(double* s, int* n, double v) {
    int i = *n;
    while (i > 0 && s[i - 1] > v) { s[i] = s[i - 1]; i--; }
    s[i] = v;
    (*n)++;
}

static void remove_value(double* s, int* n, double v) {
    int i = 0;
    while (i < *n - 1 && s[i] != v) i++;
    for (; i < *n - 1; i++) s[i] = s[i + 1];
    (*n)--;
}

static void time_medians(int f) {
    if (f == tframe + 1 && tlen > 0) {
        const double* incoming = spec_mag[slot_of(f + HT)];
        const double* outgoing = f - HT - 1 >= 0 ? spec_mag[slot_of(f - HT - 1)] : 0;
        for (int bin = 0; bin < BINS; bin++) {
            double* s = tsorted + bin * MAXT;
            int n = tlen;
            if (outgoing) remove_value(s, &n, outgoing[bin]);
            insert(s, &n, incoming[bin]);
        }
        if (!outgoing) tlen++;
    } else {
        int count = 0;
        for (int d = -HT; d <= HT; d++) {
            if (f + d < 0) continue;
            const double* m = spec_mag[slot_of(f + d)];
            for (int bin = 0; bin < BINS; bin++) {
                int n = count;
                insert(tsorted + bin * MAXT, &n, m[bin]);
            }
            count++;
        }
        tlen = count;
    }
    tframe = f;
    int half = tlen >> 1;
    for (int bin = 0; bin < BINS; bin++) tmed[bin] = tsorted[bin * MAXT + half];
}

EXPORT(split_grain) void split_grain(int f) {
    int slot = slot_of(f);
    const double* here = spec_mag[slot];
    time_medians(f);
    int len = 0;
    for (int q = 0; q <= HF; q++) insert(fsorted, &len, here[q]);
    for (int bin = 0; bin < BINS; bin++) {
        if (bin > 0) {
            if (bin + HF < BINS) insert(fsorted, &len, here[bin + HF]);
            if (bin - HF - 1 >= 0) remove_value(fsorted, &len, here[bin - HF - 1]);
        }
        double P = fsorted[len >> 1], H = tmed[bin];
        double h2 = H * H, p2 = P * P;
        mask_[bin] = h2 + p2 > 1e-20 ? h2 / (h2 + p2) : 0.5;
    }
    for (int c = 0; c < CH; c++) {
        const double* xr = spec_re[slot][c];
        const double* xi = spec_im[slot][c];
        // W = T + i·A over the whole spectrum (T, A Hermitian), conjugated for the inverse.
        for (int b = 0; b < BINS; b++) {
            double mt = mask_[b];
            double tr = xr[b] * mt, ti = xi[b] * mt;
            double ar = xr[b] - tr, ai = xi[b] - ti;
            zr[b] = tr - ai; zi[b] = -(ti + ar);
            if (b > 0 && b < BINS - 1) { zr[SIZE - b] = tr + ai; zi[SIZE - b] = ti - ar; }
        }
        fft(zr, zi);
        float* t = out_tonal + c * SIZE;
        float* a = out_atonal + c * SIZE;
        for (int k = 0; k < SIZE; k++) { t[k] = (float)((zr[k] / SIZE) * win[k]); a[k] = (float)((-zi[k] / SIZE) * win[k]); }
    }
}
