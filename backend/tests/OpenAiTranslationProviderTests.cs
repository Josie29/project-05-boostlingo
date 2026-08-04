using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

namespace Boostlingo.Backend.Tests;

public class OpenAiTranslationProviderTests
{
    /// <summary>
    /// Confirms a missing OPENAI_API_KEY fails loudly with a clear, catchable
    /// exception before ever touching the network - this is what the cascade pipeline
    /// turns into the per-utterance error envelope.
    /// </summary>
    [Fact]
    public async Task TranslateAsync_MissingApiKey_ThrowsWithoutConnecting()
    {
        var handler = new FakeSseHttpMessageHandler(FakeSseHttpMessageHandler.SseBody("Hola"));
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
    /// Confirms the outgoing chat completion request names gpt-4o-mini, streams, is
    /// bearer-authenticated, and carries a translate-only system prompt naming the
    /// negotiated language pair plus the source text as the user message - this is the
    /// entire contract for "swapping the MT provider only touches the provider class."
    /// </summary>
    [Fact]
    public async Task TranslateAsync_SendsStreamingChatRequest_WithModelAndInstructions()
    {
        var handler = new FakeSseHttpMessageHandler(FakeSseHttpMessageHandler.SseBody("Hola"));
        var provider = CreateProvider(handler, apiKey: "sk-test");

        await foreach (var _ in provider.TranslateAsync(new TranslationRequest("Hello", "en", "es"), CancellationToken.None))
        {
        }

        var request = Assert.Single(handler.Requests);
        Assert.Equal("Bearer sk-test", request.Authorization);
        Assert.Contains(OpenAiTranslationProvider.Model, request.Body);
        Assert.Contains("\"stream\":true", request.Body);
        Assert.Contains("en", request.Body);
        Assert.Contains("es", request.Body);
        Assert.Contains("Hello", request.Body);
    }

    /// <summary>
    /// Confirms streamed delta.content chunks are parsed into tokens in order and the
    /// stream stops at the [DONE] sentinel - this is the only place that ever has to
    /// understand OpenAI's chat-completion SSE (Server-Sent Events) shape.
    /// </summary>
    [Fact]
    public async Task TranslateAsync_ParsesDeltaTokens_InOrder()
    {
        var handler = new FakeSseHttpMessageHandler(FakeSseHttpMessageHandler.SseBody("Ho", "la"));
        var provider = CreateProvider(handler, apiKey: "sk-test");

        var tokens = new List<string>();
        await foreach (var token in provider.TranslateAsync(new TranslationRequest("Hi", "en", "es"), CancellationToken.None))
        {
            tokens.Add(token);
        }

        Assert.Equal(["Ho", "la"], tokens);
    }

    /// <summary>
    /// Confirms a non-success upstream response surfaces as TranslationProviderException
    /// rather than an unhandled HTTP exception or silently yielding no tokens - the
    /// cascade pipeline relies on this to turn upstream failures into a per-utterance
    /// error envelope without killing the session.
    /// </summary>
    [Fact]
    public async Task TranslateAsync_NonSuccessStatus_ThrowsTranslationProviderException()
    {
        var handler = new FakeSseHttpMessageHandler(HttpStatusCode.TooManyRequests, "rate limited");
        var provider = CreateProvider(handler, apiKey: "sk-test");

        async Task ConsumeAsync()
        {
            await foreach (var _ in provider.TranslateAsync(new TranslationRequest("Hi", "en", "es"), CancellationToken.None))
            {
            }
        }

        await Assert.ThrowsAsync<TranslationProviderException>(ConsumeAsync);
    }

    /// <summary>
    /// Confirms a transient 5xx on the first attempt is retried exactly once (#12,
    /// error handling hardening) and succeeds on the second - the fake handler's call
    /// count is the only way to prove a retry actually happened, not just that the
    /// eventual result looks right.
    /// </summary>
    [Fact]
    public async Task TranslateAsync_TransientServerError_RetriesOnceThenSucceeds()
    {
        var handler = new FakeSseHttpMessageHandler(
            (HttpStatusCode.InternalServerError, "boom"),
            (HttpStatusCode.OK, FakeSseHttpMessageHandler.SseBody("Hola")));
        var provider = CreateProvider(handler, apiKey: "sk-test");

        var tokens = new List<string>();
        await foreach (var token in provider.TranslateAsync(new TranslationRequest("Hi", "en", "es"), CancellationToken.None))
        {
            tokens.Add(token);
        }

        Assert.Equal(["Hola"], tokens);
        Assert.Equal(2, handler.Requests.Count);
    }

    /// <summary>
    /// Confirms a 429 (rate limited) is treated as transient and retried exactly once,
    /// same as a 5xx - OpenAI's rate limit responses must not be treated as a
    /// non-retryable client error.
    /// </summary>
    [Fact]
    public async Task TranslateAsync_RateLimited_RetriesOnceThenSucceeds()
    {
        var handler = new FakeSseHttpMessageHandler(
            (HttpStatusCode.TooManyRequests, "slow down"),
            (HttpStatusCode.OK, FakeSseHttpMessageHandler.SseBody("Hola")));
        var provider = CreateProvider(handler, apiKey: "sk-test");

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
    /// retry - retrying a request OpenAI has already rejected as invalid would fail
    /// identically the second time, just adding latency for no benefit.
    /// </summary>
    [Fact]
    public async Task TranslateAsync_ClientError_ThrowsWithoutRetrying()
    {
        var handler = new FakeSseHttpMessageHandler((HttpStatusCode.BadRequest, "bad request"));
        var provider = CreateProvider(handler, apiKey: "sk-test");

        async Task ConsumeAsync()
        {
            await foreach (var _ in provider.TranslateAsync(new TranslationRequest("Hi", "en", "es"), CancellationToken.None))
            {
            }
        }

        await Assert.ThrowsAsync<TranslationProviderException>(ConsumeAsync);
        Assert.Single(handler.Requests);
    }

    /// <summary>
    /// Confirms a request that never gets a response within the client's configured
    /// timeout surfaces as a clear TranslationProviderException - the cascade pipeline
    /// relies on this to turn a hung provider connection into a per-utterance error
    /// envelope instead of the session hanging forever.
    /// </summary>
    [Fact]
    public async Task TranslateAsync_RequestTimesOut_ThrowsTranslationProviderException()
    {
        var handler = new DelayingHttpMessageHandler(TimeSpan.FromSeconds(5));
        var provider = CreateProvider(handler, apiKey: "sk-test", timeout: TimeSpan.FromMilliseconds(50));

        async Task ConsumeAsync()
        {
            await foreach (var _ in provider.TranslateAsync(new TranslationRequest("Hi", "en", "es"), CancellationToken.None))
            {
            }
        }

        await Assert.ThrowsAsync<TranslationProviderException>(ConsumeAsync);
    }

    private static OpenAiTranslationProvider CreateProvider(HttpMessageHandler handler, string? apiKey, TimeSpan? timeout = null)
    {
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["OPENAI_API_KEY"] = apiKey })
            .Build();
        var httpClient = new HttpClient(handler) { BaseAddress = new Uri("https://api.openai.com/v1/") };
        if (timeout is { } t)
        {
            httpClient.Timeout = t;
        }

        return new OpenAiTranslationProvider(httpClient, configuration, NullLogger<OpenAiTranslationProvider>.Instance);
    }
}

