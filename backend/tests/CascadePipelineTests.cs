using Microsoft.Extensions.Logging.Abstractions;

namespace Boostlingo.Backend.Tests;

public class CascadePipelineTests
{
    /// <summary>
    /// Confirms the session's negotiated source language - not a hardcoded default -
    /// reaches the STT provider as its language hint, and that hint is looked up from
    /// the language registry rather than passed through as some other value. Without
    /// this, a Spanish -> English cascade session could silently transcribe with the
    /// wrong (or a fixed) language hint.
    /// </summary>
    [Fact]
    public async Task OnSessionStartedAsync_PassesRegistryLanguageHint_ForNegotiatedSourceLang()
    {
        var stream = new FakeSttStream();
        var provider = new FakeSttProvider(stream);
        var pipeline = CreatePipeline(provider);
        var sink = new FakeEventSink();

        await pipeline.OnSessionStartedAsync(new CascadeSessionConfig("es", "en"), sink, CancellationToken.None);

        Assert.NotNull(provider.LastConfig);
        Assert.Equal(Languages.Find("es")!.SttLanguageHint, provider.LastConfig!.SourceLang);
    }

    /// <summary>
    /// Confirms audio chunks handed to the pipeline actually reach the STT provider's
    /// stream - without this, the provider never sees any speech to transcribe.
    /// </summary>
    [Fact]
    public async Task OnAudioChunkAsync_ForwardsPcmToProviderStream()
    {
        var stream = new FakeSttStream();
        var pipeline = CreatePipeline(new FakeSttProvider(stream));
        var sink = new FakeEventSink();

        await pipeline.OnSessionStartedAsync(new CascadeSessionConfig("en", "es"), sink, CancellationToken.None);
        var chunk = new byte[] { 9, 8, 7, 6 };
        await pipeline.OnAudioChunkAsync(chunk, sink, CancellationToken.None);

        Assert.Single(stream.SentAudio);
        Assert.Equal(chunk, stream.SentAudio[0]);
    }

    /// <summary>
    /// Confirms partial and final STT segments become the correct transcript envelopes
    /// on the source lane with the frontend-facing field names (utteranceId, lane,
    /// text, timestampMs) - this is the exact contract the frontend's transcript panel
    /// renders from.
    /// </summary>
    [Fact]
    public async Task StreamSegments_BecomeTranscriptEnvelopes_OnSourceLane()
    {
        var stream = new FakeSttStream();
        var pipeline = CreatePipeline(new FakeSttProvider(stream));
        var sink = new FakeEventSink();

        await pipeline.OnSessionStartedAsync(new CascadeSessionConfig("en", "es"), sink, CancellationToken.None);
        stream.Emit(new SttSegment("utt-1", "Hola", SttSegmentKind.Partial, TimestampMs: 100));
        stream.Emit(new SttSegment("utt-1", "Hola mundo", SttSegmentKind.Final, TimestampMs: 250));

        var partial = await sink.Sent.Reader.ReadAsync(TestTimeout());
        var final = await sink.Sent.Reader.ReadAsync(TestTimeout());

        Assert.Equal(CascadeMessageTypes.TranscriptPartial, partial.Type);
        var partialPayload = Assert.IsType<CascadeTranscriptPayload>(partial.Payload);
        Assert.Equal("utt-1", partialPayload.UtteranceId);
        Assert.Equal(CascadeTranscriptLanes.Source, partialPayload.Lane);
        Assert.Equal("Hola", partialPayload.Text);
        Assert.Equal(100, partialPayload.TimestampMs);

        Assert.Equal(CascadeMessageTypes.TranscriptFinal, final.Type);
        var finalPayload = Assert.IsType<CascadeTranscriptPayload>(final.Payload);
        Assert.Equal("Hola mundo", finalPayload.Text);
    }

    /// <summary>
    /// Confirms a missing OPENAI_API_KEY (surfaced as the provider throwing
    /// SttProviderUnavailableException from StartStreamAsync) becomes a clear error
    /// envelope instead of the session crashing or hanging silently.
    /// </summary>
    [Fact]
    public async Task ProviderUnavailableOnStart_SendsErrorEnvelope_WithoutThrowing()
    {
        var pipeline = CreatePipeline(new FakeSttProvider(startException:
            new SttProviderUnavailableException("The server is not configured with an OpenAI API key.")));
        var sink = new FakeEventSink();

        await pipeline.OnSessionStartedAsync(new CascadeSessionConfig("en", "es"), sink, CancellationToken.None);

        var envelope = await sink.Sent.Reader.ReadAsync(TestTimeout());
        Assert.Equal(CascadeMessageTypes.Error, envelope.Type);
        var payload = Assert.IsType<CascadeErrorPayload>(envelope.Payload);
        Assert.Contains("OpenAI API key", payload.Message);

        // #12: STT never started at all - there is no per-utterance retry that could
        // fix this, so the whole session's STT is unrecoverable, not scoped to one
        // utterance.
        Assert.Equal(CascadeErrorStages.Stt, payload.Stage);
        Assert.Null(payload.UtteranceId);
        Assert.False(payload.Recoverable);
    }

    /// <summary>
    /// Confirms that once STT failed to start, subsequent audio chunks are dropped
    /// quietly rather than throwing - a session with STT down should stay connectable,
    /// not repeatedly error or crash on every chunk the client keeps sending.
    /// </summary>
    [Fact]
    public async Task AudioChunk_AfterProviderUnavailable_DoesNotThrow()
    {
        var pipeline = CreatePipeline(new FakeSttProvider(startException:
            new SttProviderUnavailableException("no key")));
        var sink = new FakeEventSink();

        await pipeline.OnSessionStartedAsync(new CascadeSessionConfig("en", "es"), sink, CancellationToken.None);
        await sink.Sent.Reader.ReadAsync(TestTimeout()); // drain the error envelope

        await pipeline.OnAudioChunkAsync(new byte[] { 1, 2 }, sink, CancellationToken.None);
        // No exception means the session survives; nothing else to assert.
    }

