namespace Boostlingo.Backend.Tests;

public class LanguagesTests
{
    /// <summary>
    /// Confirms every language the realtime and cascade endpoints validate against is
    /// actually reachable by its wire code - the exact lookup GET /api/languages,
    /// POST /api/realtime/session, and cascade session.start all depend on.
    /// </summary>
    [Fact]
    public void Find_ReturnsRegisteredLanguage_ForEachSupportedCode()
    {
        var english = Languages.Find("en");
        var spanish = Languages.Find("es");

        Assert.NotNull(english);
        Assert.Equal("English", english!.DisplayName);
        Assert.NotNull(spanish);
        Assert.Equal("Spanish", spanish!.DisplayName);
    }

    /// <summary>
    /// Confirms an unregistered code is reported as unsupported rather than the lookup
    /// throwing or silently matching something else - this is what turns an unknown
    /// language into a clean 400/error envelope instead of a crash.
    /// </summary>
    [Fact]
    public void Find_ReturnsNull_ForUnsupportedCode()
    {
        Assert.Null(Languages.Find("fr"));
    }

    /// <summary>
    /// Confirms both directions of the one currently supported pair validate - the
    /// acceptance criteria's "English -> Spanish and Spanish -> English both work"
    /// starts here, before either mode's endpoint even gets involved.
    /// </summary>
    [Theory]
    [InlineData("en", "es")]
    [InlineData("es", "en")]
    public void IsSupportedPair_TrueForRegisteredDistinctCodes(string sourceLang, string targetLang)
    {
        Assert.True(Languages.IsSupportedPair(sourceLang, targetLang));
    }

    /// <summary>
    /// Confirms an unregistered code anywhere in the pair fails validation - the check
    /// both the realtime endpoint and cascade session.start rely on to reject a pair
    /// before ever reaching a provider.
    /// </summary>
    [Theory]
    [InlineData("en", "fr")]
    [InlineData("fr", "en")]
    [InlineData("fr", "de")]
    public void IsSupportedPair_FalseWhenEitherCodeIsUnsupported(string sourceLang, string targetLang)
    {
        Assert.False(Languages.IsSupportedPair(sourceLang, targetLang));
    }

    /// <summary>
    /// Confirms a pair naming the same language twice fails validation even though the
    /// language itself is supported - interpreting a language into itself isn't a
    /// meaningful session.
    /// </summary>
    [Fact]
    public void IsSupportedPair_FalseWhenSourceEqualsTarget()
    {
        Assert.False(Languages.IsSupportedPair("en", "en"));
    }

    /// <summary>
    /// Confirms every registered language has a distinct code - a duplicate would let
    /// Find silently return the wrong entry depending on ordering, corrupting whichever
    /// mode looked it up.
    /// </summary>
    [Fact]
    public void Supported_HasNoDuplicateCodes()
    {
        var codes = Languages.Supported.Select(language => language.Code).ToList();
        Assert.Equal(codes.Distinct().Count(), codes.Count);
    }
}
