---
number: 261
title: Always Launch Sessions with allowDangerouslySkipPermissions for Instant Mode Switching
status: accepted
created: 2026-06-08
spec: persist-per-session-settings
superseded-by: null
---

# 261. Always Launch Sessions with allowDangerouslySkipPermissions for Instant Mode Switching

## Status

Accepted

Companion to [ADR-0260](0260-persist-per-session-settings-via-narrow-core-port.md) (per-session settings persistence). Builds on [ADR-0240](0240-passthrough-permission-modes-to-sdk.md) (permission-mode passthrough).

## Context

The Claude Agent SDK refuses `query.setPermissionMode('bypassPermissions')` on a **running** session unless that session was _launched_ with `allowDangerouslySkipPermissions: true` (`--dangerously-skip-permissions`). DorkOS set that flag only when a session **started** in bypass (`message-sender.ts`), so switching an active `default`/`acceptEdits`/`plan` session to bypass threw `Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions`. `updateSession` caught this, reverted the in-memory mode, and re-threw → the route returned **422**, while the client's optimistic UI still showed bypass — so the mode appeared set but did not take effect for the in-flight turn (it only applied on the next message, which relaunches with the flag).

We verified empirically with an isolated SDK probe that `allowDangerouslySkipPermissions` is a **pure capability gate**: in `default` mode with the flag set, `canUseTool` is still invoked and a `deny` still blocks the tool — identical to not passing the flag. This matches the documented evaluation order (Hooks → Deny → Permission mode → Allow → `canUseTool`), where `default` falls through to `canUseTool` regardless of the flag. The SDK only consults the flag when `permissionMode === 'bypassPermissions'`.

## Decision

We will always launch Claude Code SDK queries with `allowDangerouslySkipPermissions: true`, decoupled from the session's current mode. The effective gate remains `permissionMode`: `default`/`acceptEdits`/`plan`/`dontAsk` behave exactly as before (verified), while every running query now holds the latent capability to switch to `bypassPermissions` instantly via `setPermissionMode`. The live `setPermissionMode` call in `updateSession` becomes best-effort: the user's chosen mode is persisted first (ADR-0260 write-through) so intent is durable even if the control request fails, and a failed live apply is never surfaced as a 422/revert — it simply takes effect on the next turn.

## Consequences

### Positive

- Instant mid-run permission-mode switching, including escalation to `bypassPermissions` — no relaunch, no waiting for the turn to end.
- Eliminates the 422/revert and the "UI shows bypass but the turn still prompts" confusion.
- `default`/`acceptEdits`/`plan` gating is unchanged (empirically verified inert), so no loss of approval prompts where they are expected.
- Simplifies `message-sender.ts` — the flag is no longer conditional on mode.

### Negative

- Every Claude Code session carries the latent capability to skip permissions. The actual skip occurs only when DorkOS sets `permissionMode: 'bypassPermissions'` (user-initiated in the UI, or a binding/Tasks config). No tool or prompt can self-escalate — `setPermissionMode` is a host control request, not a tool — so prompt injection cannot flip the mode.
- We intentionally trade away the SDK's built-in "not launched with the flag" guardrail in favor of DorkOS owning the gate via `permissionMode` + `canUseTool`.
- Relies on the verified inertness of the flag in non-bypass modes; if a future SDK version changes that, this decision must be revisited (covered by a regression test).

## Alternatives Considered

- **Graceful deferral** (apply bypass only on the next turn, swallow the SDK refusal): safer-feeling but worse UX — the in-flight turn keeps prompting. Rejected per the product decision to favor instant control.
- **Interrupt and relaunch the active query in bypass**: loses in-flight work and is disruptive. Rejected.
- **Leave as-is**: the 422/revert is a real bug and confuses operators. Rejected.

## References

- SDK probe (this session): `default + allowDangerouslySkipPermissions` behaves identically to `default` alone (`canUseTool` called, deny honored); `bypassPermissions` skips `canUseTool`.
- Official docs — permission evaluation order and `setPermissionMode` (streaming-only): https://code.claude.com/docs/en/agent-sdk/permissions
- `@anthropic-ai/claude-agent-sdk@0.3.168` `sdk.d.ts`: `allowDangerouslySkipPermissions` — "Required when using `permissionMode: 'bypassPermissions'`".
- `research/20260315_agent_runtime_permission_modes.md`
- `apps/server/src/services/runtimes/claude-code/messaging/message-sender.ts` (launch point), `.../sessions/session-store.ts` (`updateSession` live apply).
