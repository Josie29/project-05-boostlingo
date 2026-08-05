import { useCallback, useEffect, useState } from 'react';
import { getConversations, type ConversationListing } from '../api';

function formatMs(ms: number | null): string {
  // == null also catches undefined from a backend predating these fields.
  return ms == null ? '—' : `${Math.round(ms)}ms`;
}

function formatDate(startedAtMs: number): string {
  return new Date(startedAtMs).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * The Lab's experiments tracker (P1): every stored conversation as one row —
 * its stage config, per-mode end-to-end medians, and WER. Rows accumulate
 * from live sessions today; fixture runs (P3) will land in the same table.
 * Read-only and socket-free, so viewing it never disturbs a live session.
 */
export function LabPanel() {
  const [conversations, setConversations] = useState<ConversationListing[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    getConversations()
      .then((listings) => {
        setConversations(listings);
        setError(null);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Failed to load conversations.'));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <section className="lab-panel" aria-label="Experiments">
      <div className="lab-panel__header">
        <h3>Experiments</h3>
        <button type="button" className="lab-panel__refresh" onClick={refresh}>
          Refresh
        </button>
      </div>

      {error !== null && <p className="lab-panel__error">{error}</p>}
      {conversations !== null && conversations.length === 0 && (
        <p className="lab-panel__empty">No sessions captured yet. Run a session and press Stop — it lands here.</p>
      )}
      {conversations !== null && conversations.length > 0 && (
        <div className="lab-panel__table-scroll">
          <table className="lab-panel__table">
            <thead>
              <tr>
                <th>When</th>
                <th>Kind</th>
                <th>Pair</th>
                <th>STT</th>
                <th>MT</th>
                <th>RT e2e med</th>
                <th>CAS e2e med</th>
                <th>WER</th>
              </tr>
            </thead>
            <tbody>
              {conversations.map((conversation) => (
                <tr key={conversation.conversationId}>
                  <td>{formatDate(conversation.startedAtMs)}</td>
                  <td>{conversation.kind}</td>
                  <td>
                    {conversation.sourceLang}→{conversation.targetLang}
                  </td>
                  <td>
                    <code>{conversation.sttModel}</code>
                  </td>
                  <td>
                    <code>{conversation.translationProvider}</code>
                  </td>
                  <td>{formatMs(conversation.realtimeEndToEndMedianMs)}</td>
                  <td>{formatMs(conversation.cascadeEndToEndMedianMs)}</td>
                  <td>{conversation.wer == null ? '—' : `${(conversation.wer * 100).toFixed(1)}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
