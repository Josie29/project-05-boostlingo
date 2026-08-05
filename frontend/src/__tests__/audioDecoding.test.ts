import { describe, expect, it } from 'vitest';
import { float32ToPcm16Le } from '../cascade/audioEncoding';
import { pcm16LeToFloat32 } from '../cascade/audioDecoding';

/** Builds a raw PCM16LE ArrayBuffer from explicit int16 sample values, mirroring what the backend sends over the wire. */
function pcm16LeBufferOf(samples: number[]): ArrayBuffer {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i], /* littleEndian */ true);
  return buffer;
}

describe('pcm16LeToFloat32', () => {
  // Catches the bug this playback queue is fundamentally about: if the
  // int16->float scale is wrong, every utterance's audio plays back at the
  // wrong volume (either clipped/distorted or barely audible) with no
  // obvious symptom other than "TTS sounds wrong."
  it('maps full-scale and mid-scale samples to their expected float values', () => {
    const output = pcm16LeToFloat32(pcm16LeBufferOf([0, 32767, -32768, 16384, -16384]));

    expect(output[0]).toBeCloseTo(0, 5);
    expect(output[1]).toBeCloseTo(1, 5);
    expect(output[2]).toBeCloseTo(-1, 5);
    expect(output[3]).toBeCloseTo(0.5, 4); // 16384 / 32767
    expect(output[4]).toBeCloseTo(-0.5, 4); // -16384 / 32768
  });

  // Catches an asymmetric-bounds bug: 16-bit signed PCM's negative and
  // positive extremes (-32768 vs 32767) aren't mirror images, so a decoder
  // that divides by a single constant would map one of the two extremes to
  // something other than exactly +/-1, producing an audible click/offset at
  // the loudest moments of speech.
  it('maps the exact int16 extremes to exactly +1 and -1, not a rounding-biased value', () => {
    const output = pcm16LeToFloat32(pcm16LeBufferOf([32767, -32768]));

    expect(output[0]).toBe(1);
    expect(output[1]).toBe(-1);
  });

  // Catches a round-trip regression between the capture-side encoder and
  // this playback-side decoder: since one team's `float32ToPcm16Le` (mic
  // capture, issue #4) and this file's `pcm16LeToFloat32` (TTS playback,
  // issue #7) are inverses of the same wire format, a value encoded then
  // decoded should land back where it started (within int16 quantization
  // error) — if the two ever drifted out of sync, TTS playback would be
  // subtly distorted in a way a single-direction test wouldn't catch.
  it('round-trips through float32ToPcm16Le back to (approximately) the original samples', () => {
    const original = new Float32Array([0, 1, -1, 0.5, -0.5, 0.25, -0.75]);

    const roundTripped = pcm16LeToFloat32(float32ToPcm16Le(original));

    for (let i = 0; i < original.length; i++) {
      expect(roundTripped[i]).toBeCloseTo(original[i], 4);
    }
  });

  it('produces exactly input.byteLength / 2 samples', () => {
    const output = pcm16LeToFloat32(new ArrayBuffer(20));
    expect(output.length).toBe(10);
  });

  // Catches a crash bug: an odd-length buffer (a malformed/truncated frame)
  // must decode its whole-sample prefix rather than throwing when
  // constructing the Float32Array with a fractional length — a single bad
  // frame off the wire shouldn't take down the whole playback pipeline.
  it('drops a trailing odd byte instead of throwing on an odd-length buffer', () => {
    const output = pcm16LeToFloat32(new ArrayBuffer(5));
    expect(output.length).toBe(2);
  });
});
