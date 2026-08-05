using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

namespace Boostlingo.Backend.Tests;

public class AnthropicTranslationProviderTests
{
    /// <summary>
    /// Confirms a missing ANTHROPIC_API_KEY fails loudly with a clear, catchable
    /// exception before ever touching the network - this is what the cascade pipeline
    /// turns into the per-utterance error envelope.
    /// </summary>
    [Fact]
    public async Task TranslateAsync_MissingApiKey_ThrowsWithoutConnecting()
    {
        var handler = new FakeAnthropicSseHandler(FakeAnthropicSseHandler.SseBody("Hola"));
        var provider = CreateProvider(handler, apiKey: null);

        async Task ConsumeAsync()
        {
            await foreach (var _ in provider.TranslateAsync(new TranslationRequest("Hello", "en", "es"), CancellationToken.None))
            {
            }
        }

        var ex = await Assert.ThrowsAsync<TranslationProviderException>(ConsumeAsync);
        Assert.Contains("API key", ex.Message);
        Assert.Empty(handler.Requests);
    }

    /// <summary>
    /// Confirms the outgoing Messages API request carries Anthropic's auth and version
    /// headers (x-api-key, not a Bearer Authorization header), names the model,
    /// streams, and puts the translate-only instructions in the system field with the
    /// source text as the user message - this is the entire contract for "swapping the
    /// MT provider only touches the provider class and its registration" (#17).
    /// </summary>
    [Fact]
    public async Task TranslateAsync_SendsStreamingMessagesRequest_WithHeadersAndInstructions()
    {
        var handler = new FakeAnthropicSseHandler(FakeAnthropicSseHandler.SseBody("Hola"));
        var provider = CreateProvider(handler, apiKey: "sk-ant-test");

        await foreach (var _ in provider.TranslateAsync(new TranslationRequest("Hello", "en", "es"), CancellationToken.None))
        {
        }

        var request = Assert.Single(handler.Requests);
        Assert.Equal("sk-ant-test", request.ApiKeyHeader);
        Assert.Equal(AnthropicTranslationProvider.ApiVersion, request.VersionHeader);
        Assert.Null(request.Authorization);
        Assert.Contains(AnthropicTranslationProvider.DefaultModel, request.Body);
        Assert.Contains("\"stream\":true", request.Body);
        Assert.Contains("\"system\":", request.Body);
        Assert.Contains("en", request.Body);
        Assert.Contains("es", request.Body);
        Assert.Contains("Hello", request.Body);
    }

    /// <summary>
    /// Confirms ANTHROPIC_MT_MODEL overrides the default model - the latency/quality
    /// knob documented in the provider's remarks; without this a user configuring a
    /// larger model would silently keep getting the default.
    /// </summary>
    [Fact]
    public async Task TranslateAsync_ModelOverride_IsSentOnTheWire()
    {
        var handler = new FakeAnthropicSseHandler(FakeAnthropicSseHandler.SseBody("Hola"));
        var provider = CreateProvider(handler, apiKey: "sk-ant-test", model: "claude-sonnet-5");

        await foreach (var _ in provider.TranslateAsync(new TranslationRequest("Hello", "en", "es"), CancellationToken.None))
        {
        }

        var request = Assert.Single(handler.Requests);
        Assert.Contains("claude-sonnet-5", request.Body);
        Assert.DoesNotContain(AnthropicTranslationProvider.DefaultModel, request.Body);
    }

    /// <summary>
    /// Confirms streamed content_block_delta text_delta events are parsed into tokens
    /// in order, non-text events (message_start, ping, content_block_stop) are
    /// skipped, and the stream ends at message_stop - the only place that ever has to
    /// understand Anthropic's Messages API SSE (Server-Sent Events) shape.
    /// </summary>
    [Fact]
    public async Task TranslateAsync_ParsesTextDeltas_InOrder_AndStopsAtMessageStop()
    {
        var handler = new FakeAnthropicSseHandler(FakeAnthropicSseHandler.SseBody("Ho", "la"));
        var provider = CreateProvider(handler, apiKey: "sk-ant-test");

        var tokens = new List<string>();
        await foreach (var token in provider.TranslateAsync(new TranslationRequest("Hi", "en", "es"), CancellationToken.None))
        {
            tokens.Add(token);
        }

        Assert.Equal(["Ho", "la"], tokens);
    }

