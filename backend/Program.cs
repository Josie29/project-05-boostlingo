var builder = WebApplication.CreateBuilder(args);

// Typed HttpClient for minting ephemeral OpenAI Realtime client secrets. The
// OPENAI_API_KEY itself is attached per-request inside OpenAiRealtimeSessionClient
// and never exposed to callers of /api/realtime/session.
builder.Services.AddHttpClient<IRealtimeSessionClient, OpenAiRealtimeSessionClient>(client =>
{
    client.BaseAddress = new Uri("https://api.openai.com/v1/realtime/");
    client.Timeout = TimeSpan.FromSeconds(15);
});

// STT (speech-to-text; #5) provider and the raw OpenAI WebSocket it streams over.
// Both are stateless factories, so singleton is safe - per-session state lives in the
// ISttStream/IRealtimeSocket instances they hand out, not in these classes themselves.
builder.Services.AddSingleton<IRealtimeSocketFactory, ClientWebSocketRealtimeSocketFactory>();
builder.Services.AddSingleton<ISttProvider, OpenAiSttProvider>();

// MT (machine translation; #6) provider. Typed HttpClient, same pattern as
// IRealtimeSessionClient above - OPENAI_API_KEY is attached per-request inside
// OpenAiTranslationProvider and never exposed to callers of ITranslationProvider.
builder.Services.AddHttpClient<ITranslationProvider, OpenAiTranslationProvider>(client =>
{
    client.BaseAddress = new Uri("https://api.openai.com/v1/");
    client.Timeout = TimeSpan.FromSeconds(30);
});

// The real cascade pipeline (STT and MT live; TTS lands behind the same
// ICascadePipeline in #7). Scoped, not singleton: CascadePipeline holds per-session
// mutable state (the open STT stream and the background tasks draining it and the
// translation queue), and ASP.NET Core gives each WebSocket upgrade request its own DI
// scope for the lifetime of the connection.
builder.Services.AddScoped<ICascadePipeline, CascadePipeline>();

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
