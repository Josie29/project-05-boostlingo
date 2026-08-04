/**
 * One mic-to-PCM16 capture pipeline for a single cascade session. Abstracted
 * behind this interface so `CascadeSessionController` can be unit tested
 * without a real AudioContext/AudioWorkletNode (jsdom implements neither) —
 * tests inject a fake capture, while `MicPcmCapture` is the real
 * browser-backed implementation wired up in production.
 */
export interface CascadeAudioCapture {
  /**
   * Starts capturing from `stream`, invoking `onChunk` with each
   * downsampled, PCM16-little-endian-encoded frame ready to send as a binary
   * WebSocket frame. Resolves once capture is actively running.
   */
  start(stream: MediaStream, onChunk: (chunk: ArrayBuffer) => void): Promise<void>;

  /**
   * Stops capturing and releases the AudioContext/worklet node. Does not stop
   * `stream`'s tracks — the caller (`CascadeSessionController`) owns the
   * MediaStream's lifetime since it's also the one that requested it via
   * `getUserMedia`.
   */
  stop(): Promise<void>;
}
