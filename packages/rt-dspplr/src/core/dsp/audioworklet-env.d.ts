declare const sampleRate: number;

interface AudioParamDescriptor {
    automationRate?: 'a-rate' | 'k-rate';
    defaultValue?: number;
    maxValue?: number;
    minValue?: number;
    name: string;
}

declare class AudioWorkletProcessor {
    readonly port: MessagePort;
    process(
        inputs: Float32Array[][],
        outputs: Float32Array[][],
        parameters: Record<string, Float32Array>,
    ): boolean;
}

declare function registerProcessor(
    name: string,
    processorCtor: new () => AudioWorkletProcessor,
): void;
