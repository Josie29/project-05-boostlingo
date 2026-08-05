import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TranscriptPanel } from '../components/TranscriptPanel';
import type { TranscriptEntry } from '../transcript/types';

/**
 * jsdom never computes real layout, so `scrollHeight`/`clientHeight` are
 * always 0 by default — these tests stub them (and `scrollTop`, which jsdom
 * does let you set/read but never derives from layout either) directly on
 * the element so the component's near-bottom math has something real to
 * work with.
 */
function stubScrollGeometry(element: HTMLElement, { scrollTop, scrollHeight, clientHeight }: { scrollTop: number; scrollHeight: number; clientHeight: number }): void {
  Object.defineProperty(element, 'scrollTop', { value: scrollTop, writable: true, configurable: true });
  Object.defineProperty(element, 'scrollHeight', { value: scrollHeight, configurable: true });
  Object.defineProperty(element, 'clientHeight', { value: clientHeight, configurable: true });
}

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

  describe('auto-scroll', () => {
    function sourceScrollElement(container: HTMLElement): HTMLElement {
      return container.querySelector('.transcript-panel__column[data-lane="source"] .transcript-panel__scroll') as HTMLElement;
    }

    // Catches the core auto-scroll behavior the panel exists to provide: a
    // listener who hasn't scrolled away must keep seeing the newest text
    // without lifting a finger during a live session.
    it('pins scrollTop to the bottom as new entries arrive while the listener is still at the bottom', () => {
      const initialEntries: TranscriptEntry[] = [{ id: 'a', lane: 'source', text: 'Hello', final: true }];
      const { container, rerender } = render(<TranscriptPanel entries={initialEntries} />);
      const scrollEl = sourceScrollElement(container);
      stubScrollGeometry(scrollEl, { scrollTop: 0, scrollHeight: 100, clientHeight: 100 });
      fireEvent.scroll(scrollEl);

      stubScrollGeometry(scrollEl, { scrollTop: 0, scrollHeight: 500, clientHeight: 100 });
      rerender(<TranscriptPanel entries={[...initialEntries, { id: 'b', lane: 'source', text: 'More text', final: true }]} />);

      expect(scrollEl.scrollTop).toBe(500);
    });

    // Catches the bug this fix addresses: re-pinning scrollTop on every render
    // regardless of where the listener scrolled to hijacks a manual scroll-up
    // (e.g. rereading something said earlier) — every new utterance would yank
    // the view back to the bottom out from under them.
    it('does not re-pin scrollTop when the listener has manually scrolled away from the bottom', () => {
      const initialEntries: TranscriptEntry[] = [{ id: 'a', lane: 'source', text: 'Hello', final: true }];
      const { container, rerender } = render(<TranscriptPanel entries={initialEntries} />);
      const scrollEl = sourceScrollElement(container);

      // 400px of unseen content below — well past the near-bottom threshold.
      stubScrollGeometry(scrollEl, { scrollTop: 0, scrollHeight: 500, clientHeight: 100 });
      fireEvent.scroll(scrollEl);

      rerender(<TranscriptPanel entries={[...initialEntries, { id: 'b', lane: 'source', text: 'More text', final: true }]} />);

      expect(scrollEl.scrollTop).toBe(0);
    });

    // Catches an over-sensitive-threshold bug: a scroll position within a few
    // pixels of the bottom (e.g. sub-pixel rendering jitter, not a deliberate
    // scroll-up) must still count as "at the bottom" and keep auto-scrolling,
    // rather than requiring pixel-exact positioning to stay pinned.
    it('still auto-scrolls when the listener is within the near-bottom threshold, not scrolled exactly to 0', () => {
      const initialEntries: TranscriptEntry[] = [{ id: 'a', lane: 'source', text: 'Hello', final: true }];
      const { container, rerender } = render(<TranscriptPanel entries={initialEntries} />);
      const scrollEl = sourceScrollElement(container);

      // scrollHeight - scrollTop - clientHeight = 20px from the bottom, under the 40px threshold.
      stubScrollGeometry(scrollEl, { scrollTop: 380, scrollHeight: 500, clientHeight: 100 });
      fireEvent.scroll(scrollEl);

      stubScrollGeometry(scrollEl, { scrollTop: 380, scrollHeight: 600, clientHeight: 100 });
      rerender(<TranscriptPanel entries={[...initialEntries, { id: 'b', lane: 'source', text: 'More text', final: true }]} />);

      expect(scrollEl.scrollTop).toBe(600);
    });
  });

  describe('synced column scrolling', () => {
    const bothLanes: TranscriptEntry[] = [
      { id: 'a', lane: 'source', text: 'Hola', final: true },
      { id: 'a-target', lane: 'target', text: 'Hello', final: true },
    ];

    function scrollElement(container: HTMLElement, lane: string): HTMLElement {
      return container.querySelector(`.transcript-panel__column[data-lane="${lane}"] .transcript-panel__scroll`) as HTMLElement;
    }

    // Catches the columns drifting apart: scrolling one lane must move the other
    // to the same proportional position, so a reader comparing an utterance to
    // its interpretation never has to hunt for it in the other column.
    it('scrolls the other column proportionally when one is scrolled', () => {
      const { container } = render(<TranscriptPanel entries={bothLanes} />);
      const source = scrollElement(container, 'source');
      const target = scrollElement(container, 'target');
      stubScrollGeometry(source, { scrollTop: 250, scrollHeight: 600, clientHeight: 100 });
      stubScrollGeometry(target, { scrollTop: 0, scrollHeight: 300, clientHeight: 100 });

      fireEvent.scroll(source);

      // Source is halfway through its 500px range; target lands halfway through its 200px range.
      expect(target.scrollTop).toBe(100);
    });

    // Catches the sync fighting auto-scroll: scrolling AWAY in one column must
    // pause bottom-pinning for BOTH, or a new entry would yank the synced
    // column back down while its twin stays scrolled up.
    it('pauses auto-scroll for both columns once either is scrolled away from the bottom', () => {
      const { container, rerender } = render(<TranscriptPanel entries={bothLanes} />);
      const source = scrollElement(container, 'source');
      const target = scrollElement(container, 'target');
      stubScrollGeometry(source, { scrollTop: 0, scrollHeight: 600, clientHeight: 100 });
      stubScrollGeometry(target, { scrollTop: 0, scrollHeight: 300, clientHeight: 100 });

      fireEvent.scroll(source);
      rerender(
        <TranscriptPanel
          entries={[...bothLanes, { id: 'b', lane: 'target', text: 'More', final: true }]}
        />,
      );

      expect(target.scrollTop).toBe(0);
    });
  });

  describe('mode attribution', () => {
    const mixedEntries: TranscriptEntry[] = [
      { id: 'realtime:a', lane: 'source', text: 'Said over realtime', final: true },
      { id: 'cascade:b', lane: 'source', text: 'Said over cascade', final: true },
    ];

    // Catches a listener being unable to tell which transport captured an
    // utterance after a mid-session switch — the whole point of attribution.
    it('marks each entry with its mode chip', () => {
      render(<TranscriptPanel entries={mixedEntries} />);

      expect(screen.getByLabelText('realtime')).toHaveTextContent('RT');
      expect(screen.getByLabelText('cascade')).toHaveTextContent('CAS');
    });

    // Catches the filter narrowing nothing (or the wrong mode): picking Cascade
    // must hide realtime-captured entries, and All must bring them back.
    it('filters both columns to the selected mode and back', () => {
      render(<TranscriptPanel entries={mixedEntries} />);

      fireEvent.click(screen.getByRole('button', { name: 'Cascade' }));
      expect(screen.queryByText('Said over realtime')).not.toBeInTheDocument();
      expect(screen.getByText('Said over cascade')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'All' }));
      expect(screen.getByText('Said over realtime')).toBeInTheDocument();
    });

    // Catches the switch moment going unmarked: consecutive entries from
    // different modes get a divider naming the mode switched to; same-mode
    // neighbors don't.
    it('renders a mode-switch divider only where the mode actually changed', () => {
      render(
        <TranscriptPanel
          entries={[
            ...mixedEntries,
            { id: 'cascade:c', lane: 'source', text: 'Still cascade', final: true },
          ]}
        />,
      );

      expect(screen.getAllByText('switched to cascade')).toHaveLength(1);
    });
  });
});
