using System.Net.WebSockets;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

namespace Boostlingo.Backend.Tests;

public class OpenAiSttProviderTests
{
    /// <summary>
    /// Confirms a missing OPENAI_API_KEY fails loudly with a clear, catchable
    /// exception before ever touching the network - this is what the cascade pipeline
    /// turns into the client-facing error envelope.
    /// </summary>
    [Fact]
    public async Task StartStreamAsync_MissingApiKey_ThrowsWithoutConnecting()
    {
        var socketFactory = new FakeRealtimeSocketFactory();
        var provider = CreateProvider(socketFactory, apiKey: null);

        var ex = await Assert.ThrowsAsync<SttProviderUnavailableException>(
            () => provider.StartStreamAsync(new SttStreamConfig("en"), CancellationToken.None));

        Assert.Contains("API key", ex.Message);
        Assert.Empty(socketFactory.CreatedSockets);
    }

    /// <summary>
    /// Confirms a connect/handshake that never completes surfaces as
    /// SttProviderUnavailableException once the connect timeout (#12, error handling
    /// hardening) elapses, rather than leaving the cascade session hanging forever
    /// waiting for STT to start.
    /// </summary>
    [Fact]
    public async Task StartStreamAsync_ConnectHandshakeTimesOut_ThrowsSttProviderUnavailable()
    {
        var socketFactory = new FakeRealtimeSocketFactory { ConnectDelay = TimeSpan.FromSeconds(5) };
        var provider = CreateProvider(socketFactory, apiKey: "sk-test", connectTimeout: TimeSpan.FromMilliseconds(50));

        var ex = await Assert.ThrowsAsync<SttProviderUnavailableException>(
            () => provider.StartStreamAsync(new SttStreamConfig("en"), CancellationToken.None));

        Assert.Contains("Timed out", ex.Message);
    }

    /// <summary>
    /// Confirms starting a stream connects to OpenAI's transcription-intent endpoint
    /// with the bearer key and sends a session config naming gpt-4o-mini-transcribe and the
    /// chosen VAD mode - the whole point of hiding a real key/model behind DI is that
    /// this is the one place that config is allowed to exist.
    /// </summary>
    [Fact]
    public async Task StartStreamAsync_SendsSessionUpdate_WithModelAndVadConfigured()
    {
        var socketFactory = new FakeRealtimeSocketFactory();
        var provider = CreateProvider(socketFactory, apiKey: "sk-test");

        await provider.StartStreamAsync(new SttStreamConfig("en"), CancellationToken.None);

        var socket = Assert.Single(socketFactory.CreatedSockets);
        Assert.Equal("Bearer sk-test", socket.ConnectHeaders["Authorization"]);
        var sessionUpdate = Assert.Single(socket.SentText);
        Assert.Contains("\"type\":\"session.update\"", sessionUpdate);
        Assert.Contains("\"type\":\"transcription\"", sessionUpdate);
        Assert.Contains("\"type\":\"audio/pcm\"", sessionUpdate);
        Assert.Contains($"\"rate\":{CascadeAudioFormat.SampleRateHz}", sessionUpdate);
        Assert.Contains(OpenAiSttProvider.Model, sessionUpdate);
        Assert.Contains(OpenAiSttProvider.VadType, sessionUpdate);
    }

    /// <summary>
    /// Confirms PCM audio handed to the stream is base64-encoded into an
    /// input_audio_buffer.append message - the exact shape OpenAI's realtime API
    /// requires for streamed audio.
    /// </summary>
    [Fact]
    public async Task SendAudioAsync_Base64EncodesPcmIntoAppendMessage()
    {
        var socketFactory = new FakeRealtimeSocketFactory();
        var provider = CreateProvider(socketFactory, apiKey: "sk-test");
        var stream = await provider.StartStreamAsync(new SttStreamConfig("en"), CancellationToken.None);
        var socket = socketFactory.CreatedSockets[0];

        var pcm = new byte[] { 1, 2, 3, 4 };
        await stream.SendAudioAsync(pcm, CancellationToken.None);

        var sent = socket.SentText[^1];
        Assert.Contains("input_audio_buffer.append", sent);
        Assert.Contains(Convert.ToBase64String(pcm), sent);
    }