    /// <summary>
    /// Confirms an upstream WebSocket/provider failure mid-session (the stream's
    /// segment enumerator throwing) surfaces as a per-stage <c>stt</c> error envelope
    /// (#12) - recoverable, since a reopen attempt is about to follow - rather than
    /// unhandled-exception-ing the background pump task and killing the process.
    /// </summary>
    [Fact]
    public async Task StreamFailureMidSession_SendsErrorEnvelope_WithoutKillingSession()
    {
        var stream = new FakeSttStream();
        var pipeline = CreatePipeline(new FakeSttProvider(stream));
        var sink = new FakeEventSink();

        await pipeline.OnSessionStartedAsync(new CascadeSessionConfig("en", "es"), sink, CancellationToken.None);
        stream.Fail(new SttProviderStreamException("Speech-to-text connection dropped."));

        var envelope = await sink.Sent.Reader.ReadAsync(TestTimeout());
        Assert.Equal(CascadeMessageTypes.Error, envelope.Type);
        var payload = Assert.IsType<CascadeErrorPayload>(envelope.Payload);
        Assert.Equal(CascadeErrorStages.Stt, payload.Stage);
        Assert.True(payload.Recoverable);

        // The session is still usable afterward - ending it must not throw either. No
        // reopenStream was supplied, so the one reopen attempt this triggers (#12) also
        // fails - see StreamFailureMidSession_ReopenFails_SendsUnrecoverableSessionError
        // for that envelope's own assertions.
        await pipeline.OnSessionEndedAsync(sink, CancellationToken.None);
        Assert.Equal(1, stream.DisposeCount);
    }

    /// <summary>
    /// Confirms a mid-session STT (speech-to-text) stream failure attempts exactly one
    /// reopen (#12) - a second <c>StartStreamAsync</c> call - and, when that succeeds,
    /// resumes delivering transcripts from the new stream without the client needing to
    /// restart the session itself.
    /// </summary>
    [Fact]
    public async Task StreamFailureMidSession_ReopenSucceeds_ResumesPumpingFromNewStream()
    {
        var deadStream = new FakeSttStream();
        var newStream = new FakeSttStream();
        var provider = new FakeSttProvider(deadStream, reopenStream: newStream);
        var pipeline = CreatePipeline(provider);
        var sink = new FakeEventSink();

        await pipeline.OnSessionStartedAsync(new CascadeSessionConfig("en", "es"), sink, CancellationToken.None);
        deadStream.Fail(new SttProviderStreamException("Speech-to-text connection dropped."));

        var errorEnvelope = await sink.Sent.Reader.ReadAsync(TestTimeout());
        Assert.Equal(CascadeMessageTypes.Error, errorEnvelope.Type);

        newStream.Emit(new SttSegment("utt-1", "Hola", SttSegmentKind.Final, TimestampMs: 10));
        var transcriptEnvelope = await sink.Sent.Reader.ReadAsync(TestTimeout());
        Assert.Equal(CascadeMessageTypes.TranscriptFinal, transcriptEnvelope.Type);

        // Confirms exactly one reopen attempt: the initial start (call 1) plus the one
        // reopen (call 2), never more even though this test's own assertions could only
        // ever trigger one failure to begin with.
        Assert.Equal(2, provider.StartCallCount);

        // Audio chunks must now flow to the reopened stream, not the dead one.
        await pipeline.OnAudioChunkAsync(new byte[] { 1, 2 }, sink, CancellationToken.None);
        Assert.Single(newStream.SentAudio);
        Assert.Empty(deadStream.SentAudio);

        await pipeline.OnSessionEndedAsync(sink, CancellationToken.None);
    }

    /// <summary>
    /// Confirms that when the one allowed STT (speech-to-text) reopen attempt (#12)
    /// itself fails, the client gets a session-level, unrecoverable error - not another
    /// silent retry loop - so the UI can show persistent "speech recognition is down"
    /// guidance instead of treating it as a one-off hiccup.
    /// </summary>
    [Fact]
    public async Task StreamFailureMidSession_ReopenFails_SendsUnrecoverableSessionError()
    {
        var stream = new FakeSttStream();
        var provider = new FakeSttProvider(stream); // no reopenStream: the reopen attempt fails too
        var pipeline = CreatePipeline(provider);
        var sink = new FakeEventSink();

        await pipeline.OnSessionStartedAsync(new CascadeSessionConfig("en", "es"), sink, CancellationToken.None);
        stream.Fail(new SttProviderStreamException("Speech-to-text connection dropped."));

        var sttErrorEnvelope = await sink.Sent.Reader.ReadAsync(TestTimeout());
        Assert.Equal(CascadeErrorStages.Stt, Assert.IsType<CascadeErrorPayload>(sttErrorEnvelope.Payload).Stage);

        var sessionErrorEnvelope = await sink.Sent.Reader.ReadAsync(TestTimeout());
        Assert.Equal(CascadeMessageTypes.Error, sessionErrorEnvelope.Type);
        var payload = Assert.IsType<CascadeErrorPayload>(sessionErrorEnvelope.Payload);
        Assert.Equal(CascadeErrorStages.Session, payload.Stage);
        Assert.False(payload.Recoverable);

        Assert.Equal(2, provider.StartCallCount);
        await pipeline.OnSessionEndedAsync(sink, CancellationToken.None);
    }

    /// <summary>
    /// Confirms the provider's stream is disposed exactly once when the session ends,
    /// so a real OpenAI WebSocket connection doesn't leak past the cascade session
    /// that opened it.
    /// </summary>
    [Fact]
    public async Task SessionEnded_DisposesProviderStreamExactlyOnce()
    {
        var stream = new FakeSttStream();
        var pipeline = CreatePipeline(new FakeSttProvider(stream));
        var sink = new FakeEventSink();

        await pipeline.OnSessionStartedAsync(new CascadeSessionConfig("en", "es"), sink, CancellationToken.None);
        await pipeline.OnSessionEndedAsync(sink, CancellationToken.None);

        Assert.Equal(1, stream.DisposeCount);
    }

