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
/// <param name="Pcm">Raw audio samples, encoded per the producing provider's <see cref="ITtsProvider.OutputFormat"/>.</param>
public sealed record TtsAudioChunk(string UtteranceId, ReadOnlyMemory<byte> Pcm);

/// <summary>
/// The audio format a specific <see cref="ITtsProvider"/> emits its
/// <see cref="TtsAudioChunk"/>s in. A per-provider capability
/// (<see cref="ITtsProvider.OutputFormat"/>) rather than a global constant: providers
/// synthesize at their own native rates, and forcing one shared format on the
/// abstraction would make a non-24kHz provider (e.g. ElevenLabs) resample server-side -
/// exactly the latency cost the cascade avoids by having the frontend playback queue
/// resample instead. Echoed downstream in the <c>tts.audio.start</c> event (see
/// <see cref="CascadeTtsAudioStartPayload"/>) so the client knows how to interpret the
/// raw binary frames that follow.
/// </summary>
/// <param name="SampleRateHz">Samples per second every chunk is encoded at.</param>
/// <param name="BitsPerSample">Bits per sample. Signed, little-endian.</param>
/// <param name="Channels">Audio channel count.</param>
/// <param name="Encoding">Wire-format identifier for the encoding, echoed in the
/// <c>tts.audio.start</c> event.</param>
public sealed record TtsOutputFormat(int SampleRateHz, int BitsPerSample, int Channels, string Encoding)
{
    /// <summary>16-bit little-endian mono PCM (Pulse Code Modulation) at 24 kHz - the
    /// native output rate of OpenAI's TTS models.</summary>
    public static TtsOutputFormat Pcm16Mono24k { get; } =
        new(SampleRateHz: 24_000, BitsPerSample: 16, Channels: 1, Encoding: "pcm16");
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
    /// The format every chunk from <see cref="SynthesizeAsync"/> is encoded in - fixed
    /// for a given provider, surfaced here so the transport can tell the client how to
    /// decode the audio without the abstraction pinning all providers to one vendor's
    /// native rate.
    /// </summary>
    TtsOutputFormat OutputFormat { get; }

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
