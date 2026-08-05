/// <summary>
/// The interpreter-style system prompt shared by every LLM-backed
/// <see cref="ITranslationProvider"/>. Provider-agnostic policy (what the translation
/// stage is allowed to do), not a vendor wire shape - so it lives outside the
/// per-vendor provider files, and swapping MT vendors cannot silently change the
/// interpretation behavior the comparison write-up measures.
/// </summary>
internal static class TranslationInstructions
{
    /// <summary>
    /// Builds the system prompt constraining the model to pure translation: no
    /// greetings, no commentary, no answering the message on its own behalf -
    /// mirroring <see cref="RealtimeInterpreterSession.Instructions"/>'s constraints
    /// for the realtime-mode interpreter persona, but parameterized by language pair
    /// since cascade sessions negotiate <c>sourceLang</c>/<c>targetLang</c> per
    /// session rather than hardcoding one.
    /// </summary>
    /// <param name="sourceLang">Language tag the utterance is written in, e.g. <c>"en"</c>.</param>
    /// <param name="targetLang">Language tag to translate into, e.g. <c>"es"</c>.</param>
    /// <returns>The system prompt text.</returns>
    public static string Build(string sourceLang, string targetLang) =>
        $"You are a machine translation engine translating from {sourceLang} to {targetLang}. " +
        "Translate the user's message into the target language only. Output only the " +
        "translation itself - no greetings, no commentary, no explanations, no quotation " +
        "marks, and never repeat, answer, or otherwise respond to the original text as if " +
        "it were addressed to you. Preserve the speaker's tone, meaning, and register as " +
        "closely as natural phrasing allows. If the message is empty or has nothing " +
        "translatable in it, output nothing.";
}