    /// <summary>
    /// Confirms a finalized source segment's translation streams onto the target lane
    /// as individual token partials followed by one final carrying the full text, and
    /// that the same chunks reach every registered <see cref="ITranslationObserver"/> -
    /// the seam TTS/#7 will subscribe through.
    /// </summary>
    [Fact]
    public async Task FinalSourceSegment_StreamsTargetLanePartialsThenFinal_AndNotifiesObservers()
    {
        var stream = new FakeSttStream();
        var observer = new FakeTranslationObserver();
        var translationProvider = new FakeTranslationProvider(_ => Tokens("Hola", " ", "mundo"));
        var pipeline = CreatePipeline(new FakeSttProvider(stream), translationProvider, [observer]);
        var sink = new FakeEventSink();
        var events = new LaneSplitEventReader(sink);

        await pipeline.OnSessionStartedAsync(new CascadeSessionConfig("en", "es"), sink, CancellationToken.None);
        stream.Emit(new SttSegment("utt-1", "Hello world", SttSegmentKind.Final, TimestampMs: 10));

        var targetPartial1 = await events.Target.Reader.ReadAsync(TestTimeout());
        var targetPartial2 = await events.Target.Reader.ReadAsync(TestTimeout());
        var targetPartial3 = await events.Target.Reader.ReadAsync(TestTimeout());
        var targetFinal = await events.Target.Reader.ReadAsync(TestTimeout());

        AssertTargetPayload(targetPartial1, CascadeMessageTypes.TranscriptPartial, "utt-1-target", "Hola");
        AssertTargetPayload(targetPartial2, CascadeMessageTypes.TranscriptPartial, "utt-1-target", " ");
        AssertTargetPayload(targetPartial3, CascadeMessageTypes.TranscriptPartial, "utt-1-target", "mundo");
        AssertTargetPayload(targetFinal, CascadeMessageTypes.TranscriptFinal, "utt-1-target", "Hola mundo");

        Assert.Equal(
            new[] { ("Hola", false), (" ", false), ("mundo", false), ("Hola mundo", true) },
            observer.Chunks.Select(c => (c.Text, c.IsFinal)));
        Assert.All(observer.Chunks, chunk => Assert.Equal("utt-1", chunk.SourceUtteranceId));
        Assert.All(observer.Chunks, chunk => Assert.Equal("utt-1-target", chunk.TargetUtteranceId));

        var request = Assert.Single(translationProvider.Requests);
        Assert.Equal("Hello world", request.SourceText);
        Assert.Equal("en", request.SourceLang);
        Assert.Equal("es", request.TargetLang);
    }

    /// <summary>
    /// Confirms translation is streamed, not buffered: the first target-lane partial
    /// must reach the sink while the provider's stream is still deliberately blocked
    /// on later tokens, not only after the whole translation has finished. Without
    /// this, MT would silently regress into the full-segment-buffering behavior the
    /// #6 issue explicitly forbids (and TTS/#7 would have nothing to start early on).
    /// </summary>
    [Fact]
    public async Task Translation_EmitsFirstPartial_BeforeProviderStreamCompletes()
    {
        var stream = new FakeSttStream();
        var gate = new GatedTokenStream("Hola", "mundo");
        var translationProvider = new FakeTranslationProvider(_ => gate.StreamAsync());
        var pipeline = CreatePipeline(new FakeSttProvider(stream), translationProvider);
        var sink = new FakeEventSink();
        var events = new LaneSplitEventReader(sink);

        await pipeline.OnSessionStartedAsync(new CascadeSessionConfig("en", "es"), sink, CancellationToken.None);
        stream.Emit(new SttSegment("utt-1", "Hello", SttSegmentKind.Final, TimestampMs: 10));

        // The gate is still closed - the fake provider has not been allowed to yield
        // its second token or complete - yet the first partial must already be here.
        var firstPartial = await events.Target.Reader.ReadAsync(TestTimeout());
        AssertTargetPayload(firstPartial, CascadeMessageTypes.TranscriptPartial, "utt-1-target", "Hola");

        gate.Release();
        var secondPartial = await events.Target.Reader.ReadAsync(TestTimeout());
        var final = await events.Target.Reader.ReadAsync(TestTimeout());
        AssertTargetPayload(secondPartial, CascadeMessageTypes.TranscriptPartial, "utt-1-target", "mundo");
        AssertTargetPayload(final, CascadeMessageTypes.TranscriptFinal, "utt-1-target", "Holamundo");
    }

    /// <summary>
    /// Confirms two consecutive utterances' translations never interleave: while the
    /// first utterance's translation is still gated open, the second utterance's
    /// translation must not start - proving the sequential-queue serialization the #6
    /// issue calls for, not just that both eventually complete correctly.
    /// </summary>
    [Fact]
    public async Task TwoUtterances_TranslateSequentially_WithoutInterleaving()
    {
        var stream = new FakeSttStream();
        var gateA = new GatedTokenStream("A1", "A2");
        var callCount = 0;
        var translationProvider = new FakeTranslationProvider(_ =>
        {
            callCount++;
            return callCount == 1 ? gateA.StreamAsync() : Tokens("B1");
        });
        var pipeline = CreatePipeline(new FakeSttProvider(stream), translationProvider);
        var sink = new FakeEventSink();
        var events = new LaneSplitEventReader(sink);

        await pipeline.OnSessionStartedAsync(new CascadeSessionConfig("en", "es"), sink, CancellationToken.None);
        stream.Emit(new SttSegment("utt-a", "Hello", SttSegmentKind.Final, TimestampMs: 10));
        stream.Emit(new SttSegment("utt-b", "World", SttSegmentKind.Final, TimestampMs: 20));

        // Utterance A's first partial arrives, but A's translation is still gated -
        // utterance B (already queued behind it) must not have started translating yet.
        var firstPartial = await events.Target.Reader.ReadAsync(TestTimeout());
        AssertTargetPayload(firstPartial, CascadeMessageTypes.TranscriptPartial, "utt-a-target", "A1");
        Assert.Equal(1, callCount);

        gateA.Release();
        var secondPartial = await events.Target.Reader.ReadAsync(TestTimeout());
        var finalA = await events.Target.Reader.ReadAsync(TestTimeout());
        AssertTargetPayload(secondPartial, CascadeMessageTypes.TranscriptPartial, "utt-a-target", "A2");
        AssertTargetPayload(finalA, CascadeMessageTypes.TranscriptFinal, "utt-a-target", "A1A2");

        var partialB = await events.Target.Reader.ReadAsync(TestTimeout());
        var finalB = await events.Target.Reader.ReadAsync(TestTimeout());
        AssertTargetPayload(partialB, CascadeMessageTypes.TranscriptPartial, "utt-b-target", "B1");
        AssertTargetPayload(finalB, CascadeMessageTypes.TranscriptFinal, "utt-b-target", "B1");
    }

