/// <summary>
/// Persistence seam for captured session metrics (the same load-bearing-interface
/// discipline the provider abstractions follow): endpoints talk only to this, so the
/// local SQLite implementation can be swapped for a managed database in a cloud
/// deployment (see <c>docs/deployment-plan.md</c>) without touching any caller.
/// </summary>
public interface ISessionMetricsStore
{
    /// <summary>
    /// Saves one conversation's full report, replacing any previously saved report
    /// with the same <see cref="ConversationMetricsReport.ConversationId"/> wholesale.
    /// Replace-not-merge is deliberate: the frontend always posts the complete
    /// accumulated state, so a re-post (double Stop, retry after a network blip) must
    /// be idempotent rather than duplicating rows.
    /// </summary>
    /// <param name="report">The conversation to save.</param>
    /// <param name="stageConfig">The effective per-stage config for this conversation,
    /// resolved by the endpoint (session picks over process defaults; the realtime
    /// model across all stages for a realtime-only conversation).</param>
    /// <param name="cancellationToken">Cancels the save.</param>
    Task SaveConversationAsync(
        ConversationMetricsReport report, ResolvedStageConfig stageConfig, CancellationToken cancellationToken);

    /// <summary>Lists every stored conversation, most recently started first.</summary>
    /// <param name="cancellationToken">Cancels the query.</param>
    /// <returns>Lightweight per-conversation listings (no per-utterance detail).</returns>
    Task<IReadOnlyList<ConversationListing>> ListConversationsAsync(CancellationToken cancellationToken);

    /// <summary>Loads one conversation in full - what the run report renders.</summary>
    /// <param name="conversationId">The conversation to load.</param>
    /// <param name="cancellationToken">Cancels the query.</param>
    /// <returns>The stored detail, or <c>null</c> when the id is unknown.</returns>
    Task<ConversationDetail?> GetConversationDetailAsync(string conversationId, CancellationToken cancellationToken);

    /// <summary>
    /// Computes cross-conversation latency statistics grouped per (mode, MT provider) -
    /// the numbers <c>docs/benchmarks.md</c>'s result tables are filled from.
    /// </summary>
    /// <param name="cancellationToken">Cancels the query.</param>
    /// <param name="scope">Which conversations contribute (Lab P2); defaults to all.</param>
    /// <param name="collapseMtProvider">When <c>true</c>, cascade groups merge across
    /// MT providers (stats over the merged population — medians can't be combined
    /// after the fact). The progress pane uses this: provider is a variable there,
    /// not a comparison point.</param>
    /// <returns>The summary; <see cref="MetricsSummary.Groups"/> is empty when nothing is stored yet.</returns>
    Task<MetricsSummary> GetSummaryAsync(
        CancellationToken cancellationToken, BaselineScope scope = BaselineScope.All, bool collapseMtProvider = false);

    /// <summary>
    /// Pins the given conversations as THE baseline set (Lab P2), replacing any
    /// previously pinned set wholesale - one baseline at a time, re-pin freely.
    /// Unknown ids are ignored rather than erroring: a stale Lab view pinning a
    /// just-deleted conversation shouldn't fail the whole pin.
    /// </summary>
    /// <param name="conversationIds">Conversations forming the new baseline set.</param>
    /// <param name="cancellationToken">Cancels the update.</param>
    Task SetBaselineAsync(IReadOnlyList<string> conversationIds, CancellationToken cancellationToken);
}
