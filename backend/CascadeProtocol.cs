using System.Text.Json;

/// <summary>
/// The PCM audio format every cascade session speaks upstream (browser to server).
/// 24 kHz, not the originally assumed 16 kHz: OpenAI's realtime transcription intent
/// (<c>OpenAiSttProvider</c>) rejects <c>session.audio.input.format.rate</c> below
/// 24000 with <c>integer_below_min_value</c> - spot-checked directly against a live
/// key, not documentation. Matches <see cref="ITtsProvider.SampleRateHz"/> on the
/// output side, so the cascade speaks one rate end to end.
/// </summary>
public static class CascadeAudioFormat
{
    /// <summary>Samples per second. The frontend must downsample the mic input to this rate.</summary>
    public const int SampleRateHz = 24_000;

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
    /// transcript text. See <see cref="SttSegmentKind.SpeechEnd"/>.
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
/// Single place every cascade stage sends a <see cref="CascadeMessageTypes.Error"/>
/// envelope through (code-review fix): before this existed, <see cref="CascadeSession"/>,
/// <see cref="CascadePipeline"/>, and <see cref="TtsCascadeObserver"/> each hand-rolled
/// their own version of "send an error event and swallow/log any failure to send it" -
/// several of those call sites weren't even guarded, so a failed send (e.g. the socket
/// already closing) could itself throw and propagate out of whatever pipeline stage was
/// reporting the original failure. One implementation now, reused everywhere.
/// </summary>
public static class CascadeErrors
{
    /// <summary>
    /// Sends one <see cref="CascadeMessageTypes.Error"/> envelope. Never throws - a
    /// failure to send is logged at Debug and otherwise swallowed, exactly as
    /// <see cref="CascadeLatencyMarks.EmitAsync"/> already does for latency marks - an
    /// error report failing to reach the client must not itself take down the pipeline
    /// stage that's reporting it.
    /// </summary>
    /// <param name="events">Sink to send the error on.</param>
    /// <param name="stage">One of <see cref="CascadeErrorStages"/>.</param>
    /// <param name="message">A human-readable, non-sensitive description of what went wrong.</param>
    /// <param name="recoverable">See <see cref="CascadeErrorPayload.Recoverable"/>.</param>
    /// <param name="logger">Logs a send failure at Debug; never rethrown.</param>
    /// <param name="cancellationToken">Propagates send cancellation.</param>
    /// <param name="utteranceId">See <see cref="CascadeErrorPayload.UtteranceId"/>; <c>null</c> (the default) for an error not scoped to one utterance.</param>
    public static async Task TrySendAsync(
        ICascadeEventSink events,
        string stage,
        string message,
        bool recoverable,
        ILogger logger,
        CancellationToken cancellationToken,
        string? utteranceId = null)
    {
        try
        {
            await events.SendEventAsync(
                CascadeMessageTypes.Error, new CascadeErrorPayload(message, stage, utteranceId, recoverable), cancellationToken);
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Failed to send an error event (stage: {Stage}) for session {SessionId}.", stage, events.SessionId);
        }
    }
}

/// <summary>
/// Payload for <see cref="CascadeMessageTypes.TranscriptPartial"/> and
/// <see cref="CascadeMessageTypes.TranscriptFinal"/>. The frontend's transport-agnostic
/// <c>TranscriptUpdate</c> type maps directly onto this shape.
/// </summary>
/// <param name="UtteranceId">Stable id shared by every partial and the one final event
/// for the same utterance, so the client replaces rather than appends.</param>
/// <param name="Lane">One of <see cref="CascadeTranscriptLanes"/>.</param>
/// <param name="Text">
/// On a partial (<see cref="CascadeMessageTypes.TranscriptPartial"/>): a DELTA - just the
/// newly recognized/translated increment since the previous event for this
/// <paramref name="UtteranceId"/>, not the accumulated text so far. Both lanes work this
/// way: <see cref="CascadePipeline"/> forwards each raw STT (speech-to-text) partial's own
/// text on the source lane, and each raw MT (machine translation) token on the target
/// lane, exactly as the respective provider streamed it - the frontend's transcript
/// reducer is what appends deltas together into the text it renders. On a final
/// (<see cref="CascadeMessageTypes.TranscriptFinal"/>): the FULL settled text for this
/// utterance, not a further delta - concatenating every prior partial back together
/// would double the text if a consumer naively appended this too.
/// </param>
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
/// <param name="SampleRateHz">Samples per second the binary frames are encoded at; see <see cref="TtsOutputFormat"/>.</param>
/// <param name="Encoding">Sample encoding of the binary frames; see <see cref="TtsOutputFormat"/>.</param>
/// <param name="Channels">Audio channel count of the binary frames; see <see cref="TtsOutputFormat"/>.</param>
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
