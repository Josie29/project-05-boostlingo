var builder = WebApplication.CreateBuilder(args);

// Typed HttpClient for minting ephemeral OpenAI Realtime client secrets. The
// OPENAI_API_KEY itself is attached per-request inside OpenAiRealtimeSessionClient
// and never exposed to callers of /api/realtime/session.
builder.Services.AddHttpClient<IRealtimeSessionClient, OpenAiRealtimeSessionClient>(client =>
{
    client.BaseAddress = new Uri("https://api.openai.com/v1/realtime/");
    client.Timeout = TimeSpan.FromSeconds(15);
});

// The cascade pipeline stub until #5-7 (STT/MT/TTS) land behind ICascadePipeline.
builder.Services.AddSingleton<ICascadePipeline, NoOpCascadePipeline>();

var app = builder.Build();

// Enables WebSocket upgrade requests on this host, used by the cascade audio
// channel (#4) mapped below and any future realtime relay.
app.UseWebSockets();

app.MapGet("/healthz", () => Results.Ok(new HealthResponse("ok")));

app.MapRealtimeSessionEndpoints();
app.MapCascadeAudioEndpoints();

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
