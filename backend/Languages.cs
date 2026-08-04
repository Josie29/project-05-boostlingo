/// <summary>
/// Static registry of every language the interpreter supports, in both realtime and
/// cascade modes. This is the single place source/target languages are looked up from -
/// <c>GET /api/languages</c>, <c>POST /api/realtime/session</c>'s pair validation and
/// instruction building, the cascade <c>session.start</c> handshake's pair validation,
/// the STT (speech-to-text) language hint, and the TTS (text-to-speech) voice choice all
/// read from <see cref="Supported"/> rather than hardcoding language-specific values of
/// their own.
/// </summary>
/// <remarks>
/// ADDING A THIRD LANGUAGE IS A ONE-ENTRY CHANGE: append one <see cref="LanguageInfo"/>
/// to <see cref="Supported"/> below and nothing else in the codebase needs to change -
/// every consumer listed above reads this list at request time instead of hardcoding a
/// language of its own.
/// </remarks>
public static class Languages
{
    /// <summary>
    /// Every language usable as a source or target in either mode. See this class's own
    /// remarks: adding a language is exactly one entry here.
    /// </summary>
    public static readonly IReadOnlyList<LanguageInfo> Supported =
    [
        new LanguageInfo("en", "English", SttLanguageHint: "en", TtsVoice: "marin"),
        new LanguageInfo("es", "Spanish", SttLanguageHint: "es", TtsVoice: "alloy"),
    ];

    /// <summary>Looks up a language by its wire code.</summary>
    /// <param name="code">Language tag to look up, e.g. <c>"en"</c> - matched exactly
    /// against <see cref="LanguageInfo.Code"/>, case-sensitively.</param>
    /// <returns>The matching <see cref="LanguageInfo"/>, or <c>null</c> if <paramref name="code"/>
    /// isn't in <see cref="Supported"/>.</returns>
    public static LanguageInfo? Find(string code) =>
        Supported.FirstOrDefault(language => language.Code == code);

    /// <summary>
    /// Validates a source/target pair for use by either interpretation mode: both codes
    /// must be supported, and they must differ from one another - a session
    /// interpreting a language into itself isn't a meaningful pair.
    /// </summary>
    /// <param name="sourceLang">The speaker's language tag.</param>
    /// <param name="targetLang">The language tag to interpret into.</param>
    /// <returns><c>true</c> if both codes are supported and distinct.</returns>
    public static bool IsSupportedPair(string sourceLang, string targetLang) =>
        sourceLang != targetLang && Find(sourceLang) is not null && Find(targetLang) is not null;
}

/// <summary>
/// One supported language: its wire code plus every language-specific choice the
/// realtime and cascade pipelines need in order to interpret into or out of it.
/// </summary>
/// <param name="Code">BCP-47-ish language tag used on the wire, e.g. <c>"en"</c> - the
/// same value the frontend sends as <c>sourceLang</c>/<c>targetLang</c> and
/// <c>GET /api/languages</c> returns as each option's <c>code</c>.</param>
/// <param name="DisplayName">Human-readable name for the language selector UI, e.g. <c>"English"</c>.</param>
/// <param name="SttLanguageHint">Language hint passed to the STT (speech-to-text)
/// provider (see <see cref="SttStreamConfig.SourceLang"/>) to improve recognition
/// accuracy when this language is the session's source.</param>
/// <param name="TtsVoice">Voice passed to the TTS (text-to-speech) provider (see
/// <see cref="OpenAiTtsProvider"/>) when synthesizing speech in this language, i.e.
/// when this language is the session's target.</param>
public sealed record LanguageInfo(string Code, string DisplayName, string SttLanguageHint, string TtsVoice);

/// <summary>Wires up the language list endpoint the frontend renders its selector from.</summary>
public static class LanguageEndpoints
{
    /// <summary>Route the frontend calls to fetch the supported language list.</summary>
    public const string RoutePattern = "/api/languages";

    /// <summary>Registers <c>GET /api/languages</c>.</summary>
    /// <param name="app">The application to add the endpoint to.</param>
    /// <returns>The same application, for chaining.</returns>
    public static WebApplication MapLanguageEndpoints(this WebApplication app)
    {
        app.MapGet(RoutePattern, HandleGetLanguages);
        return app;
    }

    /// <summary>
    /// Returns every supported language's wire code and display name, so the frontend
    /// can render its selector from data instead of hardcoding the list itself.
    /// </summary>
    private static IResult HandleGetLanguages() =>
        Results.Ok(new LanguagesResponse(
            [.. Languages.Supported.Select(language => new LanguageOption(language.Code, language.DisplayName))]));
}

/// <summary>One selectable language, as exposed to the frontend.</summary>
/// <param name="Code">Wire code to send back as <c>sourceLang</c>/<c>targetLang</c>.</param>
/// <param name="DisplayName">Human-readable name to render in the selector.</param>
public sealed record LanguageOption(string Code, string DisplayName);

/// <summary>Response body for <c>GET /api/languages</c>.</summary>
/// <param name="Languages">Every supported language, in the order the selector should list them.</param>
public sealed record LanguagesResponse(IReadOnlyList<LanguageOption> Languages);
