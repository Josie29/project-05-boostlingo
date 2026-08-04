import { useEffect, useState } from 'react';
import { getHealth } from '../api';

type Status = 'checking' | 'connected' | 'unreachable';

/**
 * Calls the backend health endpoint on mount and reports whether the dev
 * proxy successfully reaches the ASP.NET Core API. Exists to prove the
 * frontend/backend dev loop works end to end before any real screens land.
 */
export function BackendStatus() {
  const [status, setStatus] = useState<Status>('checking');

  useEffect(() => {
    let cancelled = false;

    getHealth()
      .then(() => {
        if (!cancelled) setStatus('connected');
      })
      .catch(() => {
        if (!cancelled) setStatus('unreachable');
      });

    return () => {
      cancelled = true;
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
