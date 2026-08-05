# CLAUDE.md — how this project was built with a coding agent

This file is the agent-usage log the brief requires. It describes how Claude Code
(Anthropic's CLI agent) was directed on this project: the workflow, the standing
instructions, where the agent's output was accepted, and where it was overridden.
It doubles as project context for future agent sessions.

## Workflow: docs → issues → commits

1. **Context documents first.** The partner brief was converted verbatim to
   `docs/BRIEF.md`, and stack choices were argued in `docs/tech-stack.md`
   (chosen vs. rejected alternatives) before any code existed.
2. **Planning pass.** A one-off planning agent read those documents and produced
   the GitHub issue set (#1–#18): scaffolding, Realtime mode, the cascade stages
   (transport → STT → MT → TTS), language pairs, mode toggle, latency
   instrumentation, barge-in, error hardening, tests, benchmarks, write-up, docs,
   and two cut-line stretch issues. Each issue carries scope and acceptance
   criteria the implementation was checked against.
3. **Issue-driven implementation.** Work proceeded one issue at a time, usually
   backend half then frontend half, each landing as its own scoped commit
   referencing the issue (see `git log --reverse`). No "initial commit" dumps.
4. **Review pass.** After #12, a dedicated multi-agent review was run: four
   read-only reviewer agents (backend core, backend providers, frontend
   transport, frontend UI/state) audited the codebase against the brief's code
   quality bar; ~35 findings were triaged, and the accepted ones were applied as
   a series of scoped fix commits (bugs, dedup, dead-code removal, file splits).

## Standing instructions the agent worked under

- **Doc comments carry invariants and rationale**, not restatements — threading
  assumptions, id-space distinctions, backpressure choices, issue references
  (#N). This is enforced by convention across every file.
- **Every non-trivial test names the user-facing behavior that breaks if it's
  removed** ("catches stale TTS audio talking over the caller after a
  barge-in"), tests live in dedicated directories, and behavior — not
  implementation — is asserted.
- **Provider abstractions are the load-bearing wall**: everything vendor-specific
  lives in one provider file; the pipeline talks only to interfaces. The review
  pass and the #17 swap demo both audited this boundary explicitly.
- **Enums over bool flags / string literals** for fixed option sets
  (`SttSegmentKind` replaced three mutually-exclusive bools during review).
- Commit messages describe all staged changes; squash-merge PRs; no AI
  attribution in commits or PRs.

## Sub-agents: tried, then deliberately removed

Mid-project, three project-scoped sub-agents were added (`backend-implementor`,
`frontend-implementor`, `po-verifier`) and used to implement several issues and
verify acceptance criteria. They were **removed** near the end
(`9d32a3b Remove project subagent definitions`): the delegation round-trips made
iteration slower, and the implementor output (running on a smaller model)
needed enough correction that doing the work directly in the main session was
faster and better. Read-only *review* fan-outs remained valuable — finding
problems parallelizes well; fixing them didn't. That asymmetry is the main
harness lesson of this project.

## Accepted vs. overridden

**Accepted largely as produced:** the provider interface designs and their
exception taxonomy, the WebSocket protocol envelope, the barge-in cancellation
model, the latency-mark scheme, the review pass's bug findings (each verified
against the code before fixing — e.g. a CancellationTokenSource dispose race in
barge-in, a WebRTC `disconnected` state treated as fatal, latency turn-id
collisions after reconnect).

**Directed or overridden by the human:**

- Removing the implementor sub-agents (above) — a direct correction of the
  agent's own workflow proposal.
- The decision to run the full architect-level review, and the instruction to
  apply fixes rather than just report.
- Scope calls on review findings (which cleanups were worth churn vs. noted as
  follow-ups) were proposed by the agent, and follow-ups were then explicitly
  green-lit ("apply those fixes") rather than assumed.
- Model choice for the Anthropic MT provider (#17): the agent flagged the
  latency-vs-quality tradeoff and defaulted to `claude-haiku-4-5` for parity
  with `gpt-4o-mini`, with an env override rather than a hardcoded choice.

## What a future agent session should know

- Global user rules (communication, code quality, testing, git workflow,
  frontend conventions) come from the user's `~/.claude` configuration and
  apply here; this file adds the project-specific layer.
- `dotnet test` from `backend/` and `npx vitest run` from `frontend/` must both
  be green before any commit; both suites run offline (no API keys needed).
- The cascade wire protocol is documented in `backend/CascadeProtocol.cs`;
  transport lives in `backend/CascadeSession.cs`; orchestration in
  `backend/CascadePipeline.cs`. The frontend's mode-agnostic seam is
  `frontend/src/session/InterpreterSession.ts`.
