using System.Runtime.CompilerServices;
using System.Threading.Channels;
using Microsoft.Extensions.Logging.Abstractions;

namespace Boostlingo.Backend.Tests;

/// <summary>
/// Barge-in (#11): a speech-onset signal (<see cref="SttSegment.SpeechStart"/>) arriving
/// while an earlier utterance's translation/synthesis is still queued or in flight should
/// cancel that work and tell the client to flush its playback queue - but never fire on a
/// speech-onset signal that has nothing to cancel.
/// </summary>
public class CascadeBargeInTests
{
    /// <summary>
    /// Confirms a barge-in mid-playback cancels the phrase <see cref="TtsCascadeObserver"/>
    /// is actively streaming from the provider right now - the provider itself observes
    /// the cancellation (rather than the stream just being abandoned uncancelled) - and
    /// that the client learns about it via a <c>transcript.truncated</c> event for the
    /// superseded utterance followed by an aggregated <c>bargein</c> event naming it, with
    /// no <c>error</c> event (cancellation is not a synthesis failure).
    /// </summary>
    [Fact]
    public async Task SpeechStart_WhileTtsSynthesizing_CancelsInFlightSynthesis_AndEmitsBargeIn()
    {
        var stream = new FakeSttStream();
        var audio = new GatedForeverAudioStream("utt-a-target");
        var ttsProvider = new FakeCancelAwareTtsProvider((request, token) => audio.StreamAsync(token));
        var ttsObserver = new TtsCascadeObserver(ttsProvider, NullLogger<TtsCascadeObserver>.Instance);
        var translationProvider = new FakeTranslationProvider(_ => Tokens("Hola"));
        var pipeline = CreatePipeline(new FakeSttProvider(stream), translationProvider, [ttsObserver]);
        var sink = new FakeEventSink();

        await pipeline.OnSessionStartedAsync(new CascadeSessionConfig("en", "es"), sink, CancellationToken.None);
        stream.Emit(new SttSegment("utt-a", "Hola", SttSegmentKind.Final, TimestampMs: 10));

        // Waits for the provider to actually yield its first audio chunk - proving
        // synthesis genuinely started - before triggering the barge-in below.
        await audio.Started.WaitAsync(TestTimeout());

        stream.Emit(SttSegment.SpeechStart(20));

        var truncated = await ReadUntilAsync(sink.Sent, CascadeMessageTypes.TranscriptTruncated, TestTimeout());
        Assert.Equal("utt-a-target", Assert.IsType<CascadeTranscriptTruncatedPayload>(truncated.Payload).UtteranceId);

        var bargein = await ReadUntilAsync(sink.Sent, CascadeMessageTypes.BargeIn, TestTimeout());
        var payload = Assert.IsType<CascadeBargeInPayload>(bargein.Payload);
        Assert.Equal(["utt-a-target"], payload.SupersededUtteranceIds);

        // The provider's own cancellation token - not just this test giving up on
        // waiting - must have observed the cancellation.
        await audio.Cancelled.WaitAsync(TestTimeout());
        Assert.True(audio.CancellationObserved);

        await pipeline.OnSessionEndedAsync(sink, CancellationToken.None);
        Assert.False(sink.Sent.Reader.TryRead(out var stray) && stray.Type == CascadeMessageTypes.Error);
    }

