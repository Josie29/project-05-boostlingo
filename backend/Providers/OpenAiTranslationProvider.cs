using System.IO;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Serialization;

/// <summary>
/// Translates finalized source utterances via OpenAI's streaming chat completions
/// endpoint using <c>gpt-4o-mini</c>, behind an interpreter-style system prompt that
/// constrains it to pure translation. Every OpenAI-specific detail (endpoint, wire
/// shapes, model name, SSE (Server-Sent Events) parsing) lives in this one file, per
/// the same swappable-provider convention <see cref="OpenAiSttProvider"/> follows for
/// STT.
/// </summary>
/// <remarks>
/// Registered as a typed <see cref="HttpClient"/> (see <c>Program.cs</c>), the same
/// pattern <see cref="OpenAiRealtimeSessionClient"/> uses for minting realtime session
/// secrets. Unlike that class, this one needs the raw response body as a stream (to
/// read the SSE frames as they arrive) rather than a single deserialized JSON object,
/// so tests substitute a fake <see cref="HttpMessageHandler"/> that returns a canned SSE
/// body instead of faking a higher-level client interface.
/// </remarks>
public sealed class OpenAiTranslationProvider(
    HttpClient httpClient, IConfiguration configuration, ILogger<OpenAiTranslationProvider> logger)
    : ITranslationProvider
{
    /// <summary>OpenAI chat model used for cascade-mode machine translation.</summary>
    public const string Model = "gpt-4o-mini";

    /// <summary>
    /// Wire options for talking to OpenAI: snake_case property names come from explicit
    /// <see cref="JsonPropertyNameAttribute"/>s on the DTOs below, matching the
    /// convention <see cref="OpenAiSttProvider"/> uses for its own OpenAI-facing DTOs.
    /// </summary>
    private static readonly JsonSerializerOptions OpenAiJsonOptions = new();

    /// <summary>
    /// One-retry-only backoff (#12, error handling hardening) between the initial
    /// attempt and its single retry - short enough not to meaningfully add to
    /// end-to-end cascade latency, long enough to ride out a brief provider hiccup.
    /// </summary>
    private static readonly TimeSpan RetryDelay = TimeSpan.FromMilliseconds(500);

    /// <inheritdoc />
    /// <exception cref="TranslationProviderException">Thrown when <c>OPENAI_API_KEY</c>
    /// is not configured, the request fails outright (network error or non-success
    /// status) even after one retry, or the SSE stream drops before it signals
    /// completion.</exception>
    public async IAsyncEnumerable<string> TranslateAsync(
        TranslationRequest request, [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        var apiKey = configuration["OPENAI_API_KEY"];
        if (string.IsNullOrWhiteSpace(apiKey))
        {
            throw new TranslationProviderException("The server is not configured with an OpenAI API key.");
        }

        var response = await SendWithOneRetryAsync(request, apiKey, cancellationToken);

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
                catch (IOException ex)
                {
                    throw new TranslationProviderException("Machine translation connection dropped mid-stream.", ex);
                }

                if (line is null)
                {
                    // The provider closed the response body normally without an explicit
                    // [DONE] marker - treat that as the end of the translation too.
                    yield break;
                }

                if (!line.StartsWith("data: ", StringComparison.Ordinal))
                {
                    // Blank lines (SSE frame separators) and any other non-data line
                    // carry nothing this provider needs.
                    continue;
                }

                var data = line["data: ".Length..];
                if (data == "[DONE]")
                {
                    yield break;
                }

                var token = ParseDeltaToken(data);
                if (!string.IsNullOrEmpty(token))
                {
                    yield return token;
                }
            }
        }
    }

    /// <summary>
    /// Sends the chat completion request, retrying exactly once (#12, error handling
    /// hardening) if the first attempt fails transiently: a connection failure, a
    /// request timeout, a 429 (rate limited), or any 5xx. A 4xx other than 429 (auth or
    /// validation - retrying would fail identically) throws immediately with no retry.
    /// The retry always builds a brand-new <see cref="HttpRequestMessage"/> - an
    /// <see cref="HttpRequestMessage"/> can only ever be sent once - so nothing from
    /// this method's caller has read any part of the response body yet by the time a
    /// retry happens, meaning a retry here can never duplicate already-streamed tokens.
    /// </summary>
    /// <param name="request">The source text and language pair to translate.</param>
    /// <param name="apiKey">The bearer token to authenticate with.</param>
    /// <param name="cancellationToken">Propagates cancellation of either attempt.</param>
    /// <returns>The successful response, with headers already read (but the body not
    /// yet consumed) - the caller owns disposing it.</returns>
    /// <exception cref="TranslationProviderException">Thrown when both the initial
    /// attempt and the retry fail, or the first attempt fails non-transiently.</exception>
    private async Task<HttpResponseMessage> SendWithOneRetryAsync(
        TranslationRequest request, string apiKey, CancellationToken cancellationToken)
    {
        const int maxAttempts = 2;
        for (var attempt = 1; attempt <= maxAttempts; attempt++)
        {
            using var httpRequest = BuildRequest(request, apiKey);
            HttpResponseMessage response;

            try
            {
                response = await httpClient.SendAsync(httpRequest, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
            }
            catch (HttpRequestException ex) when (attempt < maxAttempts)
            {
                logger.LogWarning(
                    ex, "Machine translation request failed to connect (attempt {Attempt}); retrying once.", attempt);
                await Task.Delay(RetryDelay, cancellationToken);
                continue;
            }
            catch (HttpRequestException ex)
            {
                throw new TranslationProviderException("Failed to connect to the machine translation provider.", ex);
            }
            catch (TaskCanceledException ex) when (!cancellationToken.IsCancellationRequested && attempt < maxAttempts)
            {
                logger.LogWarning(ex, "Machine translation request timed out (attempt {Attempt}); retrying once.", attempt);
                await Task.Delay(RetryDelay, cancellationToken);
                continue;
            }
            catch (TaskCanceledException ex) when (!cancellationToken.IsCancellationRequested)
            {
                throw new TranslationProviderException("Machine translation request timed out.", ex);
            }

            if (response.IsSuccessStatusCode)
            {
                return response;
            }

            var isTransient = response.StatusCode == HttpStatusCode.TooManyRequests || (int)response.StatusCode >= 500;
            if (isTransient && attempt < maxAttempts)
            {
                if (response.StatusCode == HttpStatusCode.TooManyRequests)
                {
                    logger.LogWarning("Machine translation request was rate-limited (429); retrying once.");
                }
                else
                {
                    logger.LogWarning(
                        "Machine translation request failed transiently ({StatusCode}); retrying once.",
                        (int)response.StatusCode);
                }

                response.Dispose();
                await Task.Delay(RetryDelay, cancellationToken);
                continue;
            }

            var statusCode = (int)response.StatusCode;
            response.Dispose();
            throw new TranslationProviderException($"Machine translation request failed with status {statusCode}.");
        }

        // Unreachable: every loop iteration either returns, throws, or retries, and
        // maxAttempts bounds the number of retries - kept only so the compiler sees
        // every path as returning or throwing.
        throw new TranslationProviderException("Machine translation request failed after retrying.");
    }

    private static HttpRequestMessage BuildRequest(TranslationRequest request, string apiKey)
    {
        var httpRequest = new HttpRequestMessage(HttpMethod.Post, "chat/completions")
        {
            Content = JsonContent.Create(BuildChatCompletionRequest(request), options: OpenAiJsonOptions),
        };
        httpRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
        return httpRequest;
    }

    private static OpenAiChatCompletionRequest BuildChatCompletionRequest(TranslationRequest request) => new(
        Model: Model,
        Stream: true,
        Messages:
        [
            new OpenAiChatMessage("system", BuildInstructions(request.SourceLang, request.TargetLang)),
            new OpenAiChatMessage("user", request.SourceText),
        ]);

    /// <summary>
    /// Interpreter-style system prompt that constrains the model to pure translation:
    /// no greetings, no commentary, no answering the message on its own behalf -
    /// mirroring <see cref="RealtimeInterpreterSession.Instructions"/>'s constraints for
    /// the realtime-mode interpreter persona, but parameterized by language pair since
    /// cascade sessions negotiate <c>sourceLang</c>/<c>targetLang</c> per session rather
    /// than hardcoding one.
    /// </summary>
    private static string BuildInstructions(string sourceLang, string targetLang) =>
        $"You are a machine translation engine translating from {sourceLang} to {targetLang}. " +
        "Translate the user's message into the target language only. Output only the " +
        "translation itself - no greetings, no commentary, no explanations, no quotation " +
        "marks, and never repeat, answer, or otherwise respond to the original text as if " +
        "it were addressed to you. Preserve the speaker's tone, meaning, and register as " +
        "closely as natural phrasing allows. If the message is empty or has nothing " +
        "translatable in it, output nothing.";

    /// <summary>
    /// Extracts the incremental token text from one OpenAI chat completion streaming
    /// chunk's <c>choices[0].delta.content</c>, or <c>null</c> if this chunk carries no
    /// text (e.g. the first chunk, which only announces the assistant role).
    /// </summary>
    /// <param name="json">One SSE frame's JSON payload, with the leading <c>"data: "</c>
    /// already stripped.</param>
    private static string? ParseDeltaToken(string json)
    {
        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;
        if (!root.TryGetProperty("choices", out var choices) || choices.ValueKind != JsonValueKind.Array || choices.GetArrayLength() == 0)
        {
            return null;
        }

        var firstChoice = choices[0];
        if (!firstChoice.TryGetProperty("delta", out var delta))
        {
            return null;
        }

        return delta.TryGetProperty("content", out var content) ? content.GetString() : null;
    }
}

// --- OpenAI wire-format DTOs (snake_case, per OpenAI's chat completions API) ---

internal sealed record OpenAiChatCompletionRequest(
    [property: JsonPropertyName("model")] string Model,
    [property: JsonPropertyName("stream")] bool Stream,
    [property: JsonPropertyName("messages")] IReadOnlyList<OpenAiChatMessage> Messages);

internal sealed record OpenAiChatMessage(
    [property: JsonPropertyName("role")] string Role,
    [property: JsonPropertyName("content")] string Content);
