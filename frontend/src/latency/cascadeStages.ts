/**
 * Canonical order cascade pipeline stages occur in, for one utterance
 * (issue #10) — mirrors `CascadeLatencyStages` in
 * `backend/CascadeAudioSession.cs` exactly, string-for-string. Only used
 * internally by `cascadeLatencyAdapter.ts` to find "the nearest earlier
 * stage this utterance already has a mark for" when computing a per-stage
 * delta — every other consumer of `LatencyReport` (the panel, the
 * reducer/selectors) treats stage names as opaque strings, per issue #10's
 * transport-agnostic requirement for the UI-facing domain.
 */
export const CASCADE_STAGE_ORDER = [
  'speechEnd',
  'sttFirstPartial',
  'sttFinal',
  'mtFirstToken',
  'mtFinal',
  'ttsFirstByte',
  'ttsEnd',
] as const;

export type CascadeStage = (typeof CASCADE_STAGE_ORDER)[number];

/** Narrows an unknown wire `stage` string to a recognized {@link CascadeStage}, so an unrecognized value (future stage, typo, wire drift) is dropped rather than silently inserted into the ordered breakdown at the wrong place. */
export function isCascadeStage(stage: string): stage is CascadeStage {
  return (CASCADE_STAGE_ORDER as readonly string[]).includes(stage);
}
