/// <summary>
/// A single speech-to-text (STT) segment - one partial update or the final wording of
/// one utterance. Providers emit a stream of these; <c>IsFinal</c> distinguishes a
/// still-changing partial from the settled transcript for that utterance.
/// </summary>
/// <param name="UtteranceId">Stable id shared by every partial and the one final
/// segment that belong to the same spoken utterance, so consumers can replace rather
/// than append as text firms up.</param>
/// <param name="Text">The transcript text recognized so far (partial) or in full
/// (final).</param>
/// <param name="IsFinal"><c>true</c> once the provider considers this utterance done
/// (e.g. VAD detected the speaker stopped); <c>false</c> for an in-progress partial.</param>
/// <param name="TimestampMs">Milliseconds since the stream started, for latency
/// instrumentation and ordering.</param>
public sealed record SttSegment(string UtteranceId, string Text, bool IsFinal, long TimestampMs);

/// <summary>Per-session configuration an <see cref="ISttProvider"/> needs to start a stream.</summary>
/// <param name="SourceLang">Language tag the speaker is using, e.g. <c>"en"</c>. Providers that
/// support a language hint should use it to improve recognition accuracy.</param>
public sealed record SttStreamConfig(string SourceLang);

/// <summary>
/// One open speech-to-text stream for the lifetime of a cascade session. Callers push
/// audio in and read segments out concurrently - there is no expectation that a chunk
/// sent via <see cref="SendAudioAsync"/> produces a segment before the next chunk is sent.
/// </summary>
public interface ISttStream : IAsyncDisposable
{
    /// <summary>
    /// Forwards one chunk of PCM16 mono audio (see <see cref="CascadeAudioFormat"/> for
    /// the exact format) to the provider.
    /// </summary>
    /// <param name="pcm">Raw PCM16 samples, in arrival order relative to other calls.</param>
    /// <param name="cancellationToken">Propagates cancellation.</param>
    /// <exception cref="SttProviderStreamException">Thrown when the underlying provider
    /// connection can no longer accept audio (e.g. the transport dropped).</exception>
    Task SendAudioAsync(ReadOnlyMemory<byte> pcm, CancellationToken cancellationToken);

    /// <summary>
    /// Reads every segment the provider produces, partials and finals alike, for as
    /// long as the stream stays open. Completes (without throwing) when the provider
    /// closes the stream normally, and stops early if <paramref name="cancellationToken"/>
    /// is cancelled.
    /// </summary>
    /// <param name="cancellationToken">Stops enumeration when cancelled.</param>
    /// <returns>An async sequence of segments in the order the provider emitted them.</returns>
    /// <exception cref="SttProviderStreamException">Thrown from the enumerator when the
    /// provider reports an error or the underlying connection fails mid-stream.</exception>
    IAsyncEnumerable<SttSegment> ReadSegmentsAsync(CancellationToken cancellationToken);
}

/// <summary>
/// Swappable speech-to-text backend for cascade mode. A concrete implementation (e.g.
/// <see cref="OpenAiSttProvider"/>) is registered once in DI (dependency injection);
/// <see cref="CascadePipeline"/> only ever talks to this interface, so a second STT
/// provider (the stretch swap-demo issue) plugs in without touching pipeline code.
/// </summary>
public interface ISttProvider
{
    /// <summary>
    /// Opens a new streaming transcription session.
    /// </summary>
    /// <param name="config">The negotiated session configuration.</param>
    /// <param name="cancellationToken">Propagates cancellation of the connect attempt.</param>
    /// <returns>An open <see cref="ISttStream"/> ready to accept audio.</returns>
    /// <exception cref="SttProviderUnavailableException">Thrown when the stream cannot be
    /// started at all - missing credentials, or the initial connection to the provider
    /// failed. Callers should surface this to the user rather than retry silently.</exception>
    Task<ISttStream> StartStreamAsync(SttStreamConfig config, CancellationToken cancellationToken);
}

/// <summary>
/// Lets a later cascade stage (machine translation in particular) observe every STT
/// segment as it's produced, without the pipeline needing to know that stage exists.
/// <see cref="CascadePipeline"/> forwards each segment to the client first, then to
/// every registered observer - registering zero observers (the case until the
/// translation stage lands) is a no-op.
/// </summary>
public interface ISttSegmentObserver
{
    /// <summary>
    /// Called for every partial and final segment, after it has already been sent to
    /// the client as a <c>transcript.*</c> event.
    /// </summary>
    /// <param name="segment">The segment that was just produced.</param>
    /// <param name="cancellationToken">Propagates session cancellation.</param>
    Task OnSegmentAsync(SttSegment segment, CancellationToken cancellationToken);
}

/// <summary>
/// Thrown when an <see cref="ISttProvider"/> cannot start a stream at all - most
/// commonly a missing API key, but also covers the initial connection to the provider
/// failing. Distinct from <see cref="SttProviderStreamException"/>, which is for a
/// stream that started successfully and later failed.
/// </summary>
public sealed class SttProviderUnavailableException : Exception
{
    /// <summary>Creates the exception with a user-safe message.</summary>
    /// <param name="message">A human-readable, non-sensitive description of what went wrong.</param>
    public SttProviderUnavailableException(string message) : base(message)
    {
    }

    /// <summary>Creates the exception with a user-safe message and the underlying cause.</summary>
    /// <param name="message">A human-readable, non-sensitive description of what went wrong.</param>
    /// <param name="innerException">The lower-level exception that triggered this one.</param>
    public SttProviderUnavailableException(string message, Exception innerException) : base(message, innerException)
    {
    }
}

/// <summary>
/// Thrown from within an open <see cref="ISttStream"/> - either <see cref="ISttStream.SendAudioAsync"/>
/// or the <see cref="ISttStream.ReadSegmentsAsync"/> enumerator - when the provider reports an
/// error or the underlying connection drops mid-session.
/// </summary>
/// <param name="message">A human-readable, non-sensitive description of what went wrong.</param>
public sealed class SttProviderStreamException(string message) : Exception(message);
