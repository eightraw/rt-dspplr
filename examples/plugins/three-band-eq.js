// A third-party plugin for RT-DSPPLR: a 3-band EQ (low shelf 250 Hz, peak
// 1 kHz, high shelf 4 kHz), written against the public plugin contract only.
//
//   import { threeBandEq } from './three-band-eq.js';
//   const id = player.effects.add(threeBandEq, { params: { low: 6 } });
//   player.effects.setParam(id, 'high', -3);
//
// realtime   three native BiquadFilterNodes (Web Audio's own shelf/peaking
//            filters), gains smoothed with setTargetAtTime
// preview    process(): the same biquads (Web Audio's formulas), so the
//            waveform shows the EQ; magnitudeResponse(): their exact response,
//            so the spectrogram shows it per row and a prepared overview can
//            approximate it before any audio is decoded.
//
// MIT No Attribution — copy and change freely.

const BANDS = [
    { id: 'low', type: 'lowshelf', hz: 250, q: 0.7 },
    { id: 'mid', type: 'peaking', hz: 1000, q: 0.7 },
    { id: 'high', type: 'highshelf', hz: 4000, q: 0.7 },
];

/** Web Audio BiquadFilterNode coefficients (normalised by a0). */
function coefficients(type, hz, q, gainDb, sampleRate) {
    const A = Math.pow(10, gainDb / 40);
    const w0 = (2 * Math.PI * hz) / sampleRate;
    const cos = Math.cos(w0);
    const sin = Math.sin(w0);
    let b0, b1, b2, a0, a1, a2;
    if (type === 'peaking') {
        const alpha = sin / (2 * q);
        b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A;
        a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A;
    } else {
        const alpha = (sin / 2) * Math.SQRT2; // shelf slope S = 1
        const k = 2 * Math.sqrt(A) * alpha;
        if (type === 'lowshelf') {
            b0 = A * ((A + 1) - (A - 1) * cos + k); b1 = 2 * A * ((A - 1) - (A + 1) * cos); b2 = A * ((A + 1) - (A - 1) * cos - k);
            a0 = (A + 1) + (A - 1) * cos + k; a1 = -2 * ((A - 1) + (A + 1) * cos); a2 = (A + 1) + (A - 1) * cos - k;
        } else {
            b0 = A * ((A + 1) + (A - 1) * cos + k); b1 = -2 * A * ((A - 1) + (A + 1) * cos); b2 = A * ((A + 1) + (A - 1) * cos - k);
            a0 = (A + 1) - (A - 1) * cos + k; a1 = 2 * ((A - 1) - (A + 1) * cos); a2 = (A + 1) - (A - 1) * cos - k;
        }
    }
    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** @type {import('@saitdigital/rt-dspplr').DspPlugin} */
export const threeBandEq = {
    id: 'example.three-band-eq',
    name: '3-band EQ',
    version: '1.0.0',
    params: BANDS.map((band) => ({
        id: band.id,
        label: `${band.id[0].toUpperCase()}${band.id.slice(1)} (${band.hz >= 1000 ? `${band.hz / 1000} k` : band.hz} Hz)`,
        unit: 'dB',
        min: -18,
        max: 18,
        default: 0,
        step: 0.5,
    })),
    latencyFrames: 0,
    realtime: {
        kind: 'nodes',
        create(ctx, params) {
            const filters = BANDS.map((band) => {
                const f = ctx.createBiquadFilter();
                f.type = band.type;
                f.frequency.value = band.hz;
                f.Q.value = band.q;
                f.gain.value = params[band.id];
                return f;
            });
            filters[0].connect(filters[1]);
            filters[1].connect(filters[2]);
            return {
                input: filters[0],
                output: filters[2],
                setParam(id, value, timeConstant = 0.01) {
                    const index = BANDS.findIndex((band) => band.id === id);
                    if (index >= 0) filters[index].gain.setTargetAtTime(value, ctx.currentTime, timeConstant);
                },
                dispose() {
                    filters.forEach((f) => f.disconnect());
                },
            };
        },
    },
    preview: {
        // Self-contained (its source runs in a worker): no closures, no imports.
        process(channels, sampleRate, params, state) {
            const bands = [['lowshelf', 250, 0.7, params.low], ['peaking', 1000, 0.7, params.mid], ['highshelf', 4000, 0.7, params.high]];
            for (let k = 0; k < bands.length; k += 1) {
                const [type, hz, q, gainDb] = bands[k];
                if (gainDb === 0) continue;
                const A = Math.pow(10, gainDb / 40);
                const w0 = (2 * Math.PI * hz) / sampleRate;
                const cos = Math.cos(w0);
                const sin = Math.sin(w0);
                let b0, b1, b2, a0, a1, a2;
                if (type === 'peaking') {
                    const alpha = sin / (2 * q);
                    b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A;
                    a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A;
                } else {
                    const alpha = (sin / 2) * Math.SQRT2;
                    const kk = 2 * Math.sqrt(A) * alpha;
                    if (type === 'lowshelf') {
                        b0 = A * ((A + 1) - (A - 1) * cos + kk); b1 = 2 * A * ((A - 1) - (A + 1) * cos); b2 = A * ((A + 1) - (A - 1) * cos - kk);
                        a0 = (A + 1) + (A - 1) * cos + kk; a1 = -2 * ((A - 1) + (A + 1) * cos); a2 = (A + 1) + (A - 1) * cos - kk;
                    } else {
                        b0 = A * ((A + 1) + (A - 1) * cos + kk); b1 = -2 * A * ((A - 1) + (A + 1) * cos); b2 = A * ((A + 1) + (A - 1) * cos - kk);
                        a0 = (A + 1) - (A - 1) * cos + kk; a1 = 2 * ((A - 1) - (A + 1) * cos); a2 = (A + 1) - (A - 1) * cos - kk;
                    }
                }
                b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
                for (let c = 0; c < channels.length; c += 1) {
                    const key = `${k}:${c}`;
                    const st = state[key] || (state[key] = [0, 0, 0, 0]);
                    let [x1, x2, y1, y2] = st;
                    const x = channels[c];
                    for (let i = 0; i < x.length; i += 1) {
                        const v = x[i];
                        const y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
                        x2 = x1; x1 = v; y2 = y1; y1 = y;
                        x[i] = y;
                    }
                    st[0] = x1; st[1] = x2; st[2] = y1; st[3] = y2;
                }
            }
        },
        magnitudeResponse(params, freqs, sampleRate) {
            const out = new Float32Array(freqs.length);
            for (const band of BANDS) {
                const gainDb = params[band.id];
                if (gainDb === 0) continue;
                const c = coefficients(band.type, band.hz, band.q, gainDb, sampleRate);
                for (let i = 0; i < freqs.length; i += 1) {
                    const w = (2 * Math.PI * freqs[i]) / sampleRate;
                    const nr = c.b0 + c.b1 * Math.cos(w) + c.b2 * Math.cos(2 * w);
                    const ni = -(c.b1 * Math.sin(w) + c.b2 * Math.sin(2 * w));
                    const dr = 1 + c.a1 * Math.cos(w) + c.a2 * Math.cos(2 * w);
                    const di = -(c.a1 * Math.sin(w) + c.a2 * Math.sin(2 * w));
                    out[i] += 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
                }
            }
            return out;
        },
    },
};

export default threeBandEq;
