using System.IO;
using System.Net.Http.Json;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Serialization;

/// <summary>
/// Translates finalized source utterances via Anthropic's streaming Messages API,
/// behind the same interpreter-style system prompt (<see cref="TranslationInstructions"/>)
/// the OpenAI provider uses. Every Anthropic-specific detail (endpoint, headers, wire
/// shapes, model name, SSE (Server-Sent Events) event parsing) lives in this one file -
/// this provider exists to prove the swap convention: selecting it (see
/// <c>TRANSLATION_PROVIDER</c> in <c>Program.cs</c>) touches no code outside this file
/// and that registration switch.
/// </summary>
/// <remarks>
/// Defaults to <c>claude-haiku-4-5</c>: the MT (machine translation) stage of a live
/// interpretation cascade is a short, speed-critical task where time-to-first-token
/// directly moves the end-to-end latency the brief benchmarks, and Haiku is the
/// latency/cost tier-parity choice against the OpenAI provider's <c>gpt-4o-mini</c>.
/// Override with <c>ANTHROPIC_MT_MODEL</c> to trade latency for a larger model.
/// </remarks>
public sealed class AnthropicTranslationProvider(
    HttpClient httpClient, IConfiguration configuration, ILogger<AnthropicTranslationProvider> logger)
    : ITranslationProvider, IProviderWarmup
{
    /// <summary>Anthropic model used when <c>ANTHROPIC_MT_MODEL</c> isn't set.</summary>
    public const string DefaultModel = "claude-haiku-4-5";

    /// <summary>Required Anthropic API version header value.</summary>
    public const string ApiVersion = "2023-06-01";

    /// <summary>
    /// Output cap per translation request. Utterance translations are short by
    /// construction (one spoken turn), so this bounds a runaway response without ever
    /// truncating a real translation.
    /// </summary>
    private const int MaxTokens = 1024;

    /// <summary>
    /// Wire options for talking to Anthropic: snake_case property names come from
    /// explicit <see cref="JsonPropertyNameAttribute"/>s on the DTOs below, same
    /// convention as the OpenAI providers' DTOs.
    /// </summary>
    private static readonly JsonSerializerOptions AnthropicJsonOptions = new();

    /// <inheritdoc />
    /// <exception cref="TranslationProviderException">Thrown when
    /// <c>ANTHROPIC_API_KEY</c> is not configured, the request fails outright (network
    /// error or non-success status) even after one retry, the stream reports an error
    /// event, or the SSE stream drops before it signals completion.</exception>
    public async IAsyncEnumerable<string> TranslateAsync(
        TranslationRequest request, [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(request.SourceText))
        {
            // Nothing to translate - mirrors the OpenAI providers' blank-input guards.
            yield break;
        }

        var apiKey = configuration["ANTHROPIC_API_KEY"];
        if (string.IsNullOrWhiteSpace(apiKey))
        {
            throw new TranslationProviderException("The server is not configured with an Anthropic API key.");
        }

        var response = await ProviderHttpRetry.SendWithOneRetryAsync(
            httpClient,
            () => BuildRequest(request, apiKey),
            stageName: "Machine translation",
            wrapException: static (message, inner) => inner is null
                ? new TranslationProviderException(message)
                : new TranslationProviderException(message, inner),
            logger,
            cancellationToken);

        using (response)
        {
            var body = await response.Content.ReadAsStreamAsync(cancellationToken);
            using var reader = new StreamReader(body);

            while (true)
            {
                string? line;
                try
                {
                    line = await reader.ReadLineAsync(cancellationToken);
                }
                catch (Exception ex) when (ex is IOException
                    || (ex is OperationCanceledException && !cancellationToken.IsCancellationRequested))
                {
                    // The OperationCanceledException arm covers HttpClient.Timeout
                    // expiring mid-body - the caller's own token isn't cancelled, so
                    // this is a provider failure, not caller cancellation.
                    throw new TranslationProviderException("Machine translation connection dropped mid-stream.", ex);
                }

                if (line is null)
                {
                    // Anthropic ends the stream after message_stop; body EOF is the
                    // end of the translation.
                    yield break;
                }

                if (!line.StartsWith("data: ", StringComparison.Ordinal))
                {
                    // "event: ..." lines and blank SSE separators carry nothing this
                    // provider needs - the data payload's own "type" field
                    // discriminates events.
                    continue;
                }

                string? token;
                bool finished;
                try
                {
                    (token, finished) = ParseStreamEvent(line["data: ".Length..]);
                }
                catch (JsonException ex)
                {
                    // A malformed frame is skipped rather than allowed to escape as an
                    // undocumented exception type - mirrors the OpenAI MT provider.
                    logger.LogWarning(ex, "Skipping a malformed SSE frame from the machine translation stream.");
                    continue;
                }

                if (!string.IsNullOrEmpty(token))
                {
                    yield return token;
                }

                if (finished)
                {
                    yield break;
                }
            }
        }
    }

    /// <inheritdoc />
    /// <remarks>
    /// <c>GET /v1/models</c> is Anthropic's equivalent of the endpoint
    /// <see cref="OpenAiTranslationProvider.WarmUpAsync"/> warms with: authenticated,
    /// no inference, no tokens. Kept here rather than shared with that provider because
    /// the auth headers differ (see <see cref="BuildRequest"/>).
    /// </remarks>
    public Task WarmUpAsync(CancellationToken cancellationToken)
    {
        var apiKey = configuration["ANTHROPIC_API_KEY"];
        if (string.IsNullOrWhiteSpace(apiKey))
        {
            return Task.CompletedTask;
        }

        return ProviderConnectionWarmup.SendAsync(
            httpClient, () => BuildWarmUpRequest(apiKey), stageName: "Machine translation", logger, cancellationToken);
    }

    private static HttpRequestMessage BuildWarmUpRequest(string apiKey)
    {
        var httpRequest = new HttpRequestMessage(HttpMethod.Get, "models");
        httpRequest.Headers.Add("x-api-key", apiKey);
        httpRequest.Headers.Add("anthropic-version", ApiVersion);
        return httpRequest;
    }

    private HttpRequestMessage BuildRequest(TranslationRequest request, string apiKey)
    {
        var httpRequest = new HttpRequestMessage(HttpMethod.Post, "messages")
        {
            Content = JsonContent.Create(BuildMessagesRequest(request), options: AnthropicJsonOptions),
        };
        // Anthropic authenticates via x-api-key (not a Bearer Authorization header)
        // and requires an anthropic-version header on every request.
        httpRequest.Headers.Add("x-api-key", apiKey);
        httpRequest.Headers.Add("anthropic-version", ApiVersion);
        return httpRequest;
    }

    private AnthropicMessagesRequest BuildMessagesRequest(TranslationRequest request) => new(
        Model: configuration["ANTHROPIC_MT_MODEL"] is { Length: > 0 } model ? model : DefaultModel,
        MaxTokens: MaxTokens,
        Stream: true,
        System: TranslationInstructions.Build(request.SourceLang, request.TargetLang),
        Messages: [new AnthropicMessage("user", request.SourceText)]);

    /// <summary>
    /// Interprets one SSE data payload from Anthropic's streaming Messages API.
    /// <c>content_block_delta</c> events with a <c>text_delta</c> carry the
    /// incremental translation text; <c>message_stop</c> ends the stream; an
    /// <c>error</c> event surfaces as the provider's typed exception. Everything else
    /// (message_start, content_block_start/stop, message_delta, ping) is skipped.
    /// </summary>
    /// <param name="json">One SSE frame's JSON payload, with the leading
    /// <c>"data: "</c> already stripped.</param>
    /// <returns>The token this event carries (or <c>null</c>), and whether the stream
    /// is finished.</returns>
    /// <exception cref="TranslationProviderException">Thrown when Anthropic sends an
    /// <c>error</c> event.</exception>
    private static (string? Token, bool Finished) ParseStreamEvent(string json)
    {
        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;
        var type = root.TryGetProperty("type", out var typeProperty) ? typeProperty.GetString() : null;

        switch (type)
        {
            case "content_block_delta":
                if (root.TryGetProperty("delta", out var delta)
                    && delta.TryGetProperty("type", out var deltaType)
                    && deltaType.GetString() == "text_delta"
                    && delta.TryGetProperty("text", out var text))
                {
                    return (text.GetString(), Finished: false);
                }

                return (null, Finished: false);

            case "message_stop":
                return (null, Finished: true);

            case "error":
                var message = root.TryGetProperty("error", out var error)
                    && error.TryGetProperty("message", out var errorMessage)
                        ? errorMessage.GetString() ?? "Unknown Anthropic stream error."
                        : "Unknown Anthropic stream error.";
                throw new TranslationProviderException($"Machine translation stream reported an error: {message}");

            default:
                return (null, Finished: false);
        }
    }
}

// --- Anthropic wire-format DTOs (snake_case, per Anthropic's Messages API) ---

internal sealed record AnthropicMessagesRequest(
    [property: JsonPropertyName("model")] string Model,
    [property: JsonPropertyName("max_tokens")] int MaxTokens,
    [property: JsonPropertyName("stream")] bool Stream,
    [property: JsonPropertyName("system")] string System,
    [property: JsonPropertyName("messages")] IReadOnlyList<AnthropicMessage> Messages);

internal sealed record AnthropicMessage(
    [property: JsonPropertyName("role")] string Role,
    [property: JsonPropertyName("content")] string Content);
