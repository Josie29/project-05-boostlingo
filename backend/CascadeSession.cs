using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;

/// <summary>
/// Wires up the cascade mode audio transport: a raw WebSocket that carries binary
/// PCM (Pulse Code Modulation) audio frames upstream and JSON control/event
/// envelopes in both directions. This is transport only - the actual speech-to-text,
/// machine translation, and text-to-speech pipeline stages land in issues #5-7 behind
/// <see cref="ICascadePipeline"/> so this file never needs to change for them.
/// </summary>
public static class CascadeAudioEndpoints
{
    /// <summary>Route the frontend opens a WebSocket connection to for cascade mode audio.</summary>
    public const string RoutePattern = "/ws/cascade";

    /// <summary>Current version of the <c>{v, type, payload}</c> envelope wire format.</summary>
    public const int EnvelopeVersion = 1;

    /// <summary>
    /// Shared JSON options for every cascade message. Matches the camelCase convention
    /// minimal API's <c>Results.Json</c> already uses for the REST endpoints, so the
    /// wire format is consistent whether the frontend is reading a WebSocket frame or
    /// an HTTP response body.
    /// </summary>
    public static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    /// <summary>
    /// Registers <c>GET /ws/cascade</c> (upgraded to a WebSocket) as the cascade mode
    /// audio channel.
    /// </summary>
    /// <param name="app">The application to add the endpoint to.</param>
    /// <returns>The same application, for chaining.</returns>
    public static WebApplication MapCascadeAudioEndpoints(this WebApplication app)
    {
        app.Map(RoutePattern, HandleConnectionAsync);
        return app;
    }

    private static async Task HandleConnectionAsync(
        HttpContext context,
        ICascadePipeline pipeline,
        ILoggerFactory loggerFactory)
    {
        if (!context.WebSockets.IsWebSocketRequest)
        {
            context.Response.StatusCode = StatusCodes.Status400BadRequest;
            return;
        }

        using var socket = await context.WebSockets.AcceptWebSocketAsync();
        var logger = loggerFactory.CreateLogger("CascadeSession");
        var session = new CascadeSession(socket, pipeline, logger);
        await session.RunAsync(context.RequestAborted);
    }
}

/// <summary>
/// Lets a pipeline stage (or the transport itself) push a JSON event down to the
/// browser without knowing anything about the underlying WebSocket.
/// </summary>
public interface ICascadeEventSink
{
    /// <summary>
    /// The session this sink belongs to (#12, error handling hardening) - threaded
    /// through to every pipeline stage that already receives an <see cref="ICascadeEventSink"/>
    /// on every call, so <see cref="CascadePipeline"/> and <see cref="TtsCascadeObserver"/>
    /// can stamp every failure log line with the session id without either needing a
    /// constructor dependency of its own or <see cref="CascadeSession"/> needing to pass
    /// it as a separate parameter on every interface method.
    /// </summary>
    Guid SessionId { get; }

    /// <summary>
    /// Sends a <c>{v, type, payload}</c> envelope to the client as a text frame.
    /// </summary>
    /// <param name="type">One of <see cref="CascadeMessageTypes"/>, or a stage-specific type
    /// introduced by a later pipeline issue.</param>
    /// <param name="payload">The event's data, serialized as-is; pass <c>null</c> for none.</param>
    /// <param name="cancellationToken">Propagates send cancellation.</param>
    /// <returns>A task that completes once the frame has been written to the socket.</returns>
    Task SendEventAsync(string type, object? payload, CancellationToken cancellationToken);

    /// <summary>
    /// Sends raw bytes to the client as a single binary WebSocket frame - the downstream
    /// half of text-to-speech (#7): one call per <see cref="TtsAudioChunk"/>, bracketed
    /// by a <see cref="CascadeMessageTypes.TtsAudioStart"/>/<see cref="CascadeMessageTypes.TtsAudioEnd"/>
    /// pair sent via <see cref="SendEventAsync"/>. Shares the same underlying send lock
    /// as <see cref="SendEventAsync"/> so a control/transcript event from another task
    /// can never land in the middle of the bytes that make up one binary frame.
    /// </summary>
    /// <param name="data">Raw audio bytes for this frame.</param>
    /// <param name="cancellationToken">Propagates send cancellation.</param>
    /// <returns>A task that completes once the frame has been written to the socket.</returns>
    Task SendBinaryAsync(ReadOnlyMemory<byte> data, CancellationToken cancellationToken);
}

