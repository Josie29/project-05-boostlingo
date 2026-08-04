using System.Threading.Channels;
using Microsoft.Extensions.Logging.Abstractions;

namespace Boostlingo.Backend.Tests;

public class TtsCascadeObserverTests
{
    /// <summary>
    /// Confirms a whole-sentence partial produces the frontend-facing sequence:
    /// tts.audio.start, one binary frame per synthesized audio chunk, then
    /// tts.audio.end - exactly the protocol the frontend's playback queue is built
    /// against.
    /// </summary>
    [Fact]
    public async Task WholeSentencePartial_ProducesStartFramesEnd_InOrder()
    {
        var ttsProvider = new FakeTtsProvider(_ => Chunks("utt-1-target", [1, 2], [3, 4]));
        var observer = new TtsCascadeObserver(ttsProvider, NullLogger<TtsCascadeObserver>.Instance);
        var sink = new FakeEventSink();

        await observer.OnTranslationChunkAsync(
            new TranslationChunk("utt-1", "utt-1-target", "Hola mundo.", IsFinal: false, "es"), sink, CancellationToken.None);
        await observer.OnTranslationChunkAsync(
            new TranslationChunk("utt-1", "utt-1-target", "Hola mundo.", IsFinal: true, "es"), sink, CancellationToken.None);

        var start = await sink.Sent.Reader.ReadAsync(TestTimeout());
        var frame1 = await sink.Binary.Reader.ReadAsync(TestTimeout());
        var frame2 = await sink.Binary.Reader.ReadAsync(TestTimeout());
        var end = await sink.Sent.Reader.ReadAsync(TestTimeout());

        Assert.Equal(CascadeMessageTypes.TtsAudioStart, start.Type);
        var startPayload = Assert.IsType<CascadeTtsAudioStartPayload>(start.Payload);
        Assert.Equal("utt-1-target", startPayload.UtteranceId);
        Assert.Equal(TtsAudioFormat.SampleRateHz, startPayload.SampleRateHz);
        Assert.Equal(TtsAudioFormat.Encoding, startPayload.Encoding);
        Assert.Equal(TtsAudioFormat.Channels, startPayload.Channels);

        Assert.Equal(new byte[] { 1, 2 }, frame1);
        Assert.Equal(new byte[] { 3, 4 }, frame2);

        Assert.Equal(CascadeMessageTypes.TtsAudioEnd, end.Type);
        Assert.Equal("utt-1-target", Assert.IsType<CascadeTtsAudioEndPayload>(end.Payload).UtteranceId);

        var request = Assert.Single(ttsProvider.Requests);
        Assert.Equal("Hola mundo.", request.Text);
        Assert.Equal("es", request.TargetLang);
    }

    /// <summary>
    /// Confirms text with no terminal punctuation at all is still spoken once the
    /// utterance is finalized - the SentenceChunker.Flush() path - rather than
    /// silently dropped for lacking a sentence-ending period.
    /// </summary>
    [Fact]
    public async Task FinalChunk_WithNoPriorBoundary_SynthesizesFlushedRemainder()
    {
        var ttsProvider = new FakeTtsProvider(_ => Chunks("utt-1-target", [9]));
        var observer = new TtsCascadeObserver(ttsProvider, NullLogger<TtsCascadeObserver>.Instance);
        var sink = new FakeEventSink();

        await observer.OnTranslationChunkAsync(
            new TranslationChunk("utt-1", "utt-1-target", "Hola", IsFinal: false, "es"), sink, CancellationToken.None);
        await observer.OnTranslationChunkAsync(
            new TranslationChunk("utt-1", "utt-1-target", "Hola", IsFinal: true, "es"), sink, CancellationToken.None);

        await sink.Sent.Reader.ReadAsync(TestTimeout()); // tts.audio.start
        await sink.Binary.Reader.ReadAsync(TestTimeout());
        await sink.Sent.Reader.ReadAsync(TestTimeout()); // tts.audio.end

        var request = Assert.Single(ttsProvider.Requests);
        Assert.Equal("Hola", request.Text);
    }

