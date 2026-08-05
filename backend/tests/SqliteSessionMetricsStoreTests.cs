namespace Boostlingo.Backend.Tests;

public class SqliteSessionMetricsStoreTests : IDisposable
{
    private readonly string _dbPath =
        Path.Combine(Path.GetTempPath(), $"boostlingo-metrics-tests-{Guid.NewGuid():N}.db");

    public void Dispose()
    {
        if (File.Exists(_dbPath))
        {
            File.Delete(_dbPath);
        }
    }

    private static ConversationMetricsReport SampleReport(string conversationId = "conv-1") => new(
        ConversationId: conversationId,
        SourceLang: "en",
        TargetLang: "es",
        StartedAtMs: 1_000,
        EndedAtMs: 61_000,
        Utterances:
        [
            new UtteranceMetricsRecord(
                "cascade:item_A", InterpreterMode.Cascade, EndToEndMs: 1800,
                Stages: [new StageTimingRecord("sttFinal", 400), new StageTimingRecord("mtFirstToken", 250)]),
            new UtteranceMetricsRecord(
                "realtime:item_B", InterpreterMode.Realtime, EndToEndMs: 900, Stages: []),
        ],
        Transcript:
        [
            new TranscriptEntryRecord("cascade:item_A", TranscriptLane.Source, "hello there", Final: true),
            new TranscriptEntryRecord("cascade:item_A-target", TranscriptLane.Target, "hola", Final: true, Truncated: true),
        ]);

    /// <summary>
    /// Catches the bug where a benchmark session recorded in the app never shows up
    /// afterwards: a saved conversation must be listed back with its language pair, the
    /// server-stamped MT provider, and per-mode utterance counts intact.
    /// </summary>
    [Fact]
    public async Task SavedConversation_IsListedWithProviderAndPerModeCounts()
    {
        var store = new SqliteSessionMetricsStore(_dbPath);
        await store.SaveConversationAsync(SampleReport(), "openai", CancellationToken.None);

        var listings = await store.ListConversationsAsync(CancellationToken.None);

        var listing = Assert.Single(listings);
        Assert.Equal("conv-1", listing.ConversationId);
        Assert.Equal("en", listing.SourceLang);
        Assert.Equal("es", listing.TargetLang);
        Assert.Equal("openai", listing.TranslationProvider);
        Assert.Equal(1, listing.CascadeUtteranceCount);
        Assert.Equal(1, listing.RealtimeUtteranceCount);
    }

    /// <summary>
    /// Catches double-counted benchmark numbers after a double Stop press or a client
    /// retry: re-saving the same conversation id must replace the stored report
    /// wholesale, not append a second copy of every utterance to the averages.
    /// </summary>
    [Fact]
    public async Task ResavingSameConversation_ReplacesInsteadOfDuplicating()
    {
        var store = new SqliteSessionMetricsStore(_dbPath);
        await store.SaveConversationAsync(SampleReport(), "openai", CancellationToken.None);

        var updated = SampleReport() with
        {
            Utterances =
            [
                new UtteranceMetricsRecord(
                    "cascade:item_A", InterpreterMode.Cascade, EndToEndMs: 2000,
                    Stages: [new StageTimingRecord("sttFinal", 500)]),
            ],
        };
        await store.SaveConversationAsync(updated, "openai", CancellationToken.None);

        var listing = Assert.Single(await store.ListConversationsAsync(CancellationToken.None));
        Assert.Equal(1, listing.CascadeUtteranceCount);
        Assert.Equal(0, listing.RealtimeUtteranceCount);

        var summary = await store.GetSummaryAsync(CancellationToken.None);
        var cascade = Assert.Single(summary.Groups, group => group.Mode == InterpreterMode.Cascade);
        Assert.Equal(1, cascade.UtteranceCount);
        Assert.Equal(2000, cascade.EndToEnd!.MedianMs);
    }