    /// <summary>
    /// Confirms a translation failure for one utterance surfaces as an error envelope
    /// and does not stop a later, unrelated utterance from translating successfully -
    /// isolating one bad translation must never take down the rest of the session.
    /// </summary>
    [Fact]
    public async Task TranslationFailure_ForOneUtterance_SendsError_AndLaterUtteranceStillTranslates()
    {
        var stream = new FakeSttStream();
        var callCount = 0;
        var translationProvider = new FakeTranslationProvider(_ =>
        {
            callCount++;
            return callCount == 1 ? Failing() : Tokens("Bien");
        });
        var pipeline = CreatePipeline(new FakeSttProvider(stream), translationProvider);
        var sink = new FakeEventSink();
        var events = new LaneSplitEventReader(sink);

        await pipeline.OnSessionStartedAsync(new CascadeSessionConfig("en", "es"), sink, CancellationToken.None);
        stream.Emit(new SttSegment("utt-a", "Bad", SttSegmentKind.Final, TimestampMs: 10));

        var errorEnvelope = await events.Other.Reader.ReadAsync(TestTimeout());
        Assert.Equal(CascadeMessageTypes.Error, errorEnvelope.Type);

        // #12: scoped to this one utterance (mt stage, this utterance's source id) and
        // recoverable, since a later utterance below still translates successfully.
        var errorPayload = Assert.IsType<CascadeErrorPayload>(errorEnvelope.Payload);
        Assert.Equal(CascadeErrorStages.Mt, errorPayload.Stage);
        Assert.Equal("utt-a", errorPayload.UtteranceId);
        Assert.True(errorPayload.Recoverable);

        stream.Emit(new SttSegment("utt-b", "Good", SttSegmentKind.Final, TimestampMs: 20));

        var partialB = await events.Target.Reader.ReadAsync(TestTimeout());
        var finalB = await events.Target.Reader.ReadAsync(TestTimeout());
        AssertTargetPayload(partialB, CascadeMessageTypes.TranscriptPartial, "utt-b-target", "Bien");
        AssertTargetPayload(finalB, CascadeMessageTypes.TranscriptFinal, "utt-b-target", "Bien");
    }

    /// <summary>
    /// Confirms a translation failure notifies every registered ITranslationObserver
    /// via OnTranslationAbortedAsync - not just the client-facing error envelope - since
    /// TranslateSegmentAsync's failure exit never sends a final TranslationChunk for
    /// this utterance. Without this, an observer that tracks per-utterance state across
    /// chunks (TTS/#7's TtsCascadeObserver) would never learn the utterance ended,
    /// leaking that state (and, if it had already sent tts.audio.start, leaving the
    /// client with no matching tts.audio.end) for the rest of the session.
    /// </summary>
    [Fact]
    public async Task TranslationFailure_NotifiesObserversOfAbort_WithSourceAndTargetUtteranceIds()
    {
        var stream = new FakeSttStream();
        var observer = new FakeTranslationObserver();
        var translationProvider = new FakeTranslationProvider(_ => Failing());
        var pipeline = CreatePipeline(new FakeSttProvider(stream), translationProvider, [observer]);
        var sink = new FakeEventSink();
        var events = new LaneSplitEventReader(sink);

        await pipeline.OnSessionStartedAsync(new CascadeSessionConfig("en", "es"), sink, CancellationToken.None);
        stream.Emit(new SttSegment("utt-a", "Bad", SttSegmentKind.Final, TimestampMs: 10));

        var errorEnvelope = await events.Other.Reader.ReadAsync(TestTimeout());
        Assert.Equal(CascadeMessageTypes.Error, errorEnvelope.Type);

        // Draining the session (which awaits the translation pump to finish) guarantees
        // TranslateSegmentAsync's own abort notification - which runs immediately after
        // the error send above, on the same background task - has completed too.
        await pipeline.OnSessionEndedAsync(sink, CancellationToken.None);

        var aborted = Assert.Single(observer.AbortedCalls);
        Assert.Equal("utt-a", aborted.SourceUtteranceId);
        Assert.Equal("utt-a-target", aborted.TargetUtteranceId);
    }

    /// <summary>
    /// Confirms a finalized STT (speech-to-text) segment with only whitespace text is
    /// still delivered to the client's source-lane transcript (so the frontend sees the
    /// speaker's turn ended), but never reaches machine translation at all (#12) - there
    /// is nothing worth translating, so no request, no error, and no target-lane events
    /// for it should ever be produced.
    /// </summary>
    [Fact]
    public async Task EmptyFinalSttSegment_SkipsTranslation_NoMtRequest()
    {
        var stream = new FakeSttStream();
        var translationProvider = new FakeTranslationProvider(_ => Tokens("should never be requested"));
        var pipeline = CreatePipeline(new FakeSttProvider(stream), translationProvider);
        var sink = new FakeEventSink();

        await pipeline.OnSessionStartedAsync(new CascadeSessionConfig("en", "es"), sink, CancellationToken.None);
        stream.Emit(new SttSegment("utt-1", "   ", SttSegmentKind.Final, TimestampMs: 10));

        var envelope = await sink.Sent.Reader.ReadAsync(TestTimeout());
        Assert.Equal(CascadeMessageTypes.TranscriptFinal, envelope.Type);

        // Draining the session (which awaits the translation pump to finish) guarantees
        // that if a translation request had been queued, it would have already been
        // issued to the fake provider by the time we assert below.
        await pipeline.OnSessionEndedAsync(sink, CancellationToken.None);
        Assert.Empty(translationProvider.Requests);
    }

