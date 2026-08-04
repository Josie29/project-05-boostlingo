using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Configuration;

namespace Boostlingo.Backend.Tests;

public class OpenAiTtsProviderTests
{
    /// <summary>
    /// Confirms a missing OPENAI_API_KEY fails loudly with a clear, catchable
    /// exception before ever touching the network - this is what TtsCascadeObserver
    /// turns into the per-phrase error envelope.
    /// </summary>
    [Fact]
    public async Task SynthesizeAsync_MissingApiKey_ThrowsWithoutConnecting()
    {
        var handler = new FakeChunkedAudioHttpMessageHandler([1, 2, 3]);
        var provider = CreateProvider(handler, apiKey: null);

        async Task ConsumeAsync()
        {
            await foreach (var _ in provider.SynthesizeAsync(new TtsRequest("utt-1", "Hola", "es"), CancellationToken.None))
            {
            }
        }

        var ex = await Assert.ThrowsAsync<TtsProviderException>(ConsumeAsync);
        Assert.Contains("API key", ex.Message);
        Assert.Empty(handler.Requests);
    }

    /// <summary>
    /// Confirms an empty/blank phrase never reaches the network at all - synthesizing
    /// nothing would just be a wasted round trip, and TtsCascadeObserver never emits
    /// a phrase like this in the first place (SentenceChunker only ever reports
    /// non-empty text), but the provider guards against it defensively too.
    /// </summary>
    [Fact]
    public async Task SynthesizeAsync_BlankText_YieldsNothing_WithoutConnecting()
    {
        var handler = new FakeChunkedAudioHttpMessageHandler([1, 2, 3]);
        var provider = CreateProvider(handler, apiKey: "sk-test");

        var chunks = new List<TtsAudioChunk>();
        await foreach (var chunk in provider.SynthesizeAsync(new TtsRequest("utt-1", "   ", "es"), CancellationToken.None))
        {
            chunks.Add(chunk);
        }

        Assert.Empty(chunks);
        Assert.Empty(handler.Requests);
    }

    /// <summary>
    /// Confirms the outgoing request names gpt-4o-mini-tts, a fixed voice, PCM
    /// (Pulse Code Modulation) streaming output, and carries the phrase text plus a
    /// bearer-authenticated header - the entire contract for "swapping the TTS
    /// provider only touches the provider class."
    /// </summary>
    [Fact]
    public async Task SynthesizeAsync_SendsSpeechRequest_WithModelVoiceAndFormat()
    {
        var handler = new FakeChunkedAudioHttpMessageHandler([1, 2, 3]);
        var provider = CreateProvider(handler, apiKey: "sk-test");

        await foreach (var _ in provider.SynthesizeAsync(new TtsRequest("utt-1", "Hola mundo", "es"), CancellationToken.None))
        {
        }

        var request = Assert.Single(handler.Requests);
        Assert.Equal("Bearer sk-test", request.Authorization);
        Assert.Contains(OpenAiTtsProvider.Model, request.Body);
        Assert.Contains(OpenAiTtsProvider.Voice, request.Body);
        Assert.Contains("\"response_format\":\"pcm\"", request.Body);
        Assert.Contains("Hola mundo", request.Body);
    }

    /// <summary>
    /// Confirms a chunked audio response is read back as multiple TtsAudioChunk
    /// values, each stamped with the request's utterance id and concatenating back to
    /// the exact bytes the provider sent - this is the only place that ever has to
    /// understand OpenAI's chunked PCM response shape.
    /// </summary>
    [Fact]
    public async Task SynthesizeAsync_ReadsChunkedAudio_StampedWithUtteranceId()
    {
        var handler = new FakeChunkedAudioHttpMessageHandler([1, 2, 3, 4, 5]);
        var provider = CreateProvider(handler, apiKey: "sk-test");

        var received = new List<byte>();
        await foreach (var chunk in provider.SynthesizeAsync(new TtsRequest("utt-42", "Hi", "es"), CancellationToken.None))
        {
            Assert.Equal("utt-42", chunk.UtteranceId);
            received.AddRange(chunk.Pcm.ToArray());
        }

        Assert.Equal(new byte[] { 1, 2, 3, 4, 5 }, received);
    }

    /// <summary>
    /// Confirms a non-success upstream response surfaces as TtsProviderException
    /// rather than an unhandled HTTP exception or silently yielding no audio - the
    /// observer relies on this to turn upstream failures into a per-phrase error
    /// envelope without killing the session.
    /// </summary>
    [Fact]
    public async Task SynthesizeAsync_NonSuccessStatus_ThrowsTtsProviderException()
    {
        var handler = new FakeChunkedAudioHttpMessageHandler(HttpStatusCode.TooManyRequests);
        var provider = CreateProvider(handler, apiKey: "sk-test");

        async Task ConsumeAsync()
        {
            await foreach (var _ in provider.SynthesizeAsync(new TtsRequest("utt-1", "Hi", "es"), CancellationToken.None))
            {
            }
        }

        await Assert.ThrowsAsync<TtsProviderException>(ConsumeAsync);
    }

    private static OpenAiTtsProvider CreateProvider(HttpMessageHandler handler, string? apiKey)
    {
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["OPENAI_API_KEY"] = apiKey })
            .Build();
        var httpClient = new HttpClient(handler) { BaseAddress = new Uri("https://api.openai.com/v1/") };
        return new OpenAiTtsProvider(httpClient, configuration);
    }
}

/// <summary>A snapshot of one request the fake handler received, captured before <see cref="OpenAiTtsProvider"/> disposes its <see cref="HttpRequestMessage"/>.</summary>
/// <param name="Authorization">The raw <c>Authorization</c> header value, or <c>null</c> if none was set.</param>
/// <param name="Body">The request body, read eagerly since the original content is disposed once the caller's <c>using var httpRequest</c> goes out of scope.</param>
file sealed record CapturedRequest(string? Authorization, string Body);

/// <summary>
/// A fake OpenAI <c>/v1/audio/speech</c> endpoint: records every request it receives
/// and returns a canned chunked binary body (or an error status), so
/// <see cref="OpenAiTtsProvider"/>'s request building and streamed-read logic can be
/// exercised with no real network connection - mirroring <c>FakeSseHttpMessageHandler</c>
/// in <c>OpenAiTranslationProviderTests</c>, one level lower than the typed-client
/// fakes used elsewhere since this provider needs the raw response stream.
/// </summary>
file sealed class FakeChunkedAudioHttpMessageHandler : HttpMessageHandler
{
    private readonly HttpStatusCode _statusCode;
    private readonly byte[] _responseBytes;

    public List<CapturedRequest> Requests { get; } = [];

    public FakeChunkedAudioHttpMessageHandler(byte[] responseBytes)
    {
        _statusCode = HttpStatusCode.OK;
        _responseBytes = responseBytes;
    }

    public FakeChunkedAudioHttpMessageHandler(HttpStatusCode statusCode)
    {
        _statusCode = statusCode;
        _responseBytes = [];
    }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        // Captured eagerly here, not stored as the live HttpRequestMessage: the
        // provider disposes its request (and its content) once SynthesizeAsync's
        // enumerator finishes, before a test would otherwise get a chance to inspect it.
        var body = request.Content is null ? string.Empty : await request.Content.ReadAsStringAsync(cancellationToken);
        Requests.Add(new CapturedRequest(request.Headers.Authorization?.ToString(), body));

        return new HttpResponseMessage(_statusCode)
        {
            Content = new StreamContent(new MemoryStream(_responseBytes)),
        };
    }
}
