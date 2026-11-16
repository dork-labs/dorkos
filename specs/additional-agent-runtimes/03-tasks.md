# Tasks — Additional Agent Runtimes: OpenCode + Codex

- **Spec:** [`specs/additional-agent-runtimes/02-specification.md`](./02-specification.md)
- **Slug:** `additional-agent-runtimes`
- **Tracker:** DOR-180
- **Generated:** 2026-07-02
- **Mode:** full
- **Counts:** 27 tasks across 4 phases — P1: 8 · P2: 6 · P3: 7 · P4: 6

Phases run in order. **Phase 2 (Codex) and Phase 3 (OpenCode) are independent of each other** — both depend only on Phase 1 foundations, so the two adapters can be built in parallel. Phase 4 depends on both adapters being registered plus the Phase 1 UX surfaces.

Each task description in [`03-tasks.json`](./03-tasks.json) is self-contained (concrete file paths, code shapes, acceptance criteria, test scenarios); this file is the human-readable mirror for browsing and diffs.

---

## Phase 1 — Multi-runtime foundations

Land the runtime-agnostic seams behind no flag (aggregation of one runtime is a no-op refactor), the config + schema changes, the DX conformance suite, and the client runtime-identity surfaces.

### Task 1.1: Add `Session.runtime` field and `'opencode'` to the runtime enum

Add a required `runtime: string` to `SessionSchema` (`packages/shared/src/schemas.ts:106-120`) and insert `'opencode'` into `AgentRuntimeSchema` (`packages/shared/src/mesh-schemas.ts:18-36`, TSDoc the dual discovery-vs-execution meaning). Make claude-code and test-mode adapters set `runtime` on every returned `Session` so typecheck stays green.

- **Size:** medium · **Priority:** high
- **Dependencies:** none
- **Parallel with:** 1.2, 1.5, 1.6

### Task 1.2: Add `runtimes.*` user-config block with a semver conf migration

Add the `runtimes` section (`default`, `opencode.{enabled,binaryPath,port}`, `codex.{enabled,binaryPath}`) to `UserConfigSchema` (`packages/shared/src/config-schema.ts`) and append an idempotent `backfillRuntimesDefaults` migration to `CONFIG_MIGRATIONS` (`apps/server/src/services/core/config-manager.ts`) keyed at the next-release placeholder `'0.47.0'`.

- **Size:** medium · **Priority:** high
- **Dependencies:** none
- **Parallel with:** 1.1, 1.5, 1.6

### Task 1.3: Aggregate `GET /api/sessions` across all registered runtimes

Move the list route (`apps/server/src/routes/sessions.ts:47-74`) from `getDefault()` to a `Promise.allSettled` fan-out over `runtimeRegistry.listRuntimes()` with per-runtime 2s timeout, merge + sort by `updatedAt`, tag each session `runtime`, degrade gracefully (`warnings[]`, never a 500), add `?runtime=` filter. Include `runtime` on `GET /:id`.

- **Size:** medium · **Priority:** high
- **Dependencies:** 1.1
- **Parallel with:** 1.4

### Task 1.4: Fan in every runtime's `subscribeSessionList` into the global stream

Refactor `SessionListBroadcaster.start` (`apps/server/src/services/session/session-list-broadcaster.ts:62-99`) to subscribe to each registered runtime's `subscribeSessionList` and merge into the single fan-out, preserving the per-runtime construction-throw guard. Update the `index.ts` call site.

- **Size:** medium · **Priority:** high
- **Dependencies:** 1.1
- **Parallel with:** 1.3

### Task 1.5: Build the `runtimeConformance` shared Vitest suite (test-mode + claude-code)

Create `packages/test-utils/src/runtime-conformance.ts` — a factory-parameterized suite asserting the `AgentRuntime` contract (lifecycle, well-formed `StreamEvent`s ending terminal, interrupt, history round-trip, capability shape, dependency-check shape). Run against `TestModeRuntime` and mocked `ClaudeCodeRuntime` (via `sdk-scenarios.ts`). The DX gate every future adapter clears.

- **Size:** large · **Priority:** high
- **Dependencies:** none
- **Parallel with:** 1.1, 1.2, 1.6

### Task 1.6: Add the `RuntimeDescriptor` client registry, OpenCode/Codex icons, and session-list row marks

Add `OpenCodeLogo`/`CodexLogo` to `packages/icons/src/adapter-logos.tsx`; create `RUNTIME_DESCRIPTORS` + `getRuntimeDescriptor` in `entities/runtime/config/` (neutral fallback for unknown types); export from the entity barrel; refactor `ConfigTab`'s ad-hoc `RUNTIME_LABELS` to consume it; render a subtle runtime mark on session-list rows.

- **Size:** medium · **Priority:** high
- **Dependencies:** none
- **Parallel with:** 1.1, 1.2, 1.5

