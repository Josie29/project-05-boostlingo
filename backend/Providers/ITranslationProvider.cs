/// <summary>
/// One machine-translation (MT) request: the finalized source text for a single
/// utterance plus the negotiated language pair. There is no streaming input side -
/// unlike STT, which transcribes audio as it arrives, MT only ever runs once a source
/// utterance has settled (an <see cref="SttSegment"/> with <c>IsFinal: true</c>) - so a
/// request is always "whole sentence in."
/// </summary>
/// <param name="SourceText">The finalized source-language text to translate.</param>
/// <param name="SourceLang">Language tag the source text is written in, e.g. <c>"en"</c>.</param>
/// <param name="TargetLang">Language tag to translate into, e.g. <c>"es"</c>.</param>
public sealed record TranslationRequest(string SourceText, string SourceLang, string TargetLang);

/// <summary>
/// Swappable machine-translation backend for cascade mode. A concrete implementation
/// (e.g. <see cref="OpenAiTranslationProvider"/>) is registered once in DI (dependency
/// injection); <see cref="CascadePipeline"/> only ever talks to this interface, so a
/// second MT provider (the stretch swap-demo issue) plugs in without touching pipeline
/// code - mirroring <see cref="ISttProvider"/>'s role for the STT stage.
/// </summary>
public interface ITranslationProvider
{
    /// <summary>
    /// Translates one finalized source utterance, streaming the target-language text
    /// as it becomes available rather than waiting for the whole translation to finish -
    /// callers (<see cref="CascadePipeline"/>, and TTS/#7 behind it) forward each chunk
    /// downstream immediately so nothing sits fully buffered before the first emit.
    /// </summary>
    /// <param name="request">The source text and language pair to translate.</param>
    /// <param name="cancellationToken">Propagates cancellation of the in-flight request.</param>
    /// <returns>An async sequence of token/chunk deltas, in emission order. Concatenating
    /// every yielded value reconstructs the full translation.</returns>
    /// <exception cref="TranslationProviderException">Thrown when the provider cannot
    /// be reached, rejects the request, or the connection fails mid-stream. Callers
    /// should treat this as a failure scoped to the one utterance being translated,
    /// not the whole session.</exception>
    IAsyncEnumerable<string> TranslateAsync(TranslationRequest request, CancellationToken cancellationToken);
}

/// <summary>
/// One chunk of a streaming translation of a single finalized source utterance -
/// either a token delta (<c>IsFinal: false</c>) or the completed translation in full
/// (<c>IsFinal: true</c>), mirroring the partial/final split <see cref="SttSegment"/>
/// uses for STT. This is the seam TTS (#7) hooks into via <see cref="ITranslationObserver"/>
/// to start synthesizing speech from the same token stream the client's target
/// transcript column is rendering, without needing to know MT internals.
/// </summary>
/// <param name="SourceUtteranceId">The <see cref="SttSegment.UtteranceId"/> of the
/// source utterance this translation was produced from, so a subscriber can correlate
/// target-language audio back to the utterance that triggered it.</param>
/// <param name="TargetUtteranceId">The id <see cref="CascadePipeline"/> assigned this
/// translation's target-lane transcript entries (derived from, but distinct from,
/// <paramref name="SourceUtteranceId"/> - see <c>CascadePipeline.TranslateSegmentAsync</c>).</param>
/// <param name="Text">The token delta (partial) or full translated text (final).</param>
/// <param name="IsFinal"><c>true</c> once the translation for this utterance is complete.</param>
/// <param name="TargetLang">Language tag the text is written in, e.g. <c>"es"</c> - the
/// session's negotiated target language, carried on every chunk so a subscriber (TTS/#7)
/// never needs its own copy of the session config to know what language it is
/// synthesizing.</param>
public sealed record TranslationChunk(string SourceUtteranceId, string TargetUtteranceId, string Text, bool IsFinal, string TargetLang);

/// <summary>
/// Lets a later cascade stage (text-to-speech in particular) observe every streamed
/// translation chunk as it's produced, without <see cref="CascadePipeline"/> needing to
/// know that stage exists - mirrors <see cref="ISttSegmentObserver"/>'s role for the STT
/// stage. <see cref="CascadePipeline"/> forwards each chunk to the client's target lane
/// first, then to every registered observer; registering zero observers (the case until
/// #7 lands) is a no-op.
/// </summary>
public interface ITranslationObserver
{
    /// <summary>
    /// Called for every token delta and the one final chunk, after it has already been
    /// sent to the client as a <c>transcript.*</c> event on the target lane.
    /// </summary>
    /// <param name="chunk">The chunk that was just produced.</param>
    /// <param name="events">Sink for any events (or, for TTS/#7, binary audio frames)
    /// the observer wants to push to the client. The same sink <see cref="CascadePipeline"/>
    /// itself used to send the chunk's own <c>transcript.*</c> event.</param>
    /// <param name="cancellationToken">Propagates session cancellation.</param>
    Task OnTranslationChunkAsync(TranslationChunk chunk, ICascadeEventSink events, CancellationToken cancellationToken);
}

/// <summary>
/// Thrown when an <see cref="ITranslationProvider"/> fails to translate one utterance -
/// missing credentials, the provider rejecting the request, or the connection dropping
/// mid-stream. Unlike STT's split between "couldn't start" and "failed mid-stream"
/// (two separate long-lived-connection failure modes), MT has no persistent connection
/// to keep alive across utterances, so a single exception type covers every failure
/// mode for one <see cref="ITranslationProvider.TranslateAsync"/> call.
/// </summary>
public sealed class TranslationProviderException : Exception
{
    /// <summary>Creates the exception with a user-safe message.</summary>
    /// <param name="message">A human-readable, non-sensitive description of what went wrong.</param>
    public TranslationProviderException(string message) : base(message)
    {
    }

    /// <summary>Creates the exception with a user-safe message and the underlying cause.</summary>
    /// <param name="message">A human-readable, non-sensitive description of what went wrong.</param>
    /// <param name="innerException">The lower-level exception that triggered this one.</param>
    public TranslationProviderException(string message, Exception innerException) : base(message, innerException)
    {
    }
}
