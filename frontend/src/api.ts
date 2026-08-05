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
 * A source/target language pair, using the same wire codes (e.g. `"en"`,
 * `"es"`) the backend's language registry keys on (`backend/Languages.cs`).
 * Shared by both interpretation modes — see `POST /api/realtime/session`'s
 * body and the cascade `session.start` payload.
 */
export interface LanguagePair {
  sourceLang: string;
  targetLang: string;
}

/**
 * Pair negotiated when the caller hasn't made an explicit selection yet,
 * mirroring the backend's own default (`RealtimeSession.cs`,
 * `CascadeAudioSession.cs`) so a session started before the language list
 * has loaded, or before the user has touched the selector, still works.
 */
export const DEFAULT_LANGUAGE_PAIR: LanguagePair = { sourceLang: 'en', targetLang: 'es' };

/** One selectable language, as returned by `GET /api/languages`. */
export interface LanguageOption {
  code: string;
  displayName: string;
}

/** Response body shape for `GET /api/languages`. */
interface LanguagesResponse {
  languages: LanguageOption[];
}

/**
 * Ephemeral credentials the browser needs to open a WebRTC Realtime session
 * directly with OpenAI. Mirrors the backend's `POST /api/realtime/session`
 * success shape (`{ clientSecret, expiresAt, model, sourceLang, targetLang }`).
 */
export interface RealtimeSessionInfo {
  clientSecret: string;
  expiresAt: number;
  model: string;
  /** The pair actually negotiated — echoes the request, or the backend's default if omitted. */
  sourceLang?: string;
  targetLang?: string;
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
 * @param pair - Source/target language pair to negotiate. Omitted entirely
 *   (no request body) when not given, matching the backend's own
 *   en -> es default (`RealtimeSessionRequest`'s fields are both optional).
 * @returns The client secret, its expiry, and the Realtime model it's scoped to.
 * @throws {Error} With the backend's own error message (e.g. "server is not
 *   configured with an OpenAI API key" on 503, or an unsupported pair on 400)
 *   when the request fails, so callers can surface an understandable reason
 *   rather than a raw status code.
 */
export async function createRealtimeSession(pair?: LanguagePair): Promise<RealtimeSessionInfo> {
  const response = await fetch('/api/realtime/session', {
    method: 'POST',
    ...(pair
      ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pair) }
      : {}),
  });

  if (!response.ok) {
    // A non-2xx body is expected to be JSON (`RealtimeSessionErrorBody`), but
    // swallow a parse failure here too — a plain-text error page from a
    // proxy/gateway in front of the backend shouldn't itself crash error
    // handling, and `message` already has a status-code fallback below.
    const body = (await response.json().catch(() => ({}))) as RealtimeSessionErrorBody;
    const message = body.error ?? `Failed to create realtime session (status ${response.status})`;
    throw new Error(message);
  }

  // A malformed 2xx body (e.g. missing `clientSecret`) is a real bug worth
  // surfacing loudly — unlike the error-body case above, this is never
  // expected to fail parsing, so a thrown SyntaxError here should propagate
  // rather than being masked into a bogus, silently-empty success value that
  // would fail much later as a confusing "Bearer undefined" against OpenAI.
  return (await response.json()) as RealtimeSessionInfo;
}

/**
 * Fetches every language the interpreter supports, in both realtime and
 * cascade modes, so the language pair selector can render its options from
 * data instead of hardcoding a language list of its own.
 *
 * @returns Every supported language's wire code and display name.
 * @throws {Error} If the network request fails or the response is not ok.
 */
export async function getLanguages(): Promise<LanguageOption[]> {
  const response = await fetch('/api/languages');
  if (!response.ok) {
    throw new Error(`Failed to fetch languages (status ${response.status})`);
  }
  const body = (await response.json()) as LanguagesResponse;
  return body.languages;
}
