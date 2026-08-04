using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Mvc.Testing;

namespace Boostlingo.Backend.Tests;

public class LanguageEndpointsTests
{
    /// <summary>
    /// Confirms GET /api/languages returns every registered language as {code,
    /// displayName} - the exact shape the frontend selector (#8) renders its options
    /// from instead of hardcoding a language list of its own.
    /// </summary>
    [Fact]
    public async Task GetLanguages_ReturnsEveryRegisteredLanguage()
    {
        using var factory = new WebApplicationFactory<Program>();
        using var client = factory.CreateClient();

        var response = await client.GetAsync(LanguageEndpoints.RoutePattern);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<LanguagesResponse>();
        Assert.NotNull(body);
        Assert.Equal(Languages.Supported.Count, body!.Languages.Count);
        Assert.Contains(body.Languages, language => language.Code == "en" && language.DisplayName == "English");
        Assert.Contains(body.Languages, language => language.Code == "es" && language.DisplayName == "Spanish");
    }
}