    /// <summary>
    /// Confirms synthesis for a phrase starts as soon as its sentence boundary
    /// arrives - the frontend hears the first clause before the utterance's
    /// translation has even finished streaming - mirroring the MT no-buffering test
    /// pattern (CascadePipelineTests.Translation_EmitsFirstPartial_BeforeProviderStreamCompletes).
    /// The provider's stream for the first phrase is held open by a gate that is
    /// never released in this test, proving the assertion holds without waiting for
    /// anything past the first phrase.
    /// </summary>
    [Fact]
    public async Task SentenceBoundary_StartsSynthesis_BeforeUtteranceIsFinal()
    {
        var gate = new GatedAudioStream("utt-1-target", [1]);
        var ttsProvider = new FakeTtsProvider(_ => gate.StreamAsync());
        var observer = new TtsCascadeObserver(ttsProvider, NullLogger<TtsCascadeObserver>.Instance);
        var sink = new FakeEventSink();

        // Only a partial with a complete first sentence is sent - the utterance's
        // IsFinal chunk deliberately never arrives in this test.
        await observer.OnTranslationChunkAsync(
            new TranslationChunk("utt-1", "utt-1-target", "Hola.", IsFinal: false, "es"), sink, CancellationToken.None);

        var start = await sink.Sent.Reader.ReadAsync(TestTimeout());
        var frame = await sink.Binary.Reader.ReadAsync(TestTimeout());

        Assert.Equal(CascadeMessageTypes.TtsAudioStart, start.Type);
        Assert.Equal(new byte[] { 1 }, frame);
        Assert.Single(ttsProvider.Requests);

        // Hygiene only: let the still-suspended pump task actually finish instead of
        // leaving an unobserved gated Task running past the end of the test.
        gate.Release();
        await observer.DisposeAsync();
    }

    /// <summary>
    /// Confirms a synthesis failure for one utterance's phrase surfaces as an error
    /// envelope and does not prevent a later, unrelated utterance from synthesizing
    /// successfully - isolating one bad phrase must never take down the observer's
    /// pump or the rest of the session's audio.
    /// </summary>
    [Fact]
    public async Task SynthesisFailure_ForOnePhrase_SendsError_AndLaterUtteranceStillSynthesizes()
    {
        var callCount = 0;
        var ttsProvider = new FakeTtsProvider(request =>
        {
            callCount++;
            return callCount == 1 ? Failing() : Chunks(request.UtteranceId, [7]);
        });
        var observer = new TtsCascadeObserver(ttsProvider, NullLogger<TtsCascadeObserver>.Instance);
        var sink = new FakeEventSink();

        await observer.OnTranslationChunkAsync(
            new TranslationChunk("utt-a", "utt-a-target", "Bad.", IsFinal: false, "es"), sink, CancellationToken.None);
        await observer.OnTranslationChunkAsync(
            new TranslationChunk("utt-a", "utt-a-target", "Bad.", IsFinal: true, "es"), sink, CancellationToken.None);

        var startA = await sink.Sent.Reader.ReadAsync(TestTimeout());
        var errorEnvelope = await sink.Sent.Reader.ReadAsync(TestTimeout());
        Assert.Equal(CascadeMessageTypes.TtsAudioStart, startA.Type);
        Assert.Equal(CascadeMessageTypes.Error, errorEnvelope.Type);

        // The failed phrase produced no audio, but tts.audio.start was already sent
        // for utt-a before the failure, so its IsFinal chunk still closes with
        // tts.audio.end (see TtsCascadeObserver.PumpAsync) - drain it before moving on
        // to a second, unrelated utterance and confirming it still works.
        var endA = await sink.Sent.Reader.ReadAsync(TestTimeout());
        Assert.Equal(CascadeMessageTypes.TtsAudioEnd, endA.Type);
        await observer.OnTranslationChunkAsync(
            new TranslationChunk("utt-b", "utt-b-target", "Good.", IsFinal: false, "es"), sink, CancellationToken.None);
        await observer.OnTranslationChunkAsync(
            new TranslationChunk("utt-b", "utt-b-target", "Good.", IsFinal: true, "es"), sink, CancellationToken.None);

        var startB = await sink.Sent.Reader.ReadAsync(TestTimeout());
        var frameB = await sink.Binary.Reader.ReadAsync(TestTimeout());
        var endB = await sink.Sent.Reader.ReadAsync(TestTimeout());

        Assert.Equal(CascadeMessageTypes.TtsAudioStart, startB.Type);
        Assert.Equal("utt-b-target", Assert.IsType<CascadeTtsAudioStartPayload>(startB.Payload).UtteranceId);
        Assert.Equal(new byte[] { 7 }, frameB);
        Assert.Equal(CascadeMessageTypes.TtsAudioEnd, endB.Type);
    }