### Task 1.7: Add the status-bar runtime chip (read-only after start, selectable pre-launch)

Create `features/status/ui/RuntimeItem.tsx` (modeled on `PermissionModeItem.tsx`), export it, add a `runtime` entry to `STATUS_BAR_REGISTRY`, and render it in `ChatStatusSection.tsx` beside the model picker. Read-only once a session starts (ADR-0255); a dropdown of registered runtimes (from `getCapabilities`) only pre-first-message and only when >1 runtime is registered.

- **Size:** medium · **Priority:** high
- **Dependencies:** 1.6
- **Parallel with:** 1.8

### Task 1.8: Thread a `?runtime=` launch param into new-session creation

Add `runtime: z.string().optional()` to `sessionSearchSchema` (`apps/client/src/router.tsx:46-54`), preserve it across the loader redirects, and pass it as the `runtime` hint on the FIRST `POST /:id/messages` only (server `resolveRuntimeTypeForNewSession` already honors `body.runtime`). `SessionLaunchPopover` passes the launching agent's runtime. No server change.

- **Size:** small · **Priority:** medium
- **Dependencies:** 1.6
- **Parallel with:** 1.7

---

## Phase 2 — Codex adapter

SDK-thread adapter (no sidecar → lower risk, built first among the adapters). One DorkOS session ↔ one Codex thread.

### Task 2.1: Add the Codex SDK dependency, ESLint confinement, and `checkDependencies`

Add `@openai/codex-sdk@~0.142.5` (pinned), add the `no-restricted-imports` ESLint boundary confining it to `services/runtimes/codex/`, stub `CodexRuntime` (`type = 'codex'`), and implement `checkDependencies` (binary + `codex login`, install hint `npm i -g @openai/codex && codex login`). Reads `runtimes.codex` config.

- **Size:** medium · **Priority:** high
- **Dependencies:** 1.2
- **Parallel with:** 3.1

### Task 2.2: Verify Codex permission/sandbox/approval mapping against the real SDK (carried-to-EXECUTE)

Early verification (spec Open Questions). Against the real SDK, record accepted approval-level/sandbox param shapes (post-0.132.0 explicit params), how tool-approval surfaces in `runStreamed`, and the interrupt/abort surface. Finalize Codex's `permissionModes` descriptor array (conservative default); any shared-enum change is additive-only. Note the `logs_2.sqlite` defect status.

- **Size:** small · **Priority:** high
- **Dependencies:** 2.1
- **Parallel with:** 2.3, 2.4

### Task 2.3: Persist the Codex `sessionId` ↔ `threadId` mapping

New SQLite table `codex_threads (sessionId PK, threadId, createdAt)` in `packages/db` (**assumption logged** — the explicit, testable choice that keeps `session_metadata` untouched), plus `thread-map.ts` with first-write-wins `setThreadId`/`getThreadId`.

- **Size:** small · **Priority:** high
- **Dependencies:** 2.1
- **Parallel with:** 2.2, 2.4

### Task 2.4: Map Codex `runStreamed` events to `StreamEvent` with fixtures

Build `codex/event-mapper.ts` mapping the 7 Codex event types (text, tool-call, tool-approval, error, interrupt/terminal) to `StreamEvent`s. Add `codex-scenarios.ts` (`vi.mock('@openai/codex-sdk')` scripted events, following `sdk-scenarios.ts` conventions) and fixture-driven mapper tests including error/interrupt/tool-approval shapes.

- **Size:** medium · **Priority:** high
- **Dependencies:** 2.1
- **Parallel with:** 2.2, 2.3

### Task 2.5: Complete the `CodexRuntime` facade and register it in the composition root

Assemble the facade: `ensureSession` → `startThread`/`resumeThread` (thread map) with explicit sandbox/approval params; `sendMessage` → `runStreamed` through the event mapper into the EventLog + projector (test-mode pattern); interrupt via the SDK abort; history/list via the SDK (`~/.codex/sessions`, not file scanning); honest `getCapabilities`/models; register in `index.ts` when `runtimes.codex.enabled`.

- **Size:** large · **Priority:** high
- **Dependencies:** 2.2, 2.3, 2.4, 1.1, 1.2, 1.5
- **Parallel with:** 3.6

### Task 2.6: Wire Codex conformance + integration tests and a local e2e smoke

`conformance.test.ts` running `runtimeConformance(() => new CodexRuntime(...))` with the SDK mocked; extend the aggregation test to register Codex; SSE turn delivery through the projector (`collectSseEvents`); unknown-runtime 400; env-gated local real-CLI smoke.

- **Size:** medium · **Priority:** medium
- **Dependencies:** 2.5
- **Parallel with:** 3.7

---

## Phase 3 — OpenCode adapter