    /// <summary>
    /// Confirms every translation chunk carries the session's negotiated target
    /// language - the field TTS/#7 relies on to know what language it is
    /// synthesizing without needing its own copy of the session config.
    /// </summary>
    [Fact]
    public async Task FinalSourceSegment_NotifiesObservers_WithSessionTargetLang()
    {
        var stream = new FakeSttStream();
        var observer = new FakeTranslationObserver();
        var translationProvider = new FakeTranslationProvider(_ => Tokens("Hola"));
        var pipeline = CreatePipeline(new FakeSttProvider(stream), translationProvider, [observer]);
        var sink = new FakeEventSink();
        var events = new LaneSplitEventReader(sink);

        await pipeline.OnSessionStartedAsync(new CascadeSessionConfig("en", "es"), sink, CancellationToken.None);
        stream.Emit(new SttSegment("utt-1", "Hello", SttSegmentKind.Final, TimestampMs: 10));

        // Draining through the final target-lane envelope guarantees the pipeline's
        // synchronous continuation - which notifies observers for that same token
        // immediately after sending it - has already run (see the sibling test above
        // for the same pattern).
        await events.Target.Reader.ReadAsync(TestTimeout());
        await events.Target.Reader.ReadAsync(TestTimeout());

        Assert.NotEmpty(observer.Chunks);
        Assert.All(observer.Chunks, chunk => Assert.Equal("es", chunk.TargetLang));
    }

    /// <summary>
    /// Confirms a translation observer that also implements IAsyncDisposable (the
    /// shape TTS/#7's TtsCascadeObserver takes) is disposed exactly once when the
    /// session ends - without this, TTS could never drain its per-utterance
    /// synthesis pump or release its background task before the socket closes.
    /// </summary>
    [Fact]
    public async Task SessionEnded_DisposesAsyncDisposableTranslationObserver_ExactlyOnce()
    {
        var stream = new FakeSttStream();
        var observer = new FakeAsyncDisposableTranslationObserver();
        var pipeline = CreatePipeline(new FakeSttProvider(stream), translationObservers: [observer]);
        var sink = new FakeEventSink();

        await pipeline.OnSessionStartedAsync(new CascadeSessionConfig("en", "es"), sink, CancellationToken.None);
        await pipeline.OnSessionEndedAsync(sink, CancellationToken.None);

        Assert.Equal(1, observer.DisposeCount);
    }

    /// <summary>
    /// Confirms the speechEnd mark is stamped at the acoustic boundary the provider
    /// reported, not at the moment the marker reached the pipeline. The provider only
    /// learns the utterance's id when its VAD commits, which is later - under semantic
    /// VAD, deliberately so - and that wait is time the listener spends waiting. Losing
    /// the backdating here shortens every cascade measurement by exactly the VAD's
    /// deliberation, which is the bias that made cascade look faster than it is.
    /// </summary>
    [Fact]
    public async Task SpeechEndMark_IsBackdated_ToTheProvidersAcousticBoundary()
    {
        var stream = new FakeSttStream();
        var pipeline = CreatePipeline(new FakeSttProvider(stream), new FakeTranslationProvider(_ => Tokens("Hola")), []);
        var sink = new FakeEventSink();

        await pipeline.OnSessionStartedAsync(new CascadeSessionConfig("en", "es"), sink, CancellationToken.None);
        var acousticEndMs = CascadeClock.UtcNowMs() - 750;
        stream.Emit(SttSegment.SpeechEnd("utt-1", 5, acousticEndMs));

        var mark = await sink.Marks.Reader.ReadAsync(TestTimeout());

        Assert.Equal(CascadeLatencyStages.SpeechEnd, mark.Stage);
        Assert.Equal(acousticEndMs, mark.ServerTimeMs);

        await pipeline.OnSessionEndedAsync(sink, CancellationToken.None);
    }

    /// <summary>
    /// Confirms one spoken utterance produces all eight latency marks (#10), in the
    /// order the cascade actually reaches those boundaries - speechEnd, then the STT
    /// pair, then the MT pair, then the TTS trio - each keyed by the same source
    /// utteranceId, and that their serverTimeMs values never decrease across the run.
    /// This is the exact sequence the frontend's latency panel groups by utteranceId
    /// and renders as a per-stage breakdown; losing the order or the shared key would
    /// silently corrupt that breakdown without any single stage's own test catching it.
    /// </summary>
    [Fact]
    public async Task FullUtterance_EmitsLatencyMarks_InStageOrder_WithSharedUtteranceId_AndMonotonicTimestamps()
    {
        var stream = new FakeSttStream();
        var ttsProvider = new FakeTtsProvider(request => Chunks(request.UtteranceId, [1, 2]));
        var ttsObserver = new TtsCascadeObserver(ttsProvider, NullLogger<TtsCascadeObserver>.Instance);
        var translationProvider = new FakeTranslationProvider(_ => Tokens("Hola"));
        var pipeline = CreatePipeline(new FakeSttProvider(stream), translationProvider, [ttsObserver]);
        var sink = new FakeEventSink();

        await pipeline.OnSessionStartedAsync(new CascadeSessionConfig("en", "es"), sink, CancellationToken.None);
        stream.Emit(SttSegment.SpeechEnd("utt-1", 5));
        stream.Emit(new SttSegment("utt-1", "Hello", SttSegmentKind.Partial, TimestampMs: 10));
        stream.Emit(new SttSegment("utt-1", "Hello world", SttSegmentKind.Final, TimestampMs: 50));

        string[] expectedStages =
        [
            CascadeLatencyStages.SpeechEnd,
            CascadeLatencyStages.SttFirstPartial,
            CascadeLatencyStages.SttFinal,
            CascadeLatencyStages.MtFirstToken,
            CascadeLatencyStages.MtFinal,
            CascadeLatencyStages.TtsRequestSent,
            CascadeLatencyStages.TtsFirstByte,
            CascadeLatencyStages.TtsEnd,
        ];

        var marks = new List<CascadeLatencyMarkPayload>();
        foreach (var _ in expectedStages)
        {
            marks.Add(await sink.Marks.Reader.ReadAsync(TestTimeout()));
        }

        Assert.Equal(expectedStages, marks.Select(m => m.Stage));
        Assert.All(marks, mark => Assert.Equal("utt-1", mark.UtteranceId));
        for (var i = 1; i < marks.Count; i++)
        {
            Assert.True(
                marks[i].ServerTimeMs >= marks[i - 1].ServerTimeMs,
                $"Mark '{marks[i].Stage}' ({marks[i].ServerTimeMs}) preceded '{marks[i - 1].Stage}' ({marks[i - 1].ServerTimeMs}).");
        }

        await pipeline.OnSessionEndedAsync(sink, CancellationToken.None);
    }

