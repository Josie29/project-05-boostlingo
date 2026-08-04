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
public sealed class OpenAiTtsProvider(HttpClient httpClient, IConfiguration configuration) : ITtsProvider
{
    /// <summary>OpenAI TTS model used for cascade-mode speech synthesis. Chosen for its
    /// low-latency streaming support, which is what lets synthesis start on a phrase
    /// before the rest of the utterance has finished translating.</summary>
    public const string Model = "gpt-4o-mini-tts";

    /// <summary>Fixed voice for every cascade session. Not yet configurable per session -
    /// language pair selection (#8) may revisit this, but nothing in this issue's scope
    /// calls for per-user voice choice.</summary>
    public const string Voice = "alloy";

    /// <summary>Size of each read from the response body stream, and therefore the
    /// approximate size of each <see cref="TtsAudioChunk"/> this provider yields.</summary>
    private const int ReadBufferBytes = 4096;

    /// <inheritdoc />
    /// <exception cref="TtsProviderException">Thrown when <c>OPENAI_API_KEY</c> is not
    /// configured, the request fails outright (network error or non-success status),
    /// or the response stream drops before it signals completion.</exception>
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

        using var httpRequest = BuildRequest(request, apiKey);

        HttpResponseMessage response;
        try
        {
            response = await httpClient.SendAsync(httpRequest, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        }
        catch (HttpRequestException ex)
        {
            throw new TtsProviderException("Failed to connect to the text-to-speech provider.", ex);
        }

        using (response)
        {
            if (!response.IsSuccessStatusCode)
            {
                throw new TtsProviderException(
                    $"Text-to-speech request failed with status {(int)response.StatusCode}.");
            }

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

    private static HttpRequestMessage BuildRequest(TtsRequest request, string apiKey)
    {
        var httpRequest = new HttpRequestMessage(HttpMethod.Post, "audio/speech")
        {
            Content = JsonContent.Create(BuildSpeechRequest(request)),
        };
        httpRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
        return httpRequest;
    }

    private static OpenAiSpeechRequest BuildSpeechRequest(TtsRequest request) => new(
        Model: Model,
        Input: request.Text,
        Voice: Voice,
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
