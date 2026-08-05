/**
 * Turns an uploaded audio/video file into a MediaStream that impersonates the
 * microphone (Lab P3): the file's audio track plays into a
 * MediaStreamDestination at 1× — real time on purpose, since VAD behavior and
 * every latency number are only honest against natural pacing. Downstream, the
 * existing capture pipeline treats the stream exactly like a mic (including
 * the 24kHz downsample), so nothing session-side knows it's a file.
 *
 * Not unit tested: jsdom has no AudioContext/decodeAudioData. Deliberately
 * thin so everything decision-shaped lives in the testable runner.
 */
export interface FixtureMicStream {
  /** The fake mic. Live for the fixture's duration; silent after it ends. */
  stream: MediaStream;
  durationMs: number;
  /** Resolves when the fixture has finished playing into the stream. */
  ended: Promise<void>;
  /** Stops playback and releases the AudioContext. Idempotent. */
  dispose: () => Promise<void>;
}

/**
 * Decodes the file's audio track and starts it playing into a fresh stream.
 *
 * @param file - Audio (wav/mp3/m4a) or video whose audio track the browser can decode.
 * @throws {Error} When the browser cannot decode the file's audio.
 */
export async function createFixtureMicStream(file: Blob): Promise<FixtureMicStream> {
  const audioContext = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await audioContext.decodeAudioData(await file.arrayBuffer());
  } catch {
    await audioContext.close().catch(() => {});
    throw new Error('Could not decode audio from this file. Try wav, mp3, or m4a.');
  }

  const source = audioContext.createBufferSource();
  source.buffer = decoded;
  const destination = audioContext.createMediaStreamDestination();
  source.connect(destination);

  let resolveEnded!: () => void;
  const ended = new Promise<void>((resolve) => {
    resolveEnded = resolve;
  });
  source.onended = () => resolveEnded();
  source.start();

  return {
    stream: destination.stream,
    durationMs: decoded.duration * 1000,
    ended,
    dispose: async () => {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Already finished on its own.
      }
      resolveEnded();
      if (audioContext.state !== 'closed') {
        await audioContext.close().catch(() => {});
      }
    },
  };
}