    private static async IAsyncEnumerable<TtsAudioChunk> Chunks(string utteranceId, params byte[] frames)
    {
        foreach (var frame in frames)
        {
            await Task.Yield();
            yield return new TtsAudioChunk(utteranceId, new[] { frame });
        }
    }

    private static async IAsyncEnumerable<string> Tokens(params string[] tokens)
    {
        foreach (var token in tokens)
        {
            await Task.Yield();
            yield return token;
        }
    }

    private static async IAsyncEnumerable<string> Failing()
    {
        await Task.Yield();
        throw new TranslationProviderException("upstream rejected the request");
#pragma warning disable CS0162 // Unreachable code: required so the compiler sees this as an iterator.
        yield break;
#pragma warning restore CS0162
    }

    private static void AssertTargetPayload(
        (string Type, object? Payload) envelope, string expectedType, string expectedUtteranceId, string expectedText)
    {
        Assert.Equal(expectedType, envelope.Type);
        var payload = Assert.IsType<CascadeTranscriptPayload>(envelope.Payload);
        Assert.Equal(expectedUtteranceId, payload.UtteranceId);
        Assert.Equal(CascadeTranscriptLanes.Target, payload.Lane);
        Assert.Equal(expectedText, payload.Text);
    }

    /// <summary>
    /// Confirms starting a session opens the MT and TTS providers' connections up front,
    /// reaching TTS through its observer rather than knowing TTS exists. Without this,
    /// the first utterance of every session pays DNS/TCP/TLS to each provider inside its
    /// own measured latency - the cost that lands in the mtFirstToken and ttsFirstByte
    /// spans the latency panel reports.
    /// </summary>
    [Fact]
    public async Task OnSessionStartedAsync_WarmsMtAndTtsProviderConnections()
    {
        var translationProvider = new WarmableTranslationProvider();
        var ttsObserver = new WarmableTranslationObserver();
        var pipeline = CreatePipeline(
            new FakeSttProvider(new FakeSttStream()), translationProvider, [ttsObserver]);

        await pipeline.OnSessionStartedAsync(new CascadeSessionConfig("en", "es"), new FakeEventSink(), TestTimeout());

        // Warming is deliberately fire-and-forget, so both waits (not a synchronous
        // assertion) are what prove it was actually started rather than skipped.
        await translationProvider.Warmed.WaitAsync(TestTimeout());
        await ttsObserver.Warmed.WaitAsync(TestTimeout());
    }

    /// <summary>
    /// Confirms a provider whose warm-up fails - offline, bad key, provider down - still
    /// leaves a fully working session that transcribes audio. Warming is purely an
    /// optimization, so a session refusing to start (or silently dropping audio) because
    /// a throwaway request failed would be a strict regression on the behavior that
    /// existed before it.
    /// </summary>
    [Fact]
    public async Task OnSessionStartedAsync_StartsWorkingSession_WhenWarmUpThrows()
    {
        var stream = new FakeSttStream();
        var pipeline = CreatePipeline(
            new FakeSttProvider(stream), new WarmableTranslationProvider(throwOnWarmUp: true));
        var sink = new FakeEventSink();

        await pipeline.OnSessionStartedAsync(new CascadeSessionConfig("en", "es"), sink, TestTimeout());
        var chunk = new byte[] { 4, 3, 2, 1 };
        await pipeline.OnAudioChunkAsync(chunk, sink, TestTimeout());

        Assert.Single(stream.SentAudio);
        Assert.Equal(chunk, stream.SentAudio[0]);
    }

    private static CascadePipeline CreatePipeline(
        ISttProvider provider,
        ITranslationProvider? translationProvider = null,
        IEnumerable<ITranslationObserver>? translationObservers = null) =>
        new(
            provider,
            new FixedTranslationProviderSelector(translationProvider ?? new FakeTranslationProvider(_ => Tokens())),
            translationObservers ?? [],
            NullLogger<CascadePipeline>.Instance);

    private static CancellationToken TestTimeout() => new CancellationTokenSource(TimeSpan.FromSeconds(5)).Token;
}

/// <summary>
/// Records every envelope sent, so tests can assert on the exact shape the frontend
/// receives. <c>latency.mark</c> envelopes (#10) are routed to the separate
/// <see cref="Marks"/> channel instead of <see cref="Sent"/> - mirroring how
/// <see cref="LaneSplitEventReader"/> demultiplexes transcript lanes - so every test
/// written before latency instrumentation existed keeps reading exactly the sequence of
/// envelopes it always did, without needing to filter marks out itself.
/// </summary>
file sealed class FakeEventSink : ICascadeEventSink
{
    public Guid SessionId { get; } = Guid.NewGuid();

    public System.Threading.Channels.Channel<(string Type, object? Payload)> Sent { get; } =
        System.Threading.Channels.Channel.CreateUnbounded<(string Type, object? Payload)>();

    public System.Threading.Channels.Channel<CascadeLatencyMarkPayload> Marks { get; } =
        System.Threading.Channels.Channel.CreateUnbounded<CascadeLatencyMarkPayload>();

    public Task SendEventAsync(string type, object? payload, CancellationToken cancellationToken)
    {
        if (type == CascadeMessageTypes.LatencyMark && payload is CascadeLatencyMarkPayload mark)
        {
            Marks.Writer.TryWrite(mark);
        }
        else
        {
            Sent.Writer.TryWrite((type, payload));
        }

        return Task.CompletedTask;
    }

    public Task SendBinaryAsync(ReadOnlyMemory<byte> data, CancellationToken cancellationToken)
    {
        return Task.CompletedTask;
    }
}

