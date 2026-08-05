using System.Net;

/// <summary>
/// Shared send-with-one-retry policy for the request-per-utterance OpenAI HTTP
/// providers (<see cref="OpenAiTranslationProvider"/>, <see cref="OpenAiTtsProvider"/>).
/// Retries exactly once (#12, error handling hardening) if the first attempt fails
/// transiently: a connection failure, a request timeout, a 429 (rate limited), or any
/// 5xx. A 4xx other than 429 (auth or validation - retrying would fail identically)
/// throws immediately with no retry. This is policy shared across providers, not a
/// vendor wire shape, so factoring it out of the individual provider files doesn't
/// violate the everything-vendor-specific-lives-in-one-file convention.
/// </summary>
internal static class OpenAiHttpRetry
{
    /// <summary>
    /// One-retry-only backoff between the initial attempt and its single retry - short
    /// enough not to meaningfully add to end-to-end cascade latency, long enough to
    /// ride out a brief provider hiccup.
    /// </summary>
    private static readonly TimeSpan RetryDelay = TimeSpan.FromMilliseconds(500);

    /// <summary>
    /// Upper bound honored from a 429's <c>Retry-After</c> header. A rate-limit window
    /// longer than this isn't worth stalling a live interpretation session for - the
    /// retry proceeds after this cap and surfaces the failure if still limited.
    /// </summary>
    private static readonly TimeSpan MaxRetryAfter = TimeSpan.FromSeconds(2);

    /// <summary>
    /// Sends the request, retrying exactly once on a transient failure. The retry
    /// always builds a brand-new <see cref="HttpRequestMessage"/> via
    /// <paramref name="buildRequest"/> - an <see cref="HttpRequestMessage"/> can only
    /// ever be sent once - so nothing from this method's caller has read any part of
    /// the response body yet by the time a retry happens, meaning a retry here can
    /// never duplicate already-streamed tokens or audio.
    /// </summary>
    /// <param name="httpClient">The typed client to send with.</param>
    /// <param name="buildRequest">Builds a fresh request for each attempt.</param>
    /// <param name="stageName">Human-readable stage name used in log and exception
    /// messages, e.g. <c>"Machine translation"</c>.</param>
    /// <param name="wrapException">Wraps a failure message (and optional cause) in the
    /// calling provider's typed exception.</param>
    /// <param name="logger">Receives one warning per retried attempt.</param>
    /// <param name="cancellationToken">Propagates cancellation of either attempt.</param>
    /// <returns>The successful response, with headers already read (but the body not
    /// yet consumed) - the caller owns disposing it.</returns>
    /// <exception cref="Exception">The exception produced by
    /// <paramref name="wrapException"/> when both the initial attempt and the retry
    /// fail, or the first attempt fails non-transiently.</exception>
    public static async Task<HttpResponseMessage> SendWithOneRetryAsync(
        HttpClient httpClient,
        Func<HttpRequestMessage> buildRequest,
        string stageName,
        Func<string, Exception?, Exception> wrapException,
        ILogger logger,
        CancellationToken cancellationToken)
    {
        const int maxAttempts = 2;
        for (var attempt = 1; attempt <= maxAttempts; attempt++)
        {
            using var httpRequest = buildRequest();
            HttpResponseMessage response;

            try
            {
                response = await httpClient.SendAsync(httpRequest, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
            }
            catch (HttpRequestException ex) when (attempt < maxAttempts)
            {
                logger.LogWarning(
                    ex, "{Stage} request failed to connect (attempt {Attempt}); retrying once.", stageName, attempt);
                await Task.Delay(RetryDelay, cancellationToken);
                continue;
            }
            catch (HttpRequestException ex)
            {
                throw wrapException($"Failed to connect to the {stageName.ToLowerInvariant()} provider.", ex);
            }
            catch (TaskCanceledException ex) when (!cancellationToken.IsCancellationRequested && attempt < maxAttempts)
            {
                logger.LogWarning(ex, "{Stage} request timed out (attempt {Attempt}); retrying once.", stageName, attempt);
                await Task.Delay(RetryDelay, cancellationToken);
                continue;
            }
            catch (TaskCanceledException ex) when (!cancellationToken.IsCancellationRequested)
            {
                throw wrapException($"{stageName} request timed out.", ex);
            }

            if (response.IsSuccessStatusCode)
            {
                return response;
            }

            var isTransient = response.StatusCode == HttpStatusCode.TooManyRequests || (int)response.StatusCode >= 500;
            if (isTransient && attempt < maxAttempts)
            {
                TimeSpan delay;
                if (response.StatusCode == HttpStatusCode.TooManyRequests)
                {
                    delay = ResolveRateLimitDelay(response);
                    logger.LogWarning(
                        "{Stage} request was rate-limited (429); retrying once after {Delay}.", stageName, delay);
                }
                else
                {
                    delay = RetryDelay;
                    logger.LogWarning(
                        "{Stage} request failed transiently ({StatusCode}); retrying once.",
                        stageName, (int)response.StatusCode);
                }

                response.Dispose();
                await Task.Delay(delay, cancellationToken);
                continue;
            }

            var statusCode = (int)response.StatusCode;
            response.Dispose();
            throw wrapException($"{stageName} request failed with status {statusCode}.", null);
        }

        // Unreachable: every loop iteration either returns, throws, or retries, and
        // maxAttempts bounds the number of retries - kept only so the compiler sees
        // every path as returning or throwing.
        throw wrapException($"{stageName} request failed after retrying.", null);
    }

    /// <summary>
    /// Honors a 429's <c>Retry-After</c> header (either delta-seconds or an absolute
    /// date), capped at <see cref="MaxRetryAfter"/>; falls back to
    /// <see cref="RetryDelay"/> when the header is absent, malformed, or in the past.
    /// </summary>
    private static TimeSpan ResolveRateLimitDelay(HttpResponseMessage response)
    {
        var retryAfter = response.Headers.RetryAfter;
        var delay = retryAfter?.Delta
            ?? (retryAfter?.Date is { } date ? date - DateTimeOffset.UtcNow : null);
        if (delay is not { } suggested || suggested <= TimeSpan.Zero)
        {
            return RetryDelay;
        }

        // Clamped so a long rate-limit window can't stall a live session.
        return suggested < MaxRetryAfter ? suggested : MaxRetryAfter;
    }
}
