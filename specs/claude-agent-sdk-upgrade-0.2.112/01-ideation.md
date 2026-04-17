---
slug: claude-agent-sdk-upgrade-0.2.112
number: 245
created: 2026-04-16
status: ideation
---

# Claude Agent SDK Upgrade to 0.2.112

**Slug:** claude-agent-sdk-upgrade-0.2.112
**Author:** Claude Code
**Date:** 2026-04-16
**Branch:** runtime/claude-agent-sdk-upgrade-0.2.112

---

## 1) Intent & Assumptions

- **Task brief:** Upgrade `@anthropic-ai/claude-agent-sdk` from `0.2.89` → `0.2.112` across all workspace packages, and bundle all feasible feature adoptions that have no external dependencies. The upgrade itself is low-risk (both "breaking" changes in the window are non-issues for our codebase), but several valuable additive capabilities landed that we should absorb in a single push: Opus 4.7 support (required), richer termination signaling (`terminal_reason`), memory observability (`memory_recall` events + `memory_paths`), and finer-grained status reporting (`SDKStatus = 'requesting'`).

- **Assumptions:**
  - The `AgentRuntime` interface (ADR-0089) is the abstraction boundary; new SDK fields flow out via `StreamEvent` variants in `@dorkos/shared/types`, not by leaking SDK types.
  - We already spread `process.env` explicitly at `message-sender.ts:190-194`, so the 0.2.111 `options.env` overlay change is behaviorally equivalent for us. No code change needed, no eslint-disable removal (defensive spread stays).
  - `options.sandbox` is unused — the 0.2.91 `failIfUnavailable` default change is irrelevant.
  - The server's stream handling already passes unknown `system/*` subtypes through the catch-all logger, so adding new mapper branches is additive.
  - The UI can pick up new optional fields on existing `StreamEvent` variants without breaking existing renders.

- **Out of scope:**
  - **`startup()` / `WarmQuery` adoption** — deferred to `specs/claude-agent-sdk-warmup/` (gated on perf measurement).
  - **`SDKUserMessage.shouldQuery: false`** — no current DorkOS feature needs it.
  - **Per-tool `permission_policy` on remote MCP servers** — we have no remote MCP servers yet; revisit when marketplace adapters (ADR-0239) start using remote transports.
  - **Rich UI beyond a small indicator** for `terminal_reason` — we add a minimal chip; larger UX work (e.g., "continue" button on `max_turns`) is separate.

## 2) Pre-reading Log

### Research Artifacts

- `research/runtime-upgrades/claude-agent-sdk/0.2.89-to-0.2.112/changelog.md` — Full categorized changelog across 23 releases
- `research/runtime-upgrades/claude-agent-sdk/0.2.89-to-0.2.112/impact-assessment.md` — Per-change codebase impact, effort estimates, and ADR conflict checks
- `research/runtime-upgrades/claude-agent-sdk/0.2.89-to-0.2.112/triage-decisions.md` — User-approved scope for this spec

### Package Manifests

- `package.json` — root workspace, declares `"@anthropic-ai/claude-agent-sdk": "0.2.89"`
- `apps/server/package.json` — server workspace, `"0.2.89"`
- `packages/cli/package.json` — CLI workspace, `"0.2.89"`

### Affected Source Files

- `apps/server/src/services/runtimes/claude-code/message-sender.ts:223-226` — PermissionMode type cast (remove after bump)
- `apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts:40-531` — adds mapper branches for `memory_recall`, reads `terminal_reason` on result, reads `status` on system/status, reads `memory_paths` on system/init
- `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts` — may need to store `memoryPaths` on session metadata
- `packages/shared/src/types/*` — extend `StreamEvent` variants: `session_status` gets `terminalReason?`, `system_status` gets `status?`, new `memory_recall` variant
- `apps/client/src/**` — render a small chip for non-`completed` `terminal_reason`; optionally surface memory-path metadata

### Related ADRs (must stay consistent)

- **ADR-0089** (SDK Import Confinement): All new SDK field reads stay inside `services/runtimes/claude-code/`. Stream events carry data out.
- **ADR-0143** (Retry over Circuit Breaker): `terminal_reason` complements retry semantics — a `'max_turns'` termination is structurally different from an error, reinforcing the ADR's stance.
- **ADR-0239** (Plugin Activation): No change to plugin activation; per-tool MCP policy feature deferred.
- **ADR-0240** (Permission Passthrough): The `'auto'` cleanup reinforces the passthrough model — we no longer need a type-hole cast.

## 3) Scope

### Must Do — Version Bump

