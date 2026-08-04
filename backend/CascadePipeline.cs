using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using System.Threading.Channels;

/// <summary>
/// The first two real cascade pipeline stages: speech-to-text (STT; #5) and machine
/// translation (MT; #6). Opens an <see cref="ISttProvider"/> stream on session start,
/// forwards every audio chunk into it, and turns the segments it produces into
/// <c>transcript.partial</c> / <c>transcript.final</c> events on the
/// <see cref="CascadeTranscriptLanes.Source"/> lane. Every finalized source segment is
/// then handed to <see cref="ITranslationProvider"/>, whose streamed token deltas
/// become the same two event types on the <see cref="CascadeTranscriptLanes.Target"/>
/// lane. Text-to-speech (#7, <see cref="TtsCascadeObserver"/>) subscribes to the same
/// translation chunks via <see cref="ITranslationObserver"/> - it needed this class to
/// grow two small, generic hooks (the target language on every <see cref="TranslationChunk"/>,
/// and disposing observers that opt into <see cref="IAsyncDisposable"/>) but no
/// TTS-specific logic of its own.
/// </summary>
/// <remarks>
/// Registered as scoped (one instance per WebSocket connection, not a shared
/// singleton) because it holds per-session mutable state - the open
/// <see cref="ISttStream"/> and the background tasks draining it and the translation
/// queue. See <c>Program.cs</c>'s DI registration.
/// </remarks>
public sealed class CascadePipeline(
    ISttProvider sttProvider,
    ITranslationProvider translationProvider,
    IEnumerable<ISttSegmentObserver> segmentObservers,
    IEnumerable<ITranslationObserver> translationObservers,
    ILogger<CascadePipeline> logger) : ICascadePipeline
{
    private readonly Channel<SttSegment> _translationQueue = Channel.CreateUnbounded<SttSegment>(
        new UnboundedChannelOptions { SingleReader = true, SingleWriter = true });
    private readonly Stopwatch _sessionStopwatch = new();

    /// <summary>
    /// Utterance ids that have already had their <see cref="CascadeLatencyStages.SttFirstPartial"/>
    /// mark sent (#10, per-stage latency instrumentation) - only <see cref="PumpSegmentsAsync"/>
    /// touches this, so no locking is needed despite the field being mutated across
    /// awaits within that single background task.
    /// </summary>
    private readonly HashSet<string> _firstPartialMarked = [];

    /// <summary>
    /// Every source utterance id with a finalized segment currently queued in
    /// <see cref="_translationQueue"/> or actively being translated, mapped to a
    /// cancellation source scoped to that one utterance's translation (#11, barge-in
    /// detection). <see cref="PumpSegmentsAsync"/> adds an entry the moment it queues a
    /// segment for translation; <see cref="TranslateSegmentAsync"/> removes it once
    /// that translation finishes, fails, or is itself cancelled. A
    /// <see cref="ConcurrentDictionary{TKey,TValue}"/> because those two additions/removals
    /// happen from different background tasks (the segment pump and the translation
    /// pump respectively), while <see cref="HandleBargeInAsync"/> - called from the
    /// segment pump's own task - iterates and cancels every entry still present the
    /// instant a new speech-onset marker arrives.
    /// </summary>
    private readonly ConcurrentDictionary<string, CancellationTokenSource> _inFlightMt = new();

    private ISttStream? _sttStream;
    private Task? _segmentPumpTask;
    private Task? _translationPumpTask;
    private CancellationTokenSource? _pumpCts;
    private CascadeSessionConfig? _config;

    /// <inheritdoc />
    /// <remarks>
    /// If the STT provider can't be started (most commonly a missing API key), this
    /// sends an <c>error</c> event and leaves the session otherwise alive: the client
    /// stays connected and subsequent audio chunks are silently dropped rather than
    /// the whole session tearing down.
    /// </remarks>
    public async Task OnSessionStartedAsync(CascadeSessionConfig config, ICascadeEventSink events, CancellationToken cancellationToken)
    {
        _config = config;

        // Looked up from the language registry (rather than passing config.SourceLang
        // straight through) so a provider whose language hint differs from the wire
        // code (see LanguageInfo.SttLanguageHint) picks up that difference for free -
        // CascadeAudioSession.HandleSessionStartAsync already validated config.SourceLang
        // against the same registry before this method is ever called, but the fallback
        // below still guards a direct caller (e.g. a unit test) that skips that step.
        var sttLanguageHint = Languages.Find(config.SourceLang)?.SttLanguageHint ?? config.SourceLang;

        try
        {
            _sttStream = await sttProvider.StartStreamAsync(new SttStreamConfig(sttLanguageHint), cancellationToken);
        }
        catch (SttProviderUnavailableException ex)
        {
            logger.LogError(ex, "Speech-to-text provider could not be started.");
            await events.SendEventAsync(CascadeMessageTypes.Error, new CascadeErrorPayload(ex.Message), cancellationToken);
            return;
        }

        _pumpCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        _sessionStopwatch.Start();
        _translationPumpTask = PumpTranslationsAsync(events, _pumpCts.Token);
        _segmentPumpTask = PumpSegmentsAsync(_sttStream, events, _pumpCts.Token);
    }

    /// <inheritdoc />
    /// <remarks>
    /// Chunks are dropped (not queued) if the STT stream never started or has already
    /// failed - there is nothing useful to do with audio when there is no live
    /// transcription session to feed it into.
    /// </remarks>
    public async Task OnAudioChunkAsync(ReadOnlyMemory<byte> pcm, ICascadeEventSink events, CancellationToken cancellationToken)
    {
        if (_sttStream is null)
        {
            return;
        }

        try
        {
            await _sttStream.SendAudioAsync(pcm, cancellationToken);
        }
        catch (SttProviderStreamException ex)
        {
            logger.LogError(ex, "Speech-to-text provider rejected an audio chunk.");
            await events.SendEventAsync(CascadeMessageTypes.Error, new CascadeErrorPayload(ex.Message), cancellationToken);
        }
    }

    /// <inheritdoc />
    public async Task OnSessionEndedAsync(ICascadeEventSink events, CancellationToken cancellationToken)
    {
        _pumpCts?.Cancel();

        if (_segmentPumpTask is not null)
        {
            try
            {
                await _segmentPumpTask;
            }
            catch (OperationCanceledException)
            {
                // Expected: cancelling _pumpCts above is exactly what stops the pump.
            }
        }

        // Unblocks PumpTranslationsAsync's ReadAllAsync once no more finalized
        // segments are coming - the segment pump above has already stopped writing to
        // this channel by the time we reach here.
        _translationQueue.Writer.TryComplete();

        if (_translationPumpTask is not null)
        {
            try
            {
                await _translationPumpTask;
            }
            catch (OperationCanceledException)
            {
                // Expected: cancelling _pumpCts above is exactly what stops the pump.
            }
        }

        // Anything still queued when the translation pump stopped (rather than having
        // reached TranslateSegmentAsync's own cleanup) never got its _inFlightMt entry
        // disposed - clean those up now instead of leaking a CancellationTokenSource
        // per utterance that happened to still be queued at session end.
        foreach (var sourceUtteranceId in _inFlightMt.Keys.ToArray())
        {
            RemoveInFlightMt(sourceUtteranceId);
        }

        if (_sttStream is not null)
        {
            await _sttStream.DisposeAsync();
        }

        await DisposeObserversAsync();

        _pumpCts?.Dispose();
    }

    /// <summary>
    /// Disposes every registered <see cref="ITranslationObserver"/> that also
    /// implements <see cref="IAsyncDisposable"/> - the seam <see cref="TtsCascadeObserver"/>
    /// uses to drain its per-utterance synthesis pump and release its background task
    /// before the session's socket closes. A generic check here (rather than a
    /// TTS-specific call) keeps this class from needing to change again if a later
    /// stage needs the same cleanup, matching this file's own goal of not changing for
    /// #7.
    /// </summary>
    private async Task DisposeObserversAsync()
    {
        foreach (var observer in translationObservers)
        {
            if (observer is not IAsyncDisposable disposable)
            {
                continue;
            }

            try
            {
                await disposable.DisposeAsync();
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Translation observer failed to dispose cleanly.");
            }
        }
    }

    /// <summary>
    /// Drains <see cref="ISttStream.ReadSegmentsAsync"/> for the lifetime of the
    /// session: every segment becomes a <c>transcript.*</c> event on the sink, then is
    /// handed to every <see cref="ISttSegmentObserver"/>. A provider/stream failure is
    /// reported as an <c>error</c> event rather than propagating and killing the
    /// session - the client can keep the connection open even with STT down. Also emits
    /// this utterance's <see cref="CascadeLatencyStages.SpeechEnd"/>,
    /// <see cref="CascadeLatencyStages.SttFirstPartial"/>, and
    /// <see cref="CascadeLatencyStages.SttFinal"/> latency marks (#10) - a leading
    /// <see cref="SttSegment.SpeechEnd"/> marker segment produces only the speechEnd
    /// mark (no transcript event, no observer notification, no translation queueing).
    /// A leading <see cref="SttSegment.SpeechStart"/> marker (#11, barge-in) is handled
    /// the same way: no transcript event, just a call to <see cref="HandleBargeInAsync"/>.
    /// </summary>
    private async Task PumpSegmentsAsync(ISttStream stream, ICascadeEventSink events, CancellationToken cancellationToken)
    {
        try
        {
            await foreach (var segment in stream.ReadSegmentsAsync(cancellationToken))
            {
                if (segment.IsSpeechStartMarker)
                {
                    await HandleBargeInAsync(events, cancellationToken);
                    continue;
                }

                if (segment.IsSpeechEndMarker)
                {
                    await CascadeLatencyMarks.EmitAsync(
                        segment.UtteranceId, CascadeLatencyStages.SpeechEnd, events, logger, cancellationToken);
                    continue;
                }

                var envelopeType = segment.IsFinal ? CascadeMessageTypes.TranscriptFinal : CascadeMessageTypes.TranscriptPartial;
                await events.SendEventAsync(
                    envelopeType,
                    new CascadeTranscriptPayload(segment.UtteranceId, CascadeTranscriptLanes.Source, segment.Text, segment.TimestampMs),
                    cancellationToken);

                if (segment.IsFinal)
                {
                    await CascadeLatencyMarks.EmitAsync(
                        segment.UtteranceId, CascadeLatencyStages.SttFinal, events, logger, cancellationToken);
                }
                else if (_firstPartialMarked.Add(segment.UtteranceId))
                {
                    await CascadeLatencyMarks.EmitAsync(
                        segment.UtteranceId, CascadeLatencyStages.SttFirstPartial, events, logger, cancellationToken);
                }

                foreach (var observer in segmentObservers)
                {
                    try
                    {
                        await observer.OnSegmentAsync(segment, cancellationToken);
                    }
                    catch (Exception ex) when (ex is not OperationCanceledException)
                    {
                        // A future TTS observer misbehaving shouldn't take down STT
                        // delivery to the client - just log and keep pumping.
                        logger.LogError(ex, "STT segment observer threw for utterance {UtteranceId}.", segment.UtteranceId);
                    }
                }

                if (segment.IsFinal && !string.IsNullOrWhiteSpace(segment.Text))
                {
                    // Registered before the write below, not after, so a barge-in
                    // marker arriving for the very next segment (read by this same
                    // loop, immediately after this iteration) can never race ahead of
                    // HandleBargeInAsync seeing this utterance as in flight (#11).
                    _inFlightMt[segment.UtteranceId] = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);

                    // Non-blocking: queueing a finalized segment for translation must
                    // never stall this loop from reading the next STT segment - see
                    // PumpTranslationsAsync's remarks for why translation runs on its
                    // own background task instead of inline here.
                    _translationQueue.Writer.TryWrite(segment);
                }
            }
        }
        catch (OperationCanceledException)
        {
            // Expected during session teardown (see OnSessionEndedAsync).
        }
        catch (SttProviderStreamException ex)
        {
            logger.LogError(ex, "Speech-to-text stream failed.");
            await events.SendEventAsync(CascadeMessageTypes.Error, new CascadeErrorPayload(ex.Message), cancellationToken);
        }
    }

    /// <summary>
    /// Serializes machine translation for the session: reads finalized source segments
    /// off <see cref="_translationQueue"/> one at a time and fully streams each one's
    /// translation via <see cref="translationProvider"/> - including its target-lane
    /// <c>transcript.final</c> - before starting the next. A plain sequential queue
    /// (rather than, say, a task per utterance) is a deliberate choice: it is the
    /// cheapest way to guarantee two consecutive utterances' target-lane text can never
    /// interleave, at the cost of one utterance's translation delaying the next's if the
    /// provider is slow. For the handful of short utterances in flight in a live cascade
    /// demo, that tradeoff is preferable to the added complexity of a reordering buffer.
    /// Runs on its own task (started in <see cref="OnSessionStartedAsync"/>) rather than
    /// inline inside <see cref="PumpSegmentsAsync"/> so a slow or stuck translation can
    /// never stall <see cref="ISttStream.ReadSegmentsAsync"/> - which, for a real
    /// provider, is reading directly off an open network connection that has to keep
    /// being drained to avoid stalling upstream.
    /// </summary>
    private async Task PumpTranslationsAsync(ICascadeEventSink events, CancellationToken cancellationToken)
    {
        try
        {
            await foreach (var segment in _translationQueue.Reader.ReadAllAsync(cancellationToken))
            {
                await TranslateSegmentAsync(segment, events, cancellationToken);
            }
        }
        catch (OperationCanceledException)
        {
            // Expected during session teardown (see OnSessionEndedAsync).
        }
    }

    /// <summary>
    /// Streams one finalized source segment's translation onto the client's target
    /// lane, forwarding each token the moment it arrives - never buffering the whole
    /// translation before the first emit - and to every registered
    /// <see cref="ITranslationObserver"/> (the seam TTS/#7 hooks into). A translation
    /// failure for this one utterance is reported as an <c>error</c> event and
    /// otherwise swallowed here so it can't take down the session or block translation
    /// of the next queued utterance. Also emits this utterance's
    /// <see cref="CascadeLatencyStages.MtFirstToken"/> and <see cref="CascadeLatencyStages.MtFinal"/>
    /// latency marks (#10), keyed by the source <paramref name="segment"/>'s
    /// <c>UtteranceId</c> - not the derived target-lane id - so every stage's mark for
    /// this utterance shares one key.
    /// </summary>
    /// <remarks>
    /// A barge-in (#11) may have already cancelled - or may cancel while this method is
    /// running - the <see cref="_inFlightMt"/> entry for <paramref name="segment"/>. That
    /// surfaces as <paramref name="cancellationToken"/> itself staying uncancelled while
    /// the per-utterance token this method actually awaits on is cancelled; distinguishing
    /// the two is exactly how this method tells "superseded by a barge-in - drop it
    /// quietly" apart from "the whole session is tearing down - propagate as before".
    /// </remarks>
    private async Task TranslateSegmentAsync(SttSegment segment, ICascadeEventSink events, CancellationToken cancellationToken)
    {
        // Derived from, but distinct from, the source utterance id: the shared
        // transcript reducer keys entries by utteranceId alone (not lane), so reusing
        // the source id here would collide the target-lane text into the already-final
        // source entry instead of opening its own column entry.
        var targetUtteranceId = $"{segment.UtteranceId}-target";

        // Falls back to the session-level token if, somehow, no entry was registered
        // (defensive only - PumpSegmentsAsync always registers one before queueing).
        var translationToken = _inFlightMt.TryGetValue(segment.UtteranceId, out var uttCts) ? uttCts.Token : cancellationToken;

        if (translationToken.IsCancellationRequested && !cancellationToken.IsCancellationRequested)
        {
            // A barge-in (#11) superseded this utterance before its translation ever
            // started - HandleBargeInAsync already sent its transcript.truncated and
            // the aggregated bargein envelope. Never call the provider for it at all.
            RemoveInFlightMt(segment.UtteranceId);
            return;
        }

        var translatedText = new StringBuilder();
        var firstTokenMarked = false;

        try
        {
            var request = new TranslationRequest(segment.Text, _config!.SourceLang, _config.TargetLang);
            await foreach (var token in translationProvider.TranslateAsync(request, translationToken))
            {
                if (token.Length == 0)
                {
                    continue;
                }

                translatedText.Append(token);
                await events.SendEventAsync(
                    CascadeMessageTypes.TranscriptPartial,
                    new CascadeTranscriptPayload(targetUtteranceId, CascadeTranscriptLanes.Target, token, ElapsedSessionMs()),
                    cancellationToken);

                if (!firstTokenMarked)
                {
                    firstTokenMarked = true;
                    await CascadeLatencyMarks.EmitAsync(
                        segment.UtteranceId, CascadeLatencyStages.MtFirstToken, events, logger, cancellationToken);
                }

                await NotifyTranslationObserversAsync(
                    new TranslationChunk(segment.UtteranceId, targetUtteranceId, token, IsFinal: false, _config.TargetLang),
                    events,
                    cancellationToken);
            }
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            // A barge-in (#11) cancelled this utterance's translation mid-stream, not a
            // session teardown (that case falls through to PumpTranslationsAsync's own
            // catch, unchanged from before #11). Whatever partials already reached the
            // target lane above stay there - HandleBargeInAsync's transcript.truncated
            // event is what tells the client this utterance won't get a proper final.
            logger.LogDebug(
                "Machine translation for utterance {UtteranceId} cancelled by a barge-in.", segment.UtteranceId);
            RemoveInFlightMt(segment.UtteranceId);
            return;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogError(ex, "Machine translation failed for utterance {UtteranceId}.", segment.UtteranceId);
            await events.SendEventAsync(
                CascadeMessageTypes.Error,
                new CascadeErrorPayload("Machine translation failed for one utterance."),
                cancellationToken);
            RemoveInFlightMt(segment.UtteranceId);
            return;
        }

        var finalText = translatedText.ToString();
        await events.SendEventAsync(
            CascadeMessageTypes.TranscriptFinal,
            new CascadeTranscriptPayload(targetUtteranceId, CascadeTranscriptLanes.Target, finalText, ElapsedSessionMs()),
            cancellationToken);
        await CascadeLatencyMarks.EmitAsync(segment.UtteranceId, CascadeLatencyStages.MtFinal, events, logger, cancellationToken);
        await NotifyTranslationObserversAsync(
            new TranslationChunk(segment.UtteranceId, targetUtteranceId, finalText, IsFinal: true, _config.TargetLang),
            events,
            cancellationToken);
        RemoveInFlightMt(segment.UtteranceId);
    }

    /// <summary>
    /// Removes and disposes <paramref name="utteranceId"/>'s <see cref="_inFlightMt"/>
    /// entry, if still present - called from every exit path of
    /// <see cref="TranslateSegmentAsync"/> (success, failure, or barge-in cancellation)
    /// so a finished utterance's cancellation source is never left around for a later
    /// barge-in to needlessly try to cancel again.
    /// </summary>
    /// <param name="utteranceId">The source utterance id whose entry to remove.</param>
    private void RemoveInFlightMt(string utteranceId)
    {
        if (_inFlightMt.TryRemove(utteranceId, out var cts))
        {
            cts.Dispose();
        }
    }

    /// <summary>
    /// Reacts to a speech-onset signal (#11, barge-in): cancels every utterance this
    /// pipeline still has queued or in-flight in machine translation (see
    /// <see cref="_inFlightMt"/>), then asks every registered
    /// <see cref="ICascadeBargeInObserver"/> (in practice, <c>TtsCascadeObserver</c>) to
    /// do the same for its own queued/in-flight text-to-speech work. The utterance
    /// currently starting - the one whose speech-onset just triggered this call - is
    /// never among the cancelled ones: it has no finalized segment yet, so it was never
    /// added to <see cref="_inFlightMt"/> or handed to any observer in the first place.
    /// Sends one <see cref="CascadeMessageTypes.TranscriptTruncated"/> event per
    /// superseded utterance, then one aggregated <see cref="CascadeMessageTypes.BargeIn"/>
    /// event - but only if at least one utterance was actually superseded, so a
    /// speech-onset signal arriving with nothing in flight produces no events at all.
    /// </summary>
    private async Task HandleBargeInAsync(ICascadeEventSink events, CancellationToken cancellationToken)
    {
        var superseded = new HashSet<string>();

        foreach (var sourceUtteranceId in _inFlightMt.Keys.ToArray())
        {
            if (_inFlightMt.TryRemove(sourceUtteranceId, out var uttCts))
            {
                uttCts.Cancel();
                uttCts.Dispose();
                superseded.Add($"{sourceUtteranceId}-target");
            }
        }

        foreach (var observer in translationObservers)
        {
            if (observer is not ICascadeBargeInObserver bargeInObserver)
            {
                continue;
            }

            try
            {
                foreach (var targetUtteranceId in await bargeInObserver.OnBargeInAsync(events, cancellationToken))
                {
                    superseded.Add(targetUtteranceId);
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                // Mirrors every other observer failure isolation in this class (see
                // NotifyTranslationObserversAsync) - one misbehaving observer must not
                // stop the barge-in signal from still being handled/reported for the rest.
                logger.LogError(ex, "Barge-in observer threw while cancelling in-flight work.");
            }
        }

        if (superseded.Count == 0)
        {
            return;
        }

        foreach (var targetUtteranceId in superseded)
        {
            await events.SendEventAsync(
                CascadeMessageTypes.TranscriptTruncated, new CascadeTranscriptTruncatedPayload(targetUtteranceId), cancellationToken);
        }

        await events.SendEventAsync(
            CascadeMessageTypes.BargeIn, new CascadeBargeInPayload(superseded, CascadeClock.UtcNowMs()), cancellationToken);
    }

    private async Task NotifyTranslationObserversAsync(
        TranslationChunk chunk, ICascadeEventSink events, CancellationToken cancellationToken)
    {
        foreach (var observer in translationObservers)
        {
            try
            {
                await observer.OnTranslationChunkAsync(chunk, events, cancellationToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                // A future TTS observer misbehaving shouldn't take down MT delivery to
                // the client - just log and keep going, mirroring how STT segment
                // observer failures are handled above.
                logger.LogError(ex, "Translation observer threw for utterance {UtteranceId}.", chunk.SourceUtteranceId);
            }
        }
    }

    private long ElapsedSessionMs() => _sessionStopwatch.ElapsedMilliseconds;
}
