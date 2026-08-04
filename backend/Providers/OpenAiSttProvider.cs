using System.Net.WebSockets;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

/// <summary>
/// Streams PCM16 audio to OpenAI's Realtime API in transcription intent
/// (<c>wss://api.openai.com/v1/realtime?intent=transcription</c>) and turns the
/// server's transcription delta/completed events into <see cref="SttSegment"/>s. Every
/// <c>gpt-4o-transcribe</c>-specific detail (message shapes, model name, VAD choice)
/// lives in this one file, per the issue's acceptance criteria that nothing outside
/// the provider knows which STT vendor is in use.
/// </summary>
public sealed class OpenAiSttProvider(
    IConfiguration configuration,
    IRealtimeSocketFactory socketFactory,
    ILogger<OpenAiSttProvider> logger) : ISttProvider
{
    /// <summary>OpenAI transcription model used for cascade-mode STT.</summary>
    public const string Model = "gpt-4o-transcribe";

    /// <summary>
    /// OpenAI server-side VAD (Voice Activity Detection) mode used to decide utterance
    /// boundaries. See the "Open sub-decisions" entry in <c>docs/tech-stack.md</c> for
    /// the semantic_vad-vs-server_vad rationale.
    /// </summary>
    public const string VadType = "semantic_vad";

    private static readonly Uri Endpoint = new("wss://api.openai.com/v1/realtime?intent=transcription");

    /// <summary>
    /// Wire options for talking to OpenAI: snake_case property names come from explicit
    /// <see cref="JsonPropertyNameAttribute"/>s on the DTOs below, not from a naming
    /// policy, so this is intentionally the untouched default rather than
    /// <see cref="CascadeAudioEndpoints.JsonOptions"/> (which is camelCase for the
    /// browser-facing envelope).
    /// </summary>
    private static readonly JsonSerializerOptions OpenAiJsonOptions = new();

    /// <inheritdoc />
    /// <exception cref="SttProviderUnavailableException">Thrown when <c>OPENAI_API_KEY</c>
    /// is not configured, or the initial connection/handshake with OpenAI fails.</exception>
    public async Task<ISttStream> StartStreamAsync(SttStreamConfig config, CancellationToken cancellationToken)
    {
        var apiKey = configuration["OPENAI_API_KEY"];
        if (string.IsNullOrWhiteSpace(apiKey))
        {
            throw new SttProviderUnavailableException(
                "The server is not configured with an OpenAI API key.");
        }

        var socket = socketFactory.Create();
        try
        {
            var headers = new Dictionary<string, string>
            {
                ["Authorization"] = $"Bearer {apiKey}",
            };
            await socket.ConnectAsync(Endpoint, headers, cancellationToken);
            await socket.SendTextAsync(
                JsonSerializer.Serialize(BuildSessionUpdate(config), OpenAiJsonOptions), cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            await socket.DisposeAsync();
            logger.LogError(ex, "Failed to open the OpenAI realtime transcription stream.");
            throw new SttProviderUnavailableException("Failed to connect to the speech-to-text provider.", ex);
        }

        return new OpenAiSttStream(socket);
    }

    private static OpenAiTranscriptionSessionUpdate BuildSessionUpdate(SttStreamConfig config) => new(
        new OpenAiTranscriptionSessionConfig(
            InputAudioFormat: "pcm16",
            InputAudioTranscription: new OpenAiInputAudioTranscriptionConfig(Model, config.SourceLang),
            TurnDetection: new OpenAiTurnDetectionConfig(VadType)));

    /// <summary>
    /// One open OpenAI transcription WebSocket, wrapped as an <see cref="ISttStream"/>.
    /// </summary>
    private sealed class OpenAiSttStream(IRealtimeSocket socket) : ISttStream
    {
        private readonly DateTime _startedAtUtc = DateTime.UtcNow;

        /// <inheritdoc />
        /// <exception cref="SttProviderStreamException">Thrown when the underlying
        /// socket can no longer accept a send (e.g. it has already closed).</exception>
        public async Task SendAudioAsync(ReadOnlyMemory<byte> pcm, CancellationToken cancellationToken)
        {
            var message = new OpenAiInputAudioBufferAppend(Convert.ToBase64String(pcm.Span));
            try
            {
                await socket.SendTextAsync(JsonSerializer.Serialize(message, OpenAiJsonOptions), cancellationToken);
            }
            catch (Exception ex) when (ex is WebSocketException or ObjectDisposedException)
            {
                throw new SttProviderStreamException("Speech-to-text connection dropped while sending audio.");
            }
        }

        /// <inheritdoc />
        public async IAsyncEnumerable<SttSegment> ReadSegmentsAsync(
            [EnumeratorCancellation] CancellationToken cancellationToken)
        {
            while (true)
            {
                string? json;
                try
                {
                    json = await socket.ReceiveTextAsync(cancellationToken);
                }
                catch (Exception ex) when (ex is WebSocketException or ObjectDisposedException)
                {
                    throw new SttProviderStreamException("Speech-to-text connection dropped.");
                }

                if (json is null)
                {
                    // Provider closed the socket normally - nothing more to enumerate.
                    yield break;
                }

                var segment = ParseEvent(json, (long)(DateTime.UtcNow - _startedAtUtc).TotalMilliseconds);
                if (segment is not null)
                {
                    yield return segment;
                }
            }
        }

        /// <inheritdoc />
        public ValueTask DisposeAsync() => socket.DisposeAsync();

        /// <summary>
        /// Interprets one inbound OpenAI realtime event. The transcription
        /// delta/completed and error events map to a transcript <see cref="SttSegment"/>;
        /// <c>input_audio_buffer.committed</c> maps to a <see cref="SttSegment.SpeechEnd"/>
        /// marker (#10, per-stage latency instrumentation - see that method's remarks
        /// for why <c>committed</c>, not <c>speech_started</c>/<c>speech_stopped</c>, is
        /// the one VAD (Voice Activity Detection) event worth surfacing here). Everything
        /// else (session lifecycle, etc.) is skipped.
        /// </summary>
        /// <param name="json">One complete JSON text frame received from OpenAI.</param>
        /// <param name="timestampMs">Milliseconds since this stream was opened.</param>
        /// <returns>The parsed segment, or <c>null</c> if this event doesn't map to one.</returns>
        /// <exception cref="SttProviderStreamException">Thrown when OpenAI sends an
        /// <c>error</c> event.</exception>
        private static SttSegment? ParseEvent(string json, long timestampMs)
        {
            using var document = JsonDocument.Parse(json);
            var root = document.RootElement;
            var type = root.TryGetProperty("type", out var typeProperty) ? typeProperty.GetString() : null;

            switch (type)
            {
                case "conversation.item.input_audio_transcription.delta":
                    return new SttSegment(
                        UtteranceId: GetString(root, "item_id") ?? "unknown",
                        Text: GetString(root, "delta") ?? string.Empty,
                        IsFinal: false,
                        TimestampMs: timestampMs);

                case "conversation.item.input_audio_transcription.completed":
                    return new SttSegment(
                        UtteranceId: GetString(root, "item_id") ?? "unknown",
                        Text: GetString(root, "transcript") ?? string.Empty,
                        IsFinal: true,
                        TimestampMs: timestampMs);

                case "input_audio_buffer.committed":
                    // The VAD (Voice Activity Detection; semantic_vad - see
                    // OpenAiSttProvider.VadType) decided this utterance's speech is
                    // complete and committed it as a new conversation item: the
                    // earliest cross-network "speech end" signal available, ahead of
                    // any transcript text. item_id here is the same id the delta/completed
                    // events for this same utterance will use, so CascadePipeline's
                    // speechEnd latency mark keys by the same utteranceId every other
                    // stage's mark for this utterance uses. Not yet spot-checked against
                    // a live OPENAI_API_KEY - see this field's caveat in
                    // docs/tech-stack.md alongside the semantic_vad decision itself.
                    return SttSegment.SpeechEnd(GetString(root, "item_id") ?? "unknown", timestampMs);

                case "input_audio_buffer.speech_started":
                case "input_audio_buffer.speech_stopped":
                    // VAD lifecycle events that don't carry an item_id yet (that's only
                    // assigned at commit, handled above) - nothing to key a segment or
                    // latency mark by from these alone.
                    return null;

                case "error":
                    var message = root.TryGetProperty("error", out var error)
                        ? GetString(error, "message") ?? "Unknown OpenAI realtime error."
                        : "Unknown OpenAI realtime error.";
                    throw new SttProviderStreamException(message);

                default:
                    return null;
            }
        }

        private static string? GetString(JsonElement element, string propertyName) =>
            element.TryGetProperty(propertyName, out var property) ? property.GetString() : null;
    }
}

// --- OpenAI wire-format DTOs (snake_case, per OpenAI's Realtime API) ---

internal sealed record OpenAiTranscriptionSessionUpdate(
    [property: JsonPropertyName("session")] OpenAiTranscriptionSessionConfig Session)
{
    [JsonPropertyName("type")]
    public string Type => "transcription_session.update";
}

internal sealed record OpenAiTranscriptionSessionConfig(
    [property: JsonPropertyName("input_audio_format")] string InputAudioFormat,
    [property: JsonPropertyName("input_audio_transcription")] OpenAiInputAudioTranscriptionConfig InputAudioTranscription,
    [property: JsonPropertyName("turn_detection")] OpenAiTurnDetectionConfig TurnDetection);

internal sealed record OpenAiInputAudioTranscriptionConfig(
    [property: JsonPropertyName("model")] string Model,
    [property: JsonPropertyName("language")] string? Language);

internal sealed record OpenAiTurnDetectionConfig(
    [property: JsonPropertyName("type")] string Type);

internal sealed record OpenAiInputAudioBufferAppend(
    [property: JsonPropertyName("audio")] string AudioBase64)
{
    [JsonPropertyName("type")]
    public string Type => "input_audio_buffer.append";
}

// --- Injectable OpenAI WebSocket seam, so tests never need a real connection ---

/// <summary>
/// The minimal WebSocket surface <see cref="OpenAiSttProvider"/> needs, abstracted so
/// xUnit tests can substitute a fake, transcript-producing socket instead of a real
/// connection to OpenAI. There is no <c>OPENAI_API_KEY</c> and no live-network access
/// in this environment, so exercising <see cref="OpenAiSttProvider"/>'s message
/// building and event parsing depends entirely on this seam.
/// </summary>
public interface IRealtimeSocket : IAsyncDisposable
{
    /// <summary>Opens the connection.</summary>
    /// <param name="uri">The WebSocket endpoint to connect to.</param>
    /// <param name="headers">Additional headers to send with the upgrade request
    /// (e.g. <c>Authorization</c>).</param>
    /// <param name="cancellationToken">Propagates connect cancellation.</param>
    Task ConnectAsync(Uri uri, IReadOnlyDictionary<string, string> headers, CancellationToken cancellationToken);

    /// <summary>Sends one complete text frame.</summary>
    /// <param name="json">The UTF-8 JSON payload to send.</param>
    /// <param name="cancellationToken">Propagates send cancellation.</param>
    Task SendTextAsync(string json, CancellationToken cancellationToken);

    /// <summary>Receives one complete text frame.</summary>
    /// <param name="cancellationToken">Propagates receive cancellation.</param>
    /// <returns>The frame's text, or <c>null</c> if the peer closed the connection.</returns>
    Task<string?> ReceiveTextAsync(CancellationToken cancellationToken);
}

/// <summary>Creates <see cref="IRealtimeSocket"/> instances. Injected so DI (dependency
/// injection) can swap in a fake factory for tests without touching provider code.</summary>
public interface IRealtimeSocketFactory
{
    /// <summary>Creates a new, not-yet-connected socket.</summary>
    IRealtimeSocket Create();
}

/// <summary>Real <see cref="IRealtimeSocketFactory"/> backed by <see cref="ClientWebSocket"/>.</summary>
public sealed class ClientWebSocketRealtimeSocketFactory : IRealtimeSocketFactory
{
    /// <inheritdoc />
    public IRealtimeSocket Create() => new ClientWebSocketRealtimeSocket();
}

/// <summary>
/// <see cref="IRealtimeSocket"/> implementation over a real <see cref="ClientWebSocket"/>.
/// </summary>
internal sealed class ClientWebSocketRealtimeSocket : IRealtimeSocket
{
    private const int ReceiveBufferBytes = 16 * 1024;

    private readonly ClientWebSocket _socket = new();

    public async Task ConnectAsync(Uri uri, IReadOnlyDictionary<string, string> headers, CancellationToken cancellationToken)
    {
        foreach (var (name, value) in headers)
        {
            _socket.Options.SetRequestHeader(name, value);
        }

        await _socket.ConnectAsync(uri, cancellationToken);
    }

    public async Task SendTextAsync(string json, CancellationToken cancellationToken)
    {
        var bytes = Encoding.UTF8.GetBytes(json);
        await _socket.SendAsync(bytes, WebSocketMessageType.Text, endOfMessage: true, cancellationToken);
    }

    public async Task<string?> ReceiveTextAsync(CancellationToken cancellationToken)
    {
        var buffer = new byte[ReceiveBufferBytes];
        using var messageStream = new MemoryStream();
        WebSocketReceiveResult result;
        do
        {
            result = await _socket.ReceiveAsync(buffer, cancellationToken);
            if (result.MessageType == WebSocketMessageType.Close)
            {
                return null;
            }

            messageStream.Write(buffer, 0, result.Count);
        } while (!result.EndOfMessage);

        return Encoding.UTF8.GetString(messageStream.ToArray());
    }

    public ValueTask DisposeAsync()
    {
        _socket.Dispose();
        return ValueTask.CompletedTask;
    }
}
