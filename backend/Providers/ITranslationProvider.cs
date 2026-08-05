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
/// Resolves which <see cref="ITranslationProvider"/> a cascade session runs on (Lab
/// P1): both providers stay registered, and the choice moves from process startup to
/// <c>session.start</c>. <c>null</c> resolves the <c>TRANSLATION_PROVIDER</c> default,
/// so a client that never picks gets exactly the pre-P1 behavior.
/// </summary>
public interface ITranslationProviderSelector
{
    /// <summary>Resolves a validated provider name (or <c>null</c> for the process default) to its provider.</summary>
    /// <param name="providerName">One of <see cref="StageModels.MtProviders"/>, or <c>null</c>.</param>
    ITranslationProvider Resolve(string? providerName);
}

/// <summary>
/// DI-backed <see cref="ITranslationProviderSelector"/>. Resolves lazily per call so
/// only the provider a session actually uses gets constructed.
/// </summary>
public sealed class TranslationProviderSelector(IServiceProvider services, TranslationProviderName defaultProvider)
    : ITranslationProviderSelector
{
    /// <inheritdoc />
    /// <exception cref="InvalidOperationException">The name is neither known provider —
    /// unreachable for session-negotiated values (CascadeSession validates against
    /// <see cref="StageModels.MtProviders"/> first), so this guards config/code drift.</exception>
    public ITranslationProvider Resolve(string? providerName) => (providerName ?? defaultProvider.Value) switch
    {
        "openai" => services.GetRequiredService<OpenAiTranslationProvider>(),
        "anthropic" => services.GetRequiredService<AnthropicTranslationProvider>(),
        var unknown => throw new InvalidOperationException($"Unknown MT provider '{unknown}'."),
    };
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
/// know that stage exists. <see cref="CascadePipeline"/> forwards each chunk to the client's target lane
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

    /// <summary>
    /// Called instead of a final <see cref="OnTranslationChunkAsync"/> call when a
    /// source utterance's translation ends without ever reaching an <c>IsFinal</c>
    /// chunk (code-review fix) - either a barge-in (#11) cancelled it mid-stream, or
    /// the provider itself failed. Lets an observer that accumulates per-utterance
    /// state across chunks (TTS/#7's <c>TtsCascadeObserver</c> in particular) clear
    /// that state and close out anything already sent to the client (e.g. an
    /// already-opened <c>tts.audio.start</c>) even though no <c>IsFinal</c> chunk is
    /// ever coming for this utterance. Default no-op so an observer with no
    /// per-utterance state of its own (nothing to leak) doesn't need to implement it.
    /// </summary>
    /// <param name="sourceUtteranceId">The <see cref="TranslationChunk.SourceUtteranceId"/> whose translation was aborted.</param>
    /// <param name="targetUtteranceId">The <see cref="TranslationChunk.TargetUtteranceId"/> that utterance's own chunks used.</param>
    /// <param name="events">Sink for any closing event the observer still needs to send (e.g. <c>tts.audio.end</c>).</param>
    /// <param name="cancellationToken">Propagates session cancellation.</param>
    Task OnTranslationAbortedAsync(
        string sourceUtteranceId, string targetUtteranceId, ICascadeEventSink events, CancellationToken cancellationToken) =>
        Task.CompletedTask;
}

/// <summary>
/// Optional capability a <see cref="ITranslationObserver"/> can implement to react to a
/// barge-in (#11): the speaker starting a new utterance while this observer may still
/// have queued or in-flight downstream work for an earlier, unfinished one.
/// <see cref="TtsCascadeObserver"/> is the only implementer today - cancelling whatever
/// phrase it is mid-synthesis on and dropping any phrases still queued behind it for a
/// superseded utterance - but any later per-utterance background stage can opt in the
/// same way <see cref="IAsyncDisposable"/> already lets an observer hook session
/// teardown without <see cref="CascadePipeline"/> needing to know it exists (see
/// <c>CascadePipeline.DisposeObserversAsync</c> for that pattern).
/// </summary>
public interface ICascadeBargeInObserver
{
    /// <summary>
    /// Called once per detected barge-in (#11): a speech-onset signal arrived while
    /// this observer may still have work in flight for one or more earlier utterances.
    /// Implementations should cancel any in-flight per-utterance work immediately (so
    /// no further audio/text for a superseded utterance is produced after this
    /// returns) and report exactly which utterances that affected.
    /// </summary>
    /// <param name="events">Sink for any events the observer wants to push - unused by
    /// today's implementer; <see cref="CascadePipeline"/> sends the aggregated
    /// <see cref="CascadeMessageTypes.BargeIn"/> event itself once every observer has
    /// reported back.</param>
    /// <param name="cancellationToken">Propagates session cancellation.</param>
    /// <returns>The target-lane utterance ids (see <see cref="TranslationChunk.TargetUtteranceId"/>)
    /// this observer just cancelled in-flight work for or dropped queued work for.
    /// Empty if nothing was in flight - a barge-in signal with nothing to cancel must
    /// not be reported as having superseded anything.</returns>
    Task<IReadOnlyCollection<string>> OnBargeInAsync(ICascadeEventSink events, CancellationToken cancellationToken);
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
