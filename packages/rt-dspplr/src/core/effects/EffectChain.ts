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
//   Nor do add, remove and move: a slot is added dry, and a slot that is
//   removed or moved crossfades to dry first and leaves (or moves) once the
//   ramp is over. A dry slot is a plain wire, so taking it out or putting it
//   elsewhere changes nothing that is heard.
//
// A plugin that fails (create() throws, its worklet module does not load, its
// processor throws: `processorerror`) is bypassed and reported through
// onError; playback goes on through the dry path. A plugin whose dispose()
// throws is reported the same way, and the teardown goes on.
// ---------------------------------------------------------------------------

const BYPASS_SECONDS = 0.01;
const GAIN_SECONDS = 0.02;
/** Wait past a ramp's end before the graph changes under it. */
const SETTLE_MS = 15;

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

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

interface Slot {
    id: string;
    plugin: DspPlugin;
    params: PluginParams;
    bypassed: boolean;
    failed: boolean;
    instance: PluginInstance | null;
    /** Held dry while it moves or leaves; the graph changes once the ramp is over. */
    parked: 'moving' | 'leaving' | null;
    timer: ReturnType<typeof setTimeout> | null;
    slotIn: GainNode;
    slotOut: GainNode;
    wet: GainNode;
    dry: GainNode;
}

const modules = new WeakMap<BaseAudioContext, { urls: Map<string, Promise<void>>; codes: Map<string, Promise<void>> }>();

/**
 * Load an AudioWorklet module once per context. A URL that failed is tried
 * again by the next plugin that needs it (the network may be back). Inline
 * code is keyed by the code itself, so two plugins, or two edits of one, never
 * share a module because they share an id and version; its Blob URL is
 * revoked once the module has loaded.
 */
function loadModule(ctx: BaseAudioContext, source: { url: string } | { code: string }): Promise<void> {
    let cache = modules.get(ctx);
    if (!cache) {
        cache = { urls: new Map(), codes: new Map() };
        modules.set(ctx, cache);
    }
    if ('url' in source) {
        const urls = cache.urls;
        const cached = urls.get(source.url);
        if (cached) return cached;
        const loading = ctx.audioWorklet.addModule(source.url);
        urls.set(source.url, loading);
        loading.catch(() => {
            if (urls.get(source.url) === loading) urls.delete(source.url);
        });
        return loading;
    }
    const cached = cache.codes.get(source.code);
    if (cached) return cached;
    const url = URL.createObjectURL(new Blob([source.code], { type: 'text/javascript' }));
    const revoke = () => URL.revokeObjectURL(url);
    const loading = ctx.audioWorklet.addModule(url);
    loading.then(revoke, revoke);
    cache.codes.set(source.code, loading);
    return loading;
}

