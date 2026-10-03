// Node test for the dynamics worklet (run: npm test). The processor runs
// against stand-ins for the AudioWorklet globals; no browser needed.
//
//  1. At the default processing (compression 0, output 0 dB) the output is the
//     input, sample for sample, except that samples beyond the -0.01 dBFS
//     ceiling are clipped to it.
//  2. Compression above 0 does change the signal (the check above has teeth).

import assert from 'node:assert/strict';
import { COMPRESSION_DEFAULT, LIMITER_CEILING_DB, OUTPUT_DEFAULT_DB, outputGainDbToGain } from '../src/core/controls';
import { dbToGain } from '../src/core/dsp/compression';

const SAMPLE_RATE = 48000;
const BLOCK = 128;
const results: string[] = [];

type ProcessorCtor = new () => {
    process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
};

const scope = globalThis as Record<string, unknown>;
let Processor: ProcessorCtor | null = null;
scope.sampleRate = SAMPLE_RATE;
scope.AudioWorkletProcessor = class {};
scope.registerProcessor = (_name: string, ctor: ProcessorCtor) => { Processor = ctor; };
await import('../src/core/dsp/dynamics.worklet');
if (!Processor) throw new Error('the worklet did not register its processor');
const DynamicsProcessor: ProcessorCtor = Processor;

/** Two channels of noise with bursts well past full scale. */
function makeSignal(frames: number): Float32Array[] {
    let seed = 7;
    const random = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff - 0.5;
    };
    return [0, 1].map(() => {
        const channel = new Float32Array(frames);
        for (let i = 0; i < frames; i += 1) {
            const burst = Math.floor(i / 4800) % 4 === 3 ? 3 : 0.8;
            channel[i] = random() * burst;
        }
        return channel;
    });
}

function run(input: Float32Array[], compAmount: number, outputGain: number, ceilingGain: number): Float32Array[] {
    const processor = new DynamicsProcessor();
    const output = input.map((channel) => new Float32Array(channel.length));
    const parameters = {
        compAmount: new Float32Array([compAmount]),
        outputGain: new Float32Array([outputGain]),
        ceilingGain: new Float32Array([ceilingGain]),
    };
    for (let start = 0; start < input[0].length; start += BLOCK) {
        const end = start + BLOCK;
        processor.process(
            [input.map((channel) => channel.subarray(start, end))],
            [output.map((channel) => channel.subarray(start, end))],
            parameters,
        );
    }
    return output;
}

const input = makeSignal(SAMPLE_RATE);
const ceiling = dbToGain(LIMITER_CEILING_DB);
const ceilingF32 = Math.fround(ceiling);
const plain = run(input, COMPRESSION_DEFAULT, outputGainDbToGain(OUTPUT_DEFAULT_DB), ceiling);

let unchanged = 0;
let clipped = 0;
for (let ch = 0; ch < input.length; ch += 1) {
    for (let i = 0; i < input[ch].length; i += 1) {
        const x = input[ch][i];
        if (Math.abs(x) <= ceiling) {
            assert.equal(plain[ch][i], x, `sample ${i} of channel ${ch} is changed`);
            unchanged += 1;
        } else {
            assert.equal(plain[ch][i], Math.sign(x) * ceilingF32, `sample ${i} of channel ${ch} is not at the ceiling`);
            clipped += 1;
        }
    }
}
assert.ok(clipped > 0, 'the test signal reaches past the ceiling');
results.push(`defaults: ${unchanged} samples bit-identical, ${clipped} beyond -0.01 dBFS clipped to it`);

const compressed = run(input, 0.4, 1, ceiling);
let differ = 0;
for (let ch = 0; ch < input.length; ch += 1) {
    for (let i = 0; i < input[ch].length; i += 1) {
        if (compressed[ch][i] !== plain[ch][i]) differ += 1;
    }
}
assert.ok(differ > input[0].length / 10, 'compression 0.4 changes the signal');
results.push(`compression 0.4: ${differ} samples differ from the defaults`);

console.log(results.map((line) => `  ok  ${line}`).join('\n'));
console.log('\ndynamics tests passed');
