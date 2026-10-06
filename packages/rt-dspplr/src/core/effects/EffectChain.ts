import type { DspPlugin, PluginInstance, PluginParams } from './types';

// ---------------------------------------------------------------------------
// EffectChain — the player's master bus, built from plugins:
//
//   input ─ input gain ─ slot 1 ─ slot 2 ─ … ─ output gain ─ ceiling ─ analyser ─ destination
//
//   The gains are smoothed (20 ms). The ceiling (-0.01 dBFS, a hard clip) is
//   the last stage, so nothing before it (a boost, a third-party effect) can
//   send the output over full scale.
//
//   slot:  in ─┬─ plugin ─ wet ─┬─ out      bypass crossfades wet/dry over 10 ms,
//              └──────── dry ───┘          so it never clicks
//
// A plugin that fails (create() throws, its worklet module does not load, its
// processor throws: `processorerror`) is bypassed and reported through
// onError; playback goes on through the dry path.
// ---------------------------------------------------------------------------

const BYPASS_SECONDS = 0.01;
const GAIN_SECONDS = 0.02;

/** A transfer curve that passes the signal through and clips it at ±ceiling. */
function ceilingCurve(ceiling: number): Float32Array {
    // Identity sampled exactly (linear interpolation between points is exact on a line), clipped at the ceiling;
    // a WaveShaper holds its end values for input beyond ±1.
    const n = 65537;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
        const x = (2 * i) / (n - 1) - 1;
        curve[i] = Math.max(-ceiling, Math.min(ceiling, x));
    }
    return curve;
}

interface Slot {
    id: string;
    plugin: DspPlugin;
    params: PluginParams;
    bypassed: boolean;
    failed: boolean;
    instance: PluginInstance | null;
    slotIn: GainNode;
    slotOut: GainNode;
    wet: GainNode;
    dry: GainNode;
}

const modules = new WeakMap<BaseAudioContext, Map<string, Promise<void>>>();

function loadModule(ctx: BaseAudioContext, key: string, url: () => string): Promise<void> {
    let byCtx = modules.get(ctx);
    if (!byCtx) {
        byCtx = new Map();
        modules.set(ctx, byCtx);
    }
    let loading = byCtx.get(key);
    if (!loading) {
        loading = ctx.audioWorklet.addModule(url());
        byCtx.set(key, loading);
    }
    return loading;
}

/** A worklet plugin's nodes: every param is an AudioParam of the same name. */
async function createWorkletInstance(ctx: BaseAudioContext, plugin: DspPlugin, params: PluginParams, onError: (message: string) => void): Promise<PluginInstance> {
    const rt = plugin.realtime;
    if (rt.kind !== 'worklet') throw new Error('not a worklet plugin');
    if (!ctx.audioWorklet) throw new Error('AudioWorklet unavailable');
    if (rt.moduleUrl) {
        await loadModule(ctx, rt.moduleUrl, () => rt.moduleUrl!);
    } else if (rt.moduleCode) {
        const code = rt.moduleCode;
        await loadModule(ctx, `code:${plugin.id}@${plugin.version}`, () => URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
    } else {
        throw new Error('worklet plugin without moduleUrl or moduleCode');
    }
    const node = new AudioWorkletNode(ctx, rt.processorName, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        ...(rt.channelCount ? { outputChannelCount: [rt.channelCount] } : {}),
        parameterData: params,
        processorOptions: rt.processorOptions,
    });
    node.onprocessorerror = () => onError(`${plugin.name}: its processor threw`);
    return {
        input: node,
        output: node,
        setParam(id, value, timeConstant = 0.01) {
            const param = node.parameters.get(id);
            if (param) param.setTargetAtTime(value, ctx.currentTime, timeConstant);
            else node.port.postMessage({ type: 'param', id, value });
        },
        dispose() {
            node.onprocessorerror = null;
            try {
                node.disconnect();
            } catch {
                // no-op
            }
        },
    };
}

export class EffectChain {
    readonly input: GainNode;
    readonly analyser: AnalyserNode;
    private readonly _ctx: BaseAudioContext;
    private readonly _inputGain: GainNode;
    private readonly _outputGain: GainNode;
    private readonly _ceiling: WaveShaperNode;
    private _slots: Slot[] = [];
    private readonly _onError: (id: string, message: string) => void;
    private _disposed = false;

    constructor(ctx: BaseAudioContext, onError: (id: string, message: string) => void, ceiling = 1) {
        this._ctx = ctx;
        this._onError = onError;
        this.input = ctx.createGain();
        this._inputGain = ctx.createGain();
        this._outputGain = ctx.createGain();
        this._ceiling = ctx.createWaveShaper();
        this._ceiling.curve = ceilingCurve(ceiling);
        this.analyser = ctx.createAnalyser();
        this.analyser.fftSize = 2048;
        this.input.connect(this._inputGain);
        this._outputGain.connect(this._ceiling);
        this._ceiling.connect(this.analyser);
        this.analyser.connect(ctx.destination);
        this._rewire();
    }