    /// <summary>
    /// Catches the comparison table mixing populations that must stay separate: cascade
    /// utterances group per MT provider (the provider-swap benchmark's whole point),
    /// while realtime utterances - which never touch the MT provider - collapse into
    /// one group regardless of which provider was configured when they were saved.
    /// </summary>
    [Fact]
    public async Task Summary_GroupsCascadeByProvider_AndCollapsesRealtime()
    {
        var store = new SqliteSessionMetricsStore(_dbPath);
        await store.SaveConversationAsync(SampleReport("conv-openai"), "openai", CancellationToken.None);
        await store.SaveConversationAsync(SampleReport("conv-anthropic"), "anthropic", CancellationToken.None);

        var summary = await store.GetSummaryAsync(CancellationToken.None);

        var groupKeys = summary.Groups.Select(group => (group.Mode, group.TranslationProvider)).ToHashSet();
        Assert.Equal(3, summary.Groups.Count);
        Assert.Contains((InterpreterMode.Realtime, (string?)null), groupKeys);
        Assert.Contains((InterpreterMode.Cascade, "anthropic"), groupKeys);
        Assert.Contains((InterpreterMode.Cascade, "openai"), groupKeys);

        var realtime = Assert.Single(summary.Groups, group => group.Mode == InterpreterMode.Realtime);
        Assert.Equal(2, realtime.UtteranceCount);
    }

    /// <summary>
    /// Catches wrong latency figures landing in docs/benchmarks.md: median must
    /// interpolate the middle pair on an even count, p95 must be the nearest-rank
    /// observed value, and per-stage stats must aggregate across conversations.
    /// </summary>
    [Fact]
    public async Task Summary_ComputesMedianAndP95FromStoredDurations()
    {
        var store = new SqliteSessionMetricsStore(_dbPath);

        // Four cascade utterances with end-to-end 1000/2000/3000/4000 and one sttFinal
        // stage each: median interpolates to 2500; nearest-rank p95 of 4 samples is the
        // 4th value, 4000.
        for (var i = 1; i <= 4; i++)
        {
            var report = new ConversationMetricsReport(
                ConversationId: $"conv-{i}",
                SourceLang: "en",
                TargetLang: "es",
                StartedAtMs: i * 1000,
                EndedAtMs: i * 1000 + 500,
                Utterances:
                [
                    new UtteranceMetricsRecord(
                        $"cascade:item_{i}", InterpreterMode.Cascade, EndToEndMs: i * 1000,
                        Stages: [new StageTimingRecord("sttFinal", i * 100)]),
                ],
                Transcript: []);
            await store.SaveConversationAsync(report, "openai", CancellationToken.None);
        }

        var summary = await store.GetSummaryAsync(CancellationToken.None);

        var cascade = Assert.Single(summary.Groups);
        Assert.Equal(4, cascade.ConversationCount);
        Assert.Equal(2500, cascade.EndToEnd!.MedianMs);
        Assert.Equal(4000, cascade.EndToEnd.P95Ms);

        var sttFinal = Assert.Single(cascade.Stages);
        Assert.Equal("sttFinal", sttFinal.Stage);
        Assert.Equal(4, sttFinal.Stats.Count);
        Assert.Equal(250, sttFinal.Stats.MedianMs);
        Assert.Equal(400, sttFinal.Stats.P95Ms);
    }

    /// <summary>
    /// Catches an utterance the session cut off mid-pipeline (no end-to-end number yet)
    /// poisoning the averages: it must still count as an utterance and contribute its
    /// observed stages, but never contribute a zero/placeholder to end-to-end stats.
    /// </summary>
    [Fact]
    public async Task Summary_ExcludesIncompleteUtterancesFromEndToEnd_ButKeepsTheirStages()
    {
        var store = new SqliteSessionMetricsStore(_dbPath);
        var report = new ConversationMetricsReport(
            ConversationId: "conv-1",
            SourceLang: "en",
            TargetLang: "es",
            StartedAtMs: 0,
            EndedAtMs: 1,
            Utterances:
            [
                new UtteranceMetricsRecord(
                    "cascade:item_done", InterpreterMode.Cascade, EndToEndMs: 1500,
                    Stages: [new StageTimingRecord("sttFinal", 300)]),
                new UtteranceMetricsRecord(
                    "cascade:item_cut", InterpreterMode.Cascade, EndToEndMs: null,
                    Stages: [new StageTimingRecord("sttFinal", 500)]),
            ],
            Transcript: []);
        await store.SaveConversationAsync(report, "openai", CancellationToken.None);

        var summary = await store.GetSummaryAsync(CancellationToken.None);

        var cascade = Assert.Single(summary.Groups);
        Assert.Equal(2, cascade.UtteranceCount);
        Assert.Equal(1, cascade.EndToEnd!.Count);
        Assert.Equal(1500, cascade.EndToEnd.MedianMs);
        Assert.Equal(2, Assert.Single(cascade.Stages).Stats.Count);
    }
}
