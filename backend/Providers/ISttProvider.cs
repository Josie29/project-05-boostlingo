/// <summary>
/// What one <see cref="SttSegment"/> represents. A single discriminator (rather than
/// independent bool flags) makes the four kinds mutually exclusive by construction -
/// there is no way to build a segment that is simultaneously a final transcript and a
/// speech-end marker, and consumers switch on one value instead of checking flags in a
/// documented order.
/// </summary>
public enum SttSegmentKind
{
    /// <summary>An in-progress transcript update whose text may still change.</summary>
    Partial,

    /// <summary>The settled transcript for this utterance (e.g. VAD (Voice Activity
    /// Detection) decided the speaker stopped).</summary>
    Final,

    /// <summary>A speech-onset marker (#11, barge-in detection) - see
    /// <see cref="SttSegment.SpeechStart"/>. No transcript text, no utterance id.</summary>
    SpeechStart,

    /// <summary>A speech-end boundary marker (#10, per-stage latency instrumentation) -
    /// see <see cref="SttSegment.SpeechEnd"/>. No transcript text.</summary>
    SpeechEnd,
}

/// <summary>
/// A single speech-to-text (STT) segment: a partial or final transcript update, or a
/// VAD boundary marker - see <see cref="SttSegmentKind"/> for the four kinds.
/// </summary>
/// <param name="UtteranceId">Stable id shared by every partial, the one final segment,
/// and the speech-end marker that belong to the same spoken utterance, so consumers
/// can replace rather than append as text firms up and key latency marks
/// consistently. Empty on <see cref="SttSegmentKind.SpeechStart"/> markers (see
/// <see cref="SpeechStart"/>'s remarks).</param>
/// <param name="Text">The transcript text recognized so far (partial) or in full
/// (final); always empty on markers.</param>
/// <param name="Kind">Which of the four kinds this segment is.</param>
/// <param name="TimestampMs">Milliseconds since the stream started, for latency
/// instrumentation and ordering.</param>
/// <param name="AcousticEndAtServerMs">On <see cref="SttSegmentKind.SpeechEnd"/> markers:
/// the <see cref="CascadeClock"/> moment the VAD reported the speaker stopped talking,
/// which is where the perceived-latency window opens. The marker itself rides on the
/// later <em>commit</em>, so backdating to this keeps the VAD's deliberation inside the
/// measurement. <c>null</c> if the provider gave no separate speech-stopped signal.</param>
public sealed record SttSegment(
    string UtteranceId, string Text, SttSegmentKind Kind, long TimestampMs, long? AcousticEndAtServerMs = null)
{
    /// <summary>
    /// Creates a speech-end boundary marker (#10, per-stage latency instrumentation):
    /// no transcript text, just the moment the provider's VAD (Voice Activity
    /// Detection) considered this utterance's speech complete. <paramref name="utteranceId"/>
    /// must be the same id this same utterance's later partial/final transcript
    /// segments use, so a consumer's speechEnd latency mark and its sttFirstPartial/sttFinal
    /// marks all key by one shared utterance id.
    /// </summary>
    /// <param name="utteranceId">The id this utterance's later transcript segments will share.</param>
    /// <param name="timestampMs">Milliseconds since the stream started.</param>
    /// <param name="acousticEndAtServerMs">See <see cref="AcousticEndAtServerMs"/>.</param>
    /// <returns>A <see cref="SttSegmentKind.SpeechEnd"/> marker segment with empty text.</returns>
    public static SttSegment SpeechEnd(string utteranceId, long timestampMs, long? acousticEndAtServerMs = null) =>
        new(utteranceId, Text: string.Empty, SttSegmentKind.SpeechEnd, timestampMs, acousticEndAtServerMs);

    /// <summary>
    /// Creates a speech-onset marker (#11, barge-in detection): no transcript text,
    /// just the moment the provider's VAD detected the speaker starting a new
    /// utterance. Unlike <see cref="SpeechEnd"/>, there is no utterance id to carry
    /// yet - the provider (see <c>OpenAiSttProvider</c>'s remarks on
    /// <c>input_audio_buffer.speech_started</c>) only assigns one once it commits the
    /// utterance, which happens later, at speech end. <see cref="UtteranceId"/> is
    /// therefore always empty on this marker; it is a session-level signal, not one
    /// scoped to a particular utterance.
    /// </summary>
    /// <param name="timestampMs">Milliseconds since the stream started.</param>
    /// <returns>A <see cref="SttSegmentKind.SpeechStart"/> marker segment with empty id/text.</returns>
    public static SttSegment SpeechStart(long timestampMs) =>
        new(UtteranceId: string.Empty, Text: string.Empty, SttSegmentKind.SpeechStart, timestampMs);
}

/// <summary>Per-session configuration an <see cref="ISttProvider"/> needs to start a stream.</summary>
/// <param name="SourceLang">Language tag the speaker is using, e.g. <c>"en"</c>. Providers that
/// support a language hint should use it to improve recognition accuracy.</param>
/// <param name="Model">Session-negotiated STT model (one of <see cref="StageModels.SttModels"/>,
/// already validated), or <c>null</c> for the provider's default.</param>
public sealed record SttStreamConfig(string SourceLang, string? Model = null);

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
    /// long as the stream stays open - plus, if the provider signals it, a leading
    /// <see cref="SttSegment.SpeechEnd"/> marker for an utterance before its transcript
    /// segments arrive (#10, per-stage latency instrumentation), and a
    /// <see cref="SttSegment.SpeechStart"/> marker the moment the speaker begins a new
    /// utterance, ahead of even that (#11, barge-in detection). Completes (without
    /// throwing) when the provider closes the stream normally, and stops early if
    /// <paramref name="cancellationToken"/> is cancelled.
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
public sealed class SttProviderStreamException : Exception
{
    /// <summary>Creates the exception with a user-safe message.</summary>
    /// <param name="message">A human-readable, non-sensitive description of what went wrong.</param>
    public SttProviderStreamException(string message) : base(message)
    {
    }

    /// <summary>Creates the exception with a user-safe message and the underlying cause.</summary>
    /// <param name="message">A human-readable, non-sensitive description of what went wrong.</param>
    /// <param name="innerException">The lower-level exception that triggered this one.</param>
    public SttProviderStreamException(string message, Exception innerException) : base(message, innerException)
    {
    }
}
