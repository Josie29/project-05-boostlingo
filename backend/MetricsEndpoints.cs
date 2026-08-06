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

    /// <summary>Route for pinning the baseline conversation set (Lab P2).</summary>
    public const string BaselineRoute = "/api/metrics/baseline";

    /// <summary>Registers the metrics endpoints.</summary>
    /// <param name="app">The application to add the endpoints to.</param>
    /// <returns>The same application, for chaining.</returns>
    public static WebApplication MapMetricsEndpoints(this WebApplication app)
    {
        app.MapPost(ConversationsRoute, HandleSaveConversation);
        app.MapGet(ConversationsRoute, HandleListConversations);
        app.MapGet($"{ConversationsRoute}/{{conversationId}}", HandleGetConversationDetail);
        app.MapGet(SummaryRoute, HandleGetSummary);
        app.MapPost(BaselineRoute, HandleSetBaseline);
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
        IConfiguration configuration,
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

        if (report.Kind is not (null or "live" or "experiment"))
        {
            return Results.BadRequest(new MetricsErrorResponse($"Unsupported kind '{report.Kind}'. Valid values: live, experiment."));
        }

        if (report.Wer is < 0)
        {
            return Results.BadRequest(new MetricsErrorResponse("wer must be non-negative."));
        }

        await store.SaveConversationAsync(
            report, ResolveStageConfig(report, translationProvider.Value, configuration), cancellationToken);
        return Results.NoContent();
    }

    /// <summary>
    /// Resolves the effective per-stage models this conversation ran: session picks
    /// over process defaults. A realtime-only conversation stamps the realtime model
    /// for every stage — one model handles the whole pipeline there, and stamping the
    /// cascade defaults would claim models that never ran.
    /// </summary>
    private static ResolvedStageConfig ResolveStageConfig(
        ConversationMetricsReport report, string defaultProvider, IConfiguration configuration)
    {
        var realtimeOnly =
            report.Utterances.Count > 0 && report.Utterances.All(utterance => utterance.Mode == InterpreterMode.Realtime);
        if (realtimeOnly)
        {
            return new ResolvedStageConfig(
                defaultProvider,
                RealtimeInterpreterSession.Model,
                RealtimeInterpreterSession.Model,
                RealtimeInterpreterSession.Model);
        }

        var provider = report.MtProvider ?? defaultProvider;
        var mtModel = provider == "anthropic"
            ? (configuration["ANTHROPIC_MT_MODEL"] is { Length: > 0 } overridden ? overridden : AnthropicTranslationProvider.DefaultModel)
            : OpenAiTranslationProvider.Model;
        return new ResolvedStageConfig(
            provider, report.SttModel ?? StageModels.SttModels[0], mtModel, OpenAiTtsProvider.Model);
    }

    /// <summary>Returns one conversation in full - what the run report renders - or 404.</summary>
    private static async Task<IResult> HandleGetConversationDetail(
        string conversationId, ISessionMetricsStore store, CancellationToken cancellationToken)
    {
        var detail = await store.GetConversationDetailAsync(conversationId, cancellationToken);
        return detail is null
            ? Results.NotFound(new MetricsErrorResponse($"No conversation '{conversationId}'."))
            : Results.Ok(detail);
    }

    /// <summary>Lists every stored conversation, most recently started first.</summary>
    private static async Task<IResult> HandleListConversations(
        ISessionMetricsStore store, CancellationToken cancellationToken) =>
        Results.Ok(new ConversationListResponse(await store.ListConversationsAsync(cancellationToken)));

    /// <summary>
    /// Returns the cross-conversation latency summary, grouped per (mode, MT
    /// provider). <c>?scope=baseline|current</c> narrows to the pinned baseline set
    /// or everything after it (Lab P2); omitted means all — the pre-P2 behavior.
    /// <c>?group=mode</c> merges cascade's MT providers into one group (the progress
    /// pane's view: provider is a variable there, not a comparison point).
    /// </summary>
    private static async Task<IResult> HandleGetSummary(
        string? scope, string? group, ISessionMetricsStore store, CancellationToken cancellationToken)
    {
        BaselineScope? parsed = scope?.ToLowerInvariant() switch
        {
            null or "all" => BaselineScope.All,
            "baseline" => BaselineScope.Baseline,
            "current" => BaselineScope.Current,
            _ => null,
        };
        if (parsed is null)
        {
            return Results.BadRequest(new MetricsErrorResponse($"Unknown scope '{scope}'. Valid values: all, baseline, current."));
        }

        bool? collapse = group?.ToLowerInvariant() switch
        {
            null or "provider" => false,
            "mode" => true,
            _ => null,
        };
        if (collapse is null)
        {
            return Results.BadRequest(new MetricsErrorResponse($"Unknown group '{group}'. Valid values: provider, mode."));
        }

        return Results.Ok(await store.GetSummaryAsync(cancellationToken, parsed.Value, collapse.Value));
    }

    /// <summary>Pins the posted conversations as the baseline set, replacing any previous set.</summary>
    private static async Task<IResult> HandleSetBaseline(
        BaselineRequest request, ISessionMetricsStore store, CancellationToken cancellationToken)
    {
        if (request.ConversationIds is null)
        {
            return Results.BadRequest(new MetricsErrorResponse("conversationIds is required (may be empty to unpin)."));
        }

        await store.SetBaselineAsync(request.ConversationIds, cancellationToken);
        return Results.NoContent();
    }
}

/// <summary>Request body for <c>POST /api/metrics/baseline</c>.</summary>
/// <param name="ConversationIds">Conversations forming the new baseline set; empty unpins everything.</param>
public sealed record BaselineRequest(IReadOnlyList<string> ConversationIds);

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
