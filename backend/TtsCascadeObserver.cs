using System.Collections.Concurrent;
using System.Threading.Channels;

/// <summary>
/// The text-to-speech (TTS) cascade stage (#7): subscribes to every streamed
/// <see cref="TranslationChunk"/> via <see cref="ITranslationObserver"/>, feeds token
/// deltas through a <see cref="SentenceChunker"/> per utterance, and synthesizes each
/// completed phrase through <see cref="ITtsProvider"/> as soon as it is available -
/// well before the whole utterance's translation has to finish - turning the result
/// into a <c>tts.audio.start</c> event, one binary WebSocket frame per
/// <see cref="TtsAudioChunk"/>, and a closing <c>tts.audio.end</c> event on the
/// session's <see cref="ICascadeEventSink"/>.
/// </summary>
/// <remarks>
/// <para>
/// <see cref="OnTranslationChunkAsync"/> only ever enqueues; the actual chunking and
/// synthesis run on a single background pump task started in the constructor, for the
/// same reason <see cref="CascadePipeline"/> runs MT (machine translation) on its own
/// task rather than inline inside the STT (speech-to-text) segment pump - synthesizing
/// speech is comparatively slow, and it must never stall the target-lane
/// <c>transcript.*</c> delivery <see cref="CascadePipeline.NotifyTranslationObserversAsync"/>
/// awaits this call from.
/// </para>
/// <para>
/// A single pump task (rather than one task per utterance) is enough to guarantee
/// per-utterance audio never interleaves with another utterance's audio, because
/// <see cref="CascadePipeline"/> already guarantees translation chunks for two
/// utterances are never interleaved on the wire - see its own remarks on why MT uses a
/// plain sequential queue. This class inherits that same ordering for free instead of
/// re-implementing it.
/// </para>
/// </remarks>
public sealed class TtsCascadeObserver : ITranslationObserver, ICascadeBargeInObserver, IProviderWarmup, IAsyncDisposable
{
    private readonly ITtsProvider _ttsProvider;
    private readonly ILogger<TtsCascadeObserver> _logger;
    private readonly Channel<QueuedChunk> _queue = Channel.CreateUnbounded<QueuedChunk>(
        new UnboundedChannelOptions { SingleReader = true, SingleWriter = true });
    private readonly CancellationTokenSource _cts = new();
    private readonly Task _pumpTask;

    /// <summary>
    /// Every target utterance id that has at least one chunk queued or in flight in
    /// <see cref="_queue"/>/<see cref="PumpAsync"/> and has not yet reached its closing
    /// <c>tts.audio.end</c> (#11, barge-in detection). Added the moment the first chunk
    /// for an utterance is enqueued (<see cref="OnTranslationChunkAsync"/>), removed
    /// once <see cref="PumpAsync"/> finishes that utterance's final chunk - whether it
    /// finished normally or was dropped as superseded. A thread-safe set (values are
    /// unused) because <see cref="OnBargeInAsync"/> reads it from a different task than
    /// the one that adds to/removes from it.
    /// </summary>
    private readonly ConcurrentDictionary<string, byte> _pendingUtteranceIds = new();

    /// <summary>
    /// Target utterance ids a barge-in (#11) has superseded but whose remaining queued
    /// chunks <see cref="PumpAsync"/> has not yet drained through. Checked at the top
    /// of every loop iteration so a phrase that was still queued - not yet dequeued -
    /// when the barge-in happened is skipped (no synthesis call, no audio frames, no
    /// closing <c>tts.audio.end</c>) rather than played anyway. Never cleared except by
    /// <see cref="PumpAsync"/> itself once it reaches that utterance's final chunk, at
    /// which point it is removed from both this set and <see cref="_pendingUtteranceIds"/>.
    /// </summary>
    private readonly ConcurrentDictionary<string, byte> _supersededUtteranceIds = new();

    /// <summary>Guards <see cref="_currentPhraseCts"/> against a concurrent read from
    /// <see cref="OnBargeInAsync"/> (a different task than <see cref="PumpAsync"/>,
    /// which owns creating/disposing it).</summary>
    private readonly Lock _phraseCtsLock = new();