Managed `opencode serve` sidecar + SDK/SSE adapter. Satisfies the open-source/local-model constraint (Ollama / any OpenAI-compatible endpoint).

### Task 3.1: Add the OpenCode SDK dependency, ESLint confinement, config, and `checkDependencies`

Add `@opencode-ai/sdk@^1.17.13`, the `no-restricted-imports` boundary to `services/runtimes/opencode/`, stub `OpenCodeRuntime` (`type = 'opencode'`), implement `checkDependencies` (binary + server reachability, install hint `npm i -g opencode-ai && opencode auth login`), and read `runtimes.opencode` config. (`'opencode'` enum value comes from 1.1.)

- **Size:** small · **Priority:** high
- **Dependencies:** 1.2
- **Parallel with:** 2.1

### Task 3.2: Verify OpenCode sidecar × per-session `cwd` behavior against the real SDK (carried-to-EXECUTE)

Early verification (spec Open Questions). Confirm one `opencode serve` instance honors per-session `cwd`; **if directory-bound, the documented fallback is a small per-cwd instance pool** in `server-manager.ts` (public shape unchanged). Also record OpenCode permission surfacing/approval and finalize its `permissionModes` descriptor array (additive-only enum changes). Decides the internal shape of 3.3 and 3.5.

- **Size:** medium · **Priority:** high
- **Dependencies:** 3.1
- **Parallel with:** none

### Task 3.3: Build the `opencode serve` sidecar server-manager (spawn/health/backoff/shutdown)

`server-manager.ts`: lazy spawn, health check, exponential-backoff restart, shutdown/orphan-cleanup; bind `127.0.0.1` only with per-boot `OPENCODE_SERVER_PASSWORD`; single instance or per-cwd pool per 3.2. Cold startup must not block session listing. Fake-child-process lifecycle tests.

- **Size:** large · **Priority:** high
- **Dependencies:** 3.2
- **Parallel with:** 3.4, 3.5

### Task 3.4: Map OpenCode SSE events to `StreamEvent` with recorded fixtures

`event-mapper.ts` mapping the multiplexed SSE stream to `StreamEvent`s with per-session attribution (one subscription per runtime, filter per session); tool-approval, error, interrupt/terminal shapes. Fake SSE server emitting recorded fixtures + mapper tests (incl. two interleaved sessions on one stream).

- **Size:** medium · **Priority:** high
- **Dependencies:** 3.2
- **Parallel with:** 3.3, 3.5

### Task 3.5: Build the OpenCode session-mapper (session ↔ OpenCode session, list/history via SDK)

`session-mapper.ts`: 1:1 DorkOS↔OpenCode session mapping threading per-session `cwd`; `listSessions`/`getMessageHistory` via `@opencode-ai/sdk` only (SQLite store opaque, ADR-0308); tag returned sessions `runtime: 'opencode'`. Mocked-SDK tests assert no filesystem/DB access.

- **Size:** medium · **Priority:** high
- **Dependencies:** 3.2
- **Parallel with:** 3.3, 3.4

### Task 3.6: Complete the `OpenCodeRuntime` facade and register it in the composition root

Assemble: `ensureSession`/`sendMessage` drive a turn on the sidecar and feed filtered, mapped SSE events into the EventLog + projector; `approveTool` forwards permission decisions; `interruptQuery` via the SDK/HTTP surface; history/list via the session-mapper; honest `getCapabilities`; `getSupportedModels` incl. local models; register in `index.ts` when `runtimes.opencode.enabled`, wire sidecar shutdown.

- **Size:** large · **Priority:** high
- **Dependencies:** 3.2, 3.3, 3.4, 3.5, 1.1, 1.2, 1.5
- **Parallel with:** 2.5

### Task 3.7: Wire OpenCode conformance + integration tests and verify the local-model path

`conformance.test.ts` with sidecar/SSE mocked; extend the aggregation test to register OpenCode with cold-sidecar degradation; SSE turn delivery through the projector; env-gated local verification of a real turn against an Ollama model (satisfies the open-source-model constraint).

- **Size:** medium · **Priority:** medium
- **Dependencies:** 3.6
- **Parallel with:** 2.6

---

## Phase 4 — Polish + docs

Requirements-panel reuse, copy pass, e2e, guides, and ADR/research close-out.

### Task 4.1: Add the "needs setup" runtime state and "Add a runtime" requirements flow

Reuse `SystemRequirementsStep` machinery so a registered-but-unsatisfied runtime shows a needs-setup state with copyable install/auth commands (never a dead option or stack trace); mid-session failure shows a retry affordance tied to the typed error event. A runtime is selectable only when registered AND `checkDependencies` passes.

- **Size:** medium · **Priority:** medium
- **Dependencies:** 1.7, 1.8
- **Parallel with:** 4.3, 4.4

### Task 4.2: Runtime-named empty/error/loading copy pass across capability-gated surfaces

