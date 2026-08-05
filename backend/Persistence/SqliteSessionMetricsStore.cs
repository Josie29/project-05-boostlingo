using Microsoft.Data.Sqlite;

/// <summary>
/// SQLite-backed <see cref="ISessionMetricsStore"/>. One file on local disk, zero
/// external services - deliberately the smallest persistence that makes benchmark
/// numbers survive a page reload and become comparable across sessions
/// (<c>docs/tech-stack.md</c>'s amended #10 entry). Opens a pooled connection per
/// operation rather than holding one open: Microsoft.Data.Sqlite pools connections
/// per connection string, and per-operation scoping keeps this class safe as a
/// singleton without any locking of its own (SQLite serializes writers itself).
/// </summary>
public sealed class SqliteSessionMetricsStore : ISessionMetricsStore
{
    private readonly string _connectionString;

    /// <summary>
    /// Creates the store, its containing directory, and the schema if missing. Schema
    /// creation is synchronous constructor work on purpose: the store is registered as
    /// a singleton, so this runs exactly once at startup, and a misconfigured path
    /// (unwritable directory, etc.) fails the app at boot rather than on the first
    /// metrics post mid-benchmark.
    /// </summary>
    /// <param name="databasePath">Filesystem path of the SQLite database file.</param>
    public SqliteSessionMetricsStore(string databasePath)
    {
        var directory = Path.GetDirectoryName(Path.GetFullPath(databasePath));
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }

