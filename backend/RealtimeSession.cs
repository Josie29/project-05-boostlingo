using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json.Serialization;

/// <summary>
/// Wires up the ephemeral Realtime session endpoint that lets the browser open a
/// WebRTC connection to OpenAI without ever seeing <c>OPENAI_API_KEY</c>.
/// </summary>
public static class RealtimeSessionEndpoints
{
    /// <summary>Route the frontend calls to obtain a fresh ephemeral Realtime session.</summary>
    public const string RoutePattern = "/api/realtime/session";

    /// <summary>
    /// Registers <c>POST /api/realtime/session</c>, which mints a short-lived OpenAI
    /// Realtime client secret server-side and returns just enough for the browser to
    /// negotiate a WebRTC connection directly with OpenAI.
    /// </summary>
    /// <param name="app">The application to add the endpoint to.</param>
    /// <returns>The same application, for chaining.</returns>
    public static WebApplication MapRealtimeSessionEndpoints(this WebApplication app)
    {
        app.MapPost(RoutePattern, HandleCreateSessionAsync);
        return app;
    }

    private static async Task<IResult> HandleCreateSessionAsync(
        RealtimeSessionRequest? request,
        IConfiguration configuration,
        IRealtimeSessionClient client,
        ILoggerFactory loggerFactory,
        CancellationToken cancellationToken)
    {
        var logger = loggerFactory.CreateLogger("RealtimeSession");

        var sourceLangCode = string.IsNullOrWhiteSpace(request?.SourceLang)
            ? RealtimeInterpreterSession.DefaultSourceLangCode
            : request.SourceLang;
        var targetLangCode = string.IsNullOrWhiteSpace(request?.TargetLang)
            ? RealtimeInterpreterSession.DefaultTargetLangCode
            : request.TargetLang;

        var sourceLang = Languages.Find(sourceLangCode);
        var targetLang = Languages.Find(targetLangCode);
        if (sourceLang is null || targetLang is null || sourceLangCode == targetLangCode)
        {
            logger.LogWarning(
                "Rejected {Route}: unsupported language pair '{SourceLang}' -> '{TargetLang}'.",
                RoutePattern,
                sourceLangCode,
                targetLangCode);
            return Results.Json(
                new RealtimeSessionErrorResponse($"Unsupported language pair '{sourceLangCode}' -> '{targetLangCode}'."),
                statusCode: StatusCodes.Status400BadRequest);
        }

        if (string.IsNullOrWhiteSpace(configuration["OPENAI_API_KEY"]))
        {
            logger.LogWarning("Rejected {Route}: OPENAI_API_KEY is not configured.", RoutePattern);
            return Results.Json(
                new RealtimeSessionErrorResponse("The server is not configured with an OpenAI API key."),
                statusCode: StatusCodes.Status503ServiceUnavailable);
        }

        try
        {
            var secret = await client.CreateClientSecretAsync(sourceLang, targetLang, cancellationToken);
            return Results.Ok(new RealtimeSessionResponse(
                secret.Value, secret.ExpiresAt, RealtimeInterpreterSession.Model, sourceLang.Code, targetLang.Code));
        }
        catch (RealtimeUpstreamException ex)
        {
            logger.LogError(
                "OpenAI Realtime client secret request failed with upstream status {StatusCode}.",
                ex.StatusCode);
            return Results.Json(
                new RealtimeSessionErrorResponse("Failed to create a realtime session with the upstream provider."),
                statusCode: StatusCodes.Status502BadGateway);
        }
        catch (HttpRequestException ex)
        {
            logger.LogError(ex, "OpenAI Realtime client secret request failed due to a network error.");
            return Results.Json(
                new RealtimeSessionErrorResponse("Failed to create a realtime session with the upstream provider."),
                statusCode: StatusCodes.Status502BadGateway);
        }
    }
}

/// <summary>
/// Configuration for the realtime interpreter persona. The language pair (#8) is
/// supplied per request rather than fixed - <see cref="BuildInstructions"/> generates
/// pair-specific system instructions, auto-detecting direction between whichever two
/// languages the caller negotiated.
/// </summary>
public static class RealtimeInterpreterSession
{
    /// <summary>OpenAI Realtime model used for voice-to-voice interpretation.</summary>
    public const string Model = "gpt-realtime";

