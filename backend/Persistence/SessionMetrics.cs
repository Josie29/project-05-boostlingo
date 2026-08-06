/// <summary>
/// Which transport produced an utterance. Persisted per utterance, not per
/// conversation, because a mid-session mode switch (issue #9) puts utterances
/// from BOTH transports into one conversation's shared transcript/latency
/// history - a conversation-level mode column would silently misattribute
/// every utterance recorded before the switch.
/// </summary>
public enum InterpreterMode
{
    /// <summary>Direct browser-to-OpenAI WebRTC speech-to-speech session.</summary>
    Realtime,

    /// <summary>The STT (speech-to-text) - MT (machine translation) - TTS (text-to-speech) pipeline.</summary>
    Cascade,
}

/// <summary>
/// Wire-name mapping for <see cref="InterpreterMode"/> as stored in SQLite. The DB
/// stores the same lowercase strings the frontend's <c>SessionMode</c> type and the
/// JSON wire format use (<c>"realtime"</c>/<c>"cascade"</c>), so a raw SQL query over
/// the metrics DB reads naturally against the rest of the system's vocabulary.
/// </summary>
public static class InterpreterModes
{
    /// <summary>The lowercase wire/storage name for a mode.</summary>
    public static string ToWire(InterpreterMode mode) =>
        mode == InterpreterMode.Realtime ? "realtime" : "cascade";

    /// <summary>Parses a stored wire name back to the enum.</summary>
    /// <exception cref="InvalidOperationException">The stored value is neither known
    /// mode name - a corrupted or hand-edited row, worth failing loudly on rather
    /// than misattributing latency numbers to the wrong mode.</exception>
    public static InterpreterMode FromWire(string wire) => wire switch
    {
        "realtime" => InterpreterMode.Realtime,
        "cascade" => InterpreterMode.Cascade,
        _ => throw new InvalidOperationException($"Unknown interpreter mode '{wire}' in metrics store."),
    };
}

/// <summary>Which transcript column an entry belongs to - mirrors <see cref="CascadeTranscriptLanes"/> and the frontend's <c>TranscriptLane</c>.</summary>
public enum TranscriptLane
{
    /// <summary>The speaker's own language, as recognized by STT.</summary>
    Source,

    /// <summary>The interpreted language.</summary>
    Target,
}

/// <summary>
/// One conversation's captured metrics, as reported by the frontend at session stop
/// (issue #10 revisited - see the amended "metrics live purely client-side" entry in
/// <c>docs/tech-stack.md</c>). The frontend is the reporter because it is the only
/// place latency for BOTH modes exists: realtime mode is a direct browser-to-OpenAI
/// WebRTC connection the backend has no visibility into, so a server-side capture
/// path could only ever cover cascade.
/// </summary>
/// <param name="ConversationId">Client-generated id (one per Start press). Saving is
/// an upsert keyed on this id, so a re-posted conversation (double Stop press, retry)
/// replaces rather than duplicates.</param>
/// <param name="SourceLang">Language tag the speaker used, e.g. <c>"en"</c>.</param>
/// <param name="TargetLang">Language tag interpreted into, e.g. <c>"es"</c>.</param>
/// <param name="StartedAtMs">Client clock, milliseconds since the Unix epoch, at Start.
/// Client-clock timestamps are only ever used to order/label conversations, never
/// mixed into latency math - every latency number in <paramref name="Utterances"/>
/// is a same-clock duration computed upstream (see <c>CascadeClock</c>'s discipline).</param>
/// <param name="EndedAtMs">Client clock at Stop; same caveat as <paramref name="StartedAtMs"/>.</param>
/// <param name="Utterances">Per-utterance latency breakdowns, both modes.</param>
/// <param name="Transcript">The conversation's transcript entries, kept so quality
/// (e.g. an MT provider comparison's translation output) can be reviewed alongside
/// the latency numbers, not just speed.</param>
/// <param name="SttModel">The session's negotiated STT model (Lab P1), or <c>null</c>
/// when the client didn't pick — the save stamps the default so stored rows always
/// name what actually ran.</param>
/// <param name="MtProvider">The session's negotiated MT provider, or <c>null</c> for
/// the process default (stamped server-side at save).</param>
/// <param name="Kind"><c>"experiment"</c> for a fixture replay run (Lab P3); omitted means <c>"live"</c>.</param>
/// <param name="Wer">Word Error Rate of the run's STT output against its ground truth
/// (Lab P3) — computed client-side, where both texts live. <c>null</c> for live sessions.</param>
/// <param name="Fixture">Name of the replayed fixture (e.g. the audio file), or <c>null</c> for live sessions.</param>
/// <param name="GroundTruth">The fixture's reference transcript, stored so a past run's
/// WER diff can be re-rendered later (recomputed client-side by the same scorer — the
/// diff itself is never persisted, so scoring can't drift from storage).</param>
public sealed record ConversationMetricsReport(
    string ConversationId,
    string SourceLang,
    string TargetLang,
    long StartedAtMs,
    long EndedAtMs,
    IReadOnlyList<UtteranceMetricsRecord> Utterances,
    IReadOnlyList<TranscriptEntryRecord> Transcript,
    string? SttModel = null,
    string? MtProvider = null,
    string? Kind = null,
    double? Wer = null,
    string? Fixture = null,
    string? GroundTruth = null);

