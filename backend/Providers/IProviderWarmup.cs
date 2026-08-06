/// <summary>
/// Optional capability a provider (or a stage that owns one) can implement to open its
/// connection to the vendor ahead of the first real request. Cascade's MT and TTS
/// stages both talk to their providers over one-request-per-utterance HTTPS, so the
/// first utterance of a session otherwise pays DNS + TCP + TLS on top of the provider's
/// own latency - directly inside the <c>sttFinal - mtFirstToken</c> and
/// <c>mtFinal - ttsFirstByte</c> spans the latency panel reports.
/// <see cref="CascadePipeline.OnSessionStartedAsync"/> fires every implementer it can
/// reach while the STT stream's own WebSocket handshake is still in flight, so the
/// warm-up costs no wall-clock time of its own.
/// </summary>
/// <remarks>
/// An optional interface discovered with an <c>is</c> check, deliberately not a member
/// of <see cref="ITranslationProvider"/>/<see cref="ITtsProvider"/>: a provider that
/// holds no poolable connection (or a test fake) has nothing to warm and shouldn't be
/// made to say so. Same pattern <see cref="ICascadeBargeInObserver"/> and
/// <see cref="IAsyncDisposable"/> already use to let a stage opt into a pipeline hook.
/// </remarks>
public interface IProviderWarmup
{
    /// <summary>
    /// Opens (and leaves pooled) a connection to the provider. Never throws: a failed
    /// warm-up is not a session failure, it just means the first real request pays
    /// connection setup as it did before. Implementations should return promptly and
    /// must not consume paid quota - a cheap authenticated GET, not a real inference
    /// request.
    /// </summary>
    /// <param name="cancellationToken">Propagates session cancellation.</param>
    Task WarmUpAsync(CancellationToken cancellationToken);
}

/// <summary>
/// Shared warm-up send used by the request-per-utterance HTTP providers, the same way
/// <see cref="ProviderHttpRetry"/> shares their retry policy: how a warm-up behaves
/// (never throw, never retry, ignore the status code) is cross-provider policy, while
/// which endpoint is cheap enough to warm with stays in each vendor's own file.
/// </summary>
internal static class ProviderConnectionWarmup
{
    /// <summary>
    /// Sends one warm-up request and discards the result. Any outcome other than a
    /// completed TLS handshake is irrelevant here - even a 401 leaves exactly the pooled
    /// connection this exists to establish - so the status code is never checked and
    /// every failure is swallowed at Debug.
    /// </summary>
    /// <param name="httpClient">The typed client whose connection pool to warm.</param>
    /// <param name="buildRequest">Builds the warm-up request, including auth headers.</param>
    /// <param name="stageName">Human-readable stage name for the log line, e.g. <c>"Machine translation"</c>.</param>
    /// <param name="logger">Receives the Debug-level outcome.</param>
    /// <param name="cancellationToken">Propagates session cancellation.</param>
    public static async Task SendAsync(
        HttpClient httpClient,
        Func<HttpRequestMessage> buildRequest,
        string stageName,
        ILogger logger,
        CancellationToken cancellationToken)
    {
        try
        {
            using var request = buildRequest();
            using var response = await httpClient.SendAsync(
                request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
            logger.LogDebug(
                "{Stage} connection warmed (status {StatusCode}).", stageName, (int)response.StatusCode);
        }
        catch (Exception ex)
        {
            // Includes cancellation: a session ending before the warm-up lands is a
            // non-event, not something to surface.
            logger.LogDebug(
                ex, "{Stage} connection warm-up did not complete; the first request will pay connection setup.", stageName);
        }
    }
}
