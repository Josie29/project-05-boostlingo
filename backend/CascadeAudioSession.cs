using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
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
/// The PCM audio format every cascade session speaks upstream (browser to server).
/// 16 kHz was chosen over 24 kHz because it's the lowest common denominator speech
/// providers (including OpenAI's transcription models) accept without upsampling,
/// and it halves the bandwidth/CPU cost of the frontend's AudioWorklet resampler
/// relative to 24 kHz for no meaningful loss in speech recognition quality.
/// </summary>
public static class CascadeAudioFormat
{
    /// <summary>Samples per second. The frontend must downsample the mic input to this rate.</summary>
    public const int SampleRateHz = 16_000;

    /// <summary>Bits per sample. Signed, little-endian.</summary>
    public const int BitsPerSample = 16;

    /// <summary>Audio channels. Mono only - stereo mic input must be downmixed client-side.</summary>
    public const int Channels = 1;

    /// <summary>Wire-format identifier for the encoding, echoed in the <c>session.ready</c> event.</summary>
    public const string Encoding = "pcm16";
}

/// <summary>String constants for every <c>type</c> value used in the cascade envelope, kept in
/// one place so the transport and later pipeline stages (#5-7) share a single vocabulary.</summary>
public static class CascadeMessageTypes
{
    /// <summary>Client to server: begin a session with a source/target language pair.</summary>
    public const string SessionStart = "session.start";

    /// <summary>Client to server: end the session; the server acks by closing the socket.</summary>
    public const string SessionStop = "session.stop";

    /// <summary>Server to client: acknowledges <see cref="SessionStart"/> and echoes the audio format.</summary>
    public const string SessionReady = "session.ready";

    /// <summary>Server to client: a non-fatal problem the client should surface to the user.</summary>
    public const string Error = "error";

    /// <summary>Server to client: an in-progress (not yet settled) transcript segment.</summary>
    public const string TranscriptPartial = "transcript.partial";

    /// <summary>Server to client: the settled transcript text for one utterance.</summary>
    public const string TranscriptFinal = "transcript.final";

    /// <summary>
    /// Server to client: announces that one or more binary PCM audio frames for the
    /// named utterance are about to follow, and how to interpret them. See
    /// <see cref="CascadeTtsAudioStartPayload"/>.
    /// </summary>
    public const string TtsAudioStart = "tts.audio.start";

    /// <summary>
    /// Server to client: no more binary audio frames are coming for the utterance
    /// named in the matching <see cref="TtsAudioStart"/>. See <see cref="CascadeTtsAudioEndPayload"/>.
    /// </summary>
    public const string TtsAudioEnd = "tts.audio.end";

    /// <summary>
    /// Server to client: one pipeline stage boundary was just reached for one
    /// utterance (#10, per-stage latency instrumentation). See
    /// <see cref="CascadeLatencyMarkPayload"/> and <see cref="CascadeLatencyStages"/>.
    /// </summary>
    public const string LatencyMark = "latency.mark";

    /// <summary>
    /// Server to client: the speaker started a new utterance while one or more earlier
    /// utterances still had translation/synthesis work queued or in flight (#11,
    /// barge-in). <see cref="CascadePipeline"/> has already cancelled that in-flight
    /// work server-side; this event tells the client which utterances it applies to so
    /// its own playback queue can be flushed - no stale audio from a cancelled
    /// utterance should keep playing after this arrives. Only ever sent when at least
    /// one utterance was actually superseded; a speech-onset signal with nothing in
    /// flight produces no event at all. See <see cref="CascadeBargeInPayload"/>. Always
    /// preceded by one <see cref="TranscriptTruncated"/> event per superseded id.
    /// </summary>
    public const string BargeIn = "bargein";

    /// <summary>
    /// Server to client: marks one target-lane utterance's transcript as cut short by
    /// a later barge-in (#11) rather than having reached a natural end. Sent once per
    /// superseded utterance, immediately before the aggregated <see cref="BargeIn"/>
    /// event for the same barge-in - see <see cref="CascadeTranscriptTruncatedPayload"/>.
    /// </summary>
    public const string TranscriptTruncated = "transcript.truncated";
}

/// <summary>
/// String constants for the <c>lane</c> field of <see cref="CascadeTranscriptPayload"/>,
/// identifying which transcript column on the client a segment belongs to.
/// </summary>
public static class CascadeTranscriptLanes
{
    /// <summary>The speaker's own language, as recognized by STT (speech-to-text; #5).</summary>
    public const string Source = "source";