    /// <summary>
    /// Output voice for the interpreted speech. Fixed regardless of language pair - a
    /// single realtime session interprets in both directions, so there is no one
    /// "target language" to key a per-language voice off of (unlike cascade mode's TTS
    /// stage; see <see cref="LanguageInfo.TtsVoice"/>) - and OpenAI's realtime voices
    /// are multilingual.
    /// </summary>
    public const string Voice = "marin";

    /// <summary>Source language used when the frontend sends no explicit pair, for backward compatibility.</summary>
    public const string DefaultSourceLangCode = "en";

    /// <summary>Target language used when the frontend sends no explicit pair, for backward compatibility.</summary>
    public const string DefaultTargetLangCode = "es";

    /// <summary>
    /// Builds system instructions that constrain the model to pure interpretation
    /// between exactly the given pair: no greetings, no chit-chat, no answering on its
    /// own behalf.
    /// </summary>
    /// <param name="source">One language of the pair.</param>
    /// <param name="target">The other language of the pair.</param>
    /// <returns>Instructions naming both languages, symmetric in <paramref name="source"/>
    /// and <paramref name="target"/> since the model auto-detects which one it's hearing.</returns>
    public static string BuildInstructions(LanguageInfo source, LanguageInfo target) =>
        $"You are a real-time voice interpreter between a {source.DisplayName} speaker and a " +
        $"{target.DisplayName} speaker. Automatically detect which of the two languages each " +
        $"utterance is spoken in, then immediately speak the interpretation in the " +
        $"other language: {source.DisplayName} utterances become {target.DisplayName}, and " +
        $"{target.DisplayName} utterances become {source.DisplayName}. Output only the " +
        "interpretation itself, in the target language. Never greet, chat, answer " +
        "questions, add commentary, or otherwise participate in the conversation as " +
        "yourself - you are strictly a conduit between the two speakers. Preserve the " +
        "speaker's tone, meaning, and register as closely as natural phrasing allows. " +
        "Never ask for clarification; choose the most reasonable interpretation of an " +
        "ambiguous phrase and continue.";
}

/// <summary>
/// Mints ephemeral OpenAI Realtime client secrets. Kept as a small interface so the
/// endpoint can be tested against a fake without making real network calls.
/// </summary>
public interface IRealtimeSessionClient
{
    /// <summary>
    /// Requests a new ephemeral client secret scoped to an interpreter session for the
    /// given language pair.
    /// </summary>
    /// <param name="sourceLang">One language of the negotiated pair.</param>
    /// <param name="targetLang">The other language of the negotiated pair.</param>
    /// <param name="cancellationToken">Propagates request cancellation.</param>
    /// <returns>The ephemeral secret value and its expiry.</returns>
    /// <exception cref="RealtimeUpstreamException">
    /// Thrown when OpenAI responds with a non-success status code or an unreadable body.
    /// </exception>
    Task<RealtimeClientSecret> CreateClientSecretAsync(
        LanguageInfo sourceLang, LanguageInfo targetLang, CancellationToken cancellationToken);
}

/// <summary>An ephemeral OpenAI Realtime client secret and when it expires.</summary>
/// <param name="Value">The bearer token the browser presents to OpenAI over WebRTC.</param>
/// <param name="ExpiresAt">Unix timestamp (seconds) after which the secret is invalid.</param>
public sealed record RealtimeClientSecret(string Value, long ExpiresAt);

/// <summary>Thrown when OpenAI's client-secrets endpoint returns a non-success response.</summary>
internal sealed class RealtimeUpstreamException(HttpStatusCode statusCode)
    : Exception($"OpenAI Realtime client secret request failed with status {(int)statusCode}.")
{
    /// <summary>The HTTP status code OpenAI responded with.</summary>
    public HttpStatusCode StatusCode { get; } = statusCode;
}