/// <summary>
/// Demultiplexes a <see cref="FakeEventSink"/>'s single envelope stream into one
/// channel per transcript lane (plus a catch-all for non-transcript envelopes, e.g.
/// <c>error</c>), so tests asserting on the target lane's partial/final sequence don't
/// have to race against - or accidentally consume - the source lane's independently
/// produced events on the same underlying sink. The two lanes are genuinely produced
/// by two different background tasks in <see cref="CascadePipeline"/> (the STT segment
/// pump and the MT translation pump), so their relative arrival order on the raw sink
/// is not guaranteed and is not part of the frozen contract either lane's consumer
/// (the frontend transcript reducer groups strictly by utterance id) relies on.
/// </summary>
file sealed class LaneSplitEventReader
{
    public System.Threading.Channels.Channel<(string Type, object? Payload)> Source { get; } =
        System.Threading.Channels.Channel.CreateUnbounded<(string Type, object? Payload)>();

    public System.Threading.Channels.Channel<(string Type, object? Payload)> Target { get; } =
        System.Threading.Channels.Channel.CreateUnbounded<(string Type, object? Payload)>();

    public System.Threading.Channels.Channel<(string Type, object? Payload)> Other { get; } =
        System.Threading.Channels.Channel.CreateUnbounded<(string Type, object? Payload)>();

    public LaneSplitEventReader(FakeEventSink sink) => _ = PumpAsync(sink);

    private async Task PumpAsync(FakeEventSink sink)
    {
        await foreach (var envelope in sink.Sent.Reader.ReadAllAsync())
        {
            var writer = (envelope.Payload as CascadeTranscriptPayload)?.Lane switch
            {
                CascadeTranscriptLanes.Source => Source.Writer,
                CascadeTranscriptLanes.Target => Target.Writer,
                _ => Other.Writer,
            };
            writer.TryWrite(envelope);
        }
    }
}

/// <summary>
/// A controllable <see cref="ISttProvider"/> - either fails to start, or hands back a
/// <see cref="FakeSttStream"/>. <paramref name="reopenStream"/> controls what happens on
/// the second and later calls (#12, error handling hardening's one-reopen-attempt path
/// in <c>CascadePipeline.TryReopenSttStreamAsync</c>): supplying it makes the reopen
/// succeed with a fresh stream; leaving it <c>null</c> (the default) makes every reopen
/// attempt fail, mirroring a provider that stays down after the first stream died.
/// </summary>
file sealed class FakeSttProvider(FakeSttStream? stream = null, Exception? startException = null, FakeSttStream? reopenStream = null)
    : ISttProvider
{
    /// <summary>The config the pipeline most recently started a stream with, so tests can
    /// assert the negotiated language actually reached the provider.</summary>
    public SttStreamConfig? LastConfig { get; private set; }

    /// <summary>How many times <see cref="StartStreamAsync"/> has been called - 1 for the
    /// session's initial start, 2+ for each reopen attempt - so tests can assert a
    /// reopen was attempted exactly once.</summary>
    public int StartCallCount { get; private set; }

    public Task<ISttStream> StartStreamAsync(SttStreamConfig config, CancellationToken cancellationToken)
    {
        StartCallCount++;
        LastConfig = config;

        if (StartCallCount == 1)
        {
            return startException is not null
                ? throw startException
                : Task.FromResult<ISttStream>(stream!);
        }

        return reopenStream is not null
            ? Task.FromResult<ISttStream>(reopenStream)
            : throw new SttProviderUnavailableException("Speech-to-text reopen failed.");
    }
}

/// <summary>
/// A controllable <see cref="ISttStream"/>: records audio sent to it, and lets a test
/// push segments (or an exception) into <see cref="ReadSegmentsAsync"/> on demand -
/// the same "fake the far side" pattern <c>FakeCascadePipeline</c> uses in
/// <c>CascadeAudioSessionTests</c>, one layer further into the pipeline.
/// </summary>
file sealed class FakeSttStream : ISttStream
{
    private readonly System.Threading.Channels.Channel<SttSegment> _segments =
        System.Threading.Channels.Channel.CreateUnbounded<SttSegment>();

    public List<byte[]> SentAudio { get; } = [];

    public int DisposeCount { get; private set; }

    public void Emit(SttSegment segment) => _segments.Writer.TryWrite(segment);

    public void Fail(Exception exception) => _segments.Writer.TryComplete(exception);

    public Task SendAudioAsync(ReadOnlyMemory<byte> pcm, CancellationToken cancellationToken)
    {
        SentAudio.Add(pcm.ToArray());
        return Task.CompletedTask;
    }

    public IAsyncEnumerable<SttSegment> ReadSegmentsAsync(CancellationToken cancellationToken) =>
        _segments.Reader.ReadAllAsync(cancellationToken);

    public ValueTask DisposeAsync()
    {
        DisposeCount++;
        return ValueTask.CompletedTask;
    }
}

/// <summary>
/// A controllable <see cref="ITranslationProvider"/>: records every request it
/// receives and hands back whatever token stream the test's <paramref name="respond"/>
/// callback produces for that request - letting tests script normal completion,
/// gated/delayed completion, or failure per call.
/// </summary>
file sealed class FakeTranslationProvider(Func<TranslationRequest, IAsyncEnumerable<string>> respond) : ITranslationProvider
{
    public List<TranslationRequest> Requests { get; } = [];

    public IAsyncEnumerable<string> TranslateAsync(TranslationRequest request, CancellationToken cancellationToken)
    {
        Requests.Add(request);
        return respond(request);
    }
}

