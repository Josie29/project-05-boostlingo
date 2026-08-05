/// <summary>
/// Wires up the session-metrics capture and query endpoints (issue #10 revisited -
/// see <c>docs/tech-stack.md</c>'s amended entry). The frontend posts each
/// conversation's accumulated latency reports and transcript at session stop; the
/// query endpoints exist so <c>docs/benchmarks.md</c>'s tables can be filled from
/// stored numbers instead of hand-copied off the live latency panel.
/// </summary>
public static class MetricsEndpoints
{
    /// <summary>Route for posting one conversation's report (POST) and listing stored conversations (GET).</summary>
    public const string ConversationsRoute = "/api/metrics/conversations";

    /// <summary>Route for the cross-conversation latency summary.</summary>
    public const string SummaryRoute = "/api/metrics/summary";

    /// <summary>Registers the metrics endpoints.</summary>
    /// <param name="app">The application to add the endpoints to.</param>
    /// <returns>The same application, for chaining.</returns>
    public static WebApplication MapMetricsEndpoints(this WebApplication app)
    {
        app.MapPost(ConversationsRoute, HandleSaveConversation);
        app.MapGet(ConversationsRoute, HandleListConversations);
        app.MapGet(SummaryRoute, HandleGetSummary);
        return app;
    }

    /// <summary>
    /// Upserts one conversation's report. Validation is deliberately light (identity
    /// fields only): this endpoint's job is to capture what the frontend observed, and
    /// rejecting a report over, say, an unexpected stage name would throw away exactly
    /// the anomalous benchmark data most worth keeping.
    /// </summary>
    private static async Task<IResult> HandleSaveConversation(
        ConversationMetricsReport report,
        ISessionMetricsStore store,
        TranslationProviderName translationProvider,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(report.ConversationId))
        {
            return Results.BadRequest(new MetricsErrorResponse("conversationId is required."));
        }

        if (string.IsNullOrWhiteSpace(report.SourceLang) || string.IsNullOrWhiteSpace(report.TargetLang))
        {
            return Results.BadRequest(new MetricsErrorResponse("sourceLang and targetLang are required."));
        }

        // Omitted collections deserialize to null despite the record's non-nullable
        // types - System.Text.Json doesn't enforce nullability - so reject rather than
        // NullReference deep inside the store.
        if (report.Utterances is null || report.Transcript is null)
        {
            return Results.BadRequest(new MetricsErrorResponse("utterances and transcript are required (may be empty)."));
        }

        // Stage config is identity, not observation: an unknown value would corrupt
        // the Lab table's config grouping, so unlike stage/timing data it is validated.
        if (report.SttModel is not null && !StageModels.IsSupportedSttModel(report.SttModel))
        {
            return Results.BadRequest(new MetricsErrorResponse($"Unsupported STT model '{report.SttModel}'."));
        }

        if (report.MtProvider is not null && !StageModels.IsSupportedMtProvider(report.MtProvider))
        {
            return Results.BadRequest(new MetricsErrorResponse($"Unsupported MT provider '{report.MtProvider}'."));
        }

        await store.SaveConversationAsync(
            report,
            report.MtProvider ?? translationProvider.Value,
            report.SttModel ?? StageModels.SttModels[0],
            cancellationToken);
        return Results.NoContent();
    }

    /// <summary>Lists every stored conversation, most recently started first.</summary>
    private static async Task<IResult> HandleListConversations(
        ISessionMetricsStore store, CancellationToken cancellationToken) =>
        Results.Ok(new ConversationListResponse(await store.ListConversationsAsync(cancellationToken)));

    /// <summary>Returns the cross-conversation latency summary, grouped per (mode, MT provider).</summary>
    private static async Task<IResult> HandleGetSummary(
        ISessionMetricsStore store, CancellationToken cancellationToken) =>
        Results.Ok(await store.GetSummaryAsync(cancellationToken));
}

/// <summary>
/// The validated MT (machine translation) provider name Program.cs resolved at startup
/// (<c>TRANSLATION_PROVIDER</c>), registered as its own type so consumers get the
/// already-validated value instead of re-reading (and re-validating) raw configuration.
/// </summary>
/// <param name="Value">The lowercase provider name, e.g. <c>"openai"</c>.</param>
public sealed record TranslationProviderName(string Value);

/// <summary>Error body for metrics endpoints - same <c>{ error }</c> shape as <see cref="RealtimeSessionErrorResponse"/>, which the frontend's error handling already expects.</summary>
/// <param name="Error">Human-readable reason the request was rejected.</param>
public sealed record MetricsErrorResponse(string Error);

/// <summary>Response body for <c>GET /api/metrics/conversations</c>.</summary>
/// <param name="Conversations">Every stored conversation, most recently started first.</param>
public sealed record ConversationListResponse(IReadOnlyList<ConversationListing> Conversations);
