/// <summary>
/// One text-to-speech (TTS) synthesis request: a phrase-sized slice of already
/// translated target-language text for one utterance. Callers (<see cref="TtsCascadeObserver"/>)
/// issue one request per sentence/phrase boundary rather than waiting for a whole
/// utterance's translation to finish, so playback can start well before MT (machine
/// translation; #6) settles the utterance's final target text - mirroring how MT
/// itself never waits for the full source utterance's STT (speech-to-text) transcript
/// to settle before it starts translating a token at a time.
/// </summary>
/// <param name="UtteranceId">The target-lane utterance id (<see cref="TranslationChunk.TargetUtteranceId"/>)
/// this phrase belongs to, echoed onto every <see cref="TtsAudioChunk"/> the request
/// produces so a caller can always tell which utterance a chunk of audio belongs to.</param>
/// <param name="Text">The phrase text to synthesize, already in <paramref name="TargetLang"/>.</param>
/// <param name="TargetLang">Language tag the text is written in, e.g. <c>"es"</c>. Providers
/// that support a language hint should use it to pick an appropriate voice/pronunciation.</param>
public sealed record TtsRequest(string UtteranceId, string Text, string TargetLang);

/// <summary>
/// One chunk of raw synthesized audio produced for a single <see cref="TtsRequest"/>.
/// Concatenating every chunk yielded for one request reconstructs that phrase's full
/// audio - there is no explicit "final" chunk here; the async sequence completing
/// signals the end, mirroring how <see cref="ITranslationProvider.TranslateAsync"/>
/// signals completion of a translation with no explicit final token either.
/// </summary>
/// <param name="UtteranceId">Echoes <see cref="TtsRequest.UtteranceId"/> for the request
/// this chunk was produced from.</param>
/// <param name="Pcm">Raw audio samples, encoded per <see cref="TtsAudioFormat"/>.</param>
public sealed record TtsAudioChunk(string UtteranceId, ReadOnlyMemory<byte> Pcm);

/// <summary>
/// The audio format every <see cref="ITtsProvider"/> implementation must emit. Echoed
/// downstream in the <c>tts.audio.start</c> event (see <see cref="CascadeTtsAudioStartPayload"/>)
/// so the frontend playback queue knows exactly how to interpret and resample the raw
/// binary frames that follow.
/// </summary>
/// <remarks>
/// 24 kHz - not the 16 kHz <see cref="CascadeAudioFormat"/> uses for upstream mic audio -
/// because that is the native PCM (Pulse Code Modulation) output rate OpenAI's TTS
/// models produce. Resampling on the server would cost latency for no quality benefit,
/// so the frontend's playback queue is the one that resamples, same tradeoff
/// <see cref="CascadeAudioFormat"/>'s own remarks call out for the upstream direction.
/// </remarks>
public static class TtsAudioFormat
{
    /// <summary>Samples per second every <see cref="TtsAudioChunk"/> is encoded at.</summary>
    public const int SampleRateHz = 24_000;

    /// <summary>Bits per sample. Signed, little-endian.</summary>
    public const int BitsPerSample = 16;

    /// <summary>Audio channels. Mono only.</summary>
    public const int Channels = 1;

    /// <summary>Wire-format identifier for the encoding, echoed in the <c>tts.audio.start</c> event.</summary>
    public const string Encoding = "pcm16";
}

/// <summary>
/// Swappable text-to-speech backend for cascade mode. A concrete implementation (e.g.
/// <see cref="OpenAiTtsProvider"/>) is registered once in DI (dependency injection);
/// <see cref="TtsCascadeObserver"/> only ever talks to this interface, so a second TTS
/// provider (the stretch swap-demo issue) plugs in without touching pipeline code -
/// mirroring <see cref="ITranslationProvider"/>'s role for the MT stage.
/// </summary>
public interface ITtsProvider
{
    /// <summary>
    /// Synthesizes one phrase of target-language text, streaming audio as it becomes
    /// available rather than waiting for the whole phrase's audio to finish - callers
    /// forward each chunk downstream immediately so nothing sits fully buffered before
    /// the first binary frame reaches the client.
    /// </summary>
    /// <param name="request">The phrase text, its utterance id, and target language.</param>
    /// <param name="cancellationToken">Propagates cancellation of the in-flight request.</param>
    /// <returns>An async sequence of audio chunks, in emission order. Concatenating every
    /// yielded chunk's PCM reconstructs the phrase's full audio.</returns>
    /// <exception cref="TtsProviderException">Thrown when the provider cannot be
    /// reached, rejects the request, or the connection fails mid-stream. Callers should
    /// treat this as a failure scoped to the one phrase being synthesized, not the
    /// whole utterance or session.</exception>
    IAsyncEnumerable<TtsAudioChunk> SynthesizeAsync(TtsRequest request, CancellationToken cancellationToken);
}

/// <summary>
/// Thrown when an <see cref="ITtsProvider"/> fails to synthesize one phrase - missing
/// credentials, the provider rejecting the request, or the connection dropping
/// mid-stream. Mirrors <see cref="TranslationProviderException"/>'s single-exception
/// coverage of every failure mode for one request, since TTS (like MT) has no
/// persistent connection to keep alive across phrases the way STT's <see cref="ISttStream"/> does.
/// </summary>
public sealed class TtsProviderException : Exception
{
    /// <summary>Creates the exception with a user-safe message.</summary>
    /// <param name="message">A human-readable, non-sensitive description of what went wrong.</param>
    public TtsProviderException(string message) : base(message)
    {
    }

    /// <summary>Creates the exception with a user-safe message and the underlying cause.</summary>
    /// <param name="message">A human-readable, non-sensitive description of what went wrong.</param>
    /// <param name="innerException">The lower-level exception that triggered this one.</param>
    public TtsProviderException(string message, Exception innerException) : base(message, innerException)
    {
    }
}
