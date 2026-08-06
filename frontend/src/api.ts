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
 * One utterance's latency breakdown as posted to the backend — the wire form
 * of `LatencyReport` plus the mode recovered from its id prefix (see
 * `modeOfPrefixedId` in `session/InterpreterSession.ts`). The `mode` union is
 * spelled out (rather than importing `SessionMode`) so this module keeps its
 * one-way dependency direction: session code imports from `api.ts`, never the
 * reverse.
 */
export interface UtteranceMetricsPayload {
  utteranceId: string;
  mode: 'realtime' | 'cascade';
  /** Perceived end-to-end latency in ms, or `null` if this utterance never completed one. */
  endToEndMs: number | null;
  stages: { stage: string; ms: number }[];
}

/** One transcript entry as posted to the backend — the wire form of `TranscriptEntry`. */
export interface TranscriptEntryPayload {
  utteranceId: string;
  lane: 'source' | 'target';
  text: string;
  final: boolean;
  truncated?: boolean;
}

/**
 * One conversation's full captured metrics, posted at session stop so
 * benchmark numbers survive the page and become comparable across sessions
 * (`POST /api/metrics/conversations`; issue #10 revisited — see
 * docs/tech-stack.md's amended entry). The id is client-generated per Start
 * press; the backend upserts on it, so re-posting is safe.
 */
export interface ConversationMetricsPayload {
  conversationId: string;
  sourceLang: string;
  targetLang: string;
  /** Client clock (`Date.now()`) at Start — labels/orders conversations only, never enters latency math. */
  startedAtMs: number;
  /** Client clock at Stop; same caveat as `startedAtMs`. */
  endedAtMs: number;
  utterances: UtteranceMetricsPayload[];
  transcript: TranscriptEntryPayload[];
  /** The session's STT model pick, omitted for the default (backend stamps what ran). */
  sttModel?: string;
  /** The session's MT provider pick, omitted for the default. */
  mtProvider?: string;
  /** `'experiment'` for a fixture replay run (Lab P3); omitted means live. */
  kind?: 'live' | 'experiment';
  /** Word Error Rate against the run's ground truth; omitted for live sessions. */
  wer?: number;
  /** Name of the replayed fixture; omitted for live sessions. */
  fixture?: string;
  /** The fixture's reference transcript, stored so past runs can re-render their diff. */
  groundTruth?: string;
}

/** One stored conversation in full, per `GET /api/metrics/conversations/{id}` — what the run report renders. */
export interface ConversationDetail {
  conversationId: string;
  sourceLang: string;
  targetLang: string;
  translationProvider: string;
  sttModel: string;
  mtModel: string;
  ttsModel: string;
  startedAtMs: number;
  endedAtMs: number;
  kind: string;
  wer: number | null;
  fixture: string | null;
  groundTruth: string | null;
  utterances: UtteranceMetricsPayload[];
  transcript: TranscriptEntryPayload[];
}

/**
 * Fetches one stored conversation in full.
 *
 * @param conversationId - The conversation to load.
 * @returns The stored detail.
 * @throws {Error} If the request fails or the id is unknown (404).
 */
export async function getConversationDetail(conversationId: string): Promise<ConversationDetail> {
  const response = await fetch(`/api/metrics/conversations/${encodeURIComponent(conversationId)}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch conversation detail (status ${response.status})`);
  }
  return (await response.json()) as ConversationDetail;
}

/** One stored conversation, as returned by `GET /api/metrics/conversations` — a Lab table row. */
export interface ConversationListing {
  conversationId: string;
  sourceLang: string;
  targetLang: string;
  translationProvider: string;
  startedAtMs: number;
  endedAtMs: number;
  realtimeUtteranceCount: number;
  cascadeUtteranceCount: number;
  sttModel: string;
  mtModel: string;
  ttsModel: string;
  kind: string;
  wer: number | null;
  realtimeEndToEndMedianMs: number | null;
  cascadeEndToEndMedianMs: number | null;
  baseline: boolean;
}

/** Median/p95 over one population of durations, per the summary endpoint. */
export interface LatencyStatsInfo {
  count: number;
  medianMs: number;
  p95Ms: number;
}

