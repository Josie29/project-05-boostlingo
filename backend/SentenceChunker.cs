using System.Text;

/// <summary>
/// Pure text splitter that turns a stream of translation token deltas into
/// sentence/phrase-sized chunks, so <see cref="TtsCascadeObserver"/> can dispatch
/// synthesis at each boundary rather than waiting for a whole utterance's translation
/// to finish. Not itself aware of translation, TTS, or the cascade wire protocol -
/// just buffers text and reports where it is safe to cut.
/// </summary>
/// <remarks>
/// One instance is scoped to a single utterance: <see cref="TtsCascadeObserver"/>
/// creates a fresh chunker per utterance and discards it once that utterance's
/// <see cref="TranslationChunk.IsFinal"/> chunk has been flushed.
/// </remarks>
public sealed class SentenceChunker
{
    /// <summary>
    /// Punctuation that ends a phrase worth synthesizing on its own. Deliberately
    /// excludes commas: splitting on every comma would fragment speech into
    /// unnaturally short, choppy clips and multiply the number of TTS (text-to-speech)
    /// round trips per utterance for little latency benefit, since sentence-ending
    /// punctuation already arrives frequently enough to start synthesis well before a
    /// whole utterance's translation completes.
    /// </summary>
    private static readonly char[] BoundaryChars = ['.', '!', '?', ';', '\n'];

    private readonly StringBuilder _buffer = new();

    /// <summary>
    /// Appends one token delta to the buffered text and returns every complete phrase
    /// boundary found as a result - there may be more than one if a single delta
    /// happens to cross multiple boundaries (e.g. a burst containing "Hi. Bye.").
    /// Any trailing partial phrase (text after the last boundary) stays buffered for
    /// the next call.
    /// </summary>
    /// <param name="tokenDelta">The next incremental piece of translated text.</param>
    /// <returns>Zero or more trimmed, non-empty phrases, in the order they appear in
    /// the text. A run of consecutive boundary characters (e.g. an ellipsis, or "?!")
    /// is treated as a single boundary rather than yielding a punctuation-only phrase
    /// for every character in the run.</returns>
    public IReadOnlyList<string> Append(string tokenDelta)
    {
        if (string.IsNullOrEmpty(tokenDelta))
        {
            return [];
        }

        _buffer.Append(tokenDelta);

        List<string>? phrases = null;
        int boundaryIndex;
        while ((boundaryIndex = IndexOfBoundaryRunEnd()) >= 0)
        {
            var phrase = _buffer.ToString(0, boundaryIndex + 1);
            _buffer.Remove(0, boundaryIndex + 1);

            var trimmed = phrase.Trim();
            if (trimmed.Length > 0)
            {
                (phrases ??= []).Add(trimmed);
            }
        }

        return phrases ?? (IReadOnlyList<string>)[];
    }

    /// <summary>
    /// Returns whatever partial phrase remains buffered (trimmed), clearing the
    /// buffer. Call exactly once, when the source stream's utterance has settled
    /// (<see cref="TranslationChunk.IsFinal"/>), so no trailing text - a sentence with
    /// no closing punctuation, or one still in flight when translation finished - is
    /// silently dropped.
    /// </summary>
    /// <returns>The trimmed remainder, or <c>null</c> if nothing (or only whitespace)
    /// was buffered.</returns>
    public string? Flush()
    {
        if (_buffer.Length == 0)
        {
            return null;
        }

        var remainder = _buffer.ToString().Trim();
        _buffer.Clear();
        return remainder.Length > 0 ? remainder : null;
    }

    /// <summary>
    /// Finds the end of the next run of one or more consecutive boundary characters
    /// in the buffer (a lone period, or a whole ellipsis/"?!" run alike), so the
    /// caller cuts once after the entire run rather than once per punctuation mark -
    /// otherwise "..." would produce two empty, punctuation-only phrases between its
    /// three dots once each is individually trimmed (<see cref="string.Trim()"/> only
    /// strips whitespace, not punctuation).
    /// </summary>
    /// <returns>The index of the last character in the first boundary run, or -1 if
    /// the buffer contains no boundary character.</returns>
    private int IndexOfBoundaryRunEnd()
    {
        for (var i = 0; i < _buffer.Length; i++)
        {
            if (Array.IndexOf(BoundaryChars, _buffer[i]) < 0)
            {
                continue;
            }

            while (i + 1 < _buffer.Length && Array.IndexOf(BoundaryChars, _buffer[i + 1]) >= 0)
            {
                i++;
            }

            return i;
        }

        return -1;
    }
}
