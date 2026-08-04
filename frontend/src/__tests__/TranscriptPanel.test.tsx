import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TranscriptPanel } from '../components/TranscriptPanel';
import type { TranscriptEntry } from '../transcript/types';

describe('TranscriptPanel', () => {
  // Catches the bug where source and target text end up in the same column, or in the
  // wrong column, instead of the two-column layout the issue requires.
  it('renders source and target entries in their own columns', () => {
    const entries: TranscriptEntry[] = [
      { id: 'a', lane: 'source', text: 'Hola', final: true },
      { id: 'b', lane: 'target', text: 'Hello', final: true },
    ];

    render(<TranscriptPanel entries={entries} />);

    const sourceColumn = screen.getByText('Source').closest('.transcript-panel__column');
    const targetColumn = screen.getByText('Target').closest('.transcript-panel__column');
    expect(sourceColumn).toContainElement(screen.getByText('Hola'));
    expect(targetColumn).toContainElement(screen.getByText('Hello'));
  });

  // Catches the bug where an in-progress (partial) utterance renders identically to a
  // finalized one, so a listener can't tell what's still streaming vs. settled — the
  // issue explicitly calls for "visual distinction between in-progress and final text".
  it('marks in-progress entries as not final and finalized entries as final', () => {
    const entries: TranscriptEntry[] = [
      { id: 'a', lane: 'source', text: 'Hel', final: false },
      { id: 'b', lane: 'source', text: 'Done talking', final: true },
    ];

    render(<TranscriptPanel entries={entries} />);

    expect(screen.getByText('Hel')).toHaveAttribute('data-final', 'false');
    expect(screen.getByText('Done talking')).toHaveAttribute('data-final', 'true');
  });

  // Catches the bug where multiple deltas for one utterance render as separate lines
  // instead of a single growing entry (utterance grouping is the reducer's job, but the
  // panel must render exactly one node per entry it's given, not split/duplicate it).
  it('renders exactly one entry per utterance, not one per lane occurrence', () => {
    const entries: TranscriptEntry[] = [{ id: 'a', lane: 'source', text: 'Hello there', final: true }];

    render(<TranscriptPanel entries={entries} />);

    expect(screen.getAllByText('Hello there')).toHaveLength(1);
  });

  // Catches the bug where an empty session (nothing said yet) renders a blank, confusing
  // panel instead of a clear "nothing yet" state per column.
  it('shows an empty state per column when there are no entries', () => {
    render(<TranscriptPanel entries={[]} />);

    expect(screen.getAllByText('Nothing yet.')).toHaveLength(2);
  });

  // Catches the issue #11 UX bug this exists for: a barge-in-truncated entry
  // must render visibly distinct from both an in-progress entry and a normally
  // finalized one, so a listener can tell "cut off" apart from "done talking."
  it('marks a truncated entry distinctly from both in-progress and normally-finalized entries', () => {
    const entries: TranscriptEntry[] = [
      { id: 'a', lane: 'target', text: 'Hel', final: true, truncated: true },
      { id: 'b', lane: 'target', text: 'Done talking', final: true },
    ];

    render(<TranscriptPanel entries={entries} />);

    expect(screen.getByText('Hel')).toHaveAttribute('data-truncated', 'true');
    expect(screen.getByText('Done talking')).toHaveAttribute('data-truncated', 'false');
    expect(screen.getByLabelText('cut off by barge-in')).toBeInTheDocument();
  });
});