    /// <summary>
    /// Confirms transcription delta and completed events from OpenAI are parsed into
    /// the right partial/final SttSegments - this is the only place that ever has to
    /// understand OpenAI's specific event shapes.
    /// </summary>
    [Fact]
    public async Task ReadSegmentsAsync_ParsesDeltaThenCompleted_IntoSegments()
    {
        var socketFactory = new FakeRealtimeSocketFactory();
        var provider = CreateProvider(socketFactory, apiKey: "sk-test");
        var stream = await provider.StartStreamAsync(new SttStreamConfig("en"), CancellationToken.None);
        var socket = socketFactory.CreatedSockets[0];

        socket.EnqueueIncoming("""{"type":"conversation.item.input_audio_transcription.delta","item_id":"item-1","delta":"Hel"}""");
        socket.EnqueueIncoming("""{"type":"conversation.item.input_audio_transcription.completed","item_id":"item-1","transcript":"Hello"}""");
        socket.EnqueueIncoming(null); // socket closes after the two events

        var segments = new List<SttSegment>();
        await foreach (var segment in stream.ReadSegmentsAsync(CancellationToken.None))
        {
            segments.Add(segment);
        }

        Assert.Equal(2, segments.Count);
        Assert.Equal("item-1", segments[0].UtteranceId);
        Assert.Equal("Hel", segments[0].Text);
        Assert.Equal(SttSegmentKind.Partial, segments[0].Kind);
        Assert.Equal("Hello", segments[1].Text);
        Assert.Equal(SttSegmentKind.Final, segments[1].Kind);
    }

    /// <summary>
    /// Confirms an OpenAI "error" event surfaces as SttProviderStreamException from
    /// the enumerator, rather than being silently ignored or crashing the process -
    /// the cascade pipeline relies on this to turn upstream failures into a client
    /// error envelope.
    /// </summary>
    [Fact]
    public async Task ReadSegmentsAsync_ErrorEvent_ThrowsSttProviderStreamException()
    {
        var socketFactory = new FakeRealtimeSocketFactory();
        var provider = CreateProvider(socketFactory, apiKey: "sk-test");
        var stream = await provider.StartStreamAsync(new SttStreamConfig("en"), CancellationToken.None);
        var socket = socketFactory.CreatedSockets[0];

        socket.EnqueueIncoming("""{"type":"error","error":{"message":"rate limited"}}""");

        var ex = await Assert.ThrowsAsync<SttProviderStreamException>(async () =>
        {
            await foreach (var _ in stream.ReadSegmentsAsync(CancellationToken.None))
            {
            }
        });
        Assert.Equal("rate limited", ex.Message);
    }

    /// <summary>
    /// Confirms an <c>input_audio_buffer.committed</c> event - OpenAI's VAD (Voice
    /// Activity Detection) deciding the speaker's turn is complete - is surfaced as a
    /// speech-end marker segment keyed by that event's item_id, rather than silently
    /// dropped like other session-lifecycle events. This is the earliest signal
    /// CascadePipeline's speechEnd latency mark (#10) has to work with.
    /// </summary>
    [Fact]
    public async Task ReadSegmentsAsync_ParsesCommittedEvent_IntoSpeechEndMarker()
    {
        var socketFactory = new FakeRealtimeSocketFactory();
        var provider = CreateProvider(socketFactory, apiKey: "sk-test");
        var stream = await provider.StartStreamAsync(new SttStreamConfig("en"), CancellationToken.None);
        var socket = socketFactory.CreatedSockets[0];

        socket.EnqueueIncoming(
            """{"type":"input_audio_buffer.committed","previous_item_id":null,"item_id":"item-1"}""");
        socket.EnqueueIncoming(null);

        var segments = new List<SttSegment>();
        await foreach (var segment in stream.ReadSegmentsAsync(CancellationToken.None))
        {
            segments.Add(segment);
        }

        var marker = Assert.Single(segments);
        Assert.Equal(SttSegmentKind.SpeechEnd, marker.Kind);
        Assert.Equal("item-1", marker.UtteranceId);
        Assert.Equal(string.Empty, marker.Text);
        // No speech_stopped preceded it, so there is nothing to backdate to and the
        // consumer must stamp on arrival rather than invent a boundary.
        Assert.Null(marker.AcousticEndAtServerMs);
    }

