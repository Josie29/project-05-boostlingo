// AudioWorklet processor for cascade-mode mic capture.
//
// Served from `public/` (not bundled) because AudioWorklet modules run in
// their own AudioWorkletGlobalScope, loaded via `audioContext.audioWorklet
// .addModule(url)` as a plain script fetch — they can't `import` from the
// app's TypeScript sources or go through Vite's module graph. This file is
// intentionally kept trivial: it only buffers raw Float32 samples at the
// AudioContext's native sample rate and posts them to the main thread.
// Downsampling to 16kHz and the Float32->PCM16 conversion happen on the main
// thread instead, in `src/cascade/audioEncoding.ts`'s pure, unit-tested
// functions — see `MicPcmCapture.ts` for how the two are wired together.

/** Samples buffered per postMessage — a balance between message-passing overhead and latency. */
const CHUNK_SIZE_SAMPLES = 4096;

class CascadePcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(CHUNK_SIZE_SAMPLES);
    this._writeIndex = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel || channel.length === 0) {
      // No mic input connected yet (e.g. the very first render quantum) — keep the node alive.
      return true;
    }

    for (let i = 0; i < channel.length; i++) {
      this._buffer[this._writeIndex++] = channel[i];
      if (this._writeIndex === CHUNK_SIZE_SAMPLES) {
        // .slice() copies out a detached buffer so the next fill can't mutate
        // the one already posted (postMessage transfers ownership otherwise).
        this.port.postMessage(this._buffer.slice());
        this._writeIndex = 0;
      }
    }

    return true;
  }
}

registerProcessor('cascade-pcm-capture', CascadePcmCaptureProcessor);
