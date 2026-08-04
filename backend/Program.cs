var builder = WebApplication.CreateBuilder(args);

var app = builder.Build();

// Enables WebSocket upgrade requests on this host. No endpoints use it yet;
// the cascade audio channel (#4) and any realtime relay wire up on top of this.
app.UseWebSockets();

app.MapGet("/healthz", () => Results.Ok(new HealthResponse("ok")));

LogOpenAiKeyStatus(app.Configuration, app.Logger);

app.Run();

/// <summary>
/// Logs, at startup, whether an OpenAI API key was found in configuration
/// (environment variable or user secrets) without ever logging the key value itself.
/// </summary>
/// <param name="configuration">The app's configuration, which layers environment
/// variables and user secrets over appsettings.json.</param>
/// <param name="logger">Logger used to surface the key's presence to the console.</param>
static void LogOpenAiKeyStatus(IConfiguration configuration, ILogger logger)
{
    var hasKey = !string.IsNullOrWhiteSpace(configuration["OPENAI_API_KEY"]);
    if (hasKey)
    {
        logger.LogInformation("OPENAI_API_KEY is configured.");
    }
    else
    {
        logger.LogWarning(
            "OPENAI_API_KEY is not set. Set it via environment variable or " +
            "'dotnet user-secrets set OPENAI_API_KEY <value>' before using OpenAI-backed endpoints.");
    }
}

/// <summary>Response body for <c>GET /healthz</c>.</summary>
/// <param name="Status">A short liveness indicator, e.g. "ok".</param>
public record HealthResponse(string Status);