/** A worklet plugin's nodes: every param is an AudioParam of the same name. */
async function createWorkletInstance(ctx: BaseAudioContext, plugin: DspPlugin, params: PluginParams, onError: (message: string) => void): Promise<PluginInstance> {
    const rt = plugin.realtime;
    if (rt.kind !== 'worklet') throw new Error('not a worklet plugin');
    if (!ctx.audioWorklet) throw new Error('AudioWorklet unavailable');
    if (rt.moduleUrl) {
        await loadModule(ctx, { url: rt.moduleUrl });
    } else if (rt.moduleCode) {
        await loadModule(ctx, { code: rt.moduleCode });
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
    /** The effects, in chain order. */
    private _slots: Slot[] = [];
    /**
     * The order the graph is wired in: the effects, and slots still on their
     * way out. A moving slot keeps its old place until it is dry.
     */
    private _wired: Slot[] = [];
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

    /**
     * Add an effect (its nodes may arrive asynchronously: until then the slot
     * passes dry). `failed`: the effect failed in an earlier chain (an output
     * rebuild adds it again); it is not instantiated and stays dry, whatever
     * its bypass says.
     */
    add(id: string, plugin: DspPlugin, params: PluginParams, bypassed: boolean, position = this._slots.length, failed = false): void {
        const ctx = this._ctx;
        const slot: Slot = {
            id,
            plugin,
            params: { ...params },
            bypassed,
            failed,
            instance: null,
            parked: null,
            timer: null,
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
        this._place(slot);
        if (!failed) void this._instantiate(slot);
    }

    remove(id: string): void {
        const slot = this._slots.find((s) => s.id === id);
        if (!slot) return;
        this._slots = this._slots.filter((s) => s !== slot);
        this._park(slot, 'leaving', () => {
            // Its output first, so the next stage is never fed twice while the chain closes the gap.
            try {
                slot.slotOut.disconnect();
            } catch {
                // no-op
            }
            this._wired = this._wired.filter((s) => s !== slot);
            this._rewire();
            this._dispose(slot, true);
        });
    }

    move(id: string, position: number): void {
        const slot = this._slots.find((s) => s.id === id);
        if (!slot) return;
        const next = this._slots.filter((s) => s !== slot);
        next.splice(Math.max(0, Math.min(next.length, position)), 0, slot);
        if (next.every((s, i) => s === this._slots[i])) return;
        this._slots = next;
        this._park(slot, 'moving', () => {
            slot.parked = null;
            this._place(slot);
            this._applyBypass(slot);
        });
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

    /** A failed effect stays dry whatever this says. */
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

    dispose(): void {
        if (this._disposed) return;
        this._disposed = true;
        // Every slot is taken down, the master nodes too, whatever a plugin's dispose() does.
        for (const slot of this._wired) this._dispose(slot, true);
        this._slots = [];
        this._wired = [];
        for (const node of [this.input, this._inputGain, this._outputGain, this._ceiling, this.analyser]) {
            try {
                node.disconnect();
            } catch {
                // no-op
            }
        }
    }

    private async _instantiate(slot: Slot): Promise<void> {
        let instance: PluginInstance;
        try {
            instance = slot.plugin.realtime.kind === 'nodes'
                ? await slot.plugin.realtime.create(this._ctx, { ...slot.params })
                : await createWorkletInstance(this._ctx, slot.plugin, { ...slot.params }, (message) => this._fail(slot, message));
        } catch (error) {
            // A slot that is gone has nothing to report: the effect may be live in another chain by now.
            if (!this._disposed && this._slots.includes(slot)) this._fail(slot, `${slot.plugin.name}: ${messageOf(error)}`);
            return;
        }
        if (this._disposed || !this._slots.includes(slot)) {
            // Removed meanwhile: reported like any removal. After the chain's dispose the
            // effect may be live in the next chain, so a throw is only logged.
            this._disposeInstance(slot, instance, !this._disposed);
            return;
        }
        try {
            slot.instance = instance;
            slot.slotIn.connect(instance.input);
            instance.output.connect(slot.wet);
            // Params set while the instance was being created.
            for (const [id, value] of Object.entries(slot.params)) instance.setParam(id, value, 0.001);
            this._applyBypass(slot);
        } catch (error) {
            this._fail(slot, `${slot.plugin.name}: ${messageOf(error)}`);
        }
    }

    private _applyBypass(slot: Slot): void {
        const on = !slot.bypassed && !slot.failed && !!slot.instance && slot.parked === null;
        const now = this._ctx.currentTime;
        for (const [gain, value] of [[slot.wet.gain, on ? 1 : 0], [slot.dry.gain, on ? 0 : 1]] as const) {
            gain.cancelScheduledValues(now);
            gain.setValueAtTime(gain.value, now);
            gain.linearRampToValueAtTime(value, now + BYPASS_SECONDS);
        }
    }

    /** Crossfade `slot` to dry, then run `then` once the ramp has played (the audio clock decides). */
    private _park(slot: Slot, why: 'moving' | 'leaving', then: () => void): void {
        slot.parked = why;
        this._applyBypass(slot);
        if (slot.timer !== null) clearTimeout(slot.timer);
        const end = this._ctx.currentTime + BYPASS_SECONDS;
        const settle = () => {
            if (this._disposed) return;
            // A suspended context renders nothing, so nothing can click.
            if (this._ctx.state === 'running' && this._ctx.currentTime < end) {
                slot.timer = setTimeout(settle, SETTLE_MS);
                return;
            }
            slot.timer = null;
            then();
        };
        slot.timer = setTimeout(settle, BYPASS_SECONDS * 1000 + SETTLE_MS);
    }

    /** Wire `slot` in at its place: before the next effect that is not itself moving. */
    private _place(slot: Slot): void {
        this._wired = this._wired.filter((s) => s !== slot);
        const following = this._slots.slice(this._slots.indexOf(slot) + 1).find((s) => s.parked === null);
        const at = following ? this._wired.indexOf(following) : -1;
        this._wired.splice(at < 0 ? this._wired.length : at, 0, slot);
        this._rewire();
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

    /** Take a slot out of the graph and dispose its plugin. */
    private _dispose(slot: Slot, report: boolean): void {
        if (slot.timer !== null) {
            clearTimeout(slot.timer);
            slot.timer = null;
        }
        const instance = slot.instance;
        slot.instance = null;
        if (instance) this._disposeInstance(slot, instance, report);
        for (const node of [slot.slotIn, slot.slotOut, slot.wet, slot.dry]) {
            try {
                node.disconnect();
            } catch {
                // no-op
            }
        }
    }

    /** A plugin's own dispose(), isolated: a throw is reported (or, for a slot no chain holds any more, logged). */
    private _disposeInstance(slot: Slot, instance: PluginInstance, report: boolean): void {
        try {
            instance.dispose();
        } catch (error) {
            const message = `${slot.plugin.name}: dispose() threw: ${messageOf(error)}`;
            if (report) this._onError(slot.id, message);
            else console.warn('[EffectChain]', message);
        }
    }

    private _rewire(): void {
        try {
            this._inputGain.disconnect();
        } catch {
            // no-op
        }
        for (const slot of this._wired) {
            try {
                slot.slotOut.disconnect();
            } catch {
                // no-op
            }
        }
        let head: AudioNode = this._inputGain;
        for (const slot of this._wired) {
            head.connect(slot.slotIn);
            head = slot.slotOut;
        }
        head.connect(this._outputGain);
    }
}
