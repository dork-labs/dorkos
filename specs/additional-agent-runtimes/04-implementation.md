# Implementation Summary: Additional Agent Runtimes: OpenCode + Codex

**Created:** 2026-07-02
**Last Updated:** 2026-07-02
**Spec:** specs/additional-agent-runtimes/02-specification.md

## Session

**Worktree:** `~/.dork/workspaces/dorkos/DOR-180` (branch `DOR-180`, based on origin/main @ ec79a13b)
**Tracker:** DOR-180

## Progress

**Status:** In Progress
**Tasks Completed:** 20 / 27

## Tasks Completed

### Session 1 - 2026-07-02

- Task 1.1 (#6): Add Session.runtime field and 'opencode' to the runtime enum
- Task 1.2 (#7): Add runtimes.\* user-config block with a semver conf migration ('0.47.0' placeholder)
- Task 1.5 (#10): Build the runtimeConformance shared Vitest suite (16 tests, test-mode + mocked claude-code)
- Task 1.6 (#11): RuntimeDescriptor client registry, OpenCode/Codex icons, RuntimeMark on session rows
- Task 1.3 (#8): GET /api/sessions registry aggregation (`{sessions, warnings?}` envelope, 2s/runtime budget, ?runtime= filter) + GET/:id + PATCH runtime fill
- Task 1.4 (#9): session-list-broadcaster fan-in across AgentRuntime[] (per-runtime failure isolation)
- Task 1.7 (#12): status-bar RuntimeItem chip (+ review-gate fix round: canSelect from sessions-cache row presence; display from row runtime / ?runtime= selection — active-caps query eliminated from the chip path)
- Task 1.8 (#13): ?runtime= launch param → first-send hint → session_metadata (first-turn-only gate); SessionLaunchPopover carries agent runtime; optimistic row seeded with effective runtime
- Task 2.1 (#14): @openai/codex-sdk@0.142.5 pinned; ESLint confinement restructure (apps/server/eslint.config.js shared ban constants); codex/ stub + real checkDependencies
- Task 3.1 (#20): @opencode-ai/sdk@1.17.13; opencode/ confinement + stub + checkDependencies (auth via `opencode auth list` parsing); SDK recon for P3 recorded in task notes
- Task 2.2 (#15): Codex approval/permission verification — LIVE CLI probes (SDK vendors the binary): supportsToolApproval FALSE, modes = default/acceptEdits/bypassPermissions -> read-only/workspace-write/danger-full-access (approvalPolicy 'never'), interrupt = per-turn AbortSignal (generator throws), stream errors NON-terminal. `codex/NOTES.md`
- Task 2.3 (#16): codex_threads table (migration 0019, auto-generated) + CodexThreadMap (first-write-wins, session_metadata untouched)
- Task 2.4 (#17): Codex event mapper — 8-event exhaustive mapping, cumulative-snapshot->suffix-delta text, exactly-one-'done' guarantee, no approval events (regression-tested); mock helpers for 2.5
- Task 3.2 (#21): OpenCode sidecar verification (source-derived @ v1.17.13 tag): SINGLE instance (per-request directory routing), permissive-default permissions -> spawn with {edit/bash/webfetch:'ask'}, port-0 safe, v1 SDK surface, auth-list env-var false-missing bug flagged for 3.3. `opencode/NOTES.md`
- Task 2.5 (#18): CodexRuntime facade complete + registered (index.ts ~219-237). NOTES-honest: approval-free, explicit ThreadOptions, per-turn AbortController, getInternalSessionId undefined (C1 rekey trap). LIMITATION: SDK has no thread-listing API -> in-memory registry + EventLog history; post-restart Codex sessions not rediscovered (resume works via codex_threads). skipGitRepoCheck always true (flag for review). Static model catalog (gpt-5.5 default).
- Task 3.3 (#22): opencode serve sidecar manager - lazy spawn, per-boot password + ask-config env injection, backoff ladder (500ms->8s, 6 attempts, 30s uptime reset), SIGTERM->SIGKILL teardown wired into shutdownServices(); implements OpenCodeClientProvider (getClient/peekClient); auth-probe env-var fix applied (+ review-gate fix round: shutdown-during-boot race guard)
- Task 3.4 (#23): OpenCode SSE event mapper - 50 tests; handles BOTH wire styles (message.part.delta is a wire event ABSENT from the SDK union -> 3.6 must feed RAW parsed events); session.idle = authoritative terminal; approval echo = Permission.id, respond once/reject only
- Task 3.5 (#24): OpenCode session mapper - deterministic UUIDv5 for adopted ses\_\* ids, throwing-fs-mock SDK-only proof, promptAsync verdict (204 + SSE), provider contract with peekClient never-boots
- Task 4.1 (#27): needs-setup UX - RuntimeSetupDialog/DependencyInstallHint/useRuntimeRequirements (entities/runtime), RuntimeItem needs-setup split + Add-a-runtime entry, SessionLaunchPopover readiness gating, TurnFailedNotice keyed to turn_end{terminalReason:'error'} (the signal that actually fires; typed error events don't ride /events)

## Files Modified/Created

**Source files:**

- `packages/shared/src/schemas.ts` (Session.runtime required), `packages/shared/src/mesh-schemas.ts` ('opencode' + dual-use TSDoc), `packages/shared/src/config-schema.ts` (runtimes.\* block)
- `apps/server/src/services/core/config-manager.ts` (backfillRuntimesDefaults @ '0.47.0')
- `apps/server/src/services/runtimes/claude-code/sessions/transcript-reader.ts`, `apps/server/src/services/runtimes/test-mode/session-registry.ts` (runtime tagging)
- `packages/icons/src/adapter-logos.tsx` (OpenCodeLogo, CodexLogo)
- `apps/client/src/layers/entities/runtime/` (runtime-descriptors.ts, RuntimeMark.tsx, barrel), `entities/session/ui/SessionRow{Full,Compact}.tsx`, `features/agent-hub/ui/tabs/ConfigTab.tsx` (RUNTIME_LABELS deleted)
- `apps/client/src/layers/features/chat/model/use-session-submit.ts` (optimistic session runtime placeholder)
- `packages/test-utils/src/mock-factories.ts`, `packages/test-utils/src/runtime-conformance.ts` (+ index barrel)

**Test files:**

- `packages/shared/src/__tests__/schemas.test.ts`, `mesh-schemas.test.ts`, `config-schema.test.ts`
- `apps/server/src/services/core/__tests__/config-manager.test.ts`
- `apps/server/src/services/runtimes/{test-mode,claude-code}/__tests__/conformance.test.ts` (NEW)
- `apps/client`: entities/runtime tests (NEW), SessionRow.test.tsx, SessionsView.test.tsx (NEW), ConfigTab.test.tsx + 9 fixture updates

## Batch 2 notes

- Key SDK recon (from 2.1/3.1 agents): Codex SDK has **8** thread event types (not 7) and **no tool-approval event** in the 0.142.5 type surface — task 2.2 verifies how `approvalPolicy: 'on-request'` surfaces; interrupt = `TurnOptions.signal`; `CodexOptions.env` replaces (not merges) process env. OpenCode SDK ships `createOpencodeServer` (does NOT set `OPENCODE_SERVER_PASSWORD` itself — server-manager must inject); nearly every call takes `query.directory` (single-sidecar likely viable); 32-member SSE Event union enumerated; `session.abort` = interrupt; permission respond = `postSessionIdPermissionsPermissionId` (`once|always|reject`).
- Batch 2 review: PASS_WITH_FIXES. Criticals fixed (1.7 chip canSelect/display); Importants applied (Transport.postMessage runtime option lifted to the interface; DirectTransport intentional-drop comment). Reviewer minors deferred: `Date.parse` NaN sort pin in aggregate-session-list (later polish), dormant ?runtime= on auto-select deep links (spec-accepted).
- Orchestrator incident: a `tsc -b --force` verification emitted ~5.1k compiled artifacts into apps/client/src (not gitignored); fully cleaned via git ls-files pattern delete + tsbuildinfo removal. Use `tsc -b --noEmit` for client checks.

## Batch 4 notes

- Review PASS_WITH_FIXES: (1) server-manager shutdown-during-boot race — fixed via agent resume round with pinned regression test; (2) requirements query focus-refetch over synchronous server probes — fixed (staleTime 5min, refetchOnWindowFocus false). Follow-up worth a ticket: make checkDependencies probes async (execFile) or add a short-TTL server cache — sync probes predate this spec.
- Minors routed: SessionLockManager extraction to services/session/ + opencode barrel exports + interaction-timeout auto-deny timer (REQUIRED) + restart-resubscribe pattern + directory-from-OpenCode-Session -> task 3.6. Add-a-runtime single-runtime reachability doc -> 4.2. session-registry no-eviction note -> 2.6.
- Server-side gap (follow-up candidate): typed error StreamEvents don't ride the durable /events stream, so Codex/OpenCode failure DETAILS can't render live (generic copy shown; turn_end lifecycle carries the error signal).
- Latent dead path found by 4.1: legacy `setSessionStatus` has zero callers (TerminalReasonChip never renders from the durable path) — cleanup ticket candidate.

## Known Issues

- **Latent (routed to task 4.2):** `useActiveCapabilities` caches `['capabilities','active',<id>]` with `staleTime: Infinity` over an infer-on-miss endpoint; the chip no longer uses it, but **PermissionModeItem** still does — a pre-launch fetch for a session that later binds to a non-default runtime could pin the wrong permission-mode list. Fix shape: resolve from the session row's runtime + static capabilities map.

- Reviewer minors carried forward: routes/sessions.ts:221 loose fallback omits `runtime` on the wire (task 1.3 owns the fix); optimistic row hardcodes 'claude-code' at use-session-submit.ts:157 (task 1.8 threads the real hint); ConfigTab label fallback renders raw slug for discovery-only runtimes (acceptable per spec).
- Full-suite flakes dispositioned at the Batch 1 gate (pass in isolation): marketplace.test.ts install happy-path (5s timeout under load); known pre-existing: extension-proxy wildcard case, session-list-watcher.integration.

## Implementation Notes

### Session 1

Execution plan (derived from 03-tasks.json dependency DAG; analysis agent skipped — first session, DAG already validated at DECOMPOSE):

- Batch 1: 1.1, 1.2, 1.5, 1.6 (no dependencies)
- Batch 2: 1.3, 1.4, 1.7, 1.8, 2.1 — then 3.1 sequenced after 2.1 (both mutate apps/server/package.json + pnpm-lock + packages/eslint-config)
- Batch 3: 2.2, 2.3, 2.4, 3.2
- Batch 4: 2.5, 3.4, 3.5, 4.1, 4.3 — then 3.3 sequenced after 2.5 (both mutate apps/server/src/index.ts)
- Batch 5: 2.6, 3.6
- Batch 6: 3.7, 4.2, 4.4, 4.5
- Batch 7: 4.6

Review model: holistic batch-level gate (typecheck + affected tests + code review on the batch diff), per repo feedback memory — not per-task two-stage review. Orchestrator commits at each gate; agents never commit.