    /// <summary>
    /// Confirms DisposeAsync drains whatever was already queued (the last utterance's
    /// closing tts.audio.end still arrives) and then completes promptly, rather than
    /// hanging or throwing - the clean-disposal-on-session-end guarantee
    /// CascadePipeline.OnSessionEndedAsync relies on before it closes the socket.
    /// </summary>
    [Fact]
    public async Task DisposeAsync_DrainsQueuedWork_ThenCompletes()
    {
        var ttsProvider = new FakeTtsProvider(_ => Chunks("utt-1-target", [5]));
        var observer = new TtsCascadeObserver(ttsProvider, NullLogger<TtsCascadeObserver>.Instance);
        var sink = new FakeEventSink();

        await observer.OnTranslationChunkAsync(
            new TranslationChunk("utt-1", "utt-1-target", "Hola.", IsFinal: false, "es"), sink, CancellationToken.None);
        await observer.OnTranslationChunkAsync(
            new TranslationChunk("utt-1", "utt-1-target", "Hola.", IsFinal: true, "es"), sink, CancellationToken.None);

        await observer.DisposeAsync().AsTask().WaitAsync(TestTimeout());

        var start = await sink.Sent.Reader.ReadAsync(TestTimeout());
        await sink.Binary.Reader.ReadAsync(TestTimeout());
        var end = await sink.Sent.Reader.ReadAsync(TestTimeout());
        Assert.Equal(CascadeMessageTypes.TtsAudioStart, start.Type);
        Assert.Equal(CascadeMessageTypes.TtsAudioEnd, end.Type);
    }

    private static async IAsyncEnumerable<TtsAudioChunk> Chunks(string utteranceId, params byte[][] frames)
    {
        foreach (var frame in frames)
        {
            await Task.Yield();
            yield return new TtsAudioChunk(utteranceId, frame);
        }
    }

    private static async IAsyncEnumerable<TtsAudioChunk> Failing()
    {
        await Task.Yield();
        throw new TtsProviderException("upstream rejected the request");
#pragma warning disable CS0162 // Unreachable code: required so the compiler sees this as an iterator.
        yield break;
#pragma warning restore CS0162
    }

    private static CancellationToken TestTimeout() => new CancellationTokenSource(TimeSpan.FromSeconds(5)).Token;
}

/// <summary>
/// Records every envelope and binary frame sent, so tests can assert on the exact
/// protocol the frontend receives. <c>latency.mark</c> envelopes (#10) are routed to
/// the separate <see cref="Marks"/> channel instead of <see cref="Sent"/>, so every test
/// written before latency instrumentation existed keeps reading exactly the
/// start/frames/end sequence it always did.
/// </summary>
file sealed class FakeEventSink : ICascadeEventSink
{
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

/// <summary>
/// A controllable <see cref="ITtsProvider"/>: records every request it receives and
/// hands back whatever audio chunk stream the test's <paramref name="respond"/>
/// callback produces for that request.
/// </summary>
file sealed class FakeTtsProvider(Func<TtsRequest, IAsyncEnumerable<TtsAudioChunk>> respond) : ITtsProvider
{
    public List<TtsRequest> Requests { get; } = [];

    public IAsyncEnumerable<TtsAudioChunk> SynthesizeAsync(TtsRequest request, CancellationToken cancellationToken)
    {
        Requests.Add(request);
        return respond(request);
    }
}

/// <summary>
/// An audio chunk stream a test can hold open at a precise point: yields the first
/// chunk, then never completes unless <see cref="Release"/> is called - used to prove
/// synthesis for one phrase starts (and its first frame reaches the sink) without
/// needing the utterance to ever reach IsFinal.
/// </summary>
file sealed class GatedAudioStream(string utteranceId, params byte[][] frames)
{
    private readonly TaskCompletionSource _gate = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public void Release() => _gate.TrySetResult();

    public async IAsyncEnumerable<TtsAudioChunk> StreamAsync()
    {
        yield return new TtsAudioChunk(utteranceId, frames[0]);

        await _gate.Task;

        foreach (var frame in frames[1..])
        {
            yield return new TtsAudioChunk(utteranceId, frame);
        }
    }
}