    /// <summary>
    /// The perceived-latency window opens where the speaker stopped talking
    /// (docs/BRIEF.md), but only the later commit carries the item_id every mark for
    /// the utterance keys by. Confirms the stream carries the speech_stopped instant
    /// forward onto the commit's marker so CascadePipeline can backdate the speechEnd
    /// mark to it - without this, the VAD's deliberation before committing falls
    /// outside the measured window and cascade's latency reads lower than it is.
    /// </summary>
    [Fact]
    public async Task ReadSegmentsAsync_CarriesSpeechStoppedInstant_OntoTheCommittedMarker()
    {
        var socketFactory = new FakeRealtimeSocketFactory();
        var provider = CreateProvider(socketFactory, apiKey: "sk-test");
        var stream = await provider.StartStreamAsync(new SttStreamConfig("en"), CancellationToken.None);
        var socket = socketFactory.CreatedSockets[0];

        var beforeMs = CascadeClock.UtcNowMs();
        socket.EnqueueIncoming("""{"type":"input_audio_buffer.speech_stopped"}""");
        socket.EnqueueIncoming(
            """{"type":"input_audio_buffer.committed","previous_item_id":null,"item_id":"item-1"}""");
        socket.EnqueueIncoming(null);

        var segments = new List<SttSegment>();
        await foreach (var segment in stream.ReadSegmentsAsync(CancellationToken.None))
        {
            segments.Add(segment);
        }

        // speech_stopped itself still yields no segment - it has no id to key one by.
        var marker = Assert.Single(segments);
        Assert.Equal(SttSegmentKind.SpeechEnd, marker.Kind);
        Assert.NotNull(marker.AcousticEndAtServerMs);
        Assert.InRange(marker.AcousticEndAtServerMs!.Value, beforeMs, CascadeClock.UtcNowMs());
    }

    /// <summary>
    /// Confirms a held speech_stopped instant is consumed by the commit that uses it,
    /// so a later commit with no stop of its own (a reconnect, a provider that skips
    /// the event) is stamped on arrival rather than backdated to a stale boundary from
    /// a previous utterance - which would report a wildly inflated latency.
    /// </summary>
    [Fact]
    public async Task ReadSegmentsAsync_DoesNotReuseASpeechStoppedInstant_ForALaterCommit()
    {
        var socketFactory = new FakeRealtimeSocketFactory();
        var provider = CreateProvider(socketFactory, apiKey: "sk-test");
        var stream = await provider.StartStreamAsync(new SttStreamConfig("en"), CancellationToken.None);
        var socket = socketFactory.CreatedSockets[0];

        socket.EnqueueIncoming("""{"type":"input_audio_buffer.speech_stopped"}""");
        socket.EnqueueIncoming(
            """{"type":"input_audio_buffer.committed","previous_item_id":null,"item_id":"item-1"}""");
        socket.EnqueueIncoming(
            """{"type":"input_audio_buffer.committed","previous_item_id":"item-1","item_id":"item-2"}""");
        socket.EnqueueIncoming(null);

        var segments = new List<SttSegment>();
        await foreach (var segment in stream.ReadSegmentsAsync(CancellationToken.None))
        {
            segments.Add(segment);
        }

        Assert.Equal(2, segments.Count);
        Assert.NotNull(segments[0].AcousticEndAtServerMs);
        Assert.Null(segments[1].AcousticEndAtServerMs);
    }

