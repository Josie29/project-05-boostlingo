import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GroundTruthField } from '../components/GroundTruthField';

function renderField(value: string) {
  render(<GroundTruthField value={value} onChange={() => {}} />);
}

describe('GroundTruthField', () => {
  // Catches the preview drifting from the score. The count shown is what WER
  // divides by, so a wrong one lets a user approve a reference they did not paste.
  it('previews the utterances and the WER denominator', () => {
    renderField('# notes\nTake one tablet daily.\n\nStop if swelling occurs.');

    expect(screen.getByText('2 utterances · 8 reference words')).toBeInTheDocument();
    expect(screen.getByText('Take one tablet daily.')).toBeInTheDocument();
    expect(screen.getByText('Stop if swelling occurs.')).toBeInTheDocument();
  });

  // A fixed box hid the tail of a long set, which is exactly the content someone
  // needs to see to notice their reference stops short of the audio.
  it('grows the box to fit a long reference', () => {
    renderField(Array.from({ length: 14 }, (_, index) => `Utterance ${index}.`).join('\n\n'));

    expect(Number(screen.getByLabelText('Ground truth transcript').getAttribute('rows'))).toBeGreaterThan(14);
  });

  // Catches pasted table rows vanishing silently — losing half a reference
  // without saying so is what makes a clean run look like a model failure.
  it('says when it dropped markdown table rows', () => {
    renderField('| H01 | Are you allergic? | 3 |\nTake one tablet daily.');

    expect(screen.getByText(/Ignored 1 markdown table row/)).toBeInTheDocument();
  });

  // Catches the silent WER inflation from a written "3 days" against a spoken
  // "three days": the normalizer keeps digits, so they score as different words.
  it('warns about numerals before the run', () => {
    renderField('I have had chest pain for 3 days and it is getting worse.');

    expect(screen.getByText(/Numerals found \(3\)/)).toBeInTheDocument();
  });

  // Catches an all-chrome paste looking runnable: an empty reference scores
  // WER 1.0, which reads as total model failure rather than a bad paste.
  it('reports nothing to score when every line is chrome', () => {
    renderField('## Utterances\n| ID | Utterance |');

    expect(screen.getByText(/Nothing to score/)).toBeInTheDocument();
  });
});