/// <summary>
/// A fake handler that never responds within <paramref name="delay"/> - long enough
/// that a short <see cref="HttpClient.Timeout"/> fires first, so tests can exercise the
/// provider's timeout-handling path without actually waiting for a real timeout.
/// </summary>
file sealed class DelayingHttpMessageHandler(TimeSpan delay) : HttpMessageHandler
{
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        await Task.Delay(delay, cancellationToken);
        return new HttpResponseMessage(HttpStatusCode.OK);
    }
}

/// <summary>A snapshot of one request the fake handler received, captured before <see cref="OpenAiTranslationProvider"/> disposes its <see cref="HttpRequestMessage"/> at the end of the call.</summary>
/// <param name="Authorization">The raw <c>Authorization</c> header value, or <c>null</c> if none was set.</param>
/// <param name="Body">The request body, read eagerly since the original content is disposed once the caller's <c>using var httpRequest</c> goes out of scope.</param>
file sealed record CapturedRequest(string? Authorization, string Body);

/// <summary>
/// A fake OpenAI chat-completions endpoint: records every request it receives and
/// returns a canned response (a scripted SSE body or an error status), so
/// <see cref="OpenAiTranslationProvider"/>'s request building and SSE parsing can be
/// exercised with no real network connection - the "fake-able handler" seam called out
/// in the #6 issue, one level lower than the typed-client fakes used for realtime
/// sessions since this provider needs the raw response stream.
/// </summary>
file sealed class FakeSseHttpMessageHandler : HttpMessageHandler
{
    private readonly List<(HttpStatusCode StatusCode, string Body)> _responses;

    public List<CapturedRequest> Requests { get; } = [];

    public FakeSseHttpMessageHandler(string responseBody) : this([(HttpStatusCode.OK, responseBody)])
    {
    }

    public FakeSseHttpMessageHandler(HttpStatusCode statusCode, string responseBody) : this([(statusCode, responseBody)])
    {
    }

    /// <summary>
    /// Scripts one response per call, in order (#12, error handling hardening's retry
    /// tests) - e.g. a transient failure followed by a success, to prove a retry
    /// actually happened rather than just that the final result looks right. If more
    /// calls arrive than responses were scripted, the last response repeats.
    /// </summary>
    public FakeSseHttpMessageHandler(params (HttpStatusCode StatusCode, string Body)[] responses) => _responses = [.. responses];

    /// <summary>Builds a chat-completion SSE body streaming one delta chunk per token, terminated by [DONE].</summary>
    public static string SseBody(params string[] tokens)
    {
        var builder = new StringBuilder();
        foreach (var token in tokens)
        {
            var chunk = new { choices = new[] { new { delta = new { content = token } } } };
            builder.Append("data: ").Append(JsonSerializer.Serialize(chunk)).Append("\n\n");
        }

        builder.Append("data: [DONE]\n\n");
        return builder.ToString();
    }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var (statusCode, responseBody) = _responses[Math.Min(Requests.Count, _responses.Count - 1)];

        // Captured eagerly here, not stored as the live HttpRequestMessage: the
        // provider disposes its request (and its content) once TranslateAsync's
        // enumerator finishes, before a test would otherwise get a chance to inspect it.
        var body = request.Content is null ? string.Empty : await request.Content.ReadAsStringAsync(cancellationToken);
        Requests.Add(new CapturedRequest(request.Headers.Authorization?.ToString(), body));

        return new HttpResponseMessage(statusCode)
        {
            Content = new StringContent(responseBody, Encoding.UTF8, "text/event-stream"),
        };
    }
}
