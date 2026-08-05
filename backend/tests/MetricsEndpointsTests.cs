using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;

namespace Boostlingo.Backend.Tests;

public class MetricsEndpointsTests : IDisposable
{
    private readonly string _dbPath =
        Path.Combine(Path.GetTempPath(), $"boostlingo-metrics-endpoint-tests-{Guid.NewGuid():N}.db");

    public void Dispose()
    {
        if (File.Exists(_dbPath))
        {
            File.Delete(_dbPath);
        }
    }

    /// <summary>Factory whose app writes metrics to this test's own temp database, never the dev one.</summary>
    private WebApplicationFactory<Program> CreateFactory() =>
        new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
            builder.UseSetting("METRICS_DB_PATH", _dbPath));

    private static readonly object SamplePayload = new
    {
        conversationId = "conv-http-1",
        sourceLang = "en",
        targetLang = "es",
        startedAtMs = 1_000L,
        endedAtMs = 61_000L,
        utterances = new object[]
        {
            new
            {
                utteranceId = "cascade:item_A",
                mode = "cascade",
                endToEndMs = 1800.0,
                stages = new object[] { new { stage = "sttFinal", ms = 400.0 } },
            },
            new
            {
                utteranceId = "realtime:item_B",
                mode = "realtime",
                endToEndMs = 900.0,
                stages = Array.Empty<object>(),
            },
        },
        transcript = new object[]
        {
            new { utteranceId = "cascade:item_A", lane = "source", text = "hello there", final = true },
        },
    };

    /// <summary>
    /// Catches the whole capture loop breaking end to end: a posted conversation (the
    /// exact JSON shape the frontend sends, lowercase mode/lane strings included) must
    /// come back from both query endpoints - listed with per-mode counts, and folded
    /// into per-group summary stats with modes serialized back as the same lowercase
    /// strings the frontend's types use.
    /// </summary>
    [Fact]
    public async Task PostedConversation_AppearsInListingAndSummary()
    {
        using var factory = CreateFactory();
        using var client = factory.CreateClient();

        var post = await client.PostAsJsonAsync(MetricsEndpoints.ConversationsRoute, SamplePayload);
        Assert.Equal(HttpStatusCode.NoContent, post.StatusCode);

        var listing = await client.GetFromJsonAsync<JsonElement>(MetricsEndpoints.ConversationsRoute);
        var conversation = Assert.Single(listing.GetProperty("conversations").EnumerateArray());
        Assert.Equal("conv-http-1", conversation.GetProperty("conversationId").GetString());
        Assert.Equal(1, conversation.GetProperty("cascadeUtteranceCount").GetInt32());
        Assert.Equal(1, conversation.GetProperty("realtimeUtteranceCount").GetInt32());

        var summary = await client.GetFromJsonAsync<JsonElement>(MetricsEndpoints.SummaryRoute);
        var groups = summary.GetProperty("groups").EnumerateArray().ToList();
        Assert.Equal(2, groups.Count);
        var modes = groups.Select(group => group.GetProperty("mode").GetString()).ToHashSet();
        Assert.Contains("realtime", modes);
        Assert.Contains("cascade", modes);

        var cascade = Assert.Single(groups, group => group.GetProperty("mode").GetString() == "cascade");
        Assert.Equal(1800, cascade.GetProperty("endToEnd").GetProperty("medianMs").GetDouble());
    }

    /// <summary>
    /// Catches a malformed report silently vanishing instead of being surfaced to the
    /// poster: identity-less or collection-less payloads must be rejected with the
    /// { error } body shape the frontend's error handling reads, not stored as
    /// unusable rows or crashed on server-side.
    /// </summary>
    [Theory]
    [InlineData("""{ "conversationId": "", "sourceLang": "en", "targetLang": "es", "startedAtMs": 0, "endedAtMs": 1, "utterances": [], "transcript": [] }""")]
    [InlineData("""{ "conversationId": "c1", "sourceLang": "", "targetLang": "es", "startedAtMs": 0, "endedAtMs": 1, "utterances": [], "transcript": [] }""")]
    [InlineData("""{ "conversationId": "c1", "sourceLang": "en", "targetLang": "es", "startedAtMs": 0, "endedAtMs": 1 }""")]
    public async Task InvalidReport_IsRejectedWithErrorBody(string payload)
    {
        using var factory = CreateFactory();
        using var client = factory.CreateClient();

        var response = await client.PostAsync(
            MetricsEndpoints.ConversationsRoute,
            new StringContent(payload, System.Text.Encoding.UTF8, "application/json"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.False(string.IsNullOrWhiteSpace(body.GetProperty("error").GetString()));
    }

    /// <summary>
    /// Catches the progress pane's whole loop breaking over the wire: pinning a
    /// baseline must mark the listing row and scope the summary; an unknown scope
    /// value must 400 rather than silently returning everything.
    /// </summary>
    [Fact]
    public async Task BaselinePin_MarksListing_AndScopesSummary()
    {
        using var factory = CreateFactory();
        using var client = factory.CreateClient();
        await client.PostAsJsonAsync(MetricsEndpoints.ConversationsRoute, SamplePayload);

        var pin = await client.PostAsJsonAsync(MetricsEndpoints.BaselineRoute, new { conversationIds = new[] { "conv-http-1" } });
        Assert.Equal(HttpStatusCode.NoContent, pin.StatusCode);

        var listing = await client.GetFromJsonAsync<JsonElement>(MetricsEndpoints.ConversationsRoute);
        Assert.True(Assert.Single(listing.GetProperty("conversations").EnumerateArray()).GetProperty("baseline").GetBoolean());

        var baseline = await client.GetFromJsonAsync<JsonElement>($"{MetricsEndpoints.SummaryRoute}?scope=baseline");
        Assert.Equal(2, baseline.GetProperty("groups").EnumerateArray().Count());
        var current = await client.GetFromJsonAsync<JsonElement>($"{MetricsEndpoints.SummaryRoute}?scope=current");
        Assert.Empty(current.GetProperty("groups").EnumerateArray());

        var invalid = await client.GetAsync($"{MetricsEndpoints.SummaryRoute}?scope=recent");
        Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
    }

    /// <summary>
    /// Catches a benchmark session recorded before any data exists rendering a broken
    /// dashboard: the query endpoints must return well-formed empty shapes, not errors,
    /// when nothing has been captured yet.
    /// </summary>
    [Fact]
    public async Task QueryEndpoints_ReturnEmptyShapesBeforeAnyCapture()
    {
        using var factory = CreateFactory();
        using var client = factory.CreateClient();

        var listing = await client.GetFromJsonAsync<JsonElement>(MetricsEndpoints.ConversationsRoute);
        Assert.Empty(listing.GetProperty("conversations").EnumerateArray());

        var summary = await client.GetFromJsonAsync<JsonElement>(MetricsEndpoints.SummaryRoute);
        Assert.Empty(summary.GetProperty("groups").EnumerateArray());
    }
}
