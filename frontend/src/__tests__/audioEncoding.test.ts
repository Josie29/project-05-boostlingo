import { describe, expect, it } from 'vitest';
import { downsampleTo, float32ToPcm16Le } from '../cascade/audioEncoding';

/** Reads one little-endian signed 16-bit sample out of an encoded buffer. */
function readInt16Le(buffer: ArrayBuffer, sampleIndex: number): number {
  return new DataView(buffer).getInt16(sampleIndex * 2, /* littleEndian */ true);
}

describe('float32ToPcm16Le', () => {
  // Catches the bug where full-scale samples silently wrap instead of
  // clamping (e.g. Math.round(1.5 * 32767) overflowing Int16 range), which
  // would corrupt audio into loud clicking noise the moment a caller speaks
  // even slightly too loud into the mic.
  it('clamps out-of-range samples instead of wrapping', () => {
    const buffer = float32ToPcm16Le(new Float32Array([1.5, -1.5, 2, -2]));

    expect(readInt16Le(buffer, 0)).toBe(32767);
    expect(readInt16Le(buffer, 1)).toBe(-32768);
    expect(readInt16Le(buffer, 2)).toBe(32767);
    expect(readInt16Le(buffer, 3)).toBe(-32768);
  });

  it('maps full-scale and mid-scale samples to their expected 16-bit values', () => {
    const buffer = float32ToPcm16Le(new Float32Array([0, 1, -1, 0.5, -0.5]));

    expect(readInt16Le(buffer, 0)).toBe(0);
    expect(readInt16Le(buffer, 1)).toBe(32767);
    expect(readInt16Le(buffer, 2)).toBe(-32768);
    expect(readInt16Le(buffer, 3)).toBe(16384); // round(0.5 * 32767)
    expect(readInt16Le(buffer, 4)).toBe(-16384); // round(-0.5 * 32768)
  });

  // Catches an endianness bug: the backend (CascadeAudioFormat in
  // backend/CascadeAudioSession.cs) requires little-endian byte order
  // specifically — if the conversion ever used native/big-endian byte order,
  // every sample would decode as static/noise on a little-endian-expecting
  // STT (Speech-to-Text) provider.
  it('writes bytes in little-endian order', () => {
    const buffer = float32ToPcm16Le(new Float32Array([-1])); // -32768 = 0x8000
    const bytes = new Uint8Array(buffer);

    expect(bytes[0]).toBe(0x00); // low byte first
    expect(bytes[1]).toBe(0x80); // high byte second
  });

  it('produces exactly 2 bytes of output per input sample', () => {
    const buffer = float32ToPcm16Le(new Float32Array(10));
    expect(buffer.byteLength).toBe(20);
  });
});

describe('downsampleTo', () => {
  // Catches the bug this issue is fundamentally about: if the resample ratio
  // or indexing is off, every chunk sent to the backend has the wrong pitch
  // or duration relative to what the mic actually captured, silently
  // corrupting speech recognition without an obvious symptom in the UI.
  it('picks exact input samples when the ratio is a whole number', () => {
    const input = new Float32Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

    const output = downsampleTo(input, 32000, 16000); // ratio 2

    expect(Array.from(output)).toEqual([0, 2, 4, 6, 8, 10]);
  });

  it('linearly interpolates between input samples when the ratio is fractional', () => {
    const input = new Float32Array([0, 4, 8, 12, 16, 20, 24, 28]);

    // ratio = 44100 / 16000 = 2.75625; output[1]'s source index is 2.75625,
    // interpolating 75.625% of the way from input[2]=8 to input[3]=12.
    const output = downsampleTo(input, 44100, 16000);

    expect(output[0]).toBeCloseTo(0, 5);
    expect(output[1]).toBeCloseTo(8 + 0.75625 * (12 - 8), 5);
  });

  it('returns a copy, unchanged, when input and output rates match', () => {
    const input = new Float32Array([0.1, 0.2, 0.3]);

    const output = downsampleTo(input, 16000, 16000);

    // Compared as Float32Arrays (not widened to float64 via Array.from) so
    // the float32-rounded literals on both sides line up bit for bit.
    expect(output).toEqual(input);
    expect(output).not.toBe(input);
  });

  // Catches an inverted-ratio bug: this pipeline is downsample-only (mic
  // input is always faster than the 16kHz wire format), so silently
  // "upsampling" via the same interpolation would produce fabricated
  // samples instead of surfacing the misconfiguration.
  it('throws when asked to upsample', () => {
    const input = new Float32Array([0, 1, 2]);

    expect(() => downsampleTo(input, 8000, 16000)).toThrow(/upsample/);
  });
});
