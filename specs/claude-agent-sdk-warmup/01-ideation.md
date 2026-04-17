---
slug: claude-agent-sdk-warmup
number: 246
created: 2026-04-16
status: ideation
---

# Claude Agent SDK Warm-up via `startup()` / `WarmQuery`

**Slug:** claude-agent-sdk-warmup
**Author:** Claude Code
**Date:** 2026-04-16
**Branch:** perf/claude-agent-sdk-warmup

---

## 1) Intent & Assumptions

- **Task brief:** The Claude Agent SDK 0.2.111 promoted `startup()` and `WarmQuery` to the public TypeScript API. These let the agent runtime pre-spawn the SDK subprocess at server boot, reducing first-query latency. This spec scopes the adoption: add a warm-up call during `ClaudeCodeRuntime` construction (or a post-boot hook), measure perceived latency before and after, and ship only if the improvement is meaningful.

- **Assumptions:**
  - Cold-start latency on the first user message is user-visible, especially on Electron launch.
  - Warm-up is safe to fail silently — if it throws, the runtime should still serve queries normally (just without the warm benefit).
  - `startup()` / `WarmQuery` are additive; no existing call site changes.
  - The measurement harness can piggyback on existing session telemetry — we time from "user hits send" to "first assistant token" for the first message after boot.

- **Out of scope:**
  - Warm-up for non-Claude-Code runtimes (this is SDK-specific).
  - Multi-session pre-warming strategies (only do the default runtime).
  - Complex lifecycle coordination (Electron state, sleep/wake, etc.) — initial scope is a single warm-up at runtime construction.

- **Dependencies:**
  - **Requires `claude-agent-sdk-upgrade-0.2.112` to land first** — `startup()` / `WarmQuery` are only public from 0.2.111.

## 2) Pre-reading Log

### Related Artifacts

- `research/runtime-upgrades/claude-agent-sdk/0.2.89-to-0.2.112/changelog.md` — Entry for 0.2.111: "`startup()` and `WarmQuery` are now part of the public TypeScript API"
- `research/runtime-upgrades/claude-agent-sdk/0.2.89-to-0.2.112/impact-assessment.md` — Section "F. `startup()` / `WarmQuery` public API"

### Affected Files (Tentative)

- `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts` — add warm-up in construction or a lifecycle hook
- `apps/server/src/services/runtimes/claude-code/sdk-utils.ts` — potentially house the warm-up helper
- Telemetry/logging layer — time-to-first-token instrumentation (if not already available)

### Related ADRs

- **ADR-0089** (SDK Import Confinement): Warm-up code stays inside `services/runtimes/claude-code/`. No boundary impact.

## 3) Scope

### Must Do — Measurement Baseline

- Instrument "time to first assistant token" for the first message after server boot. If existing telemetry already captures this, reuse it.
- Collect baseline across ~5 cold-start runs to establish a p50/p95.

### Must Do — Warm-up Integration

- Call `startup()` or instantiate `WarmQuery` once during `ClaudeCodeRuntime` construction (or a lifecycle hook).
- Wrap in a try/catch — warm-up failures must not block server boot.
- Log warm-up duration for observability.

### Must Do — Validation

- Collect post-warm-up measurements across ~5 runs.
- Compare p50/p95 latency. Ship only if p50 improves by ≥100 ms (or a threshold agreed during spec-create).
- Document the measurement in the spec's `04-implementation.md`.

### Should Do — Tests

- Unit test that warm-up is called at runtime construction.
- Unit test that a warm-up failure does not prevent `sendMessage` from working.

### Rollback Criteria

- Warm-up introduces startup errors or timing regressions in other code paths → revert.
- Measured p50 improvement below threshold → keep the code behind a feature flag or revert and keep the spec marked `superseded` with the measurement recorded.

## 4) Open Questions

- Does `startup()` return a `WarmQuery` that we must hold onto to realize the benefit, or is the subprocess implicitly warmed? Read the 0.2.111 types during implementation.
- Can we warm multiple backends (e.g., for multiple agents with different permission modes), or is there only one warm pool? First implementation phase answers this.