    /** Add an effect (its nodes may arrive asynchronously: until then the slot passes dry). */
    add(id: string, plugin: DspPlugin, params: PluginParams, bypassed: boolean, position = this._slots.length): void {
        const ctx = this._ctx;
        const slot: Slot = {
            id,
            plugin,
            params: { ...params },
            bypassed,
            failed: false,
            instance: null,
            slotIn: ctx.createGain(),
            slotOut: ctx.createGain(),
            wet: ctx.createGain(),
            dry: ctx.createGain(),
        };
        slot.wet.gain.value = 0;
        slot.dry.gain.value = 1;
        slot.slotIn.connect(slot.dry);
        slot.dry.connect(slot.slotOut);
        slot.wet.connect(slot.slotOut);
        this._slots.splice(Math.max(0, Math.min(this._slots.length, position)), 0, slot);
        this._rewire();
        void this._instantiate(slot);
    }

    remove(id: string): void {
        const slot = this._slots.find((s) => s.id === id);
        if (!slot) return;
        this._slots = this._slots.filter((s) => s !== slot);
        this._rewire();
        this._dispose(slot);
    }

    move(id: string, position: number): void {
        const slot = this._slots.find((s) => s.id === id);
        if (!slot) return;
        this._slots = this._slots.filter((s) => s !== slot);
        this._slots.splice(Math.max(0, Math.min(this._slots.length, position)), 0, slot);
        this._rewire();
    }

    setParam(id: string, param: string, value: number): void {
        const slot = this._slots.find((s) => s.id === id);
        if (!slot) return;
        slot.params[param] = value;
        if (!slot.instance || slot.failed) return;
        try {
            slot.instance.setParam(param, value);
        } catch (error) {
            this._fail(slot, `${slot.plugin.name}: setParam threw: ${String(error)}`);
        }
    }

    bypass(id: string, bypassed: boolean): void {
        const slot = this._slots.find((s) => s.id === id);
        if (!slot) return;
        slot.bypassed = bypassed;
        this._applyBypass(slot);
    }

    /** Linear gain before the effects, ramped so a move never clicks. */
    setInputGain(value: number): void {
        this._ramp(this._inputGain.gain, value);
    }

    /** Linear gain after the effects (before the ceiling), ramped so a move never clicks. */
    setOutputGain(value: number): void {
        this._ramp(this._outputGain.gain, value);
    }

    private _ramp(g: AudioParam, value: number): void {
        const now = this._ctx.currentTime;
        g.cancelScheduledValues(now);
        g.setValueAtTime(g.value, now);
        g.linearRampToValueAtTime(value, now + GAIN_SECONDS);
    }

    /** Sum of the active effects' declared latencies, in frames. */
    get latencyFrames(): number {
        return this._slots.filter((s) => !s.bypassed && !s.failed).reduce((n, s) => n + (s.plugin.latencyFrames ?? 0), 0);
    }

    dispose(): void {
        this._disposed = true;
        for (const slot of this._slots) this._dispose(slot);
        this._slots = [];
        for (const node of [this.input, this._inputGain, this._outputGain, this._ceiling, this.analyser]) {
            try {
                node.disconnect();
            } catch {
                // no-op
            }
        }
    }

    private async _instantiate(slot: Slot): Promise<void> {
        try {
            const instance = slot.plugin.realtime.kind === 'nodes'
                ? await slot.plugin.realtime.create(this._ctx, { ...slot.params })
                : await createWorkletInstance(this._ctx, slot.plugin, { ...slot.params }, (message) => this._fail(slot, message));
            if (this._disposed || !this._slots.includes(slot)) {
                instance.dispose();
                return;
            }
            slot.instance = instance;
            slot.slotIn.connect(instance.input);
            instance.output.connect(slot.wet);
            // Params set while the instance was being created.
            for (const [id, value] of Object.entries(slot.params)) instance.setParam(id, value, 0.001);
            this._applyBypass(slot);
        } catch (error) {
            this._fail(slot, `${slot.plugin.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private _applyBypass(slot: Slot): void {
        const on = !slot.bypassed && !slot.failed && !!slot.instance;
        const now = this._ctx.currentTime;
        for (const [gain, value] of [[slot.wet.gain, on ? 1 : 0], [slot.dry.gain, on ? 0 : 1]] as const) {
            gain.cancelScheduledValues(now);
            gain.setValueAtTime(gain.value, now);
            gain.linearRampToValueAtTime(value, now + BYPASS_SECONDS);
        }
    }

    private _fail(slot: Slot, message: string): void {
        if (slot.failed) return;
        slot.failed = true;
        this._applyBypass(slot);
        // Let the ramp finish before cutting the plugin out of the graph.
        setTimeout(() => {
            if (!slot.instance) return;
            try {
                slot.slotIn.disconnect(slot.instance.input);
            } catch {
                // no-op
            }
        }, 50);
        this._onError(slot.id, message);
    }

    private _dispose(slot: Slot): void {
        slot.instance?.dispose();
        for (const node of [slot.slotIn, slot.slotOut, slot.wet, slot.dry]) {
            try {
                node.disconnect();
            } catch {
                // no-op
            }
        }
    }

    private _rewire(): void {
        try {
            this._inputGain.disconnect();
        } catch {
            // no-op
        }
        for (const slot of this._slots) {
            try {
                slot.slotOut.disconnect();
            } catch {
                // no-op
            }
        }
        let head: AudioNode = this._inputGain;
        for (const slot of this._slots) {
            head.connect(slot.slotIn);
            head = slot.slotOut;
        }
        head.connect(this._outputGain);
    }
}