/// <summary>
/// A controllable <see cref="ITtsProvider"/> - the same "fake the far side" shape as
/// <see cref="FakeTranslationProvider"/>, needed here (rather than reusing
/// <c>TtsCascadeObserverTests</c>' own copy, which is file-scoped to that file) so a
/// full end-to-end latency-mark test can wire a real <see cref="TtsCascadeObserver"/>
/// into <see cref="CascadePipeline"/> without a real TTS backend.
/// </summary>
file sealed class FakeTtsProvider(Func<TtsRequest, IAsyncEnumerable<TtsAudioChunk>> respond) : ITtsProvider
{
    public TtsOutputFormat OutputFormat => TtsOutputFormat.Pcm16Mono24k;

    public IAsyncEnumerable<TtsAudioChunk> SynthesizeAsync(TtsRequest request, CancellationToken cancellationToken) =>
        respond(request);
}

/// <summary>
/// An <see cref="ITranslationProvider"/> that also opts into <see cref="IProviderWarmup"/>,
/// so tests can observe whether the pipeline warmed it - or, with
/// <paramref name="throwOnWarmUp"/>, that a warm-up failure is contained.
/// </summary>
/// <param name="throwOnWarmUp">Whether <c>WarmUpAsync</c> should throw, standing in for a
/// provider that is unreachable when the session starts.</param>
file sealed class WarmableTranslationProvider(bool throwOnWarmUp = false) : ITranslationProvider, IProviderWarmup
{
    private readonly TaskCompletionSource _warmed = new(TaskCreationOptions.RunContinuationsAsynchronously);

    /// <summary>Completes once <see cref="WarmUpAsync"/> has been called.</summary>
    public Task Warmed => _warmed.Task;

    /// <summary>Never exercised by the warm-up tests - they never let an utterance settle.</summary>
    public IAsyncEnumerable<string> TranslateAsync(TranslationRequest request, CancellationToken cancellationToken) =>
        NoTokens();

    public Task WarmUpAsync(CancellationToken cancellationToken)
    {
        _warmed.TrySetResult();
        if (throwOnWarmUp)
        {
            // Synchronously, not as a faulted task: the harsher of the two shapes an
            // implementation could fail in, and the one that would escape a try/catch
            // written around the await instead of around the call.
            throw new InvalidOperationException("Warm-up failed.");
        }

        return Task.CompletedTask;
    }

    private static async IAsyncEnumerable<string> NoTokens()
    {
        await Task.CompletedTask;
        yield break;
    }
}

/// <summary>
/// An <see cref="ITranslationObserver"/> that opts into <see cref="IProviderWarmup"/> the
/// way <see cref="TtsCascadeObserver"/> does - the seam that lets the pipeline warm the
/// TTS stage without depending on it.
/// </summary>
file sealed class WarmableTranslationObserver : ITranslationObserver, IProviderWarmup
{
    private readonly TaskCompletionSource _warmed = new(TaskCreationOptions.RunContinuationsAsynchronously);

    /// <summary>Completes once <see cref="WarmUpAsync"/> has been called.</summary>
    public Task Warmed => _warmed.Task;

    public Task OnTranslationChunkAsync(
        TranslationChunk chunk, ICascadeEventSink events, CancellationToken cancellationToken) => Task.CompletedTask;

    public Task WarmUpAsync(CancellationToken cancellationToken)
    {
        _warmed.TrySetResult();
        return Task.CompletedTask;
    }
}

/// <summary>Records every chunk it's notified of, so tests can confirm the TTS/#7 observer seam actually fires.</summary>
file sealed class FakeTranslationObserver : ITranslationObserver
{
    public List<TranslationChunk> Chunks { get; } = [];

    /// <summary>Every (sourceUtteranceId, targetUtteranceId) pair OnTranslationAbortedAsync was called with.</summary>
    public List<(string SourceUtteranceId, string TargetUtteranceId)> AbortedCalls { get; } = [];

    public Task OnTranslationChunkAsync(TranslationChunk chunk, ICascadeEventSink events, CancellationToken cancellationToken)
    {
        Chunks.Add(chunk);
        return Task.CompletedTask;
    }

    public Task OnTranslationAbortedAsync(
        string sourceUtteranceId, string targetUtteranceId, ICascadeEventSink events, CancellationToken cancellationToken)
    {
        AbortedCalls.Add((sourceUtteranceId, targetUtteranceId));
        return Task.CompletedTask;
    }
}

/// <summary>
/// An <see cref="ITranslationObserver"/> that also implements <see cref="IAsyncDisposable"/> -
/// the shape <see cref="TtsCascadeObserver"/> (#7) takes - so tests can confirm
/// <see cref="CascadePipeline"/> disposes it exactly once at session end, the generic
/// seam that lets TTS drain its per-utterance synthesis pump before the socket closes.
/// </summary>
file sealed class FakeAsyncDisposableTranslationObserver : ITranslationObserver, IAsyncDisposable
{
    public int DisposeCount { get; private set; }

    public Task OnTranslationChunkAsync(TranslationChunk chunk, ICascadeEventSink events, CancellationToken cancellationToken) =>
        Task.CompletedTask;

    public ValueTask DisposeAsync()
    {
        DisposeCount++;
        return ValueTask.CompletedTask;
    }
}

/// <summary>
/// A token stream a test can hold open at a precise point: yields the first token,
/// then waits until <see cref="Release"/> is called before yielding every remaining
/// token and completing. Used to prove no-buffering (asserting on the sink before
/// <see cref="Release"/>) and sequential ordering (asserting a second utterance hasn't
/// started translating while this one is still gated).
/// </summary>
file sealed class GatedTokenStream(params string[] tokens)
{
    private readonly TaskCompletionSource _gate = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public void Release() => _gate.TrySetResult();

    public async IAsyncEnumerable<string> StreamAsync()
    {
        yield return tokens[0];

        await _gate.Task;

        foreach (var token in tokens[1..])
        {
            yield return token;
        }
    }
}