/// <summary>
/// Calls OpenAI's Realtime client-secrets endpoint to mint an ephemeral token scoped
/// to an interpreter session for the negotiated language pair, authenticating with
/// <c>OPENAI_API_KEY</c> from server-side configuration. The key never leaves this class.
/// </summary>
internal sealed class OpenAiRealtimeSessionClient(HttpClient httpClient, IConfiguration configuration)
    : IRealtimeSessionClient
{
    /// <inheritdoc />
    public async Task<RealtimeClientSecret> CreateClientSecretAsync(
        LanguageInfo sourceLang, LanguageInfo targetLang, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "client_secrets")
        {
            Content = JsonContent.Create(BuildSessionRequest(sourceLang, targetLang)),
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", configuration["OPENAI_API_KEY"]);

        using var response = await httpClient.SendAsync(request, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            throw new RealtimeUpstreamException(response.StatusCode);
        }

        var body = await response.Content.ReadFromJsonAsync<OpenAiClientSecretResponse>(cancellationToken: cancellationToken);
        if (body is null)
        {
            throw new RealtimeUpstreamException(response.StatusCode);
        }

        return new RealtimeClientSecret(body.Value, body.ExpiresAt);
    }

    private static OpenAiClientSecretRequest BuildSessionRequest(LanguageInfo sourceLang, LanguageInfo targetLang) => new(
        new OpenAiRealtimeSessionConfig(
            Type: "realtime",
            Model: RealtimeInterpreterSession.Model,
            Instructions: RealtimeInterpreterSession.BuildInstructions(sourceLang, targetLang),
            Audio: new OpenAiRealtimeAudioConfig(new OpenAiRealtimeAudioOutputConfig(RealtimeInterpreterSession.Voice))));
}

// --- OpenAI wire-format DTOs (snake_case, per OpenAI's API) ---

internal sealed record OpenAiClientSecretRequest(
    [property: JsonPropertyName("session")] OpenAiRealtimeSessionConfig Session);

internal sealed record OpenAiRealtimeSessionConfig(
    [property: JsonPropertyName("type")] string Type,
    [property: JsonPropertyName("model")] string Model,
    [property: JsonPropertyName("instructions")] string Instructions,
    [property: JsonPropertyName("audio")] OpenAiRealtimeAudioConfig Audio);

internal sealed record OpenAiRealtimeAudioConfig(
    [property: JsonPropertyName("output")] OpenAiRealtimeAudioOutputConfig Output);

internal sealed record OpenAiRealtimeAudioOutputConfig(
    [property: JsonPropertyName("voice")] string Voice);

internal sealed record OpenAiClientSecretResponse(
    [property: JsonPropertyName("value")] string Value,
    [property: JsonPropertyName("expires_at")] long ExpiresAt);

// --- Public request/response shapes for POST /api/realtime/session ---

/// <summary>
/// Request body for <c>POST /api/realtime/session</c>. Both fields are optional and
/// independently defaultable - omitting the whole body, or either field, falls back to
/// <see cref="RealtimeInterpreterSession.DefaultSourceLangCode"/> / <see cref="RealtimeInterpreterSession.DefaultTargetLangCode"/>
/// (English &lt;-&gt; Spanish) for backward compatibility with callers that predate #8.
/// </summary>
/// <param name="SourceLang">Language tag for one side of the pair, e.g. <c>"en"</c>. Must be
/// one of <see cref="Languages.Supported"/>'s codes.</param>
/// <param name="TargetLang">Language tag for the other side of the pair, e.g. <c>"es"</c>. Must be
/// one of <see cref="Languages.Supported"/>'s codes and different from <see cref="SourceLang"/>.</param>
public sealed record RealtimeSessionRequest(string? SourceLang, string? TargetLang);

/// <summary>Response body for <c>POST /api/realtime/session</c>.</summary>
/// <param name="ClientSecret">
/// Ephemeral bearer token the browser presents to OpenAI when negotiating the
/// WebRTC session. Short-lived; request a new one if it expires before use.
/// </param>
/// <param name="ExpiresAt">Unix timestamp (seconds) after which the client secret is invalid.</param>
/// <param name="Model">The Realtime model the client secret is scoped to.</param>
/// <param name="SourceLang">The language pair's source, as actually negotiated - either
/// what the caller sent or the backward-compat default.</param>
/// <param name="TargetLang">The language pair's target, as actually negotiated - either
/// what the caller sent or the backward-compat default.</param>
public sealed record RealtimeSessionResponse(string ClientSecret, long ExpiresAt, string Model, string SourceLang, string TargetLang);

/// <summary>Error body returned by <c>POST /api/realtime/session</c> on failure.</summary>
/// <param name="Error">A human-readable, non-sensitive description of what went wrong.</param>
public sealed record RealtimeSessionErrorResponse(string Error);