    /// <summary>
    /// Cancellation source for whichever phrase <see cref="SynthesizePhraseAsync"/> is
    /// currently mid-synthesis on, or <c>null</c> between phrases. A barge-in (#11)
    /// cancels this to abort the provider stream (and any binary frames still being
    /// sent) for a phrase that had already started before the barge-in was detected -
    /// see <see cref="OnBargeInAsync"/>.
    /// </summary>
    private CancellationTokenSource? _currentPhraseCts;

    /// <summary>Bounded window <see cref="DisposeAsync"/> gives the pump to drain
    /// whatever was already queued before forcing it to stop - mirrors the grace
    /// period <c>CascadeSession.CloseSocketAsync</c> gives the WebSocket close
    /// handshake, for the same "don't hang session teardown forever" reason (a stalled
    /// network call to the TTS provider should not be able to block the socket from
    /// ever closing).</summary>
    private static readonly TimeSpan DisposeDrainTimeout = TimeSpan.FromSeconds(5);

    /// <summary>Creates the observer and immediately starts its background synthesis pump.</summary>
    /// <param name="ttsProvider">Synthesizes each phrase's audio.</param>
    /// <param name="logger">Logs per-phrase synthesis failures.</param>
    public TtsCascadeObserver(ITtsProvider ttsProvider, ILogger<TtsCascadeObserver> logger)
    {
        _ttsProvider = ttsProvider;
        _logger = logger;
        _pumpTask = PumpAsync(_cts.Token);
    }

    /// <inheritdoc />
    public Task OnTranslationChunkAsync(TranslationChunk chunk, ICascadeEventSink events, CancellationToken cancellationToken)
    {
        // Tracked from the first chunk, not just the final one, so a barge-in (#11)
        // arriving mid-utterance already sees it as in flight - see _pendingUtteranceIds.
        _pendingUtteranceIds.TryAdd(chunk.TargetUtteranceId, 0);

        // Never blocks: a slow or stuck TTS synthesis must not stall MT's own
        // transcript.* delivery to the client - see this class's remarks.
        _queue.Writer.TryWrite(new QueuedChunk(chunk, events));
        return Task.CompletedTask;
    }

    /// <inheritdoc />
    /// <remarks>
    /// Code-review fix: <see cref="CascadePipeline.TranslateSegmentAsync"/> calls this
    /// instead of a final <see cref="OnTranslationChunkAsync"/> chunk when an
    /// utterance's translation ends without ever settling - a barge-in (#11)
    /// cancelled it mid-stream, or the provider itself failed. Without this,
    /// <paramref name="targetUtteranceId"/> would never leave <see cref="_pendingUtteranceIds"/>/
    /// <see cref="_supersededUtteranceIds"/> (both only ever cleared by <see cref="PumpAsync"/>
    /// reaching an <c>IsFinal</c> chunk, which is now never coming), and any
    /// already-sent <c>tts.audio.start</c> for it would never get a matching
    /// <c>tts.audio.end</c>. Cancels <see cref="_currentPhraseCts"/> synchronously here
    /// (mirroring <see cref="OnBargeInAsync"/>) rather than only enqueuing, since MT is
    /// strictly sequential - if this observer's pump is mid-synthesis right now, it can
    /// only be synthesizing a phrase from this exact utterance's own already-queued
    /// chunks (no later utterance's chunks can have been enqueued yet). The rest of the
    /// cleanup (removing from both sets, sending a closing <c>tts.audio.end</c> if a
    /// start already went out) is enqueued so it happens in-order relative to any of
    /// this utterance's own chunks still ahead of it in <see cref="_queue"/>.
    /// </remarks>
    public Task OnTranslationAbortedAsync(
        string sourceUtteranceId, string targetUtteranceId, ICascadeEventSink events, CancellationToken cancellationToken)
    {
        lock (_phraseCtsLock)
        {
            _currentPhraseCts?.Cancel();
        }

        _queue.Writer.TryWrite(new QueuedChunk(Chunk: null, Events: events, AbortedTargetUtteranceId: targetUtteranceId));
        return Task.CompletedTask;
    }

