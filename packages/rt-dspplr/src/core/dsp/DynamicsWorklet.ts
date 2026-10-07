import type { DSPNodeDescriptor } from './DSPChain';

const PARAM_RAMP_SECONDS = 0.02;
const MIN_GAIN = 1e-6;

function clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
}

function scheduleParam(
    context: BaseAudioContext,
    param: AudioParam,
    value: number,
): void {
    const now = context.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(value, now + PARAM_RAMP_SECONDS);
}

/** The dynamics processor. `disconnect()` also ends its processor: it is the teardown. */
export interface DynamicsWorkletNode extends DSPNodeDescriptor {
    readonly name: 'dynamics';
    readonly node: AudioWorkletNode;
    setAmount(amount: number): void;
    setGain(value: number): void;
    setCeilingGain(value: number): void;
}

export interface DynamicsWorkletOptions {
    amount?: number;
    outputGain?: number;
    ceilingGain?: number;
}

export function createDynamicsWorklet(
    context: AudioContext,
    options?: DynamicsWorkletOptions,
): DynamicsWorkletNode {
    const node = new AudioWorkletNode(context, 'rtd-dynamics-processor');

    const compAmount = node.parameters.get('compAmount');
    const outputGain = node.parameters.get('outputGain');
    const ceilingGain = node.parameters.get('ceilingGain');

    if (!compAmount || !outputGain || !ceilingGain) {
        try { node.disconnect(); } catch { /* noop */ }
        throw new Error('rtd-dynamics-processor is missing expected AudioParams');
    }

    const initialAmount = clamp01(options?.amount ?? 0);
    const initialOutputGain = Math.max(0, options?.outputGain ?? 1);
    const initialCeilingGain = Math.max(MIN_GAIN, options?.ceilingGain ?? 1);
    const now = context.currentTime;

    compAmount.setValueAtTime(initialAmount, now);
    outputGain.setValueAtTime(initialOutputGain, now);
    ceilingGain.setValueAtTime(initialCeilingGain, now);

    return {
        name: 'dynamics',
        node,
        input: node,
        output: node,

        setAmount(amount: number): void {
            scheduleParam(context, compAmount, clamp01(amount));
        },

        setGain(value: number): void {
            scheduleParam(context, outputGain, Math.max(0, value));
        },

        setCeilingGain(value: number): void {
            scheduleParam(context, ceilingGain, Math.max(MIN_GAIN, value));
        },

        disconnect(): void {
            try { node.disconnect(); } catch { /* noop */ }
            // A processor runs (and is pulled) for as long as it says so; this one
            // stops at 'dispose'. The node cannot be used again.
            try { node.port.postMessage('dispose'); } catch { /* closed context */ }
        },
    };
}
