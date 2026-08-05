/// <summary>
/// Single registry of the per-stage model choices a cascade session may negotiate
/// (Lab P1). Mirrors <see cref="Languages"/>' role: session.start validation, the
/// architecture endpoint's options list, and metrics stamping all read from here, so
/// offering a new stage model is a one-entry change.
/// </summary>
public static class StageModels
{
    /// <summary>The larger STT model offered as an accuracy-vs-cost alternative to the default.</summary>
    public const string FullSttModel = "gpt-4o-transcribe";

    /// <summary>STT models a session may select; first entry is the default.</summary>
    public static readonly IReadOnlyList<string> SttModels = [OpenAiSttProvider.Model, FullSttModel];

    /// <summary>MT provider names a session may select. The process default comes from <c>TRANSLATION_PROVIDER</c>.</summary>
    public static readonly IReadOnlyList<string> MtProviders = ["openai", "anthropic"];

    /// <summary>Whether a session.start STT model choice is one this deployment offers.</summary>
    public static bool IsSupportedSttModel(string model) => SttModels.Contains(model);

    /// <summary>Whether a session.start MT provider choice is one this deployment offers.</summary>
    public static bool IsSupportedMtProvider(string provider) => MtProviders.Contains(provider);
}