    /// <inheritdoc />
    /// <remarks>
    /// Cancels whichever phrase is mid-synthesis right now (if any) via
    /// <see cref="_currentPhraseCts"/>, and marks every other utterance still pending
    /// as superseded so <see cref="PumpAsync"/> drops their remaining queued chunks
    /// without synthesizing or sending audio for them - see <see cref="_supersededUtteranceIds"/>.
    /// </remarks>
    public Task<IReadOnlyCollection<string>> OnBargeInAsync(ICascadeEventSink events, CancellationToken cancellationToken)
    {
        var superseded = _pendingUtteranceIds.Keys.ToArray();
        foreach (var utteranceId in superseded)
        {
            _supersededUtteranceIds.TryAdd(utteranceId, 0);
        }

        lock (_phraseCtsLock)
        {
            _currentPhraseCts?.Cancel();
        }

        return Task.FromResult<IReadOnlyCollection<string>>(superseded);
    }

    /// <inheritdoc />
    /// <remarks>
    /// Forwards to the underlying <see cref="ITtsProvider"/> if it has a connection worth
    /// warming. This indirection is what lets <see cref="CascadePipeline"/> warm the TTS
    /// stage while still knowing nothing about TTS: it only ever sees an
    /// <see cref="ITranslationObserver"/> that happens to also implement
    /// <see cref="IProviderWarmup"/>, exactly as it already does for
    /// <see cref="ICascadeBargeInObserver"/> and <see cref="IAsyncDisposable"/>.
    /// </remarks>
    public Task WarmUpAsync(CancellationToken cancellationToken) =>
        _ttsProvider is IProviderWarmup warmable ? warmable.WarmUpAsync(cancellationToken) : Task.CompletedTask;

    /// <summary>
    /// Stops accepting new work, gives the pump <see cref="DisposeDrainTimeout"/> to
    /// drain whatever was already queued (so the last utterance in flight still gets
    /// its closing <c>tts.audio.end</c> in the common case), then forces it to stop.
    /// Called by <see cref="CascadePipeline"/> during <c>OnSessionEndedAsync</c>,
    /// before the socket closes.
    /// </summary>
    public async ValueTask DisposeAsync()
    {
        _queue.Writer.TryComplete();

        try
        {
            var completed = await Task.WhenAny(_pumpTask, Task.Delay(DisposeDrainTimeout));
            if (completed != _pumpTask)
            {
                _cts.Cancel();
            }

            await _pumpTask;
        }
        catch (OperationCanceledException)
        {
            // Expected if the drain window above expired and cancelled the pump.
        }
        finally
        {
            _cts.Dispose();
        }
    }

