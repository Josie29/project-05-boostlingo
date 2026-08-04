/**
 * Sole seam for calls to the backend API. Screens/components must import
 * from here rather than calling `fetch` directly, so the transport (base
 * URL, error handling, auth headers later) stays in one place.
 *
 * In dev, `/api` and `/healthz` are proxied to the backend by Vite
 * (see vite.config.ts) so no CORS configuration or base URL is needed.
 */

export interface HealthResponse {
  status: string;
}

/**
 * Ephemeral credentials the browser needs to open a WebRTC Realtime session
 * directly with OpenAI. Mirrors the backend's `POST /api/realtime/session`
 * success shape (`{ clientSecret, expiresAt, model }`).
 */
export interface RealtimeSessionInfo {
  clientSecret: string;
  expiresAt: number;
  model: string;
}

/** Error body shape the backend returns on 503 (no server key) or 502 (upstream failure). */
interface RealtimeSessionErrorBody {
  error?: string;
}

/**
 * Calls the backend health endpoint.
 *
 * @returns The parsed health response body.
 * @throws {Error} If the network request fails or the response is not ok.
 */
export async function getHealth(): Promise<HealthResponse> {
  const response = await fetch('/healthz');
  if (!response.ok) {
    throw new Error(`Health check failed with status ${response.status}`);
  }
  return (await response.json()) as HealthResponse;
}

/**
 * Requests a fresh, short-lived OpenAI Realtime client secret from the
 * backend. The secret is used as the bearer token when the browser posts
 * its SDP offer straight to OpenAI to open the WebRTC session.
 *
 * @returns The client secret, its expiry, and the Realtime model it's scoped to.
 * @throws {Error} With the backend's own error message (e.g. "server is not
 *   configured with an OpenAI API key" on 503) when the request fails, so
 *   callers can surface an understandable reason rather than a raw status code.
 */
export async function createRealtimeSession(): Promise<RealtimeSessionInfo> {
  const response = await fetch('/api/realtime/session', { method: 'POST' });
  const body = (await response.json().catch(() => ({}))) as
    | RealtimeSessionInfo
    | RealtimeSessionErrorBody;

  if (!response.ok) {
    const message =
      'error' in body && body.error
        ? body.error
        : `Failed to create realtime session (status ${response.status})`;
    throw new Error(message);
  }

  return body as RealtimeSessionInfo;
}