    /// <summary>
    /// Confirms a phrase still sitting queued behind the one actively synthesizing -
    /// never dequeued, never handed to the provider - is dropped by a barge-in rather
    /// than played once the currently-blocking phrase is out of the way. Without this,
    /// an interrupted utterance's translation could still start speaking moments later.
    /// </summary>
    [Fact]
    public async Task SpeechStart_WithPhraseStillQueued_DropsIt_WithoutEverStartingSynthesis()
    {
        var stream = new FakeSttStream();
        var audio = new GatedForeverAudioStream("utt-a-target");
        var ttsProvider = new FakeCancelAwareTtsProvider((request, token) =>
            request.UtteranceId == "utt-a-target" ? audio.StreamAsync(token) : Chunks(request.UtteranceId, 9));
        var ttsObserver = new TtsCascadeObserver(ttsProvider, NullLogger<TtsCascadeObserver>.Instance);
        var callCount = 0;
        var translationProvider = new FakeTranslationProvider(_ =>
        {
            callCount++;
            return callCount == 1 ? Tokens("Hola") : Tokens("Mundo");
        });
        var pipeline = CreatePipeline(new FakeSttProvider(stream), translationProvider, [ttsObserver]);
        var sink = new FakeEventSink();

        await pipeline.OnSessionStartedAsync(new CascadeSessionConfig("en", "es"), sink, CancellationToken.None);
        stream.Emit(new SttSegment("utt-a", "Hola", SttSegmentKind.Final, TimestampMs: 10));
        await audio.Started.WaitAsync(TestTimeout());

        // utt-a's synthesis is now permanently blocked (until cancelled) - utt-b's
        // translation still runs to completion and queues its own phrase behind it in
        // the TTS observer's channel, which the pump never reaches while stuck on utt-a.
        stream.Emit(new SttSegment("utt-b", "World", SttSegmentKind.Final, TimestampMs: 20));
        var targetFinalB = await ReadTargetLaneFinalAsync(sink.Sent, "utt-b-target", TestTimeout());
        Assert.Equal("Mundo", targetFinalB);

        stream.Emit(SttSegment.SpeechStart(30));

        var bargein = await ReadUntilAsync(sink.Sent, CascadeMessageTypes.BargeIn, TestTimeout());
        var payload = Assert.IsType<CascadeBargeInPayload>(bargein.Payload);
        Assert.Equal(new HashSet<string> { "utt-a-target", "utt-b-target" }, payload.SupersededUtteranceIds.ToHashSet());

        await pipeline.OnSessionEndedAsync(sink, CancellationToken.None);

        // The provider was asked to synthesize utt-a's phrase (that's what's cancelled
        // above) but never utt-b's - it was dropped from the queue untouched.
        Assert.DoesNotContain(ttsProvider.Requests, r => r.UtteranceId == "utt-b-target");
    }

    /// <summary>
    /// Confirms the utterance whose speech-onset just triggered the barge-in is never
    /// itself superseded, and the pipeline's background pumps are still healthy after
    /// cancelling the earlier one - a later, unrelated utterance flows through STT, MT,
    /// and TTS exactly as if no barge-in had happened.
    /// </summary>
    [Fact]
    public async Task SpeechStart_DoesNotSupersede_TheUtteranceItStarts_WhichFlowsNormallyAfterward()
    {
        var stream = new FakeSttStream();
        var audio = new GatedForeverAudioStream("utt-a-target");
        var ttsProvider = new FakeCancelAwareTtsProvider((request, token) =>
            request.UtteranceId == "utt-a-target" ? audio.StreamAsync(token) : Chunks(request.UtteranceId, 7));
        var ttsObserver = new TtsCascadeObserver(ttsProvider, NullLogger<TtsCascadeObserver>.Instance);
        var callCount = 0;
        var translationProvider = new FakeTranslationProvider(_ =>
        {
            callCount++;
            return callCount == 1 ? Tokens("Hola") : Tokens("Adios");
        });
        var pipeline = CreatePipeline(new FakeSttProvider(stream), translationProvider, [ttsObserver]);
        var sink = new FakeEventSink();

        await pipeline.OnSessionStartedAsync(new CascadeSessionConfig("en", "es"), sink, CancellationToken.None);
        stream.Emit(new SttSegment("utt-a", "Hola", SttSegmentKind.Final, TimestampMs: 10));
        await audio.Started.WaitAsync(TestTimeout());

        // Drain the one binary frame utt-a's synthesis already sent before it got
        // stuck - not the frame this test cares about, but still on the wire.
        await sink.Binary.Reader.ReadAsync(TestTimeout());

        stream.Emit(SttSegment.SpeechStart(20));
        await ReadUntilAsync(sink.Sent, CascadeMessageTypes.BargeIn, TestTimeout());

        // The new utterance the speaker just started speaking - the one the barge-in
        // itself signalled - flows through the whole cascade with no special handling.
        stream.Emit(new SttSegment("utt-c", "Bye", SttSegmentKind.Final, TimestampMs: 30));

        var start = await ReadUntilAsync(sink.Sent, CascadeMessageTypes.TtsAudioStart, TestTimeout());
        Assert.Equal("utt-c-target", Assert.IsType<CascadeTtsAudioStartPayload>(start.Payload).UtteranceId);
        var frame = await sink.Binary.Reader.ReadAsync(TestTimeout());
        Assert.Equal(new byte[] { 7 }, frame);
        var end = await ReadUntilAsync(sink.Sent, CascadeMessageTypes.TtsAudioEnd, TestTimeout());
        Assert.Equal("utt-c-target", Assert.IsType<CascadeTtsAudioEndPayload>(end.Payload).UtteranceId);

        await pipeline.OnSessionEndedAsync(sink, CancellationToken.None);
    }