    private async Task PumpAsync(CancellationToken cancellationToken)
    {
        var chunker = new SentenceChunker();
        string? currentUtteranceId = null;
        var startSent = false;
        var firstByteMarked = false;

        await foreach (var queued in _queue.Reader.ReadAllAsync(cancellationToken))
        {
            try
            {
                if (queued.AbortedTargetUtteranceId is { } abortedUtteranceId)
                {
                    // Code-review fix: OnTranslationAbortedAsync's queued marker - no
                    // IsFinal chunk is ever coming for this utterance now, so this is
                    // the only place left that can close it out. Only touches pump
                    // state (currentUtteranceId/startSent/firstByteMarked) if this is
                    // genuinely the utterance the pump is on right now; if the pump
                    // hasn't dequeued any of its chunks yet (nothing was ever
                    // synthesized for it), there is nothing to reset.
                    if (abortedUtteranceId == currentUtteranceId)
                    {
                        if (startSent)
                        {
                            await queued.Events!.SendEventAsync(
                                CascadeMessageTypes.TtsAudioEnd, new CascadeTtsAudioEndPayload(abortedUtteranceId), cancellationToken);
                        }

                        currentUtteranceId = null;
                        startSent = false;
                        firstByteMarked = false;
                    }

                    _supersededUtteranceIds.TryRemove(abortedUtteranceId, out _);
                    _pendingUtteranceIds.TryRemove(abortedUtteranceId, out _);
                    continue;
                }

                var chunk = queued.Chunk!;
                var events = queued.Events!;

                if (chunk.TargetUtteranceId != currentUtteranceId)
                {
                    // A new utterance's chunks have started arriving - previous
                    // utterances always reach their IsFinal chunk (handled below) before
                    // this can happen, since CascadePipeline serializes MT per utterance.
                    chunker = new SentenceChunker();
                    currentUtteranceId = chunk.TargetUtteranceId;
                    startSent = false;
                    firstByteMarked = false;
                }

                if (_supersededUtteranceIds.ContainsKey(chunk.TargetUtteranceId))
                {
                    // A barge-in (#11) already cancelled this utterance before this chunk
                    // was dequeued - consume it to keep queue ordering intact, but no
                    // chunking, synthesis, or tts.audio.end for it. The client already
                    // learned this utterance was superseded from the bargein envelope
                    // OnBargeInAsync's caller sent.
                    if (chunk.IsFinal)
                    {
                        _supersededUtteranceIds.TryRemove(chunk.TargetUtteranceId, out _);
                        _pendingUtteranceIds.TryRemove(chunk.TargetUtteranceId, out _);
                        currentUtteranceId = null;
                    }

                    continue;
                }

                if (!chunk.IsFinal)
                {
                    foreach (var phrase in chunker.Append(chunk.Text))
                    {
                        (startSent, firstByteMarked) =
                            await SynthesizePhraseAsync(phrase, chunk, events, startSent, firstByteMarked, cancellationToken);
                    }

                    continue;
                }

                // IsFinal: chunk.Text here is the whole accumulated translation (see
                // TranslationChunk's docs), not a further delta - appending it to the
                // chunker would double-count everything already buffered from the
                // partials above. Only the tail after the chunker's last boundary (if
                // any) still needs synthesizing - unless a barge-in cancelled the phrase
                // this exact chunk was mid-synthesis on (see SynthesizePhraseAsync's own
                // cancellation handling), in which case _supersededUtteranceIds now
                // carries this utterance even though the check above already passed.
                var remainder = chunker.Flush();
                if (!string.IsNullOrEmpty(remainder) && !_supersededUtteranceIds.ContainsKey(chunk.TargetUtteranceId))
                {
                    (startSent, firstByteMarked) =
                        await SynthesizePhraseAsync(remainder, chunk, events, startSent, firstByteMarked, cancellationToken);
                }

                if (startSent && !_supersededUtteranceIds.ContainsKey(chunk.TargetUtteranceId))
                {
                    await events.SendEventAsync(
                        CascadeMessageTypes.TtsAudioEnd, new CascadeTtsAudioEndPayload(chunk.TargetUtteranceId), cancellationToken);
                    await CascadeLatencyMarks.EmitAsync(
                        chunk.SourceUtteranceId, CascadeLatencyStages.TtsEnd, events, _logger, cancellationToken);
                }

                _supersededUtteranceIds.TryRemove(chunk.TargetUtteranceId, out _);
                _pendingUtteranceIds.TryRemove(chunk.TargetUtteranceId, out _);
                currentUtteranceId = null;
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                // Code-review fix: one malformed/unexpected queued item must not kill
                // the whole synthesis pump for the rest of the session - mirrors how
                // SynthesizePhraseAsync already isolates a single phrase's own failure
                // below, just one level up.
                _logger.LogError(ex, "Text-to-speech pump failed processing a queued item; continuing with the next.");
            }
        }
    }

