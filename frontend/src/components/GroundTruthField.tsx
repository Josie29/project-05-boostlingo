import { groundTruthLines, normalizeForWer } from '../lab/wer';

/** The format, by example — the fastest way to convey it. */
const EXAMPLE = `# healthcare-practice-v1, en -> es
Are you allergic to any medications?
I have been having sharp chest pain for about three days.
Take one tablet twice a day with food.`;

/** Below this the denominator is small enough that one error swings WER wildly. */
const SHORT_REFERENCE_WORDS = 20;

export interface GroundTruthFieldProps {
  value: string;
  onChange: (value: string) => void;
}

/**
 * The experiment's ground-truth input: the format rules, the box, and a preview
 * of exactly what will be scored. The preview is the point — a paste that
 * silently loses lines or keeps doc chrome inflates WER into what reads as a
 * model failure, so the user sees the parse before spending a run on it.
 */
export function GroundTruthField({ value, onChange }: GroundTruthFieldProps) {
  const utterances = groundTruthLines(value);
  // The same normalization the scorer applies, so this IS the WER denominator.
  const words = normalizeForWer(utterances.join('\n'));
  const droppedTableRows = value.split('\n').filter((line) => line.trim().startsWith('|')).length;
  const numerals = [...new Set(words.filter((word) => /\p{N}/u.test(word)))];

  return (
    <div className="ground-truth">
      <p className="ground-truth__title">Ground truth — one utterance per line, in spoken order:</p>
      <pre className="ground-truth__example">{EXAMPLE}</pre>
      <ul className="ground-truth__rules">
        <li>
          Blank lines and <code>#</code> comments are ignored. Plain lines only — markdown table rows are dropped,
          so paste the utterance column, not the table.
        </li>
        <li>Write it naturally: case and punctuation are normalized away before scoring.</li>
        <li>
          Write numbers as they are spoken — <em>three days</em>, not <em>3 days</em>.
        </li>
        <li>Source language only. WER scores the speech-to-text output, never the translation.</li>
      </ul>

      <textarea
        className="ground-truth__input"
        aria-label="Ground truth transcript"
        placeholder="One utterance per line, in the order they are spoken in the file"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={6}
      />

      {value.trim() !== '' && (
        <div className="ground-truth__preview">
          {utterances.length === 0 ? (
            <p className="lab-panel__error">
              Nothing to score — every line was read as a comment or table chrome. Paste the spoken lines
              themselves.
            </p>
          ) : (
            <p className="lab-panel__live-status">
              {utterances.length} {utterances.length === 1 ? 'utterance' : 'utterances'} · {words.length} reference
              words
            </p>
          )}

          {droppedTableRows > 0 && (
            <p className="ground-truth__warning">
              Ignored {droppedTableRows} markdown table {droppedTableRows === 1 ? 'row' : 'rows'}. Paste the spoken
              lines themselves, one per line.
            </p>
          )}
          {numerals.length > 0 && (
            <p className="ground-truth__warning">
              Numerals found ({numerals.slice(0, 4).join(', ')}). Write numbers the way they are spoken — “3” and
              “three” score as different words.
            </p>
          )}
          {words.length > 0 && words.length < SHORT_REFERENCE_WORDS && (
            <p className="ground-truth__warning">
              Only {words.length} reference words. Below ~{SHORT_REFERENCE_WORDS} a single error moves WER a lot —
              read the diff, not just the number.
            </p>
          )}

          {utterances.length > 0 && (
            <details className="ground-truth__details">
              <summary>Exactly what will be scored</summary>
              <ol className="ground-truth__lines">
                {utterances.map((utterance, index) => (
                  <li key={index}>{utterance}</li>
                ))}
              </ol>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
