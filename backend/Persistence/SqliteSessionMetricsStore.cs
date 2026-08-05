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
        using (var command = connection.CreateCommand())
        {
            command.CommandText = Schema;
            command.ExecuteNonQuery();
        }

        MigrateConversationColumns(connection);
    }

    /// <summary>
    /// Adds columns the Lab work introduced (stt_model, kind, wer, fixture) to a
    /// database created before them. CREATE IF NOT EXISTS alone would silently leave
    /// an existing dev database on the old shape — and dropping it would discard
    /// captured benchmark sessions, which are exactly the data worth keeping.
    /// </summary>
    private static void MigrateConversationColumns(SqliteConnection connection)
    {
        var existing = new HashSet<string>();
        using (var query = connection.CreateCommand())
        {
            query.CommandText = "PRAGMA table_info(conversations)";
            using var reader = query.ExecuteReader();
            while (reader.Read())
            {
                existing.Add(reader.GetString(1)); // Column 1 is the column name.
            }
        }

        (string Name, string Definition)[] added =
        [
            ("stt_model", $"TEXT NOT NULL DEFAULT '{OpenAiSttProvider.Model}'"),
            ("mt_model", $"TEXT NOT NULL DEFAULT '{OpenAiTranslationProvider.Model}'"),
            ("tts_model", $"TEXT NOT NULL DEFAULT '{OpenAiTtsProvider.Model}'"),
            ("kind", "TEXT NOT NULL DEFAULT 'live'"),
            ("wer", "REAL NULL"),
            ("fixture", "TEXT NULL"),
            ("baseline", "INTEGER NOT NULL DEFAULT 0"),
        ];
        foreach (var (name, definition) in added.Where(column => !existing.Contains(column.Name)))
        {
            using var alter = connection.CreateCommand();
            alter.CommandText = $"ALTER TABLE conversations ADD COLUMN {name} {definition}";
            alter.ExecuteNonQuery();
        }
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
            ended_at_ms INTEGER NOT NULL,
            stt_model TEXT NOT NULL DEFAULT 'gpt-4o-mini-transcribe',
            mt_model TEXT NOT NULL DEFAULT 'gpt-4o-mini',
            tts_model TEXT NOT NULL DEFAULT 'gpt-4o-mini-tts',
            kind TEXT NOT NULL DEFAULT 'live',
            wer REAL NULL,
            fixture TEXT NULL,
            baseline INTEGER NOT NULL DEFAULT 0
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
        ConversationMetricsReport report, ResolvedStageConfig stageConfig, CancellationToken cancellationToken)
    {
        await using var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync(cancellationToken);
        await using var transaction = (SqliteTransaction)await connection.BeginTransactionAsync(cancellationToken);

        // The delete-and-reinsert below must not silently unpin a conversation that
        // was already in the baseline set (a re-post replaces data, not curation).
        var wasBaseline = false;
        await using (var query = connection.CreateCommand())
        {
            query.Transaction = transaction;
            query.CommandText = "SELECT baseline FROM conversations WHERE id = $id";
            query.Parameters.AddWithValue("$id", report.ConversationId);
            wasBaseline = await query.ExecuteScalarAsync(cancellationToken) is long and not 0;
        }

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
                INSERT INTO conversations (id, source_lang, target_lang, translation_provider, started_at_ms, ended_at_ms, stt_model, mt_model, tts_model, kind, baseline, wer, fixture)
                VALUES ($id, $sourceLang, $targetLang, $translationProvider, $startedAtMs, $endedAtMs, $sttModel, $mtModel, $ttsModel, $kind, $baseline, $wer, $fixture)
                """;
            insert.Parameters.AddWithValue("$kind", report.Kind ?? "live");
            insert.Parameters.AddWithValue("$baseline", wasBaseline ? 1 : 0);
            insert.Parameters.AddWithValue("$wer", (object?)report.Wer ?? DBNull.Value);
            insert.Parameters.AddWithValue("$fixture", (object?)report.Fixture ?? DBNull.Value);
            insert.Parameters.AddWithValue("$id", report.ConversationId);
            insert.Parameters.AddWithValue("$sourceLang", report.SourceLang);
            insert.Parameters.AddWithValue("$targetLang", report.TargetLang);
            insert.Parameters.AddWithValue("$translationProvider", stageConfig.TranslationProvider);
            insert.Parameters.AddWithValue("$startedAtMs", report.StartedAtMs);
            insert.Parameters.AddWithValue("$endedAtMs", report.EndedAtMs);
            insert.Parameters.AddWithValue("$sttModel", stageConfig.SttModel);
            insert.Parameters.AddWithValue("$mtModel", stageConfig.MtModel);
            insert.Parameters.AddWithValue("$ttsModel", stageConfig.TtsModel);
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

        // Per-conversation, per-mode end-to-end populations for the median columns
        // (SQLite has no median; computed in C# like GetSummaryAsync's stats).
        var endToEnd = new Dictionary<(string ConversationId, string Mode), List<double>>();
        await using (var command = connection.CreateCommand())
        {
            command.CommandText =
                "SELECT conversation_id, mode, end_to_end_ms FROM utterances WHERE end_to_end_ms IS NOT NULL";
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken))
            {
                var key = (reader.GetString(0), reader.GetString(1));
                if (!endToEnd.TryGetValue(key, out var values))
                {
                    values = [];
                    endToEnd[key] = values;
                }

                values.Add(reader.GetDouble(2));
            }
        }

        await using var listCommand = connection.CreateCommand();
        listCommand.CommandText = """
            SELECT
                c.id, c.source_lang, c.target_lang, c.translation_provider, c.started_at_ms, c.ended_at_ms,
                COUNT(CASE WHEN u.mode = 'realtime' THEN 1 END) AS realtime_count,
                COUNT(CASE WHEN u.mode = 'cascade' THEN 1 END) AS cascade_count,
                c.stt_model, c.mt_model, c.tts_model, c.kind, c.wer, c.baseline
            FROM conversations c
            LEFT JOIN utterances u ON u.conversation_id = c.id
            GROUP BY c.id
            ORDER BY c.started_at_ms DESC
            """;

        var listings = new List<ConversationListing>();
        await using var listReader = await listCommand.ExecuteReaderAsync(cancellationToken);
        while (await listReader.ReadAsync(cancellationToken))
        {
            var conversationId = listReader.GetString(0);
            listings.Add(new ConversationListing(
                ConversationId: conversationId,
                SourceLang: listReader.GetString(1),
                TargetLang: listReader.GetString(2),
                TranslationProvider: listReader.GetString(3),
                StartedAtMs: listReader.GetInt64(4),
                EndedAtMs: listReader.GetInt64(5),
                RealtimeUtteranceCount: listReader.GetInt32(6),
                CascadeUtteranceCount: listReader.GetInt32(7),
                SttModel: listReader.GetString(8),
                MtModel: listReader.GetString(9),
                TtsModel: listReader.GetString(10),
                Kind: listReader.GetString(11),
                Wer: listReader.IsDBNull(12) ? null : listReader.GetDouble(12),
                RealtimeEndToEndMedianMs: MedianOrNull(endToEnd, conversationId, "realtime"),
                CascadeEndToEndMedianMs: MedianOrNull(endToEnd, conversationId, "cascade"),
                Baseline: listReader.GetInt64(13) != 0));
        }

        return listings;
    }

    /// <inheritdoc />
    public async Task SetBaselineAsync(IReadOnlyList<string> conversationIds, CancellationToken cancellationToken)
    {
        await using var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync(cancellationToken);
        await using var transaction = (SqliteTransaction)await connection.BeginTransactionAsync(cancellationToken);

        await using (var clear = connection.CreateCommand())
        {
            clear.Transaction = transaction;
            clear.CommandText = "UPDATE conversations SET baseline = 0 WHERE baseline = 1";
            await clear.ExecuteNonQueryAsync(cancellationToken);
        }

        foreach (var conversationId in conversationIds)
        {
            await using var pin = connection.CreateCommand();
            pin.Transaction = transaction;
            pin.CommandText = "UPDATE conversations SET baseline = 1 WHERE id = $id";
            pin.Parameters.AddWithValue("$id", conversationId);
            await pin.ExecuteNonQueryAsync(cancellationToken);
        }

        await transaction.CommitAsync(cancellationToken);
    }

    private static double? MedianOrNull(
        Dictionary<(string, string), List<double>> populations, string conversationId, string mode) =>
        populations.TryGetValue((conversationId, mode), out var values) ? Median(values.Order().ToList()) : null;

    /// <inheritdoc />
    public async Task<MetricsSummary> GetSummaryAsync(
        CancellationToken cancellationToken, BaselineScope scope = BaselineScope.All, bool collapseMtProvider = false)
    {
        await using var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync(cancellationToken);

        var scopeFilter = scope switch
        {
            BaselineScope.Baseline => " WHERE c.baseline = 1",
            BaselineScope.Current => " WHERE c.baseline = 0",
            _ => string.Empty,
        };

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
                """ + scopeFilter;
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken))
            {
                var mode = InterpreterModes.FromWire(reader.GetString(0));
                var accumulator = GetAccumulator(groups, mode, collapseMtProvider ? null : reader.GetString(1));
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
                """ + scopeFilter;
            await using var reader = await command.ExecuteReaderAsync(cancellationToken);
            while (await reader.ReadAsync(cancellationToken))
            {
                var mode = InterpreterModes.FromWire(reader.GetString(0));
                var accumulator = GetAccumulator(groups, mode, collapseMtProvider ? null : reader.GetString(1));
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

        // Nearest-rank: the smallest observed value with at least 95% of the sample at or below it.
        var rank = (int)Math.Ceiling(0.95 * sorted.Count);
        var p95 = sorted[Math.Clamp(rank - 1, 0, sorted.Count - 1)];

        return new LatencyStats(sorted.Count, Median(sorted), p95);
    }

    /// <summary>Median of an already-sorted, non-empty population; interpolates the middle pair on even counts.</summary>
    private static double Median(List<double> sorted)
    {
        var middle = sorted.Count / 2; // Upper-middle index; exact middle when count is odd.
        return sorted.Count % 2 == 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2.0;
    }
}
