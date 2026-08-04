/// <summary>
/// The first real cascade pipeline stage: speech-to-text (STT; #5). Opens an
/// <see cref="ISttProvider"/> stream on session start, forwards every audio chunk into
/// it, and turns the segments it produces into <c>transcript.partial</c> /
/// <c>transcript.final</c> events on the <see cref="CascadeTranscriptLanes.Source"/>
/// lane. Machine translation and text-to-speech (#6-7) subscribe to the same segments
/// via <see cref="ISttSegmentObserver"/> rather than this class changing.
/// </summary>
/// <remarks>
/// Registered as scoped (one instance per WebSocket connection, not a shared
/// singleton) because it holds per-session mutable state - the open
/// <see cref="ISttStream"/> and the background task draining it. See
/// <c>Program.cs</c>'s DI registration.
/// </remarks>
public sealed class CascadePipeline(
    ISttProvider sttProvider,
    IEnumerable<ISttSegmentObserver> segmentObservers,
    ILogger<CascadePipeline> logger) : ICascadePipeline
{
    private ISttStream? _sttStream;
    private Task? _segmentPumpTask;
    private CancellationTokenSource? _pumpCts;

    /// <inheritdoc />
    /// <remarks>
    /// If the STT provider can't be started (most commonly a missing API key), this
    /// sends an <c>error</c> event and leaves the session otherwise alive: the client
    /// stays connected and subsequent audio chunks are silently dropped rather than
    /// the whole session tearing down.
    /// </remarks>
    public async Task OnSessionStartedAsync(CascadeSessionConfig config, ICascadeEventSink events, CancellationToken cancellationToken)
    {
        try
        {
            _sttStream = await sttProvider.StartStreamAsync(new SttStreamConfig(config.SourceLang), cancellationToken);
        }
        catch (SttProviderUnavailableException ex)
        {
            logger.LogError(ex, "Speech-to-text provider could not be started.");
            await events.SendEventAsync(CascadeMessageTypes.Error, new CascadeErrorPayload(ex.Message), cancellationToken);
            return;
        }

        _pumpCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
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

        if (_sttStream is not null)
        {
            await _sttStream.DisposeAsync();
        }

        _pumpCts?.Dispose();
    }

    /// <summary>
    /// Drains <see cref="ISttStream.ReadSegmentsAsync"/> for the lifetime of the
    /// session: every segment becomes a <c>transcript.*</c> event on the sink, then is
    /// handed to every <see cref="ISttSegmentObserver"/>. A provider/stream failure is
    /// reported as an <c>error</c> event rather than propagating and killing the
    /// session - the client can keep the connection open even with STT down.
    /// </summary>
    private async Task PumpSegmentsAsync(ISttStream stream, ICascadeEventSink events, CancellationToken cancellationToken)
    {
        try
        {
            await foreach (var segment in stream.ReadSegmentsAsync(cancellationToken))
            {
                var envelopeType = segment.IsFinal ? CascadeMessageTypes.TranscriptFinal : CascadeMessageTypes.TranscriptPartial;
                await events.SendEventAsync(
                    envelopeType,
                    new CascadeTranscriptPayload(segment.UtteranceId, CascadeTranscriptLanes.Source, segment.Text, segment.TimestampMs),
                    cancellationToken);

                foreach (var observer in segmentObservers)
                {
                    try
                    {
                        await observer.OnSegmentAsync(segment, cancellationToken);
                    }
                    catch (Exception ex) when (ex is not OperationCanceledException)
                    {
                        // A future MT/TTS observer misbehaving shouldn't take down STT
                        // delivery to the client - just log and keep pumping.
                        logger.LogError(ex, "STT segment observer threw for utterance {UtteranceId}.", segment.UtteranceId);
                    }
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
}
