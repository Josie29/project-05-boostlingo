import { useEffect, useState } from 'react';
import { getLanguages, type LanguageOption, type LanguagePair } from '../api';

export interface LanguagePairSelectorProps {
  /** The currently selected pair — fully controlled by the parent (issue #8: shared by both modes). */
  pair: LanguagePair;
  /** Called with the next pair whenever the source, target, or swap control changes. */
  onChange: (pair: LanguagePair) => void;
  /** Disables every control, e.g. while either mode has a session active. */
  disabled: boolean;
}

/**
 * Source/target language pair control shared by both the Realtime and
 * Cascade panels (issue #8). Renders its options from `GET /api/languages`
 * (`api.ts`'s `getLanguages`) rather than hardcoding a language list, so a
 * third language becoming available on the backend needs no frontend
 * change here.
 *
 * Fully controlled — the selected pair lives one level up (`App`) so both
 * panels always negotiate the same pair on their next Start. Deliberately
 * pre-session only: disabled while either mode is active, since safely
 * applying a language change to an already-open session is out of scope for
 * this issue (see issue #9's mode-toggle work).
 */
export function LanguagePairSelector({ pair, onChange, disabled }: LanguagePairSelectorProps) {
  const [languages, setLanguages] = useState<LanguageOption[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    getLanguages()
      .then((result) => {
        if (!cancelled) setLanguages(result);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : 'Failed to load languages.');
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="language-pair-selector" aria-label="Language pair">
      <div className="language-pair-selector__controls">
        <label className="language-pair-selector__field">
          <span className="language-pair-selector__label">Source</span>
          <select
            value={pair.sourceLang}
            disabled={disabled}
            onChange={(event) => onChange({ sourceLang: event.target.value, targetLang: pair.targetLang })}
          >
            {languages.map((language) => (
              <option key={language.code} value={language.code}>
                {language.displayName}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          className="language-pair-selector__swap"
          disabled={disabled}
          onClick={() => onChange({ sourceLang: pair.targetLang, targetLang: pair.sourceLang })}
        >
          Swap
        </button>

        <label className="language-pair-selector__field">
          <span className="language-pair-selector__label">Target</span>
          <select
            value={pair.targetLang}
            disabled={disabled}
            onChange={(event) => onChange({ sourceLang: pair.sourceLang, targetLang: event.target.value })}
          >
            {languages.map((language) => (
              <option key={language.code} value={language.code}>
                {language.displayName}
              </option>
            ))}
          </select>
        </label>
      </div>

      {loadError && (
        <p className="language-pair-selector__error" role="alert">
          {loadError}
        </p>
      )}
    </section>
  );
}