    /// <summary>
    /// Confirms an in-stream error event surfaces as TranslationProviderException -
    /// Anthropic reports mid-stream failures (e.g. overloaded_error) as SSE error
    /// events on an HTTP 200, so status-code handling alone would silently truncate
    /// the translation instead of surfacing the failure.
    /// </summary>
    [Fact]
    public async Task TranslateAsync_ErrorEvent_ThrowsTranslationProviderException()
    {
        var body =
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Ho\"}}\n\n" +
            "data: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}\n\n";
        var handler = new FakeAnthropicSseHandler(body);
        var provider = CreateProvider(handler, apiKey: "sk-ant-test");

        async Task ConsumeAsync()
        {
            await foreach (var _ in provider.TranslateAsync(new TranslationRequest("Hi", "en", "es"), CancellationToken.None))
            {
            }
        }

        var ex = await Assert.ThrowsAsync<TranslationProviderException>(ConsumeAsync);
        Assert.Contains("Overloaded", ex.Message);
    }

    /// <summary>
    /// Confirms a transient 5xx on the first attempt is retried exactly once (#12,
    /// error handling hardening, via the shared ProviderHttpRetry policy) and succeeds
    /// on the second - the fake handler's call count is the only way to prove a retry
    /// actually happened.
    /// </summary>
    [Fact]
    public async Task TranslateAsync_TransientServerError_RetriesOnceThenSucceeds()
    {
        var handler = new FakeAnthropicSseHandler(
            (HttpStatusCode.InternalServerError, "boom"),
            (HttpStatusCode.OK, FakeAnthropicSseHandler.SseBody("Hola")));
        var provider = CreateProvider(handler, apiKey: "sk-ant-test");

        var tokens = new List<string>();
        await foreach (var token in provider.TranslateAsync(new TranslationRequest("Hi", "en", "es"), CancellationToken.None))
        {
            tokens.Add(token);
        }

        Assert.Equal(["Hola"], tokens);
        Assert.Equal(2, handler.Requests.Count);
    }

    /// <summary>
    /// Confirms a 400 (validation/auth - not transient) throws immediately with no
    /// retry - retrying a request Anthropic has already rejected as invalid would fail
    /// identically the second time, just adding latency for no benefit.
    /// </summary>
    [Fact]
    public async Task TranslateAsync_ClientError_ThrowsWithoutRetrying()
    {
        var handler = new FakeAnthropicSseHandler((HttpStatusCode.BadRequest, "bad request"));
        var provider = CreateProvider(handler, apiKey: "sk-ant-test");

        async Task ConsumeAsync()
        {
            await foreach (var _ in provider.TranslateAsync(new TranslationRequest("Hi", "en", "es"), CancellationToken.None))
            {
            }
        }

        await Assert.ThrowsAsync<TranslationProviderException>(ConsumeAsync);
        Assert.Single(handler.Requests);
    }

    private static AnthropicTranslationProvider CreateProvider(
        HttpMessageHandler handler, string? apiKey, string? model = null)
    {
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["ANTHROPIC_API_KEY"] = apiKey,
                ["ANTHROPIC_MT_MODEL"] = model,
            })
            .Build();
        var httpClient = new HttpClient(handler) { BaseAddress = new Uri("https://api.anthropic.com/v1/") };
        return new AnthropicTranslationProvider(httpClient, configuration, NullLogger<AnthropicTranslationProvider>.Instance);
    }
}