    /// <summary>
    /// Confirms an <c>input_audio_buffer.speech_started</c> event - OpenAI's VAD
    /// detecting the speaker beginning a new utterance, before any item_id is assigned -
    /// is surfaced as a speech-start marker segment rather than silently dropped. This
    /// is the earliest signal CascadePipeline's barge-in detection (#11) has to work
    /// with; losing it here would mean a mid-playback interruption never gets detected
    /// at all.
    /// </summary>
    [Fact]
    public async Task ReadSegmentsAsync_ParsesSpeechStartedEvent_IntoSpeechStartMarker()
    {
        var socketFactory = new FakeRealtimeSocketFactory();
        var provider = CreateProvider(socketFactory, apiKey: "sk-test");
        var stream = await provider.StartStreamAsync(new SttStreamConfig("en"), CancellationToken.None);
        var socket = socketFactory.CreatedSockets[0];

        socket.EnqueueIncoming("""{"type":"input_audio_buffer.speech_started"}""");
        socket.EnqueueIncoming(null);

        var segments = new List<SttSegment>();
        await foreach (var segment in stream.ReadSegmentsAsync(CancellationToken.None))
        {
            segments.Add(segment);
        }

        var marker = Assert.Single(segments);
        Assert.Equal(SttSegmentKind.SpeechStart, marker.Kind);
        Assert.Equal(string.Empty, marker.UtteranceId);
        Assert.Equal(string.Empty, marker.Text);
    }

    /// <summary>
    /// Confirms a malformed (non-JSON) text frame from the provider is logged and
    /// skipped, and enumeration keeps going to the next valid segment - without this,
    /// one garbled frame from OpenAI would fault the whole segment pump and kill STT
    /// for the rest of the session instead of just losing that one frame.
    /// </summary>
    [Fact]
    public async Task ReadSegmentsAsync_MalformedFrame_IsSkipped_AndEnumerationContinues()
    {
        var socketFactory = new FakeRealtimeSocketFactory();
        var provider = CreateProvider(socketFactory, apiKey: "sk-test");
        var stream = await provider.StartStreamAsync(new SttStreamConfig("en"), CancellationToken.None);
        var socket = socketFactory.CreatedSockets[0];

        socket.EnqueueIncoming("not valid json at all");
        socket.EnqueueIncoming(
            """{"type":"conversation.item.input_audio_transcription.completed","item_id":"item-1","transcript":"Hello"}""");
        socket.EnqueueIncoming(null);

        var segments = new List<SttSegment>();
        await foreach (var segment in stream.ReadSegmentsAsync(CancellationToken.None))
        {
            segments.Add(segment);
        }

        var onlySegment = Assert.Single(segments);
        Assert.Equal("item-1", onlySegment.UtteranceId);
        Assert.Equal("Hello", onlySegment.Text);
        Assert.Equal(SttSegmentKind.Final, onlySegment.Kind);
    }

    /// <summary>
    /// Confirms a transcription delta frame missing item_id is skipped - producing no
    /// segment at all - rather than falling back to some shared/empty id that would
    /// cross-contaminate the replace-not-append transcript handling and latency marks
    /// a real item_id keys by.
    /// </summary>
    [Fact]
    public async Task ReadSegmentsAsync_DeltaFrameMissingItemId_ProducesNoSegment()
    {
        var socketFactory = new FakeRealtimeSocketFactory();
        var provider = CreateProvider(socketFactory, apiKey: "sk-test");
        var stream = await provider.StartStreamAsync(new SttStreamConfig("en"), CancellationToken.None);
        var socket = socketFactory.CreatedSockets[0];

        socket.EnqueueIncoming("""{"type":"conversation.item.input_audio_transcription.delta","delta":"Hel"}""");
        socket.EnqueueIncoming(null);

        var segments = new List<SttSegment>();
        await foreach (var segment in stream.ReadSegmentsAsync(CancellationToken.None))
        {
            segments.Add(segment);
        }

        Assert.Empty(segments);
    }