Name the runtime in error/empty/loading states ("OpenCode server is starting…", "Codex requires login"); verify capability gates (cost, permission modes, plugins, MCP, question prompt) render honestly against all three real capability profiles. Verification + copy, not new gating.

- **Size:** small · **Priority:** medium
- **Dependencies:** 2.5, 3.6
- **Parallel with:** 4.3, 4.4, 4.5

### Task 4.3: Add Playwright e2e for runtime picker, launch param, chip, and list badges

`apps/e2e` spec using `DORKOS_TEST_RUNTIME` + a second fake runtime (no real binaries): picker renders with >1 runtime, `?runtime=` launch binding, status-bar chip read-only after start, session-list badges.

- **Size:** medium · **Priority:** low
- **Dependencies:** 1.6, 1.7, 1.8
- **Parallel with:** 4.1, 4.2, 4.4

### Task 4.4: Write `contributing/adding-a-runtime.md` (the runtime-author guide)

The DX guide making runtime #4 a checklist: interface walk-through, the conformance suite, the ESLint SDK boundary, composition-root registration + config block, client `RuntimeDescriptor` registration, and the `checkDependencies`/needs-setup contract — using the two shipped adapters as worked examples. Link from `contributing/INDEX.md`.

- **Size:** medium · **Priority:** medium
- **Dependencies:** 2.5, 3.6
- **Parallel with:** 4.1, 4.3, 4.5

### Task 4.5: Write the Runtimes user guide and update AGENTS.md, architecture, and config docs

Fumadocs "Runtimes" user guide (install/connect OpenCode + Codex, choose a runtime, local models via OpenCode + Ollama); update `AGENTS.md` runtimes list, `contributing/architecture.md` adapter diagram, and `runtimes.*` config docs.

- **Size:** medium · **Priority:** medium
- **Dependencies:** 2.5, 3.6
- **Parallel with:** 4.2, 4.4

### Task 4.6: Accept ADRs 0307–0310 and refresh the two stale April research reports

Promote ADRs 0307–0310 from `draft` to `accepted` (reflect any EXECUTE-time decisions — thread-map storage, per-cwd-pool contingency), keep `decisions/manifest.json` 1:1; refresh/annotate `research/20260405_ai_coding_agent_runtime_landscape.md` and `research/20260405_pi_coding_agent_and_local_model_frameworks.md` with the July 2026 verified landscape (no new research).

- **Size:** small · **Priority:** low
- **Dependencies:** 2.5, 3.6, 4.4, 4.5
- **Parallel with:** none

---

## Critical path & parallelism

**Critical path (longest dependency chain, 7 tasks):**

```
1.2 (runtimes config) → 3.1 (OpenCode SDK+deps) → 3.2 (sidecar×cwd verification)
   → 3.3 (server-manager) → 3.6 (OpenCodeRuntime facade) → 4.4 (adding-a-runtime guide) → 4.6 (ADR/research close-out)
```

The OpenCode spine is the pacing item — it carries the sidecar lifecycle plus the carried-to-EXECUTE cwd verification, so it is longer than the Codex spine (`1.2 → 2.1 → 2.2 → 2.5 → 2.6`).

**Independent parallel tracks:**

- **Phase 1 fan-out:** `1.1`, `1.2`, `1.5`, `1.6` all start with no dependencies. Then `1.3 ∥ 1.4` (both need `1.1`) and `1.7 ∥ 1.8` (both need `1.6`).
- **Phase 2 ∥ Phase 3:** the Codex and OpenCode adapters share no dependency on each other — both gate only on Phase 1 foundations (`1.1`, `1.2`, `1.5`). The two facades `2.5` and `3.6` are explicitly parallel-safe, as are their test-wiring tasks `2.6 ∥ 3.7`.
- **Within Phase 2:** `2.2 ∥ 2.3 ∥ 2.4` after `2.1`.
- **Within Phase 3:** `3.3 ∥ 3.4 ∥ 3.5` after `3.2`.
- **Phase 4:** `4.1`, `4.2`, `4.3`, `4.4`, `4.5` are broadly parallel once their upstream adapters/UX land; `4.6` is the terminal close-out gated on the guides and both adapters.

**Cross-phase dependencies (encoded, beyond phase ordering):** both adapter facades (`2.5`, `3.6`) depend on the conformance suite (`1.5`), the config block (`1.2`), and `Session.runtime` (`1.1`). Phase 4 docs/close-out (`4.2`, `4.4`, `4.5`, `4.6`) depend on both facades being registered.

**No `xl` tasks.** The two heaviest items (`1.5` conformance suite, `3.3` server-manager, `2.5`/`3.6` facades) are sized `large`; the adapter work was deliberately split into deps/verification/thread-map(or session-mapper)/event-mapper/facade so no single task is `xl`.
