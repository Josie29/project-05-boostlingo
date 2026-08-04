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

    private static CascadePipeline CreatePipeline(ISttProvider provider) =>
        new(provider, segmentObservers: [], NullLogger<CascadePipeline>.Instance);

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