/// <summary>A snapshot of one request the fake handler received, captured before the provider disposes its <see cref="HttpRequestMessage"/>.</summary>
/// <param name="ApiKeyHeader">The raw <c>x-api-key</c> header value, or <c>null</c> if none was set.</param>
/// <param name="VersionHeader">The raw <c>anthropic-version</c> header value, or <c>null</c> if none was set.</param>
/// <param name="Authorization">The raw <c>Authorization</c> header value - asserted <c>null</c>, since Anthropic auth must not use a Bearer header.</param>
/// <param name="Body">The request body, read eagerly since the original content is disposed once the provider's <c>using var httpRequest</c> goes out of scope.</param>
file sealed record CapturedAnthropicRequest(string? ApiKeyHeader, string? VersionHeader, string? Authorization, string Body);

/// <summary>
/// A fake Anthropic Messages endpoint: records every request it receives and returns
/// a canned response (a scripted SSE body or an error status), so
/// <see cref="AnthropicTranslationProvider"/>'s request building and event parsing can
/// be exercised with no real network connection - the same fake-able handler seam the
/// OpenAI MT provider's tests use.
/// </summary>
file sealed class FakeAnthropicSseHandler : HttpMessageHandler
{
    private readonly List<(HttpStatusCode StatusCode, string Body)> _responses;

    public List<CapturedAnthropicRequest> Requests { get; } = [];

    public FakeAnthropicSseHandler(string responseBody) : this([(HttpStatusCode.OK, responseBody)])
    {
    }

    /// <summary>
    /// Scripts one response per call, in order, for the retry tests. If more calls
    /// arrive than responses were scripted, the last response repeats.
    /// </summary>
    public FakeAnthropicSseHandler(params (HttpStatusCode StatusCode, string Body)[] responses) => _responses = [.. responses];

    /// <summary>
    /// Builds a Messages API SSE body: message_start, one content_block_delta
    /// text_delta per token, content_block_stop, message_delta, message_stop -
    /// including the non-delta events so tests prove they're skipped rather than
    /// misread as text.
    /// </summary>
    public static string SseBody(params string[] tokens)
    {
        var builder = new StringBuilder();
        builder.Append("event: message_start\n");
        builder.Append("data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_test\"}}\n\n");
        builder.Append("event: content_block_start\n");
        builder.Append("data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n");
        foreach (var token in tokens)
        {
            var delta = new { type = "content_block_delta", index = 0, delta = new { type = "text_delta", text = token } };
            builder.Append("event: content_block_delta\n");
            builder.Append("data: ").Append(JsonSerializer.Serialize(delta)).Append("\n\n");
        }

        builder.Append("event: content_block_stop\n");
        builder.Append("data: {\"type\":\"content_block_stop\",\"index\":0}\n\n");
        builder.Append("event: message_delta\n");
        builder.Append("data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}\n\n");
        builder.Append("event: message_stop\n");
        builder.Append("data: {\"type\":\"message_stop\"}\n\n");
        return builder.ToString();
    }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var (statusCode, responseBody) = _responses[Math.Min(Requests.Count, _responses.Count - 1)];

        // Captured eagerly here, not stored as the live HttpRequestMessage: the
        // provider disposes its request (and its content) once TranslateAsync's
        // enumerator finishes, before a test would otherwise get a chance to inspect it.
        var body = request.Content is null ? string.Empty : await request.Content.ReadAsStringAsync(cancellationToken);
        Requests.Add(new CapturedAnthropicRequest(
            request.Headers.TryGetValues("x-api-key", out var apiKeys) ? string.Join(",", apiKeys) : null,
            request.Headers.TryGetValues("anthropic-version", out var versions) ? string.Join(",", versions) : null,
            request.Headers.Authorization?.ToString(),
            body));

        return new HttpResponseMessage(statusCode)
        {
            Content = new StringContent(responseBody, Encoding.UTF8, "text/event-stream"),
        };
    }
}
