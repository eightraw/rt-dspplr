// The part of the WebAssembly JS API prepare uses (Node has it; its types come with the DOM
// library, which this Node package does not load).
declare namespace WebAssembly {
    class Module {
        constructor(bytes: ArrayBufferView | ArrayBuffer);
    }
    class Instance {
        constructor(module: Module, imports?: object);
        readonly exports: Record<string, unknown>;
    }
    class Memory {
        readonly buffer: ArrayBuffer;
        grow(pages: number): number;
    }
}
