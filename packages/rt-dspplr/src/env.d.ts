// Build-time virtual modules provided by build/inline-plugin.ts.

/** A worker entry bundled into a self-contained script; the default export starts a new Worker from a Blob URL. */
declare module '*?inline-worker' {
    const createWorker: () => Worker;
    export default createWorker;
}

/** An AudioWorklet entry bundled into a self-contained script; the default export returns its Blob URL (created once). */
declare module '*?inline-worklet' {
    const getWorkletUrl: () => string;
    export default getWorkletUrl;
}

/** The package version, from package.json at build time. */
declare const __RTD_VERSION__: string;
