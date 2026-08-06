import type { SessionMode } from '../session/InterpreterSession';

/** Perceived-latency targets from `docs/BRIEF.md`, keyed by mode. */
export const BENCHMARK_TARGET_MS: Record<SessionMode, number> = {
  realtime: 1_500,
  cascade: 3_000,
};