- Bump `@anthropic-ai/claude-agent-sdk` from `0.2.89` to `0.2.112` in all three workspace manifests
- Run `pnpm install` to update the lockfile
- Verify `pnpm typecheck && pnpm build && pnpm test:run` all pass with no code changes
- **Auto-benefits** (no code changes): GHSA-5474-4w2j-mq4c security patch; 8 bug fixes (multibyte text, MCP child cleanup, resume-session leak, concurrent-query scalability, getContextUsage agents breakdown, error-report unhandledRejection, structured-output retry fix, await-using disposal race)

### Must Do — Breaking-Change Verification

- Confirm `options.env` overlay semantics are unaffected (we already spread `process.env` explicitly). No action needed but include in verification checklist.
- Confirm no `sandbox` usage remains unused. No action needed.

### Must Do — Cleanup (Enabled by Bump)

- Remove the `PermissionMode 'auto'` type-assertion workaround at `message-sender.ts:223-226`. The `as typeof sdkOptions.permissionMode` cast and the justifying comment both come out.

### Must Do — Opus 4.7 Support

- No code changes required — once the SDK version lands, `model: 'claude-opus-4-7'` flows through the existing `sdkOptions.model` assignment. Validate via a smoke test selecting Opus 4.7 on a session.

### Must Do — `terminal_reason` Plumbing + UI Chip

- Extend `StreamEvent['session_status']` data with optional `terminalReason?: 'completed' | 'aborted_tools' | 'max_turns' | 'blocking_limit' | string`
- In `sdk-event-mapper.ts` result-message handler, read `result.terminal_reason` and include in the emitted `session_status` event
- Persist `terminalReason` on session state (if we already persist other session_status fields)
- UI: render a minimal indicator (e.g., a `<Badge>` on the last assistant message) for non-`completed` values. Keep copy terse; no new UX surfaces beyond the chip.

### Must Do — `memory_recall` + `memory_paths` Observability

- Add new `StreamEvent` variant `memory_recall` with `data: { path?: string; content?: string }` (fields determined by SDK event shape)
- Handle `message.subtype === 'memory_recall'` in `sdk-event-mapper.ts` alongside other `system.*` subtypes
- Read `memory_paths` off `system.init` messages; expose on `AgentSession` metadata via existing session-broadcaster path
- UI: initially surface as a subtle informational event; mirror how `api_retry` is presented

### Must Do — Richer `SDKStatus`

- Extend `StreamEvent['system_status']` with optional `status?: string` (e.g., `'requesting'`, plus any other values the SDK emits)
- In `sdk-event-mapper.ts:115-125`, read `msg.status` when present and forward
- UI: optionally use for richer spinner copy; fallback remains the existing body/message text

### Should Do — Validation

- Full `pnpm lint && pnpm typecheck && pnpm build && pnpm test:run` green before merge
- Add tests for the new mapper branches (`terminal_reason`, `memory_recall`, `status`) — use `FakeAgentRuntime` scenarios per `.claude/rules/testing.md`
- Manual smoke: open a session, send a message, observe `session_status` carries `terminalReason`; trigger a tool-abort to see `'aborted_tools'`; verify Opus 4.7 model selection works end-to-end

### Nice to Have

- None — aggressive-adoption items are already absorbed above.

## 4) Rollback Criteria

Revert the bump (and feature-adoption code) if any of the following occur:

- `pnpm test:run` regression that can't be resolved in-spec
- Observable regression in the Claude Code CLI subprocess (e.g., resume-session failures, env vars not inherited)
- `terminal_reason` or `memory_recall` events break existing transcript rendering or session persistence
- Any sandbox-related failure mode surfaces despite our non-usage (e.g., SDK starts requiring sandbox config by default)

Rollback is safe because this is a pure version bump plus additive StreamEvent variants — no schema migrations, no data format changes.

## 5) Implementation Order

1. Bump version across all three workspaces + `pnpm install`
2. Run validation (`typecheck`/`build`/`test`) — fail fast if anything breaks pre-cleanup
3. Remove the `PermissionMode 'auto'` type cast
4. Extend shared `StreamEvent` variants (pure type additions)
5. Add mapper branches + field reads in `sdk-event-mapper.ts`
6. Update session-store / broadcaster to carry the new fields if applicable
7. Add UI rendering (chip for `terminalReason`, subtle memory_recall surface, richer status copy)
8. Write/update tests (mapper unit tests + one integration scenario)
9. Manual smoke test with Opus 4.7 + a long-running tool-use path
10. Final validation and PR

## 6) Open Questions

- Does `session_status` in the UI already have a "chip zone" for optional metadata, or does rendering a `terminalReason` require a new slot? Investigate during implementation; keep scope minimal if a new slot is needed.
- What exact shape does the `system/memory_recall` payload take (key/path/content)? The CHANGELOG.md entry describes the intent but not the field names. First spec-execute task should grep the SDK dist types to confirm before extending `StreamEvent`.
