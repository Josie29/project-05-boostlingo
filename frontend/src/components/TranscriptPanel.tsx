import { Fragment, useEffect, useRef, useState } from 'react';
import { modeOfPrefixedId, type SessionMode } from '../session/InterpreterSession';
import type { TranscriptEntry, TranscriptLane } from '../transcript/types';

const LANE_LABEL: Record<TranscriptLane, string> = {
  source: 'Source',
  target: 'Target',
};

const LANES: TranscriptLane[] = ['source', 'target'];

/** All | one mode — which entries both columns show. */
type ModeFilter = 'all' | SessionMode;

const FILTERS: { value: ModeFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'realtime', label: 'Realtime' },
  { value: 'cascade', label: 'Cascade' },
];

/** Short chip text per mode; the full mode name rides along as the accessible label. */
const MODE_CHIP: Record<SessionMode, string> = { realtime: 'RT', cascade: 'CAS' };

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
 * Live transcript UI: a source column (what was said) and a target column
 * (its interpretation). Each entry carries a mode rail + chip (chip text,
 * never color alone), a filter row narrows both columns to one mode, and a
 * labeled divider marks each mid-conversation mode switch.
 *
 * The two columns scroll as one: a scroll in either column moves the other
 * proportionally (their content heights differ, so position maps by ratio,
 * not pixels), and the "listener scrolled away from the bottom" state that
 * pauses auto-scroll is shared — otherwise a new entry would yank the synced
 * column back to the bottom out from under the scrolled-up one.
 */
export function TranscriptPanel({ entries }: TranscriptPanelProps) {
  const [filter, setFilter] = useState<ModeFilter>('all');
  const visible = filter === 'all' ? entries : entries.filter((entry) => modeOfPrefixedId(entry.id) === filter);

  const scrollElements = useRef<Partial<Record<TranscriptLane, HTMLDivElement>>>({});
  const scrolledAwayFromBottomRef = useRef(false);
  // Lane whose scrollTop was just set programmatically by the sync below: its
  // resulting scroll event is an echo, not a user gesture, and must not sync
  // back (feedback loop) or overwrite the shared scrolled-away state.
  const suppressEchoRef = useRef<TranscriptLane | null>(null);

  function registerScrollElement(lane: TranscriptLane, element: HTMLDivElement | null): void {
    if (element) {
      scrollElements.current[lane] = element;
    } else {
      delete scrollElements.current[lane];
    }
  }

  function handleScroll(lane: TranscriptLane): void {
    if (suppressEchoRef.current === lane) {
      suppressEchoRef.current = null;
      return;
    }

    const element = scrollElements.current[lane];
    if (!element) return;

    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    scrolledAwayFromBottomRef.current = distanceFromBottom > NEAR_BOTTOM_THRESHOLD_PX;

    const followerLane: TranscriptLane = lane === 'source' ? 'target' : 'source';
    const follower = scrollElements.current[followerLane];
    if (!follower) return;
    const leaderMax = element.scrollHeight - element.clientHeight;
    const followerMax = follower.scrollHeight - follower.clientHeight;
    if (leaderMax <= 0 || followerMax <= 0) return;

    const next = (element.scrollTop / leaderMax) * followerMax;
    if (Math.abs(follower.scrollTop - next) < 1) return;
    suppressEchoRef.current = followerLane;
    follower.scrollTop = next;
  }

  return (
    <section className="transcript-panel" aria-label="Live transcript">
      <div className="transcript-panel__filters" role="group" aria-label="Filter by mode">
        {FILTERS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            className="transcript-panel__filter"
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="transcript-panel__columns">
        {LANES.map((lane) => (
          <TranscriptColumn
            key={lane}
            lane={lane}
            entries={visible.filter((entry) => entry.lane === lane)}
            scrolledAwayFromBottomRef={scrolledAwayFromBottomRef}
            registerScrollElement={registerScrollElement}
            onScroll={handleScroll}
          />
        ))}
      </div>
    </section>
  );
}

function TranscriptColumn({
  lane,
  entries,
  scrolledAwayFromBottomRef,
  registerScrollElement,
  onScroll,
}: {
  lane: TranscriptLane;
  entries: TranscriptEntry[];
  /** Shared across both columns — see `TranscriptPanel`'s remarks on synced scrolling. */
  scrolledAwayFromBottomRef: React.RefObject<boolean>;
  registerScrollElement: (lane: TranscriptLane, element: HTMLDivElement | null) => void;
  onScroll: (lane: TranscriptLane) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Keeps the newest text in view as entries grow or in-progress text
  // lengthens, so a listener who's still following along at the bottom
  // doesn't have to manually scroll during a live session — but only while
  // they're actually still at the bottom (shared state; see panel remarks).
  useEffect(() => {
    const element = scrollRef.current;
    if (element && !scrolledAwayFromBottomRef.current) element.scrollTop = element.scrollHeight;
  }, [entries, scrolledAwayFromBottomRef]);

  return (
    <div className="transcript-panel__column" data-lane={lane}>
      <h3 className="transcript-panel__column-header">{LANE_LABEL[lane]}</h3>
      <div
        className="transcript-panel__scroll"
        ref={(element) => {
          scrollRef.current = element;
          registerScrollElement(lane, element);
        }}
        onScroll={() => onScroll(lane)}
      >
        {entries.length === 0 ? (
          <p className="transcript-panel__empty">Nothing yet.</p>
        ) : (
          entries.map((entry, index) => {
            const mode = modeOfPrefixedId(entry.id);
            const previousMode = index > 0 ? modeOfPrefixedId(entries[index - 1].id) : null;
            return (
              // The truncation marker renders as a sibling of the <p>, not a child of
              // it, so the <p>'s own text content stays exactly `entry.text` — anything
              // reading its rendered text (e.g. `getByText`) shouldn't have to account
              // for trailing UI chrome that was never part of what was actually said.
              <Fragment key={entry.id}>
                {previousMode !== null && previousMode !== mode && (
                  <p className="transcript-panel__mode-switch">switched to {mode}</p>
                )}
                <div className="transcript-panel__entry-row" data-mode={mode}>
                  <span className="transcript-panel__chip" aria-label={mode}>
                    {MODE_CHIP[mode]}
                  </span>
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
                </div>
              </Fragment>
            );
          })
        )}
      </div>
    </div>
  );
}
