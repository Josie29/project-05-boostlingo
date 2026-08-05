import { Fragment, useEffect, useRef } from 'react';
import type { TranscriptEntry, TranscriptLane } from '../transcript/types';

const LANE_LABEL: Record<TranscriptLane, string> = {
  source: 'Source',
  target: 'Target',
};

const LANES: TranscriptLane[] = ['source', 'target'];

/**
 * How close to the bottom (in pixels) a manual scroll must remain for the
 * auto-scroll effect to keep treating the listener as "still following
 * along." A small tolerance rather than an exact-zero check, since a
 * fraction-of-a-pixel rounding difference between `scrollHeight`/
 * `scrollTop`/`clientHeight` shouldn't be enough to (dis)engage pinning.
 */
const NEAR_BOTTOM_THRESHOLD_PX = 40;

export interface TranscriptPanelProps {
  /** Every utterance accumulated so far, across both lanes, in first-appearance order. */
  entries: TranscriptEntry[];
}

/**
 * Shared, mode-agnostic live transcript UI: a source column (what was said)
 * and a target column (its interpretation), each auto-scrolling as new text
 * arrives. Takes only the transport-agnostic {@link TranscriptEntry} domain
 * type — no Realtime- or cascade-specific detail — so either session mode
 * feeds it via its own adapter without this component changing.
 */
export function TranscriptPanel({ entries }: TranscriptPanelProps) {
  return (
    <section className="transcript-panel" aria-label="Live transcript">
      <div className="transcript-panel__columns">
        {LANES.map((lane) => (
          <TranscriptColumn
            key={lane}
            lane={lane}
            entries={entries.filter((entry) => entry.lane === lane)}
          />
        ))}
      </div>
    </section>
  );
}

function TranscriptColumn({ lane, entries }: { lane: TranscriptLane; entries: TranscriptEntry[] }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // True once the listener has manually scrolled away from the bottom (e.g.
  // scrolling up to reread something said earlier). The auto-scroll effect
  // below checks this before re-pinning scrollTop, so it stops hijacking a
  // manual scroll-up on every subsequent render — a ref rather than state
  // since it's read only from that effect/the scroll handler, and updating
  // it should never itself trigger a re-render.
  const scrolledAwayFromBottomRef = useRef(false);

  // Keeps the newest text in view as entries grow or in-progress text
  // lengthens, so a listener who's still following along at the bottom
  // doesn't have to manually scroll during a live session — but only while
  // they're actually still at the bottom; see `handleScroll`.
  useEffect(() => {
    const element = scrollRef.current;
    if (element && !scrolledAwayFromBottomRef.current) element.scrollTop = element.scrollHeight;
  }, [entries]);

  /** Tracks whether the listener is still within `NEAR_BOTTOM_THRESHOLD_PX` of the bottom, for the auto-scroll effect above to check before re-pinning. */
  function handleScroll(): void {
    const element = scrollRef.current;
    if (!element) return;
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    scrolledAwayFromBottomRef.current = distanceFromBottom > NEAR_BOTTOM_THRESHOLD_PX;
  }

  return (
    <div className="transcript-panel__column" data-lane={lane}>
      <h3 className="transcript-panel__column-header">{LANE_LABEL[lane]}</h3>
      <div className="transcript-panel__scroll" ref={scrollRef} onScroll={handleScroll}>
        {entries.length === 0 ? (
          <p className="transcript-panel__empty">Nothing yet.</p>
        ) : (
          entries.map((entry) => (
            // The truncation marker renders as a sibling of the <p>, not a child of
            // it, so the <p>'s own text content stays exactly `entry.text` — anything
            // reading its rendered text (e.g. `getByText`) shouldn't have to account
            // for trailing UI chrome that was never part of what was actually said.
            <Fragment key={entry.id}>
              <p
                className="transcript-panel__entry"
                data-final={entry.final}
                data-truncated={entry.truncated ?? false}
              >
                {entry.text}
              </p>
              {entry.truncated && (
                <span className="transcript-panel__truncated-marker" aria-label="cut off by barge-in">
                  (cut off)
                </span>
              )}
            </Fragment>
          ))
        )}
      </div>
    </div>
  );
}
