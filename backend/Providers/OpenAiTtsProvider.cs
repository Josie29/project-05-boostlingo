using System.IO;
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
    : ITtsProvider, IProviderWarmup
{
    /// <summary>OpenAI TTS model used for cascade-mode speech synthesis. Chosen for its
    /// low-latency streaming support, which is what lets synthesis start on a phrase
    /// before the rest of the utterance has finished translating.</summary>
    public const string Model = "gpt-4o-mini-tts";

    /// <summary>Voice used when <see cref="TtsRequest.TargetLang"/> isn't in the language
    /// registry - should not happen in practice, since <see cref="CascadeSession"/>
    /// validates the pair against the same registry before a session ever starts, but
    /// keeps this provider from throwing on an unrecognized language rather than simply
    /// picking a reasonable fallback voice.</summary>
    public const string DefaultVoice = "alloy";

    /// <summary>Size of each read from the response body stream, and therefore the
    /// approximate size of each <see cref="TtsAudioChunk"/> this provider yields.</summary>
    private const int ReadBufferBytes = 4096;

    /// <inheritdoc />
    /// <remarks>OpenAI's TTS models natively emit 24 kHz PCM; declaring that here
    /// (rather than resampling server-side to some shared rate) keeps synthesis
    /// latency down and lets the frontend playback queue do the one resample.</remarks>
    public TtsOutputFormat OutputFormat => TtsOutputFormat.Pcm16Mono24k;

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

        var response = await ProviderHttpRetry.SendWithOneRetryAsync(
            httpClient,
            () => BuildRequest(request, apiKey),
            stageName: "Text-to-speech",
            wrapException: static (message, inner) => inner is null
                ? new TtsProviderException(message)
                : new TtsProviderException(message, inner),
            logger,
            cancellationToken);

        using (response)
        {
            var body = await response.Content.ReadAsStreamAsync(cancellationToken);
            var buffer = new byte[ReadBufferBytes];
            // True when buffer[0] holds the first byte of a sample torn by the previous
            // read - carried so every yielded chunk is whole int16 samples (see
            // TtsAudioChunk.Pcm; an odd chunk plays as static client-side).
            var hasCarry = false;

            while (true)
            {
                var offset = hasCarry ? 1 : 0;
                int bytesRead;
                try
                {
                    bytesRead = await body.ReadAsync(buffer.AsMemory(offset), cancellationToken);
                }
                catch (Exception ex) when (ex is IOException
                    || (ex is OperationCanceledException && !cancellationToken.IsCancellationRequested))
                {
                    // The OperationCanceledException arm covers HttpClient.Timeout
                    // expiring mid-body (it still governs reads after
                    // ResponseHeadersRead) - the caller's own token isn't cancelled,
                    // so this is a provider failure, not caller cancellation.
                    throw new TtsProviderException("Text-to-speech connection dropped mid-stream.", ex);
                }

                if (bytesRead == 0)
                {
                    // The provider closed the response body normally - that is the end
                    // of this phrase's audio.
                    if (hasCarry)
                    {
                        logger.LogDebug(
                            "Text-to-speech stream for utterance {UtteranceId} ended mid-sample; dropping the dangling byte.",
                            request.UtteranceId);
                    }

                    yield break;
                }

                var total = offset + bytesRead;
                hasCarry = total % 2 == 1;
                if (hasCarry)
                {
                    total -= 1;
                }

                // Sliced into a new array (rather than yielding a view over the shared
                // buffer) since the buffer is reused and overwritten on the next read.
                var chunk = buffer[..total];
                if (hasCarry)
                {
                    buffer[0] = buffer[total];
                }

                if (total > 0)
                {
                    yield return new TtsAudioChunk(request.UtteranceId, chunk);
                }
            }
        }
    }

    /// <inheritdoc />
    /// <remarks>
    /// Warms this provider's own pool, not a shared one: <c>AddHttpClient</c> gives every
    /// typed client its own message handler, so the connection
    /// <see cref="OpenAiTranslationProvider.WarmUpAsync"/> opens to the same host is
    /// invisible here. Uses <c>GET /v1/models</c> for the same reason that provider does -
    /// authenticated, no inference, no tokens.
    /// </remarks>
    public Task WarmUpAsync(CancellationToken cancellationToken)
    {
        var apiKey = configuration["OPENAI_API_KEY"];
        if (string.IsNullOrWhiteSpace(apiKey))
        {
            return Task.CompletedTask;
        }

        return ProviderConnectionWarmup.SendAsync(
            httpClient, () => BuildWarmUpRequest(apiKey), stageName: "Text-to-speech", logger, cancellationToken);
    }

    private static HttpRequestMessage BuildWarmUpRequest(string apiKey)
    {
        var httpRequest = new HttpRequestMessage(HttpMethod.Get, "models");
        httpRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
        return httpRequest;
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