/// <summary>
/// The seam for the speech-to-text, machine translation, and text-to-speech stages
/// (#5-7). The transport (<see cref="CascadeSession"/>) only ever talks to this
/// interface, so those stages slot in by registering a real implementation in DI -
/// no changes to the WebSocket handling itself.
/// </summary>
public interface ICascadePipeline
{
    /// <summary>Called once, when the client sends <see cref="CascadeMessageTypes.SessionStart"/>.</summary>
    /// <param name="config">The negotiated source/target language pair.</param>
    /// <param name="events">Sink for any events the pipeline wants to push to the client.</param>
    /// <param name="cancellationToken">Propagates session cancellation.</param>
    Task OnSessionStartedAsync(CascadeSessionConfig config, ICascadeEventSink events, CancellationToken cancellationToken);

    /// <summary>Called for every PCM chunk received from the client, in arrival order.</summary>
    /// <param name="pcm">Raw PCM16 mono samples at <see cref="CascadeAudioFormat.SampleRateHz"/>.</param>
    /// <param name="events">Sink for any events the pipeline wants to push to the client.</param>
    /// <param name="cancellationToken">Propagates session cancellation.</param>
    Task OnAudioChunkAsync(ReadOnlyMemory<byte> pcm, ICascadeEventSink events, CancellationToken cancellationToken);

    /// <summary>
    /// Called once when the session ends, whether via <see cref="CascadeMessageTypes.SessionStop"/>,
    /// client disconnect, or a server-side error. Implementations should release any
    /// per-session resources here.
    /// </summary>
    /// <param name="events">Sink for any final events the pipeline wants to push to the client.</param>
    /// <param name="cancellationToken">Best-effort only - may already be cancelled on disconnect.</param>
    Task OnSessionEndedAsync(ICascadeEventSink events, CancellationToken cancellationToken);
}

/// <summary>
/// Owns the lifecycle of a single cascade WebSocket connection: parses control
/// frames, feeds binary audio frames into a bounded channel so a slow pipeline
/// can't grow server memory unboundedly, and guarantees the pipeline is notified
/// and the socket is closed exactly once however the session ends.
/// </summary>
/// <remarks>
/// Backpressure: the audio channel is bounded at <see cref="AudioChannelCapacity"/>
/// chunks and configured to drop the oldest chunk when full rather than block the
/// receive loop or grow without bound. Dropping stale audio is preferable to either
/// stalling the WebSocket (which risks the browser's send buffer backing up) or an
/// unbounded queue (which risks OOM under a pipeline stall) - a cascade interpreter
/// has no use for audio that's seconds behind real time regardless.
/// </remarks>
public sealed class CascadeSession(WebSocket socket, ICascadePipeline pipeline, ILogger logger) : ICascadeEventSink
{
    private const int ReceiveBufferBytes = 8 * 1024;
    private const int MaxFrameBytes = 256 * 1024;
    private const int AudioChannelCapacity = 64;

    private readonly Channel<byte[]> _audioChannel = Channel.CreateBounded<byte[]>(
        new BoundedChannelOptions(AudioChannelCapacity)
        {
            FullMode = BoundedChannelFullMode.DropOldest,
            SingleReader = true,
            SingleWriter = true,
        });

    private readonly SemaphoreSlim _sendLock = new(1, 1);
    private readonly Guid _sessionId = Guid.NewGuid();

    /// <summary>
    /// Bounded window <see cref="CloseSocketAsync"/> gives the WebSocket close
    /// handshake before giving up on it - mirrors <c>TtsCascadeObserver.DisposeDrainTimeout</c>'s
    /// "don't hang session teardown forever" rationale, applied to the close handshake
    /// itself rather than draining queued work.
    /// </summary>
    private static readonly TimeSpan CloseHandshakeTimeout = TimeSpan.FromSeconds(2);

    private long _bytesSinceLastLog;
    private DateTime _lastLogUtc = DateTime.UtcNow;
    private int _peakSinceLastLog;
    private double _sumSquaresSinceLastLog;
    private long _samplesSinceLastLog;
    private bool _sessionEndedNotified;

    /// <summary>
    /// Whether <see cref="HandleSessionStartAsync"/> has already started this session
    /// once (code-review fix). A second <see cref="CascadeMessageTypes.SessionStart"/>
    /// is rejected with a recoverable error rather than reaching
    /// <see cref="ICascadePipeline.OnSessionStartedAsync"/> again, which would open a
    /// second STT (speech-to-text) stream and orphan the first one's already-running
    /// pump tasks.
    /// </summary>
    private bool _started;

