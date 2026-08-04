using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace Boostlingo.Backend.Tests;

public class RealtimeSessionTests
{
    /// <summary>
    /// Confirms the frontend gets exactly the fields it needs to open a WebRTC
    /// connection to OpenAI (ephemeral secret, expiry, model) when the upstream
    /// call succeeds - not OpenAI's raw payload or any other internal detail.
    /// </summary>
    [Fact]
    public async Task CreateSession_ReturnsClientSecretShape_WhenUpstreamSucceeds()
    {
        using var factory = new RealtimeTestFactory(
            new FakeRealtimeSessionClient(() => new RealtimeClientSecret("ek_test_123", 1234567890)));
        using var client = factory.CreateClient();

        var response = await client.PostAsync(RealtimeSessionEndpoints.RoutePattern, content: null);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<RealtimeSessionResponse>();
        Assert.NotNull(body);
        Assert.Equal("ek_test_123", body!.ClientSecret);
        Assert.Equal(1234567890, body.ExpiresAt);
        Assert.Equal(RealtimeInterpreterSession.Model, body.Model);
    }

    /// <summary>
    /// Confirms a missing OPENAI_API_KEY fails loudly with 503 instead of the
    /// endpoint calling OpenAI with an empty key or crashing with a 500.
    /// </summary>
    [Fact]
    public async Task CreateSession_Returns503_WhenApiKeyMissing()
    {
        using var factory = new RealtimeTestFactory(
            new FakeRealtimeSessionClient(() => throw new InvalidOperationException("Must not call OpenAI without a key.")),
            apiKey: null);
        using var client = factory.CreateClient();

        var response = await client.PostAsync(RealtimeSessionEndpoints.RoutePattern, content: null);

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<RealtimeSessionErrorResponse>();
        Assert.NotNull(body);
        Assert.False(string.IsNullOrWhiteSpace(body!.Error));
    }

    /// <summary>
    /// Confirms an upstream OpenAI failure maps to a generic 502 rather than a raw
    /// 500, and that the response body doesn't leak the upstream status/detail.
    /// </summary>
    [Fact]
    public async Task CreateSession_Returns502_WhenUpstreamFails()
    {
        using var factory = new RealtimeTestFactory(
            new FakeRealtimeSessionClient(() => throw new RealtimeUpstreamException(HttpStatusCode.Unauthorized)));
        using var client = factory.CreateClient();

        var response = await client.PostAsync(RealtimeSessionEndpoints.RoutePattern, content: null);

        Assert.Equal(HttpStatusCode.BadGateway, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<RealtimeSessionErrorResponse>();
        Assert.NotNull(body);
        Assert.DoesNotContain("Unauthorized", body!.Error, StringComparison.OrdinalIgnoreCase);
    }
}

/// <summary>Stubs <see cref="IRealtimeSessionClient"/> so tests never hit the network.</summary>
file sealed class FakeRealtimeSessionClient(Func<RealtimeClientSecret> respond) : IRealtimeSessionClient
{
    public Task<RealtimeClientSecret> CreateClientSecretAsync(CancellationToken cancellationToken) =>
        Task.FromResult(respond());
}

/// <summary>
/// A <see cref="WebApplicationFactory{TEntryPoint}"/> that swaps the real OpenAI
/// client for a fake and pins <c>OPENAI_API_KEY</c> to a deterministic value,
/// regardless of what's set in the ambient environment running the tests.
/// </summary>
file sealed class RealtimeTestFactory(IRealtimeSessionClient fakeClient, string? apiKey = "sk-test-key")
    : WebApplicationFactory<Program>
{
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.ConfigureAppConfiguration((_, config) =>
        {
            config.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["OPENAI_API_KEY"] = apiKey,
            });
        });

        builder.ConfigureServices(services =>
        {
            services.AddSingleton(fakeClient);
        });
    }
}