/// <summary>
/// One stored conversation in full, as returned by <c>GET /api/metrics/conversations/{id}</c> -
/// everything the run report renders, reusing the same records the save accepted.
/// </summary>
/// <param name="ConversationId">The conversation's id.</param>
/// <param name="SourceLang">Language tag the speaker used.</param>
/// <param name="TargetLang">Language tag interpreted into.</param>
/// <param name="TranslationProvider">Stamped MT provider.</param>
/// <param name="SttModel">Stamped STT model.</param>
/// <param name="MtModel">Stamped MT model.</param>
/// <param name="TtsModel">Stamped TTS model.</param>
/// <param name="StartedAtMs">Client clock at Start.</param>
/// <param name="EndedAtMs">Client clock at Stop.</param>
/// <param name="Kind"><c>"live"</c> or <c>"experiment"</c>.</param>
/// <param name="Wer">Stored Word Error Rate, or <c>null</c>.</param>
/// <param name="Fixture">Fixture name, or <c>null</c>.</param>
/// <param name="GroundTruth">Stored reference transcript, or <c>null</c>.</param>
/// <param name="Utterances">Per-utterance latency breakdowns.</param>
/// <param name="Transcript">The conversation's transcript entries.</param>
public sealed record ConversationDetail(
    string ConversationId,
    string SourceLang,
    string TargetLang,
    string TranslationProvider,
    string SttModel,
    string MtModel,
    string TtsModel,
    long StartedAtMs,
    long EndedAtMs,
    string Kind,
    double? Wer,
    string? Fixture,
    string? GroundTruth,
    IReadOnlyList<UtteranceMetricsRecord> Utterances,
    IReadOnlyList<TranscriptEntryRecord> Transcript);

/// <summary>
/// One utterance's latency breakdown - the persisted form of the frontend's
/// <c>LatencyReport</c>, plus the <see cref="Mode"/> the frontend derives from its
/// per-mode utterance-id prefix (<c>prefixId</c> in <c>InterpreterSession.ts</c>).
/// </summary>
/// <param name="UtteranceId">The frontend's namespaced id, e.g. <c>"cascade:item_A"</c> -
/// stored as-is so rows join back to the transcript entries that share it.</param>
/// <param name="Mode">Which transport produced this utterance.</param>
/// <param name="EndToEndMs">Perceived end-to-end latency (speech end to audio audible),
/// or <c>null</c> if the utterance never completed (e.g. cut off by session stop).</param>
/// <param name="Stages">Stage-to-stage durations, only for boundaries actually observed -
/// never zero/NaN placeholders (mirrors <c>LatencyReport.stages</c>' contract).</param>
public sealed record UtteranceMetricsRecord(
    string UtteranceId,
    InterpreterMode Mode,
    double? EndToEndMs,
    IReadOnlyList<StageTimingRecord> Stages);

/// <summary>One stage's duration since the nearest earlier observed stage, in milliseconds.</summary>
/// <param name="Stage">Stage name, e.g. <c>"sttFinal"</c> - opaque here, exactly as the
/// frontend's latency domain treats it, so a new instrumented stage needs no schema change.</param>
/// <param name="Ms">Duration in milliseconds.</param>
public sealed record StageTimingRecord(string Stage, double Ms);

/// <summary>One transcript entry as it stood at session stop.</summary>
/// <param name="UtteranceId">The frontend's namespaced id. The target lane may carry a
/// derived id (cascade's <c>"-target"</c> suffix), so (utteranceId, lane) - not
/// utteranceId alone - is the unique key.</param>
/// <param name="Lane">Which transcript column the text belongs to.</param>
/// <param name="Text">The accumulated text.</param>
/// <param name="Final"><c>false</c> if the session stopped while this utterance was still in progress.</param>
/// <param name="Truncated"><c>true</c> if a barge-in (issue #11) cut this utterance short.</param>
public sealed record TranscriptEntryRecord(
    string UtteranceId,
    TranscriptLane Lane,
    string Text,
    bool Final,
    bool Truncated = false);

/// <summary>
/// The effective per-stage config stamped onto a stored conversation: what actually
/// ran, with every default resolved - stored rows must stay true even after a config
/// default changes. For a realtime-only conversation all three stage models are the
/// realtime model, since one model handles the whole pipeline there.
/// </summary>
/// <param name="TranslationProvider">Effective MT provider name.</param>
/// <param name="SttModel">Effective STT model.</param>
/// <param name="MtModel">Effective MT model.</param>
/// <param name="TtsModel">Effective TTS model.</param>
public sealed record ResolvedStageConfig(string TranslationProvider, string SttModel, string MtModel, string TtsModel);