    /// <summary>
    /// Confirms a WebSocketException from the underlying socket's receive surfaces as
    /// SttProviderStreamException with the original exception preserved as
    /// InnerException - CascadePipeline's mid-session STT reopen logic (#12) logs that
    /// inner exception, and losing it would leave an operator with no way to diagnose
    /// why a stream actually dropped.
    /// </summary>
    [Fact]
    public async Task ReadSegmentsAsync_WebSocketExceptionFromReceive_SurfacesAsStreamException_WithInnerExceptionPreserved()
    {
        var socketFactory = new FakeRealtimeSocketFactory();
        var provider = CreateProvider(socketFactory, apiKey: "sk-test");
        var stream = await provider.StartStreamAsync(new SttStreamConfig("en"), CancellationToken.None);
        var socket = socketFactory.CreatedSockets[0];

        var originalException = new WebSocketException("connection reset");
        socket.EnqueueException(originalException);

        var ex = await Assert.ThrowsAsync<SttProviderStreamException>(async () =>
        {
            await foreach (var _ in stream.ReadSegmentsAsync(CancellationToken.None))
            {
            }
        });

        Assert.Same(originalException, ex.InnerException);
    }

    private static OpenAiSttProvider CreateProvider(
        IRealtimeSocketFactory socketFactory, string? apiKey, TimeSpan? connectTimeout = null)
    {
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["OPENAI_API_KEY"] = apiKey })
            .Build();
        return new OpenAiSttProvider(configuration, socketFactory, NullLogger<OpenAiSttProvider>.Instance, connectTimeout);
    }
}

/// <summary>Records every socket it creates so tests can inspect what was sent to it.</summary>
file sealed class FakeRealtimeSocketFactory : IRealtimeSocketFactory
{
    public List<FakeRealtimeSocket> CreatedSockets { get; } = [];

    /// <summary>Applied to every socket this factory creates from now on (#12, error
    /// handling hardening's connect-timeout test) - lets a test simulate a handshake
    /// that never completes within <see cref="OpenAiSttProvider"/>'s connect timeout.</summary>
    public TimeSpan ConnectDelay { get; set; } = TimeSpan.Zero;

    public IRealtimeSocket Create()
    {
        var socket = new FakeRealtimeSocket { ConnectDelay = ConnectDelay };
        CreatedSockets.Add(socket);
        return socket;
    }
}

/// <summary>
/// A fake OpenAI realtime WebSocket: records outgoing text frames and lets a test
/// script the incoming ones, so <see cref="OpenAiSttProvider"/>'s message
/// building/parsing can be exercised with no real network connection.
/// </summary>
file sealed class FakeRealtimeSocket : IRealtimeSocket
{
    private readonly Queue<string?> _incoming = new();
    private Exception? _exceptionToThrowOnReceive;

    public IReadOnlyDictionary<string, string> ConnectHeaders { get; private set; } = new Dictionary<string, string>();

    public List<string> SentText { get; } = [];

    /// <summary>How long <see cref="ConnectAsync"/> waits before completing - zero
    /// (the default) completes immediately; set by <see cref="FakeRealtimeSocketFactory.ConnectDelay"/>
    /// to simulate a handshake that never finishes within the provider's own timeout.</summary>
    public TimeSpan ConnectDelay { get; set; } = TimeSpan.Zero;

    public void EnqueueIncoming(string? json) => _incoming.Enqueue(json);

    /// <summary>Makes the next <see cref="ReceiveTextAsync"/> call throw
    /// <paramref name="exception"/> instead of returning a frame - simulates the
    /// underlying WebSocket dropping mid-session.</summary>
    public void EnqueueException(Exception exception) => _exceptionToThrowOnReceive = exception;

    public async Task ConnectAsync(Uri uri, IReadOnlyDictionary<string, string> headers, CancellationToken cancellationToken)
    {
        ConnectHeaders = headers;
        if (ConnectDelay > TimeSpan.Zero)
        {
            await Task.Delay(ConnectDelay, cancellationToken);
        }
    }

    public Task SendTextAsync(string json, CancellationToken cancellationToken)
    {
        SentText.Add(json);
        return Task.CompletedTask;
    }

    public Task<string?> ReceiveTextAsync(CancellationToken cancellationToken)
    {
        if (_exceptionToThrowOnReceive is { } exception)
        {
            _exceptionToThrowOnReceive = null;
            throw exception;
        }

        return Task.FromResult(_incoming.Count > 0 ? _incoming.Dequeue() : null);
    }

    public ValueTask DisposeAsync() => ValueTask.CompletedTask;
}
