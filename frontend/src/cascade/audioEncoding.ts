/**
 * Pure PCM (Pulse Code Modulation) conversion helpers for cascade-mode audio
 * capture. Kept free of any AudioContext/AudioWorklet/WebSocket dependency so
 * they run under plain Vitest (jsdom has none of those APIs) — the
 * AudioWorklet (`public/cascade-pcm-worklet.js`) only buffers raw Float32
 * frames; all the actual DSP (downsampling, bit-depth conversion) happens
 * here, on the main thread, right before a chunk is sent over the WebSocket.
 */

/**
 * Linearly resamples mono Float32 audio from `inputSampleRate` down to
 * `outputSampleRate`. Used to convert whatever native rate the browser's
 * AudioContext captures at (commonly 44.1kHz or 48kHz) down to the 16kHz the
 * cascade backend requires (`CascadeAudioFormat.SampleRateHz` in
 * `backend/CascadeAudioSession.cs`).
 *
 * @param input Mono samples in the AudioContext's native range of [-1, 1].
 * @param inputSampleRate The sample rate `input` was captured at, in Hz.
 * @param outputSampleRate The desired output sample rate, in Hz. Must be
 *   less than or equal to `inputSampleRate` — this pipeline only ever
 *   downsamples.
 * @returns A new Float32Array at `outputSampleRate`.
 * @throws {Error} If `outputSampleRate` is greater than `inputSampleRate`.
 */
export function downsampleTo(
  input: Float32Array,
  inputSampleRate: number,
  outputSampleRate: number,
): Float32Array {
  if (outputSampleRate === inputSampleRate) {
    return input.slice();
  }
  if (outputSampleRate > inputSampleRate) {
    throw new Error(
      `Cannot upsample from ${inputSampleRate}Hz to ${outputSampleRate}Hz; this pipeline only downsamples.`,
    );
  }

  const ratio = inputSampleRate / outputSampleRate;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const sourceIndex = i * ratio;
    const lowIndex = Math.floor(sourceIndex);
    const highIndex = Math.min(lowIndex + 1, input.length - 1);
    const frac = sourceIndex - lowIndex;
    // Linear interpolation between the two nearest input samples.
    output[i] = input[lowIndex] * (1 - frac) + input[highIndex] * frac;
  }

  return output;
}

/**
 * Converts mono Float32 PCM samples (range [-1, 1]) into signed 16-bit PCM,
 * little-endian — the exact wire format `CascadeAudioFormat` expects
 * (`backend/CascadeAudioSession.cs`: 16-bit, signed, little-endian, mono).
 * Samples outside [-1, 1] (e.g. from an over-driven mic input) are clamped
 * rather than wrapped, so a loud caller degrades gracefully instead of
 * producing aliased noise.
 *
 * @param input Mono samples in [-1, 1].
 * @returns An ArrayBuffer of `input.length * 2` bytes, ready to send as one
 *   binary WebSocket frame.
 */
export function float32ToPcm16Le(input: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(input.length * 2);
  const view = new DataView(buffer);

  for (let i = 0; i < input.length; i++) {
    const clamped = Math.max(-1, Math.min(1, input[i]));
    // Negative and positive full-scale are asymmetric in 16-bit signed PCM
    // (-32768..32767), so each side scales against its own maximum.
    const scaled = clamped < 0 ? clamped * 32768 : clamped * 32767;
    view.setInt16(i * 2, Math.round(scaled), /* littleEndian */ true);
  }

  return buffer;
}

/**
 * Downsamples then bit-depth-converts one Float32 audio chunk into a PCM16
 * little-endian ArrayBuffer, ready to send as a binary cascade WebSocket
 * frame. Composition point `MicPcmCapture` calls for every chunk the
 * AudioWorklet posts.
 */
export function encodePcm16Chunk(
  input: Float32Array,
  inputSampleRate: number,
  outputSampleRateHz: number,
): ArrayBuffer {
  const downsampled = downsampleTo(input, inputSampleRate, outputSampleRateHz);
  return float32ToPcm16Le(downsampled);
}