    /// <summary>
    /// Confirms a speech-onset signal with nothing queued or in flight produces no
    /// <c>bargein</c> or <c>transcript.truncated</c> event at all - a client must never
    /// have to guard against a spurious playback flush on every utterance boundary.
    /// </summary>
    [Fact]
    public async Task SpeechStart_WithNothingInFlight_EmitsNoBargeInEnvelope()
    {
        var stream = new FakeSttStream();
        var pipeline = CreatePipeline(new FakeSttProvider(stream), new FakeTranslationProvider(_ => Tokens("Hola")), []);
        var sink = new FakeEventSink();

        await pipeline.OnSessionStartedAsync(new CascadeSessionConfig("en", "es"), sink, CancellationToken.None);
        stream.Emit(SttSegment.SpeechStart(0));
        stream.Emit(new SttSegment("utt-1", "Hello", SttSegmentKind.Final, TimestampMs: 10));

        // PumpSegmentsAsync processes segments strictly in arrival order on one task, so
        // the very first envelope to reach the sink is proof nothing (bargein or
        // transcript.truncated) was sent for the speech-start marker that preceded it.
        var first = await sink.Sent.Reader.ReadAsync(TestTimeout());
        Assert.Equal(CascadeMessageTypes.TranscriptFinal, first.Type);
        var payload = Assert.IsType<CascadeTranscriptPayload>(first.Payload);
        Assert.Equal(CascadeTranscriptLanes.Source, payload.Lane);
        Assert.Equal("utt-1", payload.UtteranceId);

        await pipeline.OnSessionEndedAsync(sink, CancellationToken.None);
    }

    private static async Task<(string Type, object? Payload)> ReadUntilAsync(
        Channel<(string Type, object? Payload)> sent, string type, CancellationToken cancellationToken)
    {
        while (true)
        {
            var envelope = await sent.Reader.ReadAsync(cancellationToken);
            if (envelope.Type == type)
            {
                return envelope;
            }
        }
    }

