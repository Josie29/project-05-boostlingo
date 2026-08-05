namespace Boostlingo.Backend.Tests;

/// <summary>Test selector that returns one fixed provider regardless of the session's choice.</summary>
public sealed class FixedTranslationProviderSelector(ITranslationProvider provider) : ITranslationProviderSelector
{
    public ITranslationProvider Resolve(string? providerName) => provider;
}