/// <summary>One stored conversation, as listed by <c>GET /api/metrics/conversations</c>.</summary>
/// <param name="ConversationId">See <see cref="ConversationMetricsReport.ConversationId"/>.</param>
/// <param name="SourceLang">Language tag the speaker used.</param>
/// <param name="TargetLang">Language tag interpreted into.</param>
/// <param name="TranslationProvider">The MT provider the backend was configured with when
/// this conversation was saved - stamped server-side (the frontend never knows it), so a
/// provider-swap benchmark's sessions stay distinguishable after the fact.</param>
/// <param name="StartedAtMs">Client clock at Start (ordering/labeling only).</param>
/// <param name="EndedAtMs">Client clock at Stop.</param>
/// <param name="RealtimeUtteranceCount">Utterances captured in realtime mode.</param>
/// <param name="CascadeUtteranceCount">Utterances captured in cascade mode.</param>
/// <param name="SttModel">The STT model this conversation ran on (stamped at save; the realtime model for realtime-only rows).</param>
/// <param name="MtModel">The MT model, resolved the same way.</param>
/// <param name="TtsModel">The TTS model, resolved the same way.</param>
/// <param name="Kind"><c>"live"</c> for mic sessions; <c>"experiment"</c> reserved for Lab P3 fixture runs.</param>
/// <param name="Wer">Word Error Rate for fixture runs, or <c>null</c> for live sessions (no ground truth).</param>
/// <param name="RealtimeEndToEndMedianMs">Median realtime end-to-end, or <c>null</c> with no completed realtime utterances.</param>
/// <param name="CascadeEndToEndMedianMs">Median cascade end-to-end, or <c>null</c> with no completed cascade utterances.</param>
/// <param name="Baseline">Whether this conversation is in the pinned baseline set (Lab P2).</param>
public sealed record ConversationListing(
    string ConversationId,
    string SourceLang,
    string TargetLang,
    string TranslationProvider,
    long StartedAtMs,
    long EndedAtMs,
    int RealtimeUtteranceCount,
    int CascadeUtteranceCount,
    string SttModel,
    string MtModel,
    string TtsModel,
    string Kind,
    double? Wer,
    double? RealtimeEndToEndMedianMs,
    double? CascadeEndToEndMedianMs,
    bool Baseline);

/// <summary>
/// Which conversations a summary draws from (Lab P2): everything, only the pinned
/// baseline set, or only what came after it. The progress pane diffs
/// <see cref="Baseline"/> against <see cref="Current"/>.
/// </summary>
public enum BaselineScope
{
    /// <summary>Every stored conversation — the pre-P2 behavior and the default.</summary>
    All,

    /// <summary>Only conversations in the pinned baseline set.</summary>
    Baseline,

    /// <summary>Only conversations outside the pinned baseline set.</summary>
    Current,
}

/// <summary>
/// Cross-session latency statistics, grouped exactly the way <c>docs/benchmarks.md</c>'s
/// result tables are laid out: one group per (mode, MT provider) combination, so the
/// Realtime, Cascade-OpenAI, and Cascade-Anthropic tables each map to one group.
/// </summary>
/// <param name="Groups">One entry per (mode, provider) combination with any stored utterances.</param>
public sealed record MetricsSummary(IReadOnlyList<MetricsSummaryGroup> Groups);

/// <summary>Latency statistics for one (mode, MT provider) combination.</summary>
/// <param name="Mode">Which transport these utterances used.</param>
/// <param name="TranslationProvider">The conversation-level MT provider, or <c>null</c>
/// for realtime utterances - realtime mode never touches the MT provider, so
/// distinguishing realtime numbers by it would split one population for no reason.</param>
/// <param name="ConversationCount">Distinct conversations contributing utterances to this group.</param>
/// <param name="UtteranceCount">Utterances contributing at least one number to this group.</param>
/// <param name="EndToEnd">End-to-end perceived latency stats, or <c>null</c> if no
/// utterance in this group completed one.</param>
/// <param name="Stages">Per-stage stats, one entry per stage name observed in this group.</param>
public sealed record MetricsSummaryGroup(
    InterpreterMode Mode,
    string? TranslationProvider,
    int ConversationCount,
    int UtteranceCount,
    LatencyStats? EndToEnd,
    IReadOnlyList<StageStats> Stages);

/// <summary>
/// Median and 95th percentile over one population of durations - the two figures
/// <c>docs/benchmarks.md</c>'s targets are phrased in. Median interpolates the middle
/// pair on even counts; p95 is nearest-rank (an actually-observed value, never an
/// interpolation past the sample).
/// </summary>
/// <param name="Count">How many durations the stats were computed over.</param>
/// <param name="MedianMs">The median duration, milliseconds.</param>
/// <param name="P95Ms">The nearest-rank 95th-percentile duration, milliseconds.</param>
public sealed record LatencyStats(int Count, double MedianMs, double P95Ms);

/// <summary>One stage's statistics within a summary group.</summary>
/// <param name="Stage">Stage name, e.g. <c>"sttFinal"</c>.</param>
/// <param name="Stats">Median/p95 over every observation of this stage in the group.</param>
public sealed record StageStats(string Stage, LatencyStats Stats);