    private static async Task<string> ReadTargetLaneFinalAsync(
        Channel<(string Type, object? Payload)> sent, string targetUtteranceId, CancellationToken cancellationToken)
    {
        while (true)
        {
            var envelope = await sent.Reader.ReadAsync(cancellationToken);
            if (envelope is (CascadeMessageTypes.TranscriptFinal, CascadeTranscriptPayload payload)
                && payload.UtteranceId == targetUtteranceId)
            {
                return payload.Text;
            }
        }
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

    private static CascadePipeline CreatePipeline(
        ISttProvider provider, ITranslationProvider translationProvider, IEnumerable<ITranslationObserver> translationObservers) =>
        new(provider, translationProvider, translationObservers, NullLogger<CascadePipeline>.Instance);

    private static CancellationToken TestTimeout() => new CancellationTokenSource(TimeSpan.FromSeconds(5)).Token;
}

/// <summary>
/// An audio chunk stream that yields one chunk, signals <see cref="Started"/>, then
/// blocks forever until its <see cref="CancellationToken"/> is cancelled - at which point
/// it signals <see cref="Cancelled"/> and rethrows, mirroring how a real streaming TTS
/// (text-to-speech) provider would surface a cancelled request. Used to prove
/// <see cref="TtsCascadeObserver"/> actually cancels the provider's own token on a
/// barge-in (#11), not just abandons the enumerator uncancelled.
/// </summary>
file sealed class GatedForeverAudioStream(string utteranceId)
{
    private readonly TaskCompletionSource _started = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource _cancelled = new(TaskCreationOptions.RunContinuationsAsynchronously);

    /// <summary>Completes once the first chunk has been yielded.</summary>
    public Task Started => _started.Task;

    /// <summary>Completes once this stream's cancellation token was actually cancelled.</summary>
    public Task Cancelled => _cancelled.Task;

    /// <summary><c>true</c> once <see cref="Cancelled"/> has completed.</summary>
    public bool CancellationObserved { get; private set; }

    public async IAsyncEnumerable<TtsAudioChunk> StreamAsync([EnumeratorCancellation] CancellationToken cancellationToken)
    {
        yield return new TtsAudioChunk(utteranceId, new byte[] { 1 });
        _started.TrySetResult();

        try
        {
            await Task.Delay(Timeout.Infinite, cancellationToken);
        }
        catch (OperationCanceledException)
        {
            CancellationObserved = true;
            _cancelled.TrySetResult();
            throw;
        }
    }
}

/// <summary>
/// A controllable <see cref="ITtsProvider"/> that, unlike the simpler fakes in the
/// sibling test files, threads the real <see cref="CancellationToken"/>
/// <see cref="TtsCascadeObserver"/> passes through to <paramref name="respond"/> - the
/// seam <see cref="GatedForeverAudioStream"/> needs to actually observe a barge-in's
/// cancellation rather than one it never receives.
/// </summary>
file sealed class FakeCancelAwareTtsProvider(Func<TtsRequest, CancellationToken, IAsyncEnumerable<TtsAudioChunk>> respond) : ITtsProvider
{
    public List<TtsRequest> Requests { get; } = [];

    public IAsyncEnumerable<TtsAudioChunk> SynthesizeAsync(TtsRequest request, CancellationToken cancellationToken)
    {
        Requests.Add(request);
        return respond(request, cancellationToken);
    }
}

/// <summary>A controllable <see cref="ISttProvider"/> handing back a <see cref="FakeSttStream"/>.</summary>
file sealed class FakeSttProvider(FakeSttStream stream) : ISttProvider
{
    public Task<ISttStream> StartStreamAsync(SttStreamConfig config, CancellationToken cancellationToken) =>
        Task.FromResult<ISttStream>(stream);
}

/// <summary>A controllable <see cref="ISttStream"/>: records audio sent to it, and lets a test push segments on demand.</summary>
file sealed class FakeSttStream : ISttStream
{
    private readonly Channel<SttSegment> _segments = Channel.CreateUnbounded<SttSegment>();

    public void Emit(SttSegment segment) => _segments.Writer.TryWrite(segment);

    public Task SendAudioAsync(ReadOnlyMemory<byte> pcm, CancellationToken cancellationToken) => Task.CompletedTask;

    public IAsyncEnumerable<SttSegment> ReadSegmentsAsync(CancellationToken cancellationToken) =>
        _segments.Reader.ReadAllAsync(cancellationToken);

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;
}

/// <summary>A controllable <see cref="ITranslationProvider"/>: hands back whatever token stream <paramref name="respond"/> produces.</summary>
file sealed class FakeTranslationProvider(Func<TranslationRequest, IAsyncEnumerable<string>> respond) : ITranslationProvider
{
    public IAsyncEnumerable<string> TranslateAsync(TranslationRequest request, CancellationToken cancellationToken) =>
        respond(request);
}

/// <summary>
/// Records every envelope and binary frame sent, so tests can assert on the exact
/// protocol the frontend receives. <c>latency.mark</c> envelopes are routed to the
/// separate <see cref="Marks"/> channel, mirroring the sibling test files' fakes.
/// </summary>
file sealed class FakeEventSink : ICascadeEventSink
{
    public Guid SessionId { get; } = Guid.NewGuid();

    public Channel<(string Type, object? Payload)> Sent { get; } = Channel.CreateUnbounded<(string Type, object? Payload)>();

    public Channel<byte[]> Binary { get; } = Channel.CreateUnbounded<byte[]>();

    public Channel<CascadeLatencyMarkPayload> Marks { get; } = Channel.CreateUnbounded<CascadeLatencyMarkPayload>();

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
        Binary.Writer.TryWrite(data.ToArray());
        return Task.CompletedTask;
    }
}