    /// <summary>The interpreted language, once MT (machine translation; #6) lands.</summary>
    public const string Target = "target";
}

/// <summary>
/// The inbound shape of every cascade text frame: <c>{ "v": 1, "type": "...", "payload": {...} }</c>.
/// <c>Payload</c> is kept as a raw <see cref="JsonElement"/> here because its shape depends on
/// <c>Type</c>, which callers inspect before deserializing into a concrete payload record.
/// </summary>
/// <param name="V">Envelope schema version. Present so a future incompatible change can be
/// detected by receivers instead of silently misparsing.</param>
/// <param name="Type">One of <see cref="CascadeMessageTypes"/>.</param>
/// <param name="Payload">Type-specific data, or <c>default</c> when the message carries none
/// (e.g. <see cref="CascadeMessageTypes.SessionStop"/>).</param>
public sealed record CascadeInboundEnvelope(int V, string Type, JsonElement Payload = default);

/// <summary>
/// The outbound shape of every cascade text frame, matching <see cref="CascadeInboundEnvelope"/>
/// on the wire. <c>Payload</c> is <see cref="object"/> here (rather than <see cref="JsonElement"/>)
/// because outbound payloads are always a concrete record we're serializing, not one we're
/// inspecting before we know its type.
/// </summary>
/// <param name="V">Envelope schema version.</param>
/// <param name="Type">One of <see cref="CascadeMessageTypes"/>.</param>
/// <param name="Payload">Type-specific data, or <c>null</c> when the event carries none.</param>
/// <param name="ServerTimeMs">The moment this envelope was sent, as milliseconds since
/// the Unix epoch (UTC) - see <see cref="CascadeClock"/>. Present on every outbound
/// envelope (#10, per-stage latency instrumentation) so the client can time any event,
/// not only <see cref="CascadeMessageTypes.LatencyMark"/>, without ever needing to
/// reconcile its own clock against the server's: every duration the client computes
/// for a server-side span is a difference of two <c>serverTimeMs</c> values, never a
/// client-minus-server subtraction.</param>
public sealed record CascadeOutboundEnvelope(int V, string Type, object? Payload, long ServerTimeMs);

/// <summary>
/// Single source of truth for the server-relative clock discipline every cascade
/// envelope uses (#10): the current time as milliseconds since the Unix epoch (UTC).
/// Every outbound envelope (<see cref="CascadeOutboundEnvelope.ServerTimeMs"/>) and
/// every <see cref="CascadeLatencyMarkPayload.ServerTimeMs"/> is stamped by calling this
/// once, at the moment the corresponding event actually happened server-side - never by
/// the client attempting to translate a server timestamp using its own clock offset.
/// See the "Open sub-decisions" entry in <c>docs/tech-stack.md</c> for the full
/// client-side-aggregation rationale this clock choice supports.
/// </summary>
public static class CascadeClock
{
    /// <summary>The current time, in milliseconds since the Unix epoch (UTC).</summary>
    public static long UtcNowMs() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
}

/// <summary>
/// String constants for the <c>stage</c> field of <see cref="CascadeLatencyMarkPayload"/>,
/// one per cascade pipeline boundary #10 instruments. Every mark for one spoken
/// utterance - across all seven stages - is keyed by the same <c>utteranceId</c>: the
/// source-lane id <see cref="SttSegment.UtteranceId"/> assigns, not the derived
/// <c>"-target"</c> id <see cref="CascadePipeline"/> uses for target-lane transcript
/// bookkeeping, so a client can group a whole utterance's stage breakdown under one key.
/// </summary>
public static class CascadeLatencyStages
{
    /// <summary>
    /// The STT (speech-to-text) provider's VAD (Voice Activity Detection) decided the
    /// speaker's turn is complete and committed it as a conversation item - the
    /// earliest cross-network signal of "speech end" the cascade has, ahead of any
    /// transcript text. See <see cref="SttSegment.IsSpeechEndMarker"/>.
    /// </summary>
    public const string SpeechEnd = "speechEnd";

    /// <summary>The first (possibly still-changing) STT transcript update for this utterance arrived.</summary>
    public const string SttFirstPartial = "sttFirstPartial";

    /// <summary>The settled STT transcript for this utterance arrived.</summary>
    public const string SttFinal = "sttFinal";

    /// <summary>The first MT (machine translation) token for this utterance's translation arrived.</summary>
    public const string MtFirstToken = "mtFirstToken";

    /// <summary>The settled MT translation for this utterance arrived.</summary>
    public const string MtFinal = "mtFinal";

