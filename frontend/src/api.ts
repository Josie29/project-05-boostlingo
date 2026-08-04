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
