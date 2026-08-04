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
public sealed class TtsCascadeObserver : ITranslationObserver, IAsyncDisposable
{
    private readonly ITtsProvider _ttsProvider;
    private readonly ILogger<TtsCascadeObserver> _logger;
    private readonly Channel<QueuedChunk> _queue = Channel.CreateUnbounded<QueuedChunk>(
        new UnboundedChannelOptions { SingleReader = true, SingleWriter = true });
    private readonly CancellationTokenSource _cts = new();
    private readonly Task _pumpTask;

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
        // Never blocks: a slow or stuck TTS synthesis must not stall MT's own
        // transcript.* delivery to the client - see this class's remarks.
        _queue.Writer.TryWrite(new QueuedChunk(chunk, events));
        return Task.CompletedTask;
    }

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
            var chunk = queued.Chunk;
            var events = queued.Events;

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
            // any) still needs synthesizing.
            var remainder = chunker.Flush();
            if (!string.IsNullOrEmpty(remainder))
            {
                (startSent, firstByteMarked) =
                    await SynthesizePhraseAsync(remainder, chunk, events, startSent, firstByteMarked, cancellationToken);
            }

            if (startSent)
            {
                await events.SendEventAsync(
                    CascadeMessageTypes.TtsAudioEnd, new CascadeTtsAudioEndPayload(chunk.TargetUtteranceId), cancellationToken);
                await CascadeLatencyMarks.EmitAsync(
                    chunk.SourceUtteranceId, CascadeLatencyStages.TtsEnd, events, _logger, cancellationToken);
            }

            currentUtteranceId = null;
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
    /// phrases.
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
        if (!startAlreadySent)
        {
            await events.SendEventAsync(
                CascadeMessageTypes.TtsAudioStart,
                new CascadeTtsAudioStartPayload(
                    chunk.TargetUtteranceId, TtsAudioFormat.SampleRateHz, TtsAudioFormat.Encoding, TtsAudioFormat.Channels),
                cancellationToken);
            startAlreadySent = true;
        }

        try
        {
            var request = new TtsRequest(chunk.TargetUtteranceId, phraseText, chunk.TargetLang);
            await foreach (var audioChunk in _ttsProvider.SynthesizeAsync(request, cancellationToken))
            {
                if (!firstByteAlreadyMarked)
                {
                    firstByteAlreadyMarked = true;
                    await CascadeLatencyMarks.EmitAsync(
                        chunk.SourceUtteranceId, CascadeLatencyStages.TtsFirstByte, events, _logger, cancellationToken);
                }

                await events.SendBinaryAsync(audioChunk.Pcm, cancellationToken);
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogError(ex, "Text-to-speech failed for utterance {UtteranceId}.", chunk.TargetUtteranceId);
            await events.SendEventAsync(
                CascadeMessageTypes.Error,
                new CascadeErrorPayload("Text-to-speech failed for one utterance."),
                cancellationToken);
        }

        return (startAlreadySent, firstByteAlreadyMarked);
    }

    private readonly record struct QueuedChunk(TranslationChunk Chunk, ICascadeEventSink Events);
}