        _connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = databasePath,
            // Enforced per-connection in SQLite, not per-database - without this the
            // ON DELETE CASCADE below is silently a no-op and an upsert would strand
            // orphaned utterance/stage/transcript rows.
            ForeignKeys = true,
        }.ToString();

        using var connection = new SqliteConnection(_connectionString);
        connection.Open();
        using var command = connection.CreateCommand();
        command.CommandText = Schema;
        command.ExecuteNonQuery();
    }

    /// <summary>
    /// One row per conversation; child tables cascade-delete from it so
    /// <see cref="SaveConversationAsync"/>'s replace-wholesale contract is a single
    /// DELETE plus fresh INSERTs. <c>transcript_entries</c> keys on (utterance_id, lane)
    /// because realtime mode reuses one item id across both lanes, and cascade's target
    /// lane uses a derived <c>"-target"</c> id - utterance_id alone is unique in neither
    /// mode's worst case.
    /// </summary>
    private const string Schema = """
        CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY,
            source_lang TEXT NOT NULL,
            target_lang TEXT NOT NULL,
            translation_provider TEXT NOT NULL,
            started_at_ms INTEGER NOT NULL,
            ended_at_ms INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS utterances (
            conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            utterance_id TEXT NOT NULL,
            mode TEXT NOT NULL,
            end_to_end_ms REAL NULL,
            PRIMARY KEY (conversation_id, utterance_id)
        );

        CREATE TABLE IF NOT EXISTS utterance_stages (
            conversation_id TEXT NOT NULL,
            utterance_id TEXT NOT NULL,
            stage TEXT NOT NULL,
            ms REAL NOT NULL,
            PRIMARY KEY (conversation_id, utterance_id, stage),
            FOREIGN KEY (conversation_id, utterance_id)
                REFERENCES utterances(conversation_id, utterance_id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS transcript_entries (
            conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            utterance_id TEXT NOT NULL,
            lane TEXT NOT NULL,
            text TEXT NOT NULL,
            final INTEGER NOT NULL,
            truncated INTEGER NOT NULL,
            PRIMARY KEY (conversation_id, utterance_id, lane)
        );
        """;

    /// <inheritdoc />
    public async Task SaveConversationAsync(
        ConversationMetricsReport report, string translationProvider, CancellationToken cancellationToken)
    {
        await using var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync(cancellationToken);
        await using var transaction = (SqliteTransaction)await connection.BeginTransactionAsync(cancellationToken);

        // Replace wholesale (see ISessionMetricsStore): the cascade FKs take the
        // conversation's utterance/stage/transcript rows with it.
        await using (var delete = connection.CreateCommand())
        {
            delete.Transaction = transaction;
            delete.CommandText = "DELETE FROM conversations WHERE id = $id";
            delete.Parameters.AddWithValue("$id", report.ConversationId);
            await delete.ExecuteNonQueryAsync(cancellationToken);
        }

        await using (var insert = connection.CreateCommand())
        {
            insert.Transaction = transaction;
            insert.CommandText = """
                INSERT INTO conversations (id, source_lang, target_lang, translation_provider, started_at_ms, ended_at_ms)
                VALUES ($id, $sourceLang, $targetLang, $translationProvider, $startedAtMs, $endedAtMs)
                """;
            insert.Parameters.AddWithValue("$id", report.ConversationId);
            insert.Parameters.AddWithValue("$sourceLang", report.SourceLang);
            insert.Parameters.AddWithValue("$targetLang", report.TargetLang);
            insert.Parameters.AddWithValue("$translationProvider", translationProvider);
            insert.Parameters.AddWithValue("$startedAtMs", report.StartedAtMs);
            insert.Parameters.AddWithValue("$endedAtMs", report.EndedAtMs);
            await insert.ExecuteNonQueryAsync(cancellationToken);
        }

        foreach (var utterance in report.Utterances)
        {
            await using (var insert = connection.CreateCommand())
            {
                insert.Transaction = transaction;
                insert.CommandText = """
                    INSERT INTO utterances (conversation_id, utterance_id, mode, end_to_end_ms)
                    VALUES ($conversationId, $utteranceId, $mode, $endToEndMs)
                    """;
                insert.Parameters.AddWithValue("$conversationId", report.ConversationId);
                insert.Parameters.AddWithValue("$utteranceId", utterance.UtteranceId);
                insert.Parameters.AddWithValue("$mode", InterpreterModes.ToWire(utterance.Mode));
                insert.Parameters.AddWithValue("$endToEndMs", (object?)utterance.EndToEndMs ?? DBNull.Value);
                await insert.ExecuteNonQueryAsync(cancellationToken);
            }

            foreach (var stage in utterance.Stages)
            {
                await using var insertStage = connection.CreateCommand();
                insertStage.Transaction = transaction;
                insertStage.CommandText = """
                    INSERT INTO utterance_stages (conversation_id, utterance_id, stage, ms)
                    VALUES ($conversationId, $utteranceId, $stage, $ms)
                    """;
                insertStage.Parameters.AddWithValue("$conversationId", report.ConversationId);
                insertStage.Parameters.AddWithValue("$utteranceId", utterance.UtteranceId);
                insertStage.Parameters.AddWithValue("$stage", stage.Stage);
                insertStage.Parameters.AddWithValue("$ms", stage.Ms);
                await insertStage.ExecuteNonQueryAsync(cancellationToken);
            }
        }

        foreach (var entry in report.Transcript)
        {
            await using var insert = connection.CreateCommand();
            insert.Transaction = transaction;
            insert.CommandText = """
                INSERT INTO transcript_entries (conversation_id, utterance_id, lane, text, final, truncated)
                VALUES ($conversationId, $utteranceId, $lane, $text, $final, $truncated)
                """;
            insert.Parameters.AddWithValue("$conversationId", report.ConversationId);
            insert.Parameters.AddWithValue("$utteranceId", entry.UtteranceId);
            insert.Parameters.AddWithValue("$lane", entry.Lane == TranscriptLane.Source ? "source" : "target");
            insert.Parameters.AddWithValue("$text", entry.Text);
            insert.Parameters.AddWithValue("$final", entry.Final ? 1 : 0);
            insert.Parameters.AddWithValue("$truncated", entry.Truncated ? 1 : 0);
            await insert.ExecuteNonQueryAsync(cancellationToken);
        }

        await transaction.CommitAsync(cancellationToken);
    }

    /// <inheritdoc />
    public async Task<IReadOnlyList<ConversationListing>> ListConversationsAsync(CancellationToken cancellationToken)
    {
        await using var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync(cancellationToken);
        await using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT
                c.id, c.source_lang, c.target_lang, c.translation_provider, c.started_at_ms, c.ended_at_ms,
                COUNT(CASE WHEN u.mode = 'realtime' THEN 1 END) AS realtime_count,
                COUNT(CASE WHEN u.mode = 'cascade' THEN 1 END) AS cascade_count
            FROM conversations c
            LEFT JOIN utterances u ON u.conversation_id = c.id
            GROUP BY c.id
            ORDER BY c.started_at_ms DESC
            """;

        var listings = new List<ConversationListing>();
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        while (await reader.ReadAsync(cancellationToken))
        {
            listings.Add(new ConversationListing(
                ConversationId: reader.GetString(0),
                SourceLang: reader.GetString(1),
                TargetLang: reader.GetString(2),
                TranslationProvider: reader.GetString(3),
                StartedAtMs: reader.GetInt64(4),
                EndedAtMs: reader.GetInt64(5),
                RealtimeUtteranceCount: reader.GetInt32(6),
                CascadeUtteranceCount: reader.GetInt32(7)));
        }

        return listings;
    }

    /// <inheritdoc />
    public async Task<MetricsSummary> GetSummaryAsync(CancellationToken cancellationToken)
    {
        await using var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync(cancellationToken);

        // Percentiles are computed in C# from the raw durations rather than in SQL:
        // SQLite has no built-in percentile function, and at benchmark scale (tens of
        // utterances per session) loading the population is trivially cheap.
        var groups = new Dictionary<(InterpreterMode Mode, string? Provider), SummaryAccumulator>();

        await using (var command = connection.CreateCommand())
        {
            command.CommandText = """
                SELECT u.mode, c.translation_provider, u.conversation_id, u.end_to_end_ms
                FROM utterances u
                JOIN conversations c ON c.id = u.conversation_id
                """;
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken))
            {
                var mode = InterpreterModes.FromWire(reader.GetString(0));
                var accumulator = GetAccumulator(groups, mode, reader.GetString(1));
                accumulator.ConversationIds.Add(reader.GetString(2));
                accumulator.UtteranceCount++;
                if (!reader.IsDBNull(3))
                {
                    accumulator.EndToEndMs.Add(reader.GetDouble(3));
                }
            }
        }

        await using (var command = connection.CreateCommand())
        {
            command.CommandText = """
                SELECT u.mode, c.translation_provider, s.stage, s.ms
                FROM utterance_stages s
                JOIN utterances u ON u.conversation_id = s.conversation_id AND u.utterance_id = s.utterance_id
                JOIN conversations c ON c.id = u.conversation_id
                """;
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken))
            {
                var mode = InterpreterModes.FromWire(reader.GetString(0));
                var accumulator = GetAccumulator(groups, mode, reader.GetString(1));
                var stage = reader.GetString(2);
                if (!accumulator.StageMs.TryGetValue(stage, out var values))
                {
                    values = [];
                    accumulator.StageMs[stage] = values;
                }

                values.Add(reader.GetDouble(3));
            }
        }

        var summaryGroups = groups
            .OrderBy(pair => pair.Key.Mode)
            .ThenBy(pair => pair.Key.Provider)
            .Select(pair => new MetricsSummaryGroup(
                Mode: pair.Key.Mode,
                TranslationProvider: pair.Key.Provider,
                ConversationCount: pair.Value.ConversationIds.Count,
                UtteranceCount: pair.Value.UtteranceCount,
                EndToEnd: ComputeStats(pair.Value.EndToEndMs),
                Stages: [.. pair.Value.StageMs
                    .OrderBy(stage => stage.Key, StringComparer.Ordinal)
                    .Select(stage => new StageStats(stage.Key, ComputeStats(stage.Value)!))]))
            .ToList();

        return new MetricsSummary(summaryGroups);
    }

    /// <summary>
    /// Fetches or creates the accumulator for one (mode, provider) group. Realtime
    /// utterances collapse the provider to <c>null</c> here (see
    /// <see cref="MetricsSummaryGroup.TranslationProvider"/>): realtime never touches
    /// the MT provider, so splitting its population by a config value it ignores would
    /// fragment the very numbers the summary exists to aggregate.
    /// </summary>
    private static SummaryAccumulator GetAccumulator(
        Dictionary<(InterpreterMode, string?), SummaryAccumulator> groups,
        InterpreterMode mode,
        string translationProvider)
    {
        var key = (mode, mode == InterpreterMode.Realtime ? null : translationProvider);
        if (!groups.TryGetValue(key, out var accumulator))
        {
            accumulator = new SummaryAccumulator();
            groups[key] = accumulator;
        }

        return accumulator;
    }

    /// <summary>Mutable per-group working state for <see cref="GetSummaryAsync"/>.</summary>
    private sealed class SummaryAccumulator
    {
        public HashSet<string> ConversationIds { get; } = [];
        public int UtteranceCount { get; set; }
        public List<double> EndToEndMs { get; } = [];
        public Dictionary<string, List<double>> StageMs { get; } = [];
    }

    /// <summary>
    /// Median (interpolated middle pair on even counts) and nearest-rank p95 for one
    /// population, or <c>null</c> for an empty one - matching <see cref="LatencyStats"/>'s
    /// documented definitions.
    /// </summary>
    private static LatencyStats? ComputeStats(List<double> values)
    {
        if (values.Count == 0)
        {
            return null;
        }

        var sorted = values.Order().ToList();
        var middle = sorted.Count / 2; // Upper-middle index; exact middle when count is odd.
        var median = sorted.Count % 2 == 1
            ? sorted[middle]
            : (sorted[middle - 1] + sorted[middle]) / 2.0;

        // Nearest-rank: the smallest observed value with at least 95% of the sample at or below it.
        var rank = (int)Math.Ceiling(0.95 * sorted.Count);
        var p95 = sorted[Math.Clamp(rank - 1, 0, sorted.Count - 1)];

        return new LatencyStats(sorted.Count, median, p95);
    }
}