/** One (mode, MT provider) group of the cross-conversation summary. */
export interface SummaryGroup {
  mode: 'realtime' | 'cascade';
  translationProvider: string | null;
  conversationCount: number;
  utteranceCount: number;
  endToEnd: LatencyStatsInfo | null;
  stages: { stage: string; stats: LatencyStatsInfo }[];
}

/** Which conversations a summary draws from — the Lab's baseline pane reads `'baseline'` (the pinned set). */
export type SummaryScope = 'all' | 'baseline' | 'current';

/**
 * Fetches the cross-conversation latency summary.
 *
 * @param scope - Which conversations contribute; defaults to all.
 * @param group - `'mode'` merges cascade's MT providers into one group (stats
 *   computed over the merged population server-side); omitted keeps the
 *   per-provider grouping.
 * @returns Per-group latency statistics.
 * @throws {Error} If the network request fails or the response is not ok.
 */
export async function getSummary(scope: SummaryScope = 'all', group?: 'mode'): Promise<{ groups: SummaryGroup[] }> {
  const response = await fetch(`/api/metrics/summary?scope=${scope}${group ? `&group=${group}` : ''}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch summary (status ${response.status})`);
  }
  return (await response.json()) as { groups: SummaryGroup[] };
}

/**
 * Pins the given conversations as the baseline set, replacing any previous set.
 *
 * @param conversationIds - The new baseline set; empty unpins everything.
 * @throws {Error} If the network request fails or the backend rejects it.
 */
export async function pinBaseline(conversationIds: string[]): Promise<void> {
  const response = await fetch('/api/metrics/baseline', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationIds }),
  });
  if (!response.ok) {
    throw new Error(`Failed to pin baseline (status ${response.status})`);
  }
}

/**
 * Fetches every stored conversation, most recently started first.
 *
 * @returns Lab table rows: per-conversation config and per-mode medians.
 * @throws {Error} If the network request fails or the response is not ok.
 */
export async function getConversations(): Promise<ConversationListing[]> {
  const response = await fetch('/api/metrics/conversations');
  if (!response.ok) {
    throw new Error(`Failed to fetch conversations (status ${response.status})`);
  }
  return ((await response.json()) as { conversations: ConversationListing[] }).conversations;
}

/**
 * Posts one conversation's captured metrics for persistence.
 *
 * @param payload - The conversation's accumulated latency reports and transcript.
 * @throws {Error} If the network request fails or the backend rejects the
 *   report — callers are expected to log-and-continue, since losing one
 *   metrics post must never break session teardown itself.
 */
export async function reportConversationMetrics(payload: ConversationMetricsPayload): Promise<void> {
  const response = await fetch('/api/metrics/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    // Lets an in-flight post survive the page being closed right after Stop —
    // the exact moment this request is always made.
    keepalive: true,
  });

  if (!response.ok) {
    throw new Error(`Failed to report session metrics (status ${response.status})`);
  }
}

/** The MT (machine translation) stage: the one cascade stage where the provider is a config choice. */
export interface MtStageInfo {
  provider: string;
  model: string;
}

/**
 * Which models power each paradigm, per `GET /api/architecture` — backend
 * truth from the providers' own constants, so the architecture cards can't
 * drift from what actually runs when `TRANSLATION_PROVIDER` flips.
 */
export interface ArchitectureInfo {
  realtime: { model: string };
  cascade: {
    stt: { model: string };
    mt: MtStageInfo;
    /** The other MT provider — what selecting it would run (the provider-swap demo). */
    mtAlternative: MtStageInfo;
    tts: { model: string };
    /** Every STT model a session may select (Lab P1); the first is the default. */
    sttOptions: string[];
  };
}

/**
 * A session's per-stage model picks (Lab P1). Omitted fields mean the
 * backend defaults — sent in cascade `session.start` and stamped into the
 * conversation's persisted metrics so Lab rows group by what actually ran.
 */
export interface CascadeStageModels {
  sttModel?: string;
  mtProvider?: string;
}

/**
 * Fetches the per-paradigm model architecture.
 *
 * @returns Models per paradigm/stage, including the currently selected MT provider.
 * @throws {Error} If the network request fails or the response is not ok.
 */
export async function getArchitecture(): Promise<ArchitectureInfo> {
  const response = await fetch('/api/architecture');
  if (!response.ok) {
    throw new Error(`Failed to fetch architecture (status ${response.status})`);
  }
  return (await response.json()) as ArchitectureInfo;
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
