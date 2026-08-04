import { useEffect, useRef } from 'react';
import type { TranscriptEntry, TranscriptLane } from '../transcript/types';

const LANE_LABEL: Record<TranscriptLane, string> = {
  source: 'Source',
  target: 'Target',
};

const LANES: TranscriptLane[] = ['source', 'target'];

export interface TranscriptPanelProps {
  /** Every utterance accumulated so far, across both lanes, in first-appearance order. */
  entries: TranscriptEntry[];
}

/**
 * Shared, mode-agnostic live transcript UI: a source column (what was said)
 * and a target column (its interpretation), each auto-scrolling as new text
 * arrives. Takes only the transport-agnostic {@link TranscriptEntry} domain
 * type — no Realtime (or, later, cascade) specifics — so any session mode
 * can feed it via its own adapter without this component changing.
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

  // Keeps the newest text in view as entries grow or in-progress text lengthens,
  // so a listener doesn't have to manually scroll during a live session.
  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [entries]);

  return (
    <div className="transcript-panel__column" data-lane={lane}>
      <h3 className="transcript-panel__column-header">{LANE_LABEL[lane]}</h3>
      <div className="transcript-panel__scroll" ref={scrollRef}>
        {entries.length === 0 ? (
          <p className="transcript-panel__empty">Nothing yet.</p>
        ) : (
          entries.map((entry) => (
            <p
              key={entry.id}
              className="transcript-panel__entry"
              data-final={entry.final}
            >
              {entry.text}
            </p>
          ))
        )}
      </div>
    </div>
  );
}
