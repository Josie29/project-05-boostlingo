namespace Boostlingo.Backend.Tests;

public class SentenceChunkerTests
{
    /// <summary>
    /// Confirms a delta with no sentence-ending punctuation yields nothing yet - this
    /// is what lets TTS/#7 wait for a real phrase boundary instead of synthesizing
    /// every single token as its own clip.
    /// </summary>
    [Fact]
    public void Append_NoBoundaryYet_ReturnsNothing()
    {
        var chunker = new SentenceChunker();

        var phrases = chunker.Append("Hello there");

        Assert.Empty(phrases);
    }

    /// <summary>
    /// Confirms a delta that completes a sentence - with more text already following
    /// the sentence-ending punctuation in the same delta - returns exactly that
    /// phrase, trimmed, in the same call. The core behavior TTS/#7 depends on to start
    /// synthesizing before an utterance's whole translation has streamed in.
    /// </summary>
    [Fact]
    public void Append_CompletesSentence_ReturnsTrimmedPhrase()
    {
        var chunker = new SentenceChunker();

        var phrases = chunker.Append("Hello there. ");

        Assert.Equal(["Hello there."], phrases);
    }

    /// <summary>
    /// Confirms a sentence-ending boundary landing exactly at the end of the buffered
    /// text is NOT reported yet - it might still be extended by more punctuation in
    /// the very next delta (see the boundary-run-split-across-deltas test below) - and
    /// only resolves once the utterance ends and Flush() claims it.
    /// </summary>
    [Fact]
    public void Append_BoundaryAtEndOfBuffer_DefersUntilConfirmedOrFlushed()
    {
        var chunker = new SentenceChunker();

        var phrases = chunker.Append("Hello there.");

        Assert.Empty(phrases);
        Assert.Equal("Hello there.", chunker.Flush());
    }

    /// <summary>
    /// Confirms a boundary run split across two deltas - the run's tail landing
    /// exactly at the end of one delta, then continuing as pure punctuation at the
    /// start of the next - never reports a punctuation-only phrase for the second
    /// delta. Without the fix this guards, TtsCascadeObserver would dispatch a
    /// nonsensical "." synthesis request to TTS (text-to-speech) every time an
    /// ellipsis (or any other multi-character boundary run) happened to be split by a
    /// token delta boundary.
    /// </summary>
    [Fact]
    public void Append_BoundaryRunSplitAcrossDeltas_NeverReportsPunctuationOnlyPhrase()
    {
        var chunker = new SentenceChunker();

        var first = chunker.Append("Hi..");
        Assert.Empty(first);

        var second = chunker.Append(".");
        Assert.Empty(second);

        Assert.Equal("Hi...", chunker.Flush());
    }

    /// <summary>
    /// Confirms a phrase can be built up across several small deltas (the realistic
    /// shape of streamed MT token deltas) and is only reported once the boundary
    /// finally arrives, not sooner and not with the boundary split off.
    /// </summary>
    [Fact]
    public void Append_AcrossMultipleDeltas_ReportsPhraseOnlyOnceBoundaryArrives()
    {
        var chunker = new SentenceChunker();

        Assert.Empty(chunker.Append("Hola"));
        Assert.Empty(chunker.Append(" mun"));
        var phrases = chunker.Append("do. ");

        Assert.Equal(["Hola mundo."], phrases);
    }

    /// <summary>
    /// Confirms one delta spanning two full sentences reports both phrases, in order -
    /// without this, a fast burst of tokens could silently lose a whole sentence.
    /// </summary>
    [Fact]
    public void Append_MultipleSentencesInOneDelta_ReturnsBothInOrder()
    {
        var chunker = new SentenceChunker();

        var phrases = chunker.Append("Hi. Bye! ");

        Assert.Equal(["Hi.", "Bye!"], phrases);
    }

    /// <summary>
    /// Confirms text left over after the last boundary stays buffered for the next
    /// call rather than being reported early or dropped.
    /// </summary>
    [Fact]
    public void Append_TrailingPartialAfterBoundary_StaysBuffered()
    {
        var chunker = new SentenceChunker();

        var phrases = chunker.Append("Done. And then");

        Assert.Equal(["Done."], phrases);

        var next = chunker.Append(" more. ");
        Assert.Equal(["And then more."], next);
    }

    /// <summary>
    /// Confirms Flush returns whatever partial phrase never reached a punctuation
    /// boundary - the case of an utterance's translation finishing (IsFinal) with no
    /// trailing period, which must still be spoken rather than silently dropped.
    /// </summary>
    [Fact]
    public void Flush_ReturnsUnterminatedRemainder()
    {
        var chunker = new SentenceChunker();
        chunker.Append("No punctuation here");

        var remainder = chunker.Flush();

        Assert.Equal("No punctuation here", remainder);
    }

    /// <summary>
    /// Confirms Flush on an empty (or already fully-consumed) buffer returns null
    /// rather than an empty string - so callers can skip synthesizing/sending
    /// tts.audio events for an utterance that had nothing left to say.
    /// </summary>
    [Fact]
    public void Flush_EmptyBuffer_ReturnsNull()
    {
        var chunker = new SentenceChunker();
        chunker.Append("Complete sentence. ");

        var remainder = chunker.Flush();

        Assert.Null(remainder);
    }

    /// <summary>
    /// Confirms whitespace-only leftovers (e.g. a trailing space after the last
    /// sentence, with nothing more ever appended) flush to null too, not an empty or
    /// whitespace-only phrase that would otherwise trigger a pointless TTS call.
    /// </summary>
    [Fact]
    public void Flush_WhitespaceOnlyRemainder_ReturnsNull()
    {
        var chunker = new SentenceChunker();
        chunker.Append("Done.   ");

        var remainder = chunker.Flush();

        Assert.Null(remainder);
    }

    /// <summary>
    /// Confirms consecutive punctuation (e.g. an ellipsis) does not yield empty
    /// phrases in between - otherwise TTS/#7 would fire off synthesis calls for
    /// nothing to say.
    /// </summary>
    [Fact]
    public void Append_ConsecutivePunctuation_SkipsEmptyPhrases()
    {
        var chunker = new SentenceChunker();

        var phrases = chunker.Append("Wait... really? ");

        Assert.Equal(["Wait...", "really?"], phrases);
    }
}