    /// <summary>The first synthesized TTS (text-to-speech) audio byte for this utterance arrived from the provider.</summary>
    public const string TtsFirstByte = "ttsFirstByte";

    /// <summary>The last synthesized TTS audio for this utterance was sent - <see cref="CascadeMessageTypes.TtsAudioEnd"/> just went out.</summary>
    public const string TtsEnd = "ttsEnd";
}

/// <summary>
/// Payload for <see cref="CascadeMessageTypes.LatencyMark"/> (#10, per-stage latency
/// instrumentation): one pipeline stage boundary, for one utterance, at one server time.
/// </summary>
/// <param name="UtteranceId">The source-lane utterance id (see <see cref="CascadeLatencyStages"/>'s
/// remarks) every stage of this one spoken utterance shares.</param>
/// <param name="Stage">One of <see cref="CascadeLatencyStages"/>.</param>
/// <param name="ServerTimeMs">The moment this stage boundary was reached, as
/// milliseconds since the Unix epoch (UTC) - see <see cref="CascadeClock"/>. Computed by
/// the pipeline stage that observed the boundary, not by the transport at send time, so
/// it reflects when the work actually happened rather than when the envelope happened
/// to be serialized.</param>
public sealed record CascadeLatencyMarkPayload(string UtteranceId, string Stage, long ServerTimeMs);

/// <summary>
/// Sends one <see cref="CascadeMessageTypes.LatencyMark"/> event and swallows any send
/// failure (logged at Debug, never thrown) so instrumentation can never take down the
/// pipeline stage that's emitting it - mirrors how every other cross-cutting
/// observer/stage failure in this codebase is isolated (e.g.
/// <see cref="CascadePipeline"/>'s segment/translation observer error handling). Shared
/// by every stage (<see cref="CascadePipeline"/> for STT/MT, <see cref="TtsCascadeObserver"/>
/// for TTS) so the mark schema and failure handling can't drift between stages.
/// </summary>
public static class CascadeLatencyMarks
{
    /// <summary>
    /// Sends a latency mark for one utterance/stage pair.
    /// </summary>
    /// <param name="utteranceId">The source-lane utterance id this mark belongs to.</param>
    /// <param name="stage">One of <see cref="CascadeLatencyStages"/>.</param>
    /// <param name="events">Sink to send the mark on - the same one the stage's own data event used.</param>
    /// <param name="logger">Logs a send failure at Debug; never rethrown.</param>
    /// <param name="cancellationToken">Propagates session cancellation.</param>
    public static async Task EmitAsync(
        string utteranceId, string stage, ICascadeEventSink events, ILogger logger, CancellationToken cancellationToken)
    {
        try
        {
            await events.SendEventAsync(
                CascadeMessageTypes.LatencyMark,
                new CascadeLatencyMarkPayload(utteranceId, stage, CascadeClock.UtcNowMs()),
                cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogDebug(ex, "Failed to send latency mark '{Stage}' for utterance {UtteranceId}.", stage, utteranceId);
        }
    }
}

/// <summary>Payload for <see cref="CascadeMessageTypes.SessionStart"/>.</summary>
/// <param name="SourceLang">BCP-47-ish language tag the speaker is using, e.g. <c>"en"</c>.</param>
/// <param name="TargetLang">Language tag to interpret into, e.g. <c>"es"</c>.</param>
public sealed record CascadeSessionStartPayload(string SourceLang, string TargetLang);

/// <summary>Payload for <see cref="CascadeMessageTypes.SessionReady"/>.</summary>
/// <param name="SampleRateHz">Required upstream PCM sample rate; see <see cref="CascadeAudioFormat"/>.</param>
/// <param name="Encoding">Required upstream PCM encoding; see <see cref="CascadeAudioFormat"/>.</param>
/// <param name="Channels">Required upstream channel count; see <see cref="CascadeAudioFormat"/>.</param>
public sealed record CascadeSessionReadyPayload(int SampleRateHz, string Encoding, int Channels);

/// <summary>
/// String constants for the <c>stage</c> field of <see cref="CascadeErrorPayload"/> (#12,
/// error handling hardening): which cascade stage - or the session/transport itself -
/// produced a given <see cref="CascadeMessageTypes.Error"/> envelope, so the client can
/// render per-stage errors distinctly instead of one undifferentiated error banner.
/// </summary>
public static class CascadeErrorStages
{
    /// <summary>Speech-to-text (#5): the provider failed to start, or an open stream died.</summary>
    public const string Stt = "stt";

