using System.Net;

// Load repo-root .env before config is built; real shell env vars still win.
DotNetEnv.Env.TraversePath().NoClobber().Load();

var builder = WebApplication.CreateBuilder(args);

// How long a warmed connection to an MT/TTS provider stays usable. Well past
// HttpClientFactory's 2-minute handler default, which would otherwise retire the pool
// IProviderWarmup just warmed and make an utterance mid-conversation pay a fresh
// DNS/TCP/TLS handshake inside its own measured latency. Still bounded, so DNS changes
// are eventually picked up.
var providerConnectionLifetime = TimeSpan.FromMinutes(10);

// Enums cross the metrics wire as the same lowercase strings the frontend's
// TypeScript unions use ("realtime"/"cascade", "source"/"target"), not integers or
// PascalCase names - one vocabulary end to end. Reading is case-insensitive.
builder.Services.ConfigureHttpJsonOptions(options =>
    options.SerializerOptions.Converters.Add(
        new System.Text.Json.Serialization.JsonStringEnumConverter(System.Text.Json.JsonNamingPolicy.CamelCase)));

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

// MT (machine translation; #6) providers. BOTH are registered (Lab P1): the
// TRANSLATION_PROVIDER value ("openai" default, or "anthropic" - the provider-swap
// demo, #17) is only the per-session *default* now, resolved through
// ITranslationProviderSelector when session.start doesn't pick one. Typed HttpClient
// either way, same pattern as IRealtimeSessionClient above - API keys are attached
// per-request inside each provider. An unrecognized default still fails startup
// rather than silently falling back, so a config typo can't quietly run the wrong
// provider.
var translationProvider = builder.Configuration["TRANSLATION_PROVIDER"]?.ToLowerInvariant() ?? "openai";
if (!StageModels.IsSupportedMtProvider(translationProvider))
{
    throw new InvalidOperationException(
        $"Unrecognized TRANSLATION_PROVIDER '{translationProvider}'. Valid values: openai, anthropic.");
}

ConfigureProviderClient(
    builder.Services.AddHttpClient<OpenAiTranslationProvider>(), "https://api.openai.com/v1/", providerConnectionLifetime);
ConfigureProviderClient(
    builder.Services.AddHttpClient<AnthropicTranslationProvider>(), "https://api.anthropic.com/v1/", providerConnectionLifetime);
builder.Services.AddScoped<ITranslationProviderSelector, TranslationProviderSelector>();

// Session-metrics persistence (#10 revisited; docs/tech-stack.md's amended entry):
// local SQLite file, path overridable via METRICS_DB_PATH so tests and deployments
// point elsewhere. The endpoints depend only on ISessionMetricsStore, so a cloud
// deployment can swap in a managed database without touching them. The provider name
// is registered alongside it because saved conversations are stamped with the MT
// provider server-side - the frontend never knows which one is configured.
var metricsDbPath = builder.Configuration["METRICS_DB_PATH"]
    ?? Path.Combine(builder.Environment.ContentRootPath, "data", "metrics.db");
builder.Services.AddSingleton<ISessionMetricsStore>(_ => new SqliteSessionMetricsStore(metricsDbPath));
builder.Services.AddSingleton(new TranslationProviderName(translationProvider));

// TTS (text-to-speech; #7) provider. Typed HttpClient, same pattern as
// ITranslationProvider above - OPENAI_API_KEY is attached per-request inside
// OpenAiTtsProvider and never exposed to callers of ITtsProvider.
ConfigureProviderClient(
    builder.Services.AddHttpClient<ITtsProvider, OpenAiTtsProvider>(), "https://api.openai.com/v1/", providerConnectionLifetime);

// TTS cascade glue (#7): observes streamed translation chunks and turns them into
// tts.audio.start/binary frames/tts.audio.end on the client. Scoped, not singleton -
// it holds a per-session background synthesis pump (see TtsCascadeObserver's remarks)
// and must be disposed with the rest of the session's scoped services when the
// WebSocket connection's DI scope ends.
builder.Services.AddScoped<ITranslationObserver, TtsCascadeObserver>();

// The real cascade pipeline (STT, MT, and TTS all live behind ICascadePipeline).
// Scoped, not singleton: CascadePipeline holds per-session mutable state (the open
// STT stream and the background tasks draining it and the translation queue), and
// ASP.NET Core gives each WebSocket upgrade request its own DI scope for the lifetime
// of the connection.
builder.Services.AddScoped<ICascadePipeline, CascadePipeline>();

var app = builder.Build();

// Enables WebSocket upgrade requests on this host, used by the cascade audio
// channel (#4) mapped below and any future realtime relay.
app.UseWebSockets();

app.MapGet("/healthz", () => Results.Ok(new HealthResponse("ok")));

app.MapLanguageEndpoints();
app.MapRealtimeSessionEndpoints();
app.MapCascadeAudioEndpoints();
app.MapMetricsEndpoints();
app.MapArchitectureEndpoints();

LogOpenAiKeyStatus(app.Configuration, app.Logger);

app.Logger.LogInformation("Machine translation provider: {Provider}.", translationProvider);
if (translationProvider == "anthropic" && string.IsNullOrWhiteSpace(app.Configuration["ANTHROPIC_API_KEY"]))
{
    app.Logger.LogWarning(
        "TRANSLATION_PROVIDER is 'anthropic' but ANTHROPIC_API_KEY is not set. Set it via " +
        "environment variable or 'dotnet user-secrets set ANTHROPIC_API_KEY <value>' " +
        "before starting a cascade session.");
}

app.Run();

/// <summary>
/// Applies the shared connection settings every per-utterance MT/TTS provider client
/// wants: a long-lived pooled connection for <see cref="IProviderWarmup"/> to warm, and
/// HTTP/2 where the provider offers it.
/// </summary>
/// <param name="clientBuilder">The typed-client builder to configure.</param>
/// <param name="baseAddress">The provider's API base address.</param>
/// <param name="connectionLifetime">How long a pooled connection (and the handler owning
/// it) stays alive before rotation.</param>
/// <returns>The same builder, for chaining.</returns>
static IHttpClientBuilder ConfigureProviderClient(
    IHttpClientBuilder clientBuilder, string baseAddress, TimeSpan connectionLifetime) =>
    clientBuilder
        .ConfigureHttpClient(client =>
        {
            client.BaseAddress = new Uri(baseAddress);
            client.Timeout = TimeSpan.FromSeconds(30);
            // Requested, not required: negotiated over ALPN during the TLS handshake and
            // silently downgraded to HTTP/1.1 if the provider declines, so this can't
            // break a provider that doesn't speak h2. Worth requesting because h2
            // multiplexes concurrent utterances over the one warmed connection instead
            // of opening a second cold one under load.
            client.DefaultRequestVersion = HttpVersion.Version20;
            client.DefaultVersionPolicy = HttpVersionPolicy.RequestVersionOrLower;
        })
        .ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler
        {
            // Both matter: the idle timeout (1 minute by default) would drop the warmed
            // connection during a lull between utterances, and the lifetime bounds how
            // long a single connection is reused.
            PooledConnectionIdleTimeout = connectionLifetime,
            PooledConnectionLifetime = connectionLifetime,
        })
        .SetHandlerLifetime(connectionLifetime);

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
