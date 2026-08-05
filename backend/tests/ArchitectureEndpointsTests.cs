using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;

namespace Boostlingo.Backend.Tests;

public class ArchitectureEndpointsTests
{
    /// <summary>
    /// Catches the architecture cards lying about what's running: the endpoint must
    /// report the providers' actual model constants, with the MT stage reflecting the
    /// default (openai) provider and anthropic offered as the swap alternative.
    /// </summary>
    [Fact]
    public async Task Get_ReturnsModelsPerStage_WithOpenAiMtByDefault()
    {
        using var factory = new WebApplicationFactory<Program>();
        using var client = factory.CreateClient();

        var body = await client.GetFromJsonAsync<JsonElement>(ArchitectureEndpoints.RoutePattern);

        Assert.Equal(RealtimeInterpreterSession.Model, body.GetProperty("realtime").GetProperty("model").GetString());
        var cascade = body.GetProperty("cascade");
        Assert.Equal(OpenAiSttProvider.Model, cascade.GetProperty("stt").GetProperty("model").GetString());
        Assert.Equal("openai", cascade.GetProperty("mt").GetProperty("provider").GetString());
        Assert.Equal(OpenAiTranslationProvider.Model, cascade.GetProperty("mt").GetProperty("model").GetString());
        Assert.Equal("anthropic", cascade.GetProperty("mtAlternative").GetProperty("provider").GetString());
        Assert.Equal(OpenAiTtsProvider.Model, cascade.GetProperty("tts").GetProperty("model").GetString());
    }

    /// <summary>
    /// Catches the provider-swap demo not showing up in the UI: with
    /// TRANSLATION_PROVIDER=anthropic the MT stage must flip to the Anthropic model
    /// and offer openai as the alternative.
    /// </summary>
    [Fact]
    public async Task Get_ReflectsAnthropicProvider_WhenConfigured()
    {
        using var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
            builder.UseSetting("TRANSLATION_PROVIDER", "anthropic"));
        using var client = factory.CreateClient();

        var mt = (await client.GetFromJsonAsync<JsonElement>(ArchitectureEndpoints.RoutePattern))
            .GetProperty("cascade").GetProperty("mt");

        Assert.Equal("anthropic", mt.GetProperty("provider").GetString());
        Assert.Equal(AnthropicTranslationProvider.DefaultModel, mt.GetProperty("model").GetString());
    }
}