    /// <summary>Machine translation (#6): a single utterance's translation request failed.</summary>
    public const string Mt = "mt";

    /// <summary>Text-to-speech (#7): a single phrase's synthesis request failed.</summary>
    public const string Tts = "tts";

    /// <summary>
    /// Not scoped to any one pipeline stage - a transport/control-message problem (see
    /// <see cref="CascadeSession"/>), or a stage that has become unusable for the rest
    /// of the session (e.g. STT's one reopen attempt also failed).
    /// </summary>
    public const string Session = "session";
}

/// <summary>
/// Payload for <see cref="CascadeMessageTypes.Error"/>. Extended for #12 (error handling
/// hardening) with <see cref="Stage"/>/<see cref="UtteranceId"/>/<see cref="Recoverable"/>
/// alongside the original <see cref="Message"/> field, so a client that only ever read
/// <c>message</c> keeps working unchanged while a client that wants to render per-stage
/// errors distinctly (e.g. a small badge on just the target-lane transcript column for an
/// <see cref="CascadeErrorStages.Mt"/> failure) has what it needs to do so.
/// </summary>
/// <param name="Message">A human-readable, non-sensitive description of what went wrong.</param>
/// <param name="Stage">One of <see cref="CascadeErrorStages"/>.</param>
/// <param name="UtteranceId">The source-lane utterance id (see <see cref="CascadeLatencyStages"/>'s
/// remarks on why every stage's per-utterance event keys by that same id, not a
/// stage-derived one like TTS's own target-lane id) this error is scoped to, or
/// <c>null</c> for a <see cref="CascadeErrorStages.Session"/> error that isn't tied to
/// any one utterance.</param>
/// <param name="Recoverable"><c>true</c> if the session can keep running as before after
/// this error (a single failed utterance, or a transient failure that a retry already
/// resolved elsewhere); <c>false</c> if <see cref="Stage"/> is now unusable for the rest
/// of the session (e.g. STT's stream died and its one reopen attempt also failed) and the
/// client should show persistent guidance rather than treating this as a one-off.</param>
public sealed record CascadeErrorPayload(string Message, string Stage, string? UtteranceId = null, bool Recoverable = true);

/// <summary>
/// Payload for <see cref="CascadeMessageTypes.TranscriptPartial"/> and
/// <see cref="CascadeMessageTypes.TranscriptFinal"/>. The frontend's transport-agnostic
/// <c>TranscriptUpdate</c> type maps directly onto this shape.
/// </summary>
/// <param name="UtteranceId">Stable id shared by every partial and the one final event
/// for the same utterance, so the client replaces rather than appends.</param>
/// <param name="Lane">One of <see cref="CascadeTranscriptLanes"/>.</param>
/// <param name="Text">The transcript text recognized so far (partial) or in full (final).</param>
/// <param name="TimestampMs">Milliseconds since the session's audio stream started.</param>
public sealed record CascadeTranscriptPayload(string UtteranceId, string Lane, string Text, long TimestampMs);

/// <summary>
/// Payload for <see cref="CascadeMessageTypes.TtsAudioStart"/>. The client should
/// begin buffering the raw binary WebSocket frames that follow as PCM (Pulse Code
/// Modulation) audio for <paramref name="UtteranceId"/>, using this format, until the
/// matching <see cref="CascadeMessageTypes.TtsAudioEnd"/> arrives.
/// </summary>
/// <param name="UtteranceId">The target-lane utterance id (see <see cref="CascadeTranscriptPayload.UtteranceId"/>
/// on the <see cref="CascadeTranscriptLanes.Target"/> lane) this audio is the spoken
/// rendering of.</param>
/// <param name="SampleRateHz">Samples per second the binary frames are encoded at; see <see cref="TtsAudioFormat"/>.</param>
/// <param name="Encoding">Sample encoding of the binary frames; see <see cref="TtsAudioFormat"/>.</param>
/// <param name="Channels">Audio channel count of the binary frames; see <see cref="TtsAudioFormat"/>.</param>
public sealed record CascadeTtsAudioStartPayload(string UtteranceId, int SampleRateHz, string Encoding, int Channels);

/// <summary>
/// Payload for <see cref="CascadeMessageTypes.TtsAudioEnd"/>: no more binary audio
/// frames are coming for this utterance, so the client's playback queue can mark it
/// complete once whatever it already buffered finishes playing.
/// </summary>
/// <param name="UtteranceId">The same id the matching <see cref="CascadeMessageTypes.TtsAudioStart"/> named.</param>
public sealed record CascadeTtsAudioEndPayload(string UtteranceId);

/// <summary>
/// Payload for <see cref="CascadeMessageTypes.TranscriptTruncated"/> (#11, barge-in).
/// </summary>
/// <param name="UtteranceId">The target-lane utterance id (see
/// <see cref="CascadeTranscriptPayload.UtteranceId"/> on the
/// <see cref="CascadeTranscriptLanes.Target"/> lane) whose transcript was cut short -
/// the same id its own <c>transcript.partial</c>/<c>transcript.final</c> events used,
/// if it had reached either yet.</param>
public sealed record CascadeTranscriptTruncatedPayload(string UtteranceId);

/// <summary>
/// Payload for <see cref="CascadeMessageTypes.BargeIn"/> (#11): tells the client which
/// utterances to flush from its playback queue after a barge-in.
/// </summary>
/// <param name="SupersededUtteranceIds">Target-lane utterance ids (the same ids
/// <see cref="CascadeTtsAudioStartPayload.UtteranceId"/> used) that had queued or
/// in-flight translation/synthesis work cancelled because the speaker started a new
/// utterance before they finished playing. Never empty - <see cref="CascadePipeline"/>
/// only sends this event when at least one utterance was actually superseded.</param>
/// <param name="ServerTimeMs">The moment the barge-in was detected, as milliseconds
/// since the Unix epoch (UTC) - see <see cref="CascadeClock"/>. Mirrors the envelope's
/// own <see cref="CascadeOutboundEnvelope.ServerTimeMs"/>, carried on the payload too
/// so a client reading just this payload (e.g. logging it) never needs to also unwrap
/// the envelope to know when the cancellation happened.</param>
public sealed record CascadeBargeInPayload(IReadOnlyCollection<string> SupersededUtteranceIds, long ServerTimeMs);

/// <summary>The negotiated configuration for one cascade session, taken from <see cref="CascadeSessionStartPayload"/>.</summary>
/// <param name="SourceLang">Language tag the speaker is using.</param>
/// <param name="TargetLang">Language tag to interpret into.</param>
public sealed record CascadeSessionConfig(string SourceLang, string TargetLang);

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
/// The stub pipeline wired up until #5-7 land: acknowledges nothing and does not
/// echo audio back. Its only job is to prove the transport can be built and torn
/// down without a real pipeline behind it.
/// </summary>
public sealed class NoOpCascadePipeline : ICascadePipeline
{
    /// <inheritdoc />
    public Task OnSessionStartedAsync(CascadeSessionConfig config, ICascadeEventSink events, CancellationToken cancellationToken) =>
        Task.CompletedTask;

