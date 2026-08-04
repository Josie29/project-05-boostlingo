using Microsoft.Extensions.Logging.Abstractions;

namespace Boostlingo.Backend.Tests;

public class CascadePipelineTests
{
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
        stream.Emit(new SttSegment("utt-1", "Hola", IsFinal: false, TimestampMs: 100));
        stream.Emit(new SttSegment("utt-1", "Hola mundo", IsFinal: true, TimestampMs: 250));

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
    /// segment enumerator throwing) surfaces as an error envelope rather than
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

        // The session is still usable afterward - ending it must not throw either.
        await pipeline.OnSessionEndedAsync(sink, CancellationToken.None);
        Assert.Equal(1, stream.DisposeCount);
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
        stream.Emit(new SttSegment("utt-1", "Hello world", IsFinal: true, TimestampMs: 10));

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
        stream.Emit(new SttSegment("utt-1", "Hello", IsFinal: true, TimestampMs: 10));

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
        stream.Emit(new SttSegment("utt-a", "Hello", IsFinal: true, TimestampMs: 10));
        stream.Emit(new SttSegment("utt-b", "World", IsFinal: true, TimestampMs: 20));

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
        stream.Emit(new SttSegment("utt-a", "Bad", IsFinal: true, TimestampMs: 10));

        var errorEnvelope = await events.Other.Reader.ReadAsync(TestTimeout());
        Assert.Equal(CascadeMessageTypes.Error, errorEnvelope.Type);

        stream.Emit(new SttSegment("utt-b", "Good", IsFinal: true, TimestampMs: 20));

        var partialB = await events.Target.Reader.ReadAsync(TestTimeout());
        var finalB = await events.Target.Reader.ReadAsync(TestTimeout());
        AssertTargetPayload(partialB, CascadeMessageTypes.TranscriptPartial, "utt-b-target", "Bien");
        AssertTargetPayload(finalB, CascadeMessageTypes.TranscriptFinal, "utt-b-target", "Bien");
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

    private static CascadePipeline CreatePipeline(
        ISttProvider provider,
        ITranslationProvider? translationProvider = null,
        IEnumerable<ITranslationObserver>? translationObservers = null) =>
        new(
            provider,
            translationProvider ?? new FakeTranslationProvider(_ => Tokens()),
            segmentObservers: [],
            translationObservers ?? [],
            NullLogger<CascadePipeline>.Instance);

    private static CancellationToken TestTimeout() => new CancellationTokenSource(TimeSpan.FromSeconds(5)).Token;
}

/// <summary>Records every envelope sent, so tests can assert on the exact shape the frontend receives.</summary>
file sealed class FakeEventSink : ICascadeEventSink
{
    public System.Threading.Channels.Channel<(string Type, object? Payload)> Sent { get; } =
        System.Threading.Channels.Channel.CreateUnbounded<(string Type, object? Payload)>();

    public Task SendEventAsync(string type, object? payload, CancellationToken cancellationToken)
    {
        Sent.Writer.TryWrite((type, payload));
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

/// <summary>A controllable <see cref="ISttProvider"/> - either fails to start, or hands back a <see cref="FakeSttStream"/>.</summary>
file sealed class FakeSttProvider(FakeSttStream? stream = null, Exception? startException = null) : ISttProvider
{
    public Task<ISttStream> StartStreamAsync(SttStreamConfig config, CancellationToken cancellationToken) =>
        startException is not null
            ? throw startException
            : Task.FromResult<ISttStream>(stream!);
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

/// <summary>Records every chunk it's notified of, so tests can confirm the TTS/#7 observer seam actually fires.</summary>
file sealed class FakeTranslationObserver : ITranslationObserver
{
    public List<TranslationChunk> Chunks { get; } = [];

    public Task OnTranslationChunkAsync(TranslationChunk chunk, CancellationToken cancellationToken)
    {
        Chunks.Add(chunk);
        return Task.CompletedTask;
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