    /// <inheritdoc />
    public Guid SessionId => _sessionId;

    /// <summary>
    /// Runs the session to completion: consumes control and audio frames until the
    /// client disconnects, sends <see cref="CascadeMessageTypes.SessionStop"/>, or an
    /// error occurs, then guarantees the pipeline is notified and the socket closed.
    /// </summary>
    /// <param name="cancellationToken">Cancelled when the server is shutting down or
    /// the underlying HTTP request is aborted.</param>
    public async Task RunAsync(CancellationToken cancellationToken)
    {
        var pipelineTask = ConsumeAudioAsync(cancellationToken);

        try
        {
            await ReceiveLoopAsync(cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogError(ex, "Cascade session {SessionId} terminated by an unexpected error.", _sessionId);
            await TrySendErrorAsync("Internal server error.", CascadeErrorStages.Session, recoverable: false, cancellationToken);
        }
        finally
        {
            // Unblocks ConsumeAudioAsync's ReadAllAsync once no more chunks are coming,
            // whatever caused the receive loop to end.
            _audioChannel.Writer.TryComplete();

            try
            {
                await pipelineTask;
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Cascade session {SessionId} pipeline consumer faulted during drain.", _sessionId);
            }

            await NotifySessionEndedOnceAsync();
            await CloseSocketAsync();
            logger.LogInformation("Cascade session {SessionId} closed.", _sessionId);
        }
    }

    private async Task ReceiveLoopAsync(CancellationToken cancellationToken)
    {
        var buffer = new byte[ReceiveBufferBytes];
        while (socket.State == WebSocketState.Open && !cancellationToken.IsCancellationRequested)
        {
            using var messageStream = new MemoryStream();
            WebSocketReceiveResult result;
            do
            {
                try
                {
                    result = await socket.ReceiveAsync(buffer, cancellationToken);
                }
                catch (WebSocketException ex)
                {
                    logger.LogInformation(
                        "Cascade session {SessionId} connection dropped: {Message}", _sessionId, ex.Message);
                    return;
                }

                if (result.MessageType == WebSocketMessageType.Close)
                {
                    logger.LogInformation("Cascade session {SessionId} received a close frame from the client.", _sessionId);
                    return;
                }

                messageStream.Write(buffer, 0, result.Count);
                if (messageStream.Length > MaxFrameBytes)
                {
                    logger.LogWarning(
                        "Cascade session {SessionId} sent a frame exceeding {MaxBytes} bytes; aborting.",
                        _sessionId,
                        MaxFrameBytes);
                    await TrySendErrorAsync(
                        $"Frame exceeded the {MaxFrameBytes}-byte limit.", CascadeErrorStages.Session, recoverable: false, cancellationToken);
                    return;
                }
            } while (!result.EndOfMessage);

            if (result.MessageType == WebSocketMessageType.Binary)
            {
                HandleAudioChunk(messageStream.ToArray());
            }
            else if (result.MessageType == WebSocketMessageType.Text)
            {
                var shouldContinue = await HandleControlMessageAsync(
                    Encoding.UTF8.GetString(messageStream.ToArray()), cancellationToken);
                if (!shouldContinue)
                {
                    return;
                }
            }
        }
    }

    /// <summary>
    /// Enqueues one PCM chunk for the pipeline and logs throughput plus signal level
    /// (peak and RMS (Root Mean Square) of the int16 samples) roughly once a second -
    /// deliberate, permanent debug telemetry (not tied to any one pipeline stage).
    /// Throughput at the expected rate with peak/RMS near zero is the signature of a
    /// dead capture path: the client is streaming, but what it streams is silence -
    /// indistinguishable from a healthy session by byte counts alone.
    /// </summary>
    /// <param name="pcm">One binary WebSocket frame's worth of PCM16 audio.</param>
    private void HandleAudioChunk(byte[] pcm)
    {
        // Bounded + DropOldest: never blocks the receive loop, never grows unbounded.
        _audioChannel.Writer.TryWrite(pcm);

        _bytesSinceLastLog += pcm.Length;
        var sampleCount = pcm.Length >> 1; // 2 bytes per int16 sample
        for (var i = 0; i < sampleCount; i++)
        {
            int sample = BitConverter.ToInt16(pcm, i * 2);
            var magnitude = Math.Abs(sample);
            if (magnitude > _peakSinceLastLog)
            {
                _peakSinceLastLog = magnitude;
            }

            _sumSquaresSinceLastLog += (double)sample * sample;
        }

        _samplesSinceLastLog += sampleCount;

        var now = DateTime.UtcNow;
        if (now - _lastLogUtc >= TimeSpan.FromSeconds(1))
        {
            var rms = _samplesSinceLastLog > 0
                ? Math.Sqrt(_sumSquaresSinceLastLog / _samplesSinceLastLog)
                : 0;
            logger.LogDebug(
                "Cascade session {SessionId} audio throughput: {BytesPerSecond} B/s, peak {Peak}, RMS {Rms:F0} (int16 full scale 32767).",
                _sessionId, _bytesSinceLastLog, _peakSinceLastLog, rms);
            _bytesSinceLastLog = 0;
            _peakSinceLastLog = 0;
            _sumSquaresSinceLastLog = 0;
            _samplesSinceLastLog = 0;
            _lastLogUtc = now;
        }
    }

    /// <returns><c>false</c> if the receive loop should stop (the client asked to end
    /// the session); <c>true</c> to keep receiving.</returns>
    private async Task<bool> HandleControlMessageAsync(string json, CancellationToken cancellationToken)
    {
        CascadeInboundEnvelope envelope;
        try
        {
            envelope = JsonSerializer.Deserialize<CascadeInboundEnvelope>(json, CascadeAudioEndpoints.JsonOptions)
                ?? throw new JsonException("Control message deserialized to null.");
        }
        catch (JsonException ex)
        {
            logger.LogWarning(
                "Cascade session {SessionId} received a malformed control message: {Message}", _sessionId, ex.Message);
            await TrySendErrorAsync(
                $"Malformed control message: {ex.Message}", CascadeErrorStages.Session, recoverable: true, cancellationToken);
            return true;
        }

        switch (envelope.Type)
        {
            case CascadeMessageTypes.SessionStart:
                await HandleSessionStartAsync(envelope.Payload, cancellationToken);
                return true;

            case CascadeMessageTypes.SessionStop:
                logger.LogInformation("Cascade session {SessionId} received session.stop from the client.", _sessionId);
                await NotifySessionEndedOnceAsync();
                return false;

            default:
                await TrySendErrorAsync(
                    $"Unknown control message type '{envelope.Type}'.", CascadeErrorStages.Session, recoverable: true, cancellationToken);
                return true;
        }
    }

    private async Task HandleSessionStartAsync(JsonElement payload, CancellationToken cancellationToken)
    {
        if (_started)
        {
            // Code-review fix: a repeat session.start must never reach the pipeline
            // again - see _started's own remarks for what that would otherwise leak.
            await TrySendErrorAsync(
                "session.start already received for this session; a session cannot be restarted.",
                CascadeErrorStages.Session,
                recoverable: true,
                cancellationToken);
            return;
        }

        if (payload.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null)
        {
            await TrySendErrorAsync(
                "session.start requires a payload with sourceLang and targetLang.",
                CascadeErrorStages.Session,
                recoverable: true,
                cancellationToken);
            return;
        }

        CascadeSessionStartPayload? start;
        try
        {
            start = payload.Deserialize<CascadeSessionStartPayload>(CascadeAudioEndpoints.JsonOptions);
        }
        catch (JsonException ex)
        {
            await TrySendErrorAsync(
                $"Malformed session.start payload: {ex.Message}", CascadeErrorStages.Session, recoverable: true, cancellationToken);
            return;
        }

        if (start is null || string.IsNullOrWhiteSpace(start.SourceLang) || string.IsNullOrWhiteSpace(start.TargetLang))
        {
            await TrySendErrorAsync(
                "session.start requires non-empty sourceLang and targetLang.",
                CascadeErrorStages.Session,
                recoverable: true,
                cancellationToken);
            return;
        }

        if (!Languages.IsSupportedPair(start.SourceLang, start.TargetLang))
        {
            logger.LogWarning(
                "Cascade session {SessionId} rejected unsupported language pair '{SourceLang}' -> '{TargetLang}'.",
                _sessionId,
                start.SourceLang,
                start.TargetLang);
            await TrySendErrorAsync(
                $"Unsupported language pair '{start.SourceLang}' -> '{start.TargetLang}'.",
                CascadeErrorStages.Session,
                recoverable: true,
                cancellationToken);
            return;
        }

        logger.LogInformation(
            "Cascade session {SessionId} started: {SourceLang} -> {TargetLang}.",
            _sessionId,
            start.SourceLang,
            start.TargetLang);

        _started = true;
        await pipeline.OnSessionStartedAsync(new CascadeSessionConfig(start.SourceLang, start.TargetLang), this, cancellationToken);

        await SendEventAsync(
            CascadeMessageTypes.SessionReady,
            new CascadeSessionReadyPayload(CascadeAudioFormat.SampleRateHz, CascadeAudioFormat.Encoding, CascadeAudioFormat.Channels),
            cancellationToken);
    }

    private async Task ConsumeAudioAsync(CancellationToken cancellationToken)
    {
        try
        {
            await foreach (var chunk in _audioChannel.Reader.ReadAllAsync(cancellationToken))
            {
                try
                {
                    await pipeline.OnAudioChunkAsync(chunk, this, cancellationToken);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    // A single bad chunk shouldn't take down the whole session - later
                    // pipeline stages (#5-7) have their own retry/error semantics; the
                    // transport just reports it and keeps forwarding subsequent chunks.
                    // Stage is stt here (not session) - OnAudioChunkAsync's only job is
                    // handing PCM to the STT provider, so any exception it lets through
                    // is necessarily that stage's.
                    logger.LogError(ex, "Cascade session {SessionId} pipeline stage failed on an audio chunk.", _sessionId);
                    await TrySendErrorAsync(
                        "Pipeline error while processing audio.", CascadeErrorStages.Stt, recoverable: true, cancellationToken);
                }
            }
        }
        catch (OperationCanceledException)
        {
            // Expected during shutdown.
        }
    }

    private async Task NotifySessionEndedOnceAsync()
    {
        if (_sessionEndedNotified)
        {
            return;
        }

        _sessionEndedNotified = true;
        try
        {
            // CancellationToken.None: this runs during teardown, where the session's
            // own token may already be cancelled - the pipeline should still get a
            // chance to release resources.
            await pipeline.OnSessionEndedAsync(this, CancellationToken.None);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Cascade session {SessionId} pipeline OnSessionEndedAsync failed.", _sessionId);
        }
    }

    private async Task CloseSocketAsync()
    {
        if (socket.State is not (WebSocketState.Open or WebSocketState.CloseReceived))
        {
            return;
        }

        try
        {
            using var timeoutCts = new CancellationTokenSource(CloseHandshakeTimeout);
            await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "Session ended.", timeoutCts.Token);
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Cascade session {SessionId} socket close did not complete cleanly.", _sessionId);
        }
    }

