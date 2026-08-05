/// <summary>
/// Wires up <c>GET /api/architecture</c>: which models power each paradigm, read from
/// the providers' own constants and the resolved MT provider config. Exists so the
/// frontend's architecture cards render backend truth — hardcoding model names
/// client-side would silently lie the day <c>TRANSLATION_PROVIDER</c> flips.
/// </summary>
public static class ArchitectureEndpoints
{
    /// <summary>Route the frontend fetches paradigm/model info from.</summary>
    public const string RoutePattern = "/api/architecture";

    /// <summary>Registers <c>GET /api/architecture</c>.</summary>
    /// <param name="app">The application to add the endpoint to.</param>
    /// <returns>The same application, for chaining.</returns>
    public static WebApplication MapArchitectureEndpoints(this WebApplication app)
    {
        app.MapGet(RoutePattern, HandleGetArchitecture);
        return app;
    }

    private static IResult HandleGetArchitecture(TranslationProviderName translationProvider, IConfiguration configuration)
    {
        var anthropicModel = configuration["ANTHROPIC_MT_MODEL"] is { Length: > 0 } overridden
            ? overridden
            : AnthropicTranslationProvider.DefaultModel;
        var openAi = new MtStageInfo("openai", OpenAiTranslationProvider.Model);
        var anthropic = new MtStageInfo("anthropic", anthropicModel);
        var anthropicActive = translationProvider.Value == "anthropic";

        return Results.Ok(new ArchitectureResponse(
            new RealtimeArchitectureInfo(RealtimeInterpreterSession.Model),
            new CascadeArchitectureInfo(
                Stt: new StageModelInfo(OpenAiSttProvider.Model),
                Mt: anthropicActive ? anthropic : openAi,
                MtAlternative: anthropicActive ? openAi : anthropic,
                Tts: new StageModelInfo(OpenAiTtsProvider.Model),
                SttOptions: StageModels.SttModels)));
    }
}

/// <summary>Response body for <c>GET /api/architecture</c>.</summary>
/// <param name="Realtime">The single voice-to-voice model.</param>
/// <param name="Cascade">The three pipeline stages' models.</param>
public sealed record ArchitectureResponse(RealtimeArchitectureInfo Realtime, CascadeArchitectureInfo Cascade);

/// <summary>Realtime mode's architecture: one model, speech to speech.</summary>
/// <param name="Model">The OpenAI Realtime model id.</param>
public sealed record RealtimeArchitectureInfo(string Model);

/// <summary>Cascade mode's architecture: one model per stage.</summary>
/// <param name="Stt">Speech-to-text stage.</param>
/// <param name="Mt">The machine-translation stage currently selected by <c>TRANSLATION_PROVIDER</c>.</param>
/// <param name="MtAlternative">The other MT provider — surfaced so the UI can show the swap that
/// selecting it would produce (the brief's provider-flexibility demo).</param>
/// <param name="Tts">Text-to-speech stage.</param>
/// <param name="SttOptions">Every STT model a session may select (Lab P1); the first is the default.</param>
public sealed record CascadeArchitectureInfo(
    StageModelInfo Stt, MtStageInfo Mt, MtStageInfo MtAlternative, StageModelInfo Tts, IReadOnlyList<string> SttOptions);

/// <summary>A pipeline stage with no provider choice: just its model id.</summary>
/// <param name="Model">The model id.</param>
public sealed record StageModelInfo(string Model);

/// <summary>The MT stage, where the provider is a config choice.</summary>
/// <param name="Provider">Lowercase provider name, e.g. <c>"openai"</c>.</param>
/// <param name="Model">The model id that provider runs.</param>
public sealed record MtStageInfo(string Provider, string Model);
