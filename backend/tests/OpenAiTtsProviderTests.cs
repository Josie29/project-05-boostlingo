using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

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
    /// Confirms the outgoing request names gpt-4o-mini-tts, the registry's voice for
    /// the request's target language, PCM (Pulse Code Modulation) streaming output, and
    /// carries the phrase text plus a bearer-authenticated header - the entire contract
    /// for "swapping the TTS provider only touches the provider class."
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
        Assert.Contains(Languages.Find("es")!.TtsVoice, request.Body);
        Assert.Contains("\"response_format\":\"pcm\"", request.Body);
        Assert.Contains("Hola mundo", request.Body);
    }

    /// <summary>
    /// Confirms the voice actually changes with the target language - not just that
    /// some voice is present - proving the language pair (#8) drives TTS voice choice
    /// via the registry rather than a single voice hardcoded regardless of direction.
    /// </summary>
    [Fact]
    public async Task SynthesizeAsync_DifferentTargetLang_SelectsDifferentVoice()
    {
        var handlerEs = new FakeChunkedAudioHttpMessageHandler([1]);
        var providerEs = CreateProvider(handlerEs, apiKey: "sk-test");
        await foreach (var _ in providerEs.SynthesizeAsync(new TtsRequest("utt-1", "Hola", "es"), CancellationToken.None))
        {
        }

        var handlerEn = new FakeChunkedAudioHttpMessageHandler([1]);
        var providerEn = CreateProvider(handlerEn, apiKey: "sk-test");
        await foreach (var _ in providerEn.SynthesizeAsync(new TtsRequest("utt-1", "Hello", "en"), CancellationToken.None))
        {
        }

        var esVoice = Languages.Find("es")!.TtsVoice;
        var enVoice = Languages.Find("en")!.TtsVoice;
        Assert.NotEqual(esVoice, enVoice);
        Assert.Contains(esVoice, Assert.Single(handlerEs.Requests).Body);
        Assert.Contains(enVoice, Assert.Single(handlerEn.Requests).Body);
    }

    /// <summary>
    /// Confirms an unrecognized target language (should never happen once
    /// CascadeAudioSession's registry validation is in place, but the provider guards
    /// against it independently) falls back to a default voice instead of throwing.
    /// </summary>
    [Fact]
    public async Task SynthesizeAsync_UnrecognizedTargetLang_FallsBackToDefaultVoice()
    {
        var handler = new FakeChunkedAudioHttpMessageHandler([1]);
        var provider = CreateProvider(handler, apiKey: "sk-test");

        await foreach (var _ in provider.SynthesizeAsync(new TtsRequest("utt-1", "Bonjour", "fr"), CancellationToken.None))
        {
        }

        Assert.Contains(OpenAiTtsProvider.DefaultVoice, Assert.Single(handler.Requests).Body);
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
    /// Confirms a non-success upstream response - even a transient one that gets one
    /// retry (#12) - surfaces as TtsProviderException once every attempt is exhausted,
    /// rather than an unhandled HTTP exception or silently yielding no audio. The
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

    /// <summary>
    /// Confirms a transient 5xx on the first attempt is retried exactly once (#12,
    /// error handling hardening) and succeeds on the second - the fake handler's call
    /// count is the only way to prove a retry actually happened, not just that the
    /// eventual result looks right.
    /// </summary>
    [Fact]
    public async Task SynthesizeAsync_TransientServerError_RetriesOnceThenSucceeds()
    {
        var handler = new FakeChunkedAudioHttpMessageHandler(
            (HttpStatusCode.InternalServerError, Array.Empty<byte>()), (HttpStatusCode.OK, new byte[] { 1, 2, 3 }));
        var provider = CreateProvider(handler, apiKey: "sk-test");

        var received = new List<byte>();
        await foreach (var chunk in provider.SynthesizeAsync(new TtsRequest("utt-1", "Hi", "es"), CancellationToken.None))
        {
            received.AddRange(chunk.Pcm.ToArray());
        }

        Assert.Equal(new byte[] { 1, 2, 3 }, received);
        Assert.Equal(2, handler.Requests.Count);
    }

    /// <summary>
    /// Confirms a 400 (validation/auth - not transient) throws immediately with no
    /// retry - retrying a request OpenAI has already rejected as invalid would fail
    /// identically the second time, just adding latency for no benefit.
    /// </summary>
    [Fact]
    public async Task SynthesizeAsync_ClientError_ThrowsWithoutRetrying()
    {
        var handler = new FakeChunkedAudioHttpMessageHandler((HttpStatusCode.BadRequest, Array.Empty<byte>()));
        var provider = CreateProvider(handler, apiKey: "sk-test");

        async Task ConsumeAsync()
        {
            await foreach (var _ in provider.SynthesizeAsync(new TtsRequest("utt-1", "Hi", "es"), CancellationToken.None))
            {
            }
        }

        await Assert.ThrowsAsync<TtsProviderException>(ConsumeAsync);
        Assert.Single(handler.Requests);
    }

    /// <summary>
    /// Confirms a request that never gets a response within the client's configured
    /// timeout surfaces as a clear TtsProviderException - the observer relies on this
    /// to turn a hung provider connection into a per-phrase error envelope instead of
    /// the session hanging forever.
    /// </summary>
    [Fact]
    public async Task SynthesizeAsync_RequestTimesOut_ThrowsTtsProviderException()
    {
        var handler = new DelayingHttpMessageHandler(TimeSpan.FromSeconds(5));
        var provider = CreateProvider(handler, apiKey: "sk-test", timeout: TimeSpan.FromMilliseconds(50));

        async Task ConsumeAsync()
        {
            await foreach (var _ in provider.SynthesizeAsync(new TtsRequest("utt-1", "Hi", "es"), CancellationToken.None))
            {
            }
        }

        await Assert.ThrowsAsync<TtsProviderException>(ConsumeAsync);
    }

    private static OpenAiTtsProvider CreateProvider(HttpMessageHandler handler, string? apiKey, TimeSpan? timeout = null)
    {
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["OPENAI_API_KEY"] = apiKey })
            .Build();
        var httpClient = new HttpClient(handler) { BaseAddress = new Uri("https://api.openai.com/v1/") };
        if (timeout is { } t)
        {
            httpClient.Timeout = t;
        }

        return new OpenAiTtsProvider(httpClient, configuration, NullLogger<OpenAiTtsProvider>.Instance);
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
    private readonly List<(HttpStatusCode StatusCode, byte[] Body)> _responses;

    public List<CapturedRequest> Requests { get; } = [];

    public FakeChunkedAudioHttpMessageHandler(byte[] responseBytes) : this([(HttpStatusCode.OK, responseBytes)])
    {
    }

    public FakeChunkedAudioHttpMessageHandler(HttpStatusCode statusCode) : this([(statusCode, [])])
    {
    }

    /// <summary>
    /// Scripts one response per call, in order (#12, error handling hardening's retry
    /// tests) - e.g. a transient failure followed by a success, to prove a retry
    /// actually happened rather than just that the final result looks right. If more
    /// calls arrive than responses were scripted, the last response repeats.
    /// </summary>
    public FakeChunkedAudioHttpMessageHandler(params (HttpStatusCode StatusCode, byte[] Body)[] responses) => _responses = [.. responses];

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var (statusCode, responseBytes) = _responses[Math.Min(Requests.Count, _responses.Count - 1)];

        // Captured eagerly here, not stored as the live HttpRequestMessage: the
        // provider disposes its request (and its content) once SynthesizeAsync's
        // enumerator finishes, before a test would otherwise get a chance to inspect it.
        var body = request.Content is null ? string.Empty : await request.Content.ReadAsStringAsync(cancellationToken);
        Requests.Add(new CapturedRequest(request.Headers.Authorization?.ToString(), body));

        return new HttpResponseMessage(statusCode)
        {
            Content = new StreamContent(new MemoryStream(responseBytes)),
        };
    }
}