    /// <summary>
    /// Synthesizes one phrase and forwards every audio chunk it produces as a binary
    /// frame, sending the utterance's opening <c>tts.audio.start</c> event first if
    /// this is the first phrase synthesized for it, and its
    /// <see cref="CascadeLatencyStages.TtsFirstByte"/> latency mark (#10) - keyed by
    /// <see cref="TranslationChunk.SourceUtteranceId"/>, matching every other stage's
    /// mark for this utterance - the moment the first audio chunk arrives from the
    /// provider, if this utterance hasn't already had one. A synthesis failure is
    /// reported as an <c>error</c> event and otherwise swallowed - scoped to this one
    /// phrase, never taking down the pump or the rest of the utterance's remaining
    /// phrases. A barge-in (#11) cancelling this exact phrase mid-synthesis is handled
    /// the same way - see the per-phrase <see cref="_currentPhraseCts"/> this method
    /// creates and <see cref="OnBargeInAsync"/>'s remarks - except nothing is reported
    /// to the client here: the aggregated <c>bargein</c> envelope
    /// <c>CascadePipeline.HandleBargeInAsync</c> sends already covers it.
    /// </summary>
    /// <returns>
    /// Whether <c>tts.audio.start</c> and the <c>ttsFirstByte</c> mark have now been
    /// sent for this utterance (whether by this call or an earlier one) - the caller
    /// threads both back in as <paramref name="startAlreadySent"/> and
    /// <paramref name="firstByteAlreadyMarked"/> for the next phrase.
    /// </returns>
    private async Task<(bool StartSent, bool FirstByteMarked)> SynthesizePhraseAsync(
        string phraseText,
        TranslationChunk chunk,
        ICascadeEventSink events,
        bool startAlreadySent,
        bool firstByteAlreadyMarked,
        CancellationToken cancellationToken)
    {
        if (_supersededUtteranceIds.ContainsKey(chunk.TargetUtteranceId))
        {
            // Code-review fix: checked here, before ever sending tts.audio.start, not
            // after - narrows the race between PumpAsync's own superseded check (just
            // before calling this method) and a barge-in landing in that same instant.
            // Checking only after the start send (the previous order) meant a phrase
            // superseded in exactly that window still produced a dangling
            // tts.audio.start with no matching end, since this same check further down
            // (now removed) would already suppress the audio and the closing-end guard
            // in PumpAsync only fires when a start was actually sent.
            return (startAlreadySent, firstByteAlreadyMarked);
        }

        if (!startAlreadySent)
        {
            await events.SendEventAsync(
                CascadeMessageTypes.TtsAudioStart,
                new CascadeTtsAudioStartPayload(
                    chunk.TargetUtteranceId,
                    _ttsProvider.OutputFormat.SampleRateHz,
                    _ttsProvider.OutputFormat.Encoding,
                    _ttsProvider.OutputFormat.Channels),
                cancellationToken);
            startAlreadySent = true;
        }

        // Linked (not the bare pump-level cancellationToken) so OnBargeInAsync can
        // cancel just this one phrase's synthesis without also tearing down the pump
        // task itself - session-level cancellation still propagates through the link.
        CancellationTokenSource phraseCts;
        lock (_phraseCtsLock)
        {
            phraseCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            _currentPhraseCts = phraseCts;
        }

        try
        {
            var request = new TtsRequest(chunk.TargetUtteranceId, phraseText, chunk.TargetLang);
            await foreach (var audioChunk in _ttsProvider.SynthesizeAsync(request, phraseCts.Token))
            {
                if (!firstByteAlreadyMarked)
                {
                    firstByteAlreadyMarked = true;
                    await CascadeLatencyMarks.EmitAsync(
                        chunk.SourceUtteranceId, CascadeLatencyStages.TtsFirstByte, events, _logger, cancellationToken);
                }

                await events.SendBinaryAsync(audioChunk.Pcm, phraseCts.Token);
            }
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            // A barge-in (#11) cancelled just this phrase, not the whole session/pump
            // (that case is allowed to propagate via the exception filter above, same
            // as before #11, so DisposeAsync's drain-timeout mechanism still works).
            // The bargein envelope CascadePipeline sends already tells the client to
            // flush whatever of this utterance's audio it buffered - nothing further
            // to report here.
            _logger.LogDebug(
                "Text-to-speech synthesis for utterance {UtteranceId} cancelled by a barge-in.", chunk.TargetUtteranceId);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogError(
                ex,
                "Text-to-speech failed for utterance {UtteranceId} in session {SessionId} (provider: OpenAI).",
                chunk.TargetUtteranceId,
                events.SessionId);

            // UtteranceId is the source-lane id (see CascadeErrorPayload's remarks),
            // matching every other stage's error/latency-mark keying even though this
            // method otherwise tracks the target-lane id.
            await CascadeErrors.TrySendAsync(
                events,
                CascadeErrorStages.Tts,
                "Text-to-speech failed for one utterance.",
                recoverable: true,
                _logger,
                cancellationToken,
                chunk.SourceUtteranceId);
        }
        finally
        {
            lock (_phraseCtsLock)
            {
                if (ReferenceEquals(_currentPhraseCts, phraseCts))
                {
                    _currentPhraseCts = null;
                }
            }

            phraseCts.Dispose();
        }

        return (startAlreadySent, firstByteAlreadyMarked);
    }

    /// <summary>
    /// One entry in <see cref="_queue"/>: either a real translation chunk to
    /// synthesize (<see cref="Chunk"/> non-null), or an abort marker for
    /// <see cref="AbortedTargetUtteranceId"/> (code-review fix - see
    /// <see cref="OnTranslationAbortedAsync"/>), never both.
    /// </summary>
    private readonly record struct QueuedChunk(
        TranslationChunk? Chunk, ICascadeEventSink? Events, string? AbortedTargetUtteranceId = null);
}
