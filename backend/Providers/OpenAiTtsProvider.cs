using System.IO;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Runtime.CompilerServices;
using System.Text.Json.Serialization;

/// <summary>
/// Synthesizes phrases of target-language text via OpenAI's <c>gpt-4o-mini-tts</c>
/// streaming text-to-speech (TTS) endpoint. Every OpenAI-specific detail (endpoint,
/// wire shapes, model name, chunked-response reading) lives in this one file, per the
/// same swappable-provider convention <see cref="OpenAiTranslationProvider"/> follows
/// for MT (machine translation).
/// </summary>
/// <remarks>
/// Registered as a typed <see cref="HttpClient"/> (see <c>Program.cs</c>), the same
/// pattern <see cref="OpenAiTranslationProvider"/> uses. Unlike that provider, which
/// parses SSE (Server-Sent Events) text frames, <c>/v1/audio/speech</c> with
/// <c>response_format: "pcm"</c> and <c>stream_format: "audio"</c> returns the raw
/// PCM (Pulse Code Modulation) bytes directly over a chunked HTTP response - so this
/// provider just reads the response body stream in fixed-size reads and yields each
/// one, rather than parsing any framing of its own. Tests substitute a fake
/// <see cref="HttpMessageHandler"/> that returns a canned chunked body instead of
/// faking a higher-level client interface, mirroring <see cref="OpenAiTranslationProvider"/>'s
/// own test seam.
/// </remarks>
public sealed class OpenAiTtsProvider(HttpClient httpClient, IConfiguration configuration, ILogger<OpenAiTtsProvider> logger)
    : ITtsProvider
{
    /// <summary>OpenAI TTS model used for cascade-mode speech synthesis. Chosen for its
    /// low-latency streaming support, which is what lets synthesis start on a phrase
    /// before the rest of the utterance has finished translating.</summary>
    public const string Model = "gpt-4o-mini-tts";

    /// <summary>Voice used when <see cref="TtsRequest.TargetLang"/> isn't in the language
    /// registry - should not happen in practice, since <see cref="CascadeAudioSession"/>
    /// validates the pair against the same registry before a session ever starts, but
    /// keeps this provider from throwing on an unrecognized language rather than simply
    /// picking a reasonable fallback voice.</summary>
    public const string DefaultVoice = "alloy";

    /// <summary>Size of each read from the response body stream, and therefore the
    /// approximate size of each <see cref="TtsAudioChunk"/> this provider yields.</summary>
    private const int ReadBufferBytes = 4096;

    /// <summary>
    /// One-retry-only backoff (#12, error handling hardening), mirroring
    /// <see cref="OpenAiTranslationProvider"/>'s own retry delay.
    /// </summary>
    private static readonly TimeSpan RetryDelay = TimeSpan.FromMilliseconds(500);

    /// <inheritdoc />
    /// <exception cref="TtsProviderException">Thrown when <c>OPENAI_API_KEY</c> is not
    /// configured, the request fails outright (network error or non-success status)
    /// even after one retry, or the response stream drops before it signals
    /// completion.</exception>
    public async IAsyncEnumerable<TtsAudioChunk> SynthesizeAsync(
        TtsRequest request, [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(request.Text))
        {
            // Nothing to synthesize - mirrors CascadePipeline only queueing non-blank
            // finalized segments for translation; an empty phrase is not worth a round
            // trip to the provider.
            yield break;
        }

        var apiKey = configuration["OPENAI_API_KEY"];
        if (string.IsNullOrWhiteSpace(apiKey))
        {
            throw new TtsProviderException("The server is not configured with an OpenAI API key.");
        }

        var response = await SendWithOneRetryAsync(request, apiKey, cancellationToken);

        using (response)
        {
            var body = await response.Content.ReadAsStreamAsync(cancellationToken);
            var buffer = new byte[ReadBufferBytes];

            while (true)
            {
                int bytesRead;
                try
                {
                    bytesRead = await body.ReadAsync(buffer, cancellationToken);
                }
                catch (IOException ex)
                {
                    throw new TtsProviderException("Text-to-speech connection dropped mid-stream.", ex);
                }

                if (bytesRead == 0)
                {
                    // The provider closed the response body normally - that is the end
                    // of this phrase's audio.
                    yield break;
                }

                // Sliced into a new array (rather than yielding a view over the shared
                // buffer) since the buffer is reused and overwritten on the next read.
                yield return new TtsAudioChunk(request.UtteranceId, buffer[..bytesRead]);
            }
        }
    }

    /// <summary>
    /// Sends the speech synthesis request, retrying exactly once (#12, error handling
    /// hardening) if the first attempt fails transiently: a connection failure, a
    /// request timeout, a 429 (rate limited), or any 5xx. A 4xx other than 429 (auth or
    /// validation - retrying would fail identically) throws immediately with no retry.
    /// The retry always builds a brand-new <see cref="HttpRequestMessage"/> - an
    /// <see cref="HttpRequestMessage"/> can only ever be sent once - so nothing from
    /// this method's caller has read any audio from the response body yet by the time a
    /// retry happens, meaning a retry here can never duplicate already-streamed audio.
    /// </summary>
    /// <param name="request">The phrase text, its utterance id, and target language.</param>
    /// <param name="apiKey">The bearer token to authenticate with.</param>
    /// <param name="cancellationToken">Propagates cancellation of either attempt.</param>
    /// <returns>The successful response, with headers already read (but the body not
    /// yet consumed) - the caller owns disposing it.</returns>
    /// <exception cref="TtsProviderException">Thrown when both the initial attempt and
    /// the retry fail, or the first attempt fails non-transiently.</exception>
    private async Task<HttpResponseMessage> SendWithOneRetryAsync(TtsRequest request, string apiKey, CancellationToken cancellationToken)
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
                    ex, "Text-to-speech request failed to connect (attempt {Attempt}); retrying once.", attempt);
                await Task.Delay(RetryDelay, cancellationToken);
                continue;
            }
            catch (HttpRequestException ex)
            {
                throw new TtsProviderException("Failed to connect to the text-to-speech provider.", ex);
            }
            catch (TaskCanceledException ex) when (!cancellationToken.IsCancellationRequested && attempt < maxAttempts)
            {
                logger.LogWarning(ex, "Text-to-speech request timed out (attempt {Attempt}); retrying once.", attempt);
                await Task.Delay(RetryDelay, cancellationToken);
                continue;
            }
            catch (TaskCanceledException ex) when (!cancellationToken.IsCancellationRequested)
            {
                throw new TtsProviderException("Text-to-speech request timed out.", ex);
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
                    logger.LogWarning("Text-to-speech request was rate-limited (429); retrying once.");
                }
                else
                {
                    logger.LogWarning(
                        "Text-to-speech request failed transiently ({StatusCode}); retrying once.", (int)response.StatusCode);
                }

                response.Dispose();
                await Task.Delay(RetryDelay, cancellationToken);
                continue;
            }

            var statusCode = (int)response.StatusCode;
            response.Dispose();
            throw new TtsProviderException($"Text-to-speech request failed with status {statusCode}.");
        }

        // Unreachable: every loop iteration either returns, throws, or retries, and
        // maxAttempts bounds the number of retries - kept only so the compiler sees
        // every path as returning or throwing.
        throw new TtsProviderException("Text-to-speech request failed after retrying.");
    }

    private static HttpRequestMessage BuildRequest(TtsRequest request, string apiKey)
    {
        var httpRequest = new HttpRequestMessage(HttpMethod.Post, "audio/speech")
        {
            Content = JsonContent.Create(BuildSpeechRequest(request)),
        };
        httpRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
        return httpRequest;
    }

    /// <summary>
    /// Picks the voice to synthesize with from the language registry's entry for
    /// <see cref="TtsRequest.TargetLang"/> (see <see cref="LanguageInfo.TtsVoice"/>) -
    /// this is the one place a language pair (#8) actually changes which voice speaks,
    /// since a cascade session's target language is fixed for its whole duration
    /// (unlike realtime mode's bidirectional single voice; see
    /// <see cref="RealtimeInterpreterSession.Voice"/>).
    /// </summary>
    private static string ResolveVoice(string targetLang) => Languages.Find(targetLang)?.TtsVoice ?? DefaultVoice;

    private static OpenAiSpeechRequest BuildSpeechRequest(TtsRequest request) => new(
        Model: Model,
        Input: request.Text,
        Voice: ResolveVoice(request.TargetLang),
        ResponseFormat: "pcm",
        StreamFormat: "audio");
}

// --- OpenAI wire-format DTOs (snake_case, per OpenAI's audio/speech API) ---

internal sealed record OpenAiSpeechRequest(
    [property: JsonPropertyName("model")] string Model,
    [property: JsonPropertyName("input")] string Input,
    [property: JsonPropertyName("voice")] string Voice,
    [property: JsonPropertyName("response_format")] string ResponseFormat,
    [property: JsonPropertyName("stream_format")] string StreamFormat);
