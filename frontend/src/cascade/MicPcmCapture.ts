import { encodePcm16Chunk } from './audioEncoding';
import type { CascadeAudioCapture } from './CascadeAudioCapture';

/** Static-asset path (see `public/cascade-pcm-worklet.js`) the AudioWorklet module is fetched from. */
const WORKLET_MODULE_URL = '/cascade-pcm-worklet.js';

/** Processor name registered by the worklet module via `registerProcessor(...)`. */
const WORKLET_PROCESSOR_NAME = 'cascade-pcm-capture';

/** Target sample rate every cascade session streams at; matches `CascadeAudioFormat.SampleRateHz` in `backend/CascadeAudioSession.cs`. */
const TARGET_SAMPLE_RATE_HZ = 16_000;

/**
 * Default `CascadeAudioCapture`: captures the mic through a real
 * AudioContext + AudioWorkletNode. The worklet itself only buffers raw
 * Float32 frames at the context's native sample rate (see the module-level
 * comment in `public/cascade-pcm-worklet.js` for why the worklet can't do
 * the DSP itself); downsampling to 16kHz and the Float32->PCM16 conversion
 * happen here, on the main thread, via `audioEncoding.ts`'s pure functions.
 *
 * Not itself unit tested — jsdom (the test environment) implements neither
 * AudioContext nor AudioWorkletNode. `CascadeSessionController`'s tests
 * inject a fake `CascadeAudioCapture` instead, so the transport/handshake
 * logic is fully covered without needing a real browser.
 */
export class MicPcmCapture implements CascadeAudioCapture {
  private audioContext: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;

  async start(stream: MediaStream, onChunk: (chunk: ArrayBuffer) => void): Promise<void> {
    const audioContext = new AudioContext();
    this.audioContext = audioContext;

    await audioContext.audioWorklet.addModule(WORKLET_MODULE_URL);

    const workletNode = new AudioWorkletNode(audioContext, WORKLET_PROCESSOR_NAME);
    this.workletNode = workletNode;
    workletNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
      onChunk(encodePcm16Chunk(event.data, audioContext.sampleRate, TARGET_SAMPLE_RATE_HZ));
    };

    const sourceNode = audioContext.createMediaStreamSource(stream);
    this.sourceNode = sourceNode;
    sourceNode.connect(workletNode);
    // The processor never writes to its output, so this stays silent — the
    // connection to `destination` only keeps the node "pulled" by the audio
    // graph (required for `process()` to run at all) without feeding the
    // mic back out through the speakers.
    workletNode.connect(audioContext.destination);
  }

  async stop(): Promise<void> {
    if (this.workletNode) {
      this.workletNode.port.onmessage = null;
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.audioContext) {
      await this.audioContext.close();
      this.audioContext = null;
    }
  }
}