    /// <inheritdoc />
    public async Task SendEventAsync(string type, object? payload, CancellationToken cancellationToken)
    {
        var envelope = new CascadeOutboundEnvelope(CascadeAudioEndpoints.EnvelopeVersion, type, payload, CascadeClock.UtcNowMs());
        var bytes = JsonSerializer.SerializeToUtf8Bytes(envelope, CascadeAudioEndpoints.JsonOptions);

        await _sendLock.WaitAsync(cancellationToken);
        try
        {
            if (socket.State == WebSocketState.Open)
            {
                await socket.SendAsync(bytes, WebSocketMessageType.Text, endOfMessage: true, cancellationToken);
            }
        }
        finally
        {
            _sendLock.Release();
        }
    }

    /// <inheritdoc />
    public async Task SendBinaryAsync(ReadOnlyMemory<byte> data, CancellationToken cancellationToken)
    {
        await _sendLock.WaitAsync(cancellationToken);
        try
        {
            if (socket.State == WebSocketState.Open)
            {
                await socket.SendAsync(data, WebSocketMessageType.Binary, endOfMessage: true, cancellationToken);
            }
        }
        finally
        {
            _sendLock.Release();
        }
    }

    /// <param name="message">A human-readable, non-sensitive description of what went wrong.</param>
    /// <param name="stage">One of <see cref="CascadeErrorStages"/>.</param>
    /// <param name="recoverable">See <see cref="CascadeErrorPayload.Recoverable"/>.</param>
    /// <param name="cancellationToken">Propagates send cancellation.</param>
    /// <param name="utteranceId">See <see cref="CascadeErrorPayload.UtteranceId"/>; <c>null</c>
    /// for every transport-level error this class sends, since none of them are scoped
    /// to one utterance.</param>
    private async Task TrySendErrorAsync(
        string message, string stage, bool recoverable, CancellationToken cancellationToken, string? utteranceId = null) =>
        await CascadeErrors.TrySendAsync(this, stage, message, recoverable, logger, cancellationToken, utteranceId);
}
