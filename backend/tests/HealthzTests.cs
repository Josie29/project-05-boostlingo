using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Mvc.Testing;

namespace Boostlingo.Backend.Tests;

public class HealthzTests
{
    /// <summary>
    /// Confirms the health endpoint the frontend/proxy and any deploy platform
    /// health check rely on actually returns 200 with the expected status payload.
    /// </summary>
    [Fact]
    public async Task Healthz_ReturnsOkWithStatusPayload()
    {
        using var factory = new WebApplicationFactory<Program>();
        using var client = factory.CreateClient();

        var response = await client.GetAsync("/healthz");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<HealthResponse>();
        Assert.NotNull(body);
        Assert.Equal("ok", body!.Status);
    }
}