    /// <inheritdoc />
    public Task OnAudioChunkAsync(ReadOnlyMemory<byte> pcm, ICascadeEventSink events, CancellationToken cancellationToken) =>
        Task.CompletedTask;

    /// <inheritdoc />
    public Task OnSessionEndedAsync(ICascadeEventSink events, CancellationToken cancellationToken) =>
        Task.CompletedTask;
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

    private long _bytesSinceLastLog;
    private DateTime _lastLogUtc = DateTime.UtcNow;
    private bool _sessionEndedNotified;

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
    /// Enqueues one PCM chunk for the pipeline and logs throughput roughly once a
    /// second - a cheap, temporary way to confirm audio is flowing end-to-end before
    /// the STT stage (#5) exists to prove it another way.
    /// </summary>
    /// <param name="pcm">One binary WebSocket frame's worth of PCM16 audio.</param>
    private void HandleAudioChunk(byte[] pcm)
    {
        // Bounded + DropOldest: never blocks the receive loop, never grows unbounded.
        _audioChannel.Writer.TryWrite(pcm);

        _bytesSinceLastLog += pcm.Length;
        var now = DateTime.UtcNow;
        if (now - _lastLogUtc >= TimeSpan.FromSeconds(1))
        {
            logger.LogDebug(
                "Cascade session {SessionId} audio throughput: {BytesPerSecond} B/s.", _sessionId, _bytesSinceLastLog);
            _bytesSinceLastLog = 0;
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
            using var timeoutCts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
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
        string message, string stage, bool recoverable, CancellationToken cancellationToken, string? utteranceId = null)
    {
        try
        {
            await SendEventAsync(
                CascadeMessageTypes.Error, new CascadeErrorPayload(message, stage, utteranceId, recoverable), cancellationToken);
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Cascade session {SessionId} failed to send an error event.", _sessionId);
        }
    }
}
