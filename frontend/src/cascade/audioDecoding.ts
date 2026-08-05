/**
 * Pure PCM (Pulse Code Modulation) conversion helpers for cascade-mode TTS
 * (Text-to-Speech) playback. Kept free of any AudioContext/WebSocket
 * dependency so it runs under plain Vitest (jsdom has neither) — mirrors
 * `audioEncoding.ts`'s role on the capture side, just inverted: that file
 * turns mic Float32 into wire PCM16LE, this one turns wire PCM16LE back into
 * Float32 for `AudioBuffer.copyToChannel`.
 */

/**
 * Converts signed 16-bit little-endian PCM samples (the exact wire format
 * `TtsAudioFormat` sends — see `backend/CascadeAudioSession.cs`) into mono
 * Float32 samples in [-1, 1], the range Web Audio's `AudioBuffer` expects.
 *
 * Exact inverse of `audioEncoding.ts`'s `float32ToPcm16Le`: negative and
 * positive full-scale are asymmetric in 16-bit signed PCM (-32768..32767),
 * so each side divides by its own maximum — this keeps -32768 mapping back
 * to exactly -1 and 32767 back to exactly 1, rather than introducing a
 * rounding bias at either end of the range.
 *
 * @param input An ArrayBuffer of raw PCM16LE bytes, normally an even length
 *   (each pair of bytes is one sample) — see below for the odd-length case.
 * @returns A new Float32Array of `Math.floor(input.byteLength / 2)` samples.
 */
export function pcm16LeToFloat32(input: ArrayBuffer): Float32Array<ArrayBuffer> {
  const sampleCount = input.byteLength >> 1; // Floor-divide by 2 (bit shift) — drops an odd trailing byte of a malformed frame instead of producing a fractional length the Float32Array constructor below would throw on.
  const view = new DataView(input);
  const output = new Float32Array(sampleCount);

  for (let i = 0; i < sampleCount; i++) {
    const sample = view.getInt16(i * 2, /* littleEndian */ true);
    output[i] = sample < 0 ? sample / 32768 : sample / 32767;
  }

  return output;
}
