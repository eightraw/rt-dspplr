// ---------------------------------------------------------------------------
// DSPChain — ordered list of audio processing nodes between track and output
// ---------------------------------------------------------------------------

/**
 * A DSP node wraps one or more Web Audio nodes and exposes a simple
 * connect/disconnect interface. It can be a native node (BiquadFilter,
 * DynamicsCompressor) or a custom AudioWorkletNode.
 */
export interface DSPNodeDescriptor {
    /** Unique name for this processor in the chain. */
    readonly name: string;
    /** The node to connect as input. */
    readonly input: AudioNode;
    /** The node to connect as output (may be the same as input). */
    readonly output: AudioNode;
    /** Disconnect all internal nodes. */
    disconnect(): void;
}

/**
 * DSPChain manages an ordered list of DSP processors.
 * Signal flows: input → node[0] → node[1] → ... → node[N] → output.
 *
 * Usage:
 *   const chain = new DSPChain(ctx);
 *   chain.add(createHighPass(ctx, 200));
 *   chain.add(createCompressor(ctx));
 *
 *   // Connect track output → chain → mixer bus
 *   trackGainNode.connect(chain.input);
 *   chain.output.connect(mixerSumBus);
 */
export class DSPChain {
    private _nodes: DSPNodeDescriptor[] = [];

    /** Pass-through gain used as the chain's fixed input point. */
    private _inputGain: GainNode;
    /** Pass-through gain used as the chain's fixed output point. */
    private _outputGain: GainNode;

    constructor(context: BaseAudioContext) {
        this._inputGain = context.createGain();
        this._outputGain = context.createGain();

        // Empty chain: input goes straight to output
        this._inputGain.connect(this._outputGain);
    }

    get input(): GainNode {
        return this._inputGain;
    }

    get output(): GainNode {
        return this._outputGain;
    }

    get nodes(): readonly DSPNodeDescriptor[] {
        return this._nodes;
    }

    /**
     * Add a DSP node to the end of the chain.
     */
    add(node: DSPNodeDescriptor): void {
        this._nodes.push(node);
        this._rewire();
    }

    /**
     * Remove a DSP node by name.
     */
    remove(name: string): void {
        const index = this._nodes.findIndex((n) => n.name === name);
        if (index === -1) return;

        const [removed] = this._nodes.splice(index, 1);
        removed.disconnect();
        this._rewire();
    }

    /**
     * Get a DSP node by name.
     */
    get(name: string): DSPNodeDescriptor | undefined {
        return this._nodes.find((n) => n.name === name);
    }

    /**
     * Disconnect and remove all nodes.
     */
    clear(): void {
        for (const node of this._nodes) {
            node.disconnect();
        }
        this._nodes = [];
        this._rewire();
    }

    /**
     * Disconnect everything and release resources.
     */
    dispose(): void {
        this.clear();
        try { this._inputGain.disconnect(); } catch { /* noop */ }
        try { this._outputGain.disconnect(); } catch { /* noop */ }
    }

    // -----------------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------------

    /**
     * Rewire the full chain: input → nodes → output.
     */
    private _rewire(): void {
        // Disconnect everything first
        try { this._inputGain.disconnect(); } catch { /* noop */ }
        for (const node of this._nodes) {
            try { node.output.disconnect(); } catch { /* noop */ }
        }

        if (this._nodes.length === 0) {
            // Empty chain: bypass
            this._inputGain.connect(this._outputGain);
            return;
        }

        // input → first node
        this._inputGain.connect(this._nodes[0].input);

        // Chain nodes together
        for (let i = 0; i < this._nodes.length - 1; i++) {
            this._nodes[i].output.connect(this._nodes[i + 1].input);
        }

        // Last node → output
        this._nodes[this._nodes.length - 1].output.connect(this._outputGain);
    }
}
