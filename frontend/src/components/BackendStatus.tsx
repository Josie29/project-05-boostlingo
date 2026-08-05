import { useEffect, useState } from 'react';
import { getHealth } from '../api';

type Status = 'checking' | 'connected' | 'unreachable';

/**
 * How often to re-check the health endpoint while the backend hasn't been
 * reached yet - frequent enough that starting the backend after the page
 * loads flips the indicator without a manual refresh, infrequent enough to
 * be invisible in the dev server logs.
 */
const RECHECK_INTERVAL_MS = 5000;

/**
 * Polls the backend health endpoint until it answers and reports whether the
 * dev proxy reaches the ASP.NET Core API. Polling stops once connected: a
 * backend lost mid-session surfaces through session errors, not this badge.
 */
export function BackendStatus() {
  const [status, setStatus] = useState<Status>('checking');

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const check = () => {
      getHealth()
        .then(() => {
          if (cancelled) return;
          setStatus('connected');
          // Success is terminal for this badge - stop polling rather than
          // keep hitting /healthz for the lifetime of the page.
          if (timer !== null) clearInterval(timer);
          timer = null;
        })
        .catch(() => {
          if (!cancelled) setStatus('unreachable');
        });
    };

    check();
    timer = setInterval(check, RECHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer !== null) clearInterval(timer);
    };
  }, []);

  const label =
    status === 'checking'
      ? 'Checking backend...'
      : status === 'connected'
        ? 'Backend connected'
        : 'Backend unreachable';

  return (
    <p className="backend-status" data-status={status}>
      <span className="backend-status__dot" aria-hidden="true" />
      {label}
    </p>
  );
}
