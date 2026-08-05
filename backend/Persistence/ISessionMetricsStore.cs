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
    /// <param name="translationProvider">The MT (machine translation) provider the
    /// backend is currently configured with - stamped server-side because the
    /// frontend never knows it.</param>
    /// <param name="cancellationToken">Cancels the save.</param>
    Task SaveConversationAsync(
        ConversationMetricsReport report, string translationProvider, CancellationToken cancellationToken);

    /// <summary>Lists every stored conversation, most recently started first.</summary>
    /// <param name="cancellationToken">Cancels the query.</param>
    /// <returns>Lightweight per-conversation listings (no per-utterance detail).</returns>
    Task<IReadOnlyList<ConversationListing>> ListConversationsAsync(CancellationToken cancellationToken);

    /// <summary>
    /// Computes cross-conversation latency statistics grouped per (mode, MT provider) -
    /// the numbers <c>docs/benchmarks.md</c>'s result tables are filled from.
    /// </summary>
    /// <param name="cancellationToken">Cancels the query.</param>
    /// <returns>The summary; <see cref="MetricsSummary.Groups"/> is empty when nothing is stored yet.</returns>
    Task<MetricsSummary> GetSummaryAsync(CancellationToken cancellationToken);
}
