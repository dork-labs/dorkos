# Stable HTTP Test Listeners — Task Breakdown

> Generated: 2026-09-06 | Source: `specs/stable-http-test-listeners/02-specification.md` | Mode: Full

## Summary

| Phase     | Name                      |  Tasks | Sizes                          |
| --------- | ------------------------- | -----: | ------------------------------ |
| 1         | Base and foundation       |      5 | 1 small, 4 medium              |
| 2         | Mechanical listener lanes |      3 | 3 large                        |
| 3         | Mixed integration         |      2 | 1 medium, 1 large              |
| 4         | Proof and review          |      1 | 1 large                        |
| **Total** |                           | **11** | **1 small, 5 medium, 5 large** |

## Ownership and critical path

- **Facade/integration author:** tasks 1.1–1.5, 3.1–3.2, and 4.1; owns the base trace, facade, guard/config wiring, 25 stable imports, shared helper import, 16 mixed files, documentation, integration, and proof.
- **Module-init lane author:** task 2.1; owns exactly 50 module-classified files, including four helper-built swappable exceptions and the two-app `agents.test.ts` exception.
- **Hook/local lane author:** tasks 2.2–2.3; owns exactly 39 hook-built and 28 local-factory/late-Server files.

DOR-1803 / PR #1608 is merged as `1328ca1b60f72615956ab848cb8a1a7cd8626bab`. Task 1.1 pins the actual prepared worktree identity and captures the 133-file pre-edit trace. Task 1.2 then freezes the facade contract. Tasks 1.3–1.5, 2.1–2.3, and 3.1 are technically independent after 1.2; author assignment serializes 2.2 before 2.3. Task 3.2 integrates every handoff and reconciles the whole 158-import/2,133-call surface. Task 4.1 consumes unchanged focused proof, runs the integrated 133-file cohort, and performs one root verify. All tasks are below XL and remain checklist work under DOR-1804; no sub-issue promotion is requested.

## Dependency graph

```text
PR #1608 merged as 1328ca1b6
  └─ 1.1 pin combined base + baseline trace
       └─ 1.2 facade + helper regressions
            ├─ 1.3 guard + executable fixture ─┐
            ├─ 1.4 stable imports + helper ───┤
            ├─ 1.5 documentation ─────────────┤
            ├─ 2.1 module lane ───────────────┤
            ├─ 2.2 hook lane ─────────────────┤─ 3.2 integrate + reconcile ─ 4.1 integrated proof
            ├─ 2.3 local/late-Server lane ────┤
            └─ 3.1 mixed lane ────────────────┘
```

## Phase 1: Base and foundation

### Task 1.1: Pin the merged implementation base and capture the pre-edit listener trace

**Size:** medium | **Priority:** high | **Dependencies:** none | **Parallel:** none

## Owner and base gate

Owner: facade/integration author. DOR-1803 / PR #1608 is merged as `1328ca1b60f72615956ab848cb8a1a7cd8626bab`, with parent `78b317e68c5b1534afe4432e7d3e8e784a753454` and tree `929a1ff05ebb83c377001d069b6dad8c9db08137`. Prepare the DOR-1804 worktree from that merged implementation base, then capture the baseline before any DOR-1804 tracked source edit. A later spec or source commit changes the commit tree; the harness records the actual worktree identity rather than assuming a commit name fully identifies the tested bytes.

## Owned harness and evidence files

- `.dork/flow/listener-trace-preload.cjs`
- `.dork/flow/run-listener-cohort.mjs`
- `.dork/flow/listener-trace-report.mjs`
- `.dork/flow/evidence/listener-cohort-baseline-command.json`
- `.dork/flow/evidence/listener-cohort-baseline-trace-summary.json`

These are ignored local proof artifacts. The runner also creates its baseline realm directory, Vitest JSON, and log as subordinate raw evidence. The preload observes `http.Server.listen()`, `close()`, and request events without changing request behavior. It records normalized origin categories and counts only; it must not record response bodies, credentials, request arguments, or arbitrary application data.

## Required execution

Use Node 24.14.1 and run the exact 133-file unbound-target cohort before editing any DOR-1804 source file. Preserve the runner's full source identity fields: `gitHead`, `gitTree`, `gitStatusPorcelain`, `trackedWorkingTreeContentSha256`, `trackedDiffSha256`, `stagedDiffSha256`, and every `untrackedFiles` path/hash entry. This distinguishes a clean committed tree from an uncommitted worktree that happens to report the same HEAD/tree. Record the command shape, Node version, candidate count, collected count, pass/fail/skip totals, exit status, total listen count, total close count, request-event count, and origin classification. The same cohort list, preload, command shape, and classification rules remain reusable for the final trace. Do not add retries, timeouts, worker changes, Turbo changes, or native rebuilds.

## Acceptance criteria

- The command record proves the actual tested source identity and that merged PR #1608 is present.
- The baseline trace covers exactly 133 candidate files and reports collected/pass/fail/skip counts and the command exit status.
- Listener starts are normalized into Supertest `serverAddress()`, helper-owned, and review-required custom-fixture categories without sensitive payloads.
- The baseline exercises the Supertest-origin classifier and observes helper-owned starts and HTTP request events.
- The preload changes observation only and leaves all request routing and assertions untouched.
- No DOR-1804 tracked source edit predates the recorded baseline trace.

---

### Task 1.2: Add the stable-target Supertest facade and helper regressions

**Size:** medium | **Priority:** high | **Dependencies:** 1.1 | **Parallel:** none

## Owner

Owner: facade/integration author.

## Owned files

- `packages/test-utils/src/supertest.ts` (new)
- `packages/test-utils/src/__tests__/supertest.test.ts` (new)
- `packages/test-utils/src/__tests__/listening-server.test.ts`
- `packages/test-utils/package.json`

## Facade contract

Export `@dorkos/test-utils/supertest`. Its default `request` accepts exactly `http.Server | string` and returns `ReturnType<typeof supertest>`. Re-export named `Test` and `Response` types. A string target must begin with `http://` or `https://`. A Server-compatible target must have `listening === true` and a non-null `address()`. Reject a callable Express app and an unbound Server before the real Supertest factory can call `listen(0)`; both diagnostics must direct the caller to `listeningServer()` or `swappableServer()`. Do not expose `agent()`, accept a second HTTP/2 options argument, or monkeypatch Supertest.

## Regression coverage

The facade tests cover a listening Server, explicit HTTP and HTTPS URL validation without making paid or external calls, callable Express rejection, unbound Server rejection, malformed string rejection, and the exact factory return surface needed for chained HTTP verbs. Update the listening-helper regression so `swappableServer()` first returns its unmapped diagnostic, then routes to app A and app B after explicit mounts. Retained mounting is deliberate; do not add an automatic `beforeEach` reset.

## Acceptance criteria

- Consumers can import the default facade plus named `Test` and `Response` from the new package subpath.
- Invalid targets fail synchronously or before request dispatch with actionable diagnostics, and no invalid Server is bound by Supertest.
- A valid listening Server and explicit URL retain Supertest's request-builder methods and installed type vocabulary.
- The helper regression proves the unmapped state and two explicit remounts.
- The focused facade and listening-helper tests, `@dorkos/test-utils` typecheck, and `@dorkos/test-utils` lint pass on Node 24.14.1.

---

### Task 1.3: Compose the server Supertest import guard and executable fixture

**Size:** medium | **Priority:** high | **Dependencies:** 1.2 | **Parallel:** 1.4, 1.5, 2.1, 2.2, 2.3, 3.1

## Owner

Owner: facade/integration author.

## Owned files

- `apps/server/eslint.config.js`
- `scripts/test-supertest-import-guard.sh` (new)
- `package.json`
- `.github/workflows/scripts-test.yml`

## Guard design

Add one runtime-import ban whose path group covers both the package root `supertest` and legal subpaths `supertest/*`; `supertest/index.js` must not bypass it. The diagnostic directs callers to `@dorkos/test-utils/supertest`. All request and response types are available from the facade, so this implementation does not add a direct-Supertest type-import carve-out: `import type { Test } from 'supertest'` is also rejected and `import type { Test } from '@dorkos/test-utils/supertest'` passes. If the final ESLint rule instead uses `allowTypeImports`, the executable fixture must prove the allowed import is syntactically type-only and that default or named runtime values remain rejected at the root and subpath forms. Compose the ban into the existing flat config: the generic server-test block keeps `patterns: ALL_CONFINED` plus the new ban, and every `confineDirectory()` test block keeps its directory-specific confinement patterns plus the new ban. Preserve source `HOMEDIR_BANS`, `ALL_CONFINED`, SDK confinement, node-pty confinement, observability confinement, and every existing source/test carve-out. Do not add a final blanket test block that replaces `no-restricted-imports`.

## Executable fixture

Follow the hermetic `eslint --stdin --stdin-filename` pattern used by `scripts/test-homedir-guard.sh`. In an ordinary route test, assert that `import request from 'supertest'`, a representative named runtime import, and `import request from 'supertest/index.js'` all fail at error severity and exit non-zero. Assert the root runtime import also fails in tests under terminal, observability, claude-code, codex, and opencode. Assert default and type-only facade imports pass in all relevant paths. Under the no-carve-out policy, prove a direct `import type` from `supertest` fails; if `allowTypeImports` is chosen instead, prove that exact type-only form passes while root/subpath default and named value imports still fail. For every owner directory, keep one representative cross-owner SDK import failing and its own allowed SDK import passing. Register the shell suite in root `test:scripts` and the installed-dependencies harness job in `scripts-test.yml`; `scripts/__tests__/shell-suite-parity.test.ts` must discover equal local, CI, and on-disk suite sets without an edit.

## Acceptance criteria

- The fixture proves the root, named-value, and `supertest/index.js` runtime forms emit an error and make ESLint exit non-zero; the chosen direct type-import policy is pinned explicitly.
- Facade imports pass in ordinary and all five owner-directory test paths.
- Cross-runtime SDK bans and own-runtime allowances remain unchanged.
- The shell-suite parity regression sees the new script on disk and on both execution surfaces.
- During parallel lane work, known direct imports may keep package-wide lint red; the guard commit is integrated only with all migration commits, after which server lint must pass.

---

### Task 1.4: Move already-stable tests and the shared turn helper to the facade

**Size:** medium | **Priority:** high | **Dependencies:** 1.2 | **Parallel:** 1.3, 1.5, 2.1, 2.2, 2.3, 3.1

## Owner

Owner: facade/integration author. Change only the 25 test files and one shared helper listed below. Their request targets already listen; do not alter their lifecycle, routes, assertions, state, or cleanup.

## Exact owned files

- `apps/server/src/lib/__tests__/local-caller.test.ts`
- `apps/server/src/middleware/__tests__/auth-rate-limit.test.ts`
- `apps/server/src/routes/__tests__/agents-conventions.test.ts`
- `apps/server/src/routes/__tests__/cloud.test.ts`
- `apps/server/src/routes/__tests__/local-caller-parity.test.ts`
- `apps/server/src/routes/__tests__/mcp-integration.test.ts`
- `apps/server/src/routes/__tests__/mcp.test.ts`
- `apps/server/src/routes/__tests__/mock-mcp-oauth-server.test.ts`
- `apps/server/src/routes/__tests__/relay.test.ts`
- `apps/server/src/routes/__tests__/room-caller-unverified-agent.test.ts`
- `apps/server/src/routes/__tests__/rooms-holds.test.ts`
- `apps/server/src/routes/__tests__/rooms-sessions.test.ts`
- `apps/server/src/routes/__tests__/runtimes-connect.test.ts`
- `apps/server/src/routes/__tests__/sessions-account-hint.test.ts`
- `apps/server/src/routes/__tests__/sessions-approval-live.test.ts`
- `apps/server/src/routes/__tests__/sessions-cross-client.test.ts`
- `apps/server/src/routes/__tests__/sessions-cwd-resolution.test.ts`
- `apps/server/src/routes/__tests__/sessions-cwdless-stream.test.ts`
- `apps/server/src/routes/__tests__/sessions-image-attachments.test.ts`
- `apps/server/src/routes/__tests__/sessions-queue.test.ts`
- `apps/server/src/routes/__tests__/sessions-retired-id.test.ts`
- `apps/server/src/routes/__tests__/sessions-streaming.test.ts`
- `apps/server/src/routes/__tests__/sessions-trigger.test.ts`
- `apps/server/src/routes/__tests__/sessions-turn-serialization.test.ts`
- `apps/server/src/routes/__tests__/sessions.test.ts`
- `apps/server/src/routes/__tests__/helpers/trigger-turn-helpers.ts`

## Required migration

Replace each direct runtime import from `supertest` with the default facade import. In `apps/server/src/routes/__tests__/mcp-integration.test.ts`, replace the existing `request.Test` and `request.Response` namespace references with named `Test` and `Response` type imports from the facade. The shared turn helper continues to receive caller-owned listening Servers; do not create or mount a listener inside it.

## Acceptance criteria

- All 26 owned modules import runtime request behavior only from `@dorkos/test-utils/supertest`.
- The two `mcp-integration.test.ts` namespace type references use the named facade types.
- Every existing stable Server target and cleanup hook is byte-for-byte or semantically unchanged apart from import/type edits.
- The exact 25-test cohort passes on Node 24.14.1, and the shared helper's caller tests still pass in their owning lane runs.
- No application, package, ESLint, documentation, or non-owned test file changes are included.

---

### Task 1.5: Document the stable server-test listener contract

**Size:** small | **Priority:** medium | **Dependencies:** 1.2 | **Parallel:** 1.3, 1.4, 2.1, 2.2, 2.3, 3.1

## Owner

Owner: facade/integration author.

## Owned files

- `.claude/rules/testing.md`
- `packages/test-utils/src/listening-server.ts`

## Required documentation

State the server route-test rule with concrete imports and lifecycle guidance: import request and response types from `@dorkos/test-utils/supertest`; pass only a listening Server or explicit HTTP(S) URL; use `listeningServer()` for a fixed app and `swappableServer()` for an app rebuilt by hooks or local factories; mount once for each logical state-sharing sequence; and preserve explicit raw/custom listeners used to test protocol boundaries. Explain that `swappableServer()` retains its last mount and requires an explicit remount when a new logical app begins.

Correct helper prose that attributes the intermittent failures to global-agent pooling or a proven kernel mechanism. Preserve only observed facts: aggregate runs have produced intermittent socket/parser/wrong-app symptoms; the bounded probe established listener ownership and bind/close counts; the specific kernel cause remains unproven.

## Acceptance criteria

- The testing rule includes fixed, hook-built, local-factory, and raw/custom fixture examples with the facade import.
- The prose does not claim global Superagent pooling; Superagent is configured with `agent: false` in this path.
- The helper TSDoc remains accurate for its actual ownership and cleanup behavior.
- Documentation checks and `@dorkos/test-utils` lint pass after formatting.

---

## Phase 2: Mechanical listener lanes

### Task 2.1: Migrate the 50 module-initialized fixtures to owned listeners

**Size:** large | **Priority:** high | **Dependencies:** 1.2 | **Parallel:** 1.3, 1.4, 1.5, 2.2, 2.3, 3.1

## Owner and boundary

Owner: module-init lane author. Exclusive scope is the 50 files below, including their request imports and type references. Do not edit shared helpers, package/config files, guard files, documentation, or another lane. Migrate exactly 807 known unbound Supertest calls plus the seven same-app durable SSE collector calls described below.

## Exact owned cohort

- `apps/server/src/routes/__tests__/agents-creation.test.ts` — 30 calls
- `apps/server/src/routes/__tests__/agents.test.ts` — 39 calls
- `apps/server/src/routes/__tests__/capabilities.test.ts` — 5 calls
- `apps/server/src/routes/__tests__/command-intents.test.ts` — 6 calls
- `apps/server/src/routes/__tests__/commands.test.ts` — 11 calls
- `apps/server/src/routes/__tests__/diff-boundary.test.ts` — 19 calls
- `apps/server/src/routes/__tests__/directory.test.ts` — 21 calls
- `apps/server/src/routes/__tests__/files-copy-reveal.test.ts` — 19 calls
- `apps/server/src/routes/__tests__/files-workbench-boundary.test.ts` — 12 calls
- `apps/server/src/routes/__tests__/files-workbench.test.ts` — 30 calls
- `apps/server/src/routes/__tests__/files.test.ts` — 24 calls
- `apps/server/src/routes/__tests__/git.test.ts` — 2 calls
- `apps/server/src/routes/__tests__/health.test.ts` — 3 calls
- `apps/server/src/routes/__tests__/mcp-config.test.ts` — 4 calls
- `apps/server/src/routes/__tests__/models.test.ts` — 5 calls
- `apps/server/src/routes/__tests__/non-claude-default-runtime.test.ts` — 5 calls
- `apps/server/src/routes/__tests__/read-cursors.test.ts` — 33 calls
- `apps/server/src/routes/__tests__/rooms-cascade.test.ts` — 14 calls
- `apps/server/src/routes/__tests__/rooms-communities.test.ts` — 3 calls
- `apps/server/src/routes/__tests__/rooms-events.test.ts` — 27 calls
- `apps/server/src/routes/__tests__/rooms-export.test.ts` — 12 calls
- `apps/server/src/routes/__tests__/rooms-files.test.ts` — 33 calls
- `apps/server/src/routes/__tests__/rooms-reactions.test.ts` — 19 calls
- `apps/server/src/routes/__tests__/rooms-repo.test.ts` — 34 calls
- `apps/server/src/routes/__tests__/rooms-update-gate.test.ts` — 11 calls
- `apps/server/src/routes/__tests__/rooms.test.ts` — 175 calls
- `apps/server/src/routes/__tests__/session-attachments.test.ts` — 12 calls
- `apps/server/src/routes/__tests__/session-devtools.test.ts` — 2 calls
- `apps/server/src/routes/__tests__/sessions-boundary.test.ts` — 12 calls
- `apps/server/src/routes/__tests__/sessions-daily-counts.test.ts` — 5 calls
- `apps/server/src/routes/__tests__/sessions-dispatch-correlation.test.ts` — 8 calls
- `apps/server/src/routes/__tests__/sessions-interactive.test.ts` — 20 calls
- `apps/server/src/routes/__tests__/sessions-kickoff-filter.test.ts` — 6 calls
- `apps/server/src/routes/__tests__/sessions-list-aggregation.test.ts` — 17 calls
- `apps/server/src/routes/__tests__/sessions-mcp-app-resource.test.ts` — 5 calls
- `apps/server/src/routes/__tests__/sessions-model-gate-unbound.test.ts` — 1 calls
- `apps/server/src/routes/__tests__/sessions-multi-runtime.test.ts` — 28 calls
- `apps/server/src/routes/__tests__/sessions-permission-mode-parity.test.ts` — 12 calls
- `apps/server/src/routes/__tests__/sessions-recent.test.ts` — 12 calls
- `apps/server/src/routes/__tests__/sessions-ui-action.test.ts` — 14 calls
- `apps/server/src/routes/__tests__/subagents.test.ts` — 3 calls
- `apps/server/src/routes/__tests__/system-memory.test.ts` — 3 calls
- `apps/server/src/routes/__tests__/system-unattended-autonomy.test.ts` — 4 calls
- `apps/server/src/routes/__tests__/system.test.ts` — 8 calls
- `apps/server/src/routes/__tests__/uploads.test.ts` — 11 calls
- `apps/server/src/routes/__tests__/workbench-serve.test.ts` — 22 calls
- `apps/server/src/services/core/auth/__tests__/seed-legacy-mcp-key.test.ts` — 1 calls
- `apps/server/src/services/core/capabilities/__tests__/capability-conformance.test.ts` — 3 calls
- `apps/server/src/services/core/external-mcp/__tests__/surface-parity.test.ts` — 1 calls
- `apps/server/src/services/core/external-mcp/__tests__/tool-security.test.ts` — 1 calls

## Lifecycle rules

For 46 fixed apps, finalize the existing app at its current module or owning `describe` scope, call `listeningServer(app)` once in that scope, and pass that Server to the facade. In `agents.test.ts`, give the module app and describe-owned `appWithMesh` distinct stable Servers; neither may depend on describe order. Use one module-scoped swappable target in each helper-built exception: `seed-legacy-mcp-key.test.ts` mounts inside `createOwner()`; `capability-conformance.test.ts` mounts once per `routeProbe()`, with ask and grant sharing one `requesterDecideProbe` mount; `surface-parity.test.ts` mounts inside `fetchExternalTools()`; `tool-security.test.ts` mounts inside `fetchLiveTools()` and keeps MCP transport cleanup. Replace the latter two files' `request.Response` references with named `Response` imports.

The Supertest and SSE/raw HTTP clients in `read-cursors.test.ts`, `rooms-events.test.ts`, and `rooms-reactions.test.ts` share the same helper-managed listener. Preserve subscribe-first ordering, ready/sentinel/replay behavior, and active-stream cleanup. In `command-intents.test.ts`, `sessions-list-aggregation.test.ts`, and `sessions-multi-runtime.test.ts`, replace the seven `collectDurableEvents(app, ...)` calls (1 + 4 + 2) with `collectDurableEventsAt(baseUrl, ...)`, using the same stable Server already owned by each file. Preserve every option, predicate, frame assertion, cold/resume sequence, and request order; do not change the shared SSE helper or any other raw protocol fixture. Stabilize only the DorkOS app in `workbench-serve.test.ts`; keep its upstream, probe/dead-port, IPv6, and preview listeners distinct. Preserve existing routes, auth headers, assertions, app/DB/config construction, singleton resets, cleanup, isolation, and the existing concurrent request groups in `rooms-cascade.test.ts`, `rooms-files.test.ts`, `rooms-update-gate.test.ts`, and `rooms.test.ts`. Preserve `sessions-permission-mode-parity.test.ts` pending-write synchronization.

## Acceptance criteria

- All 50 files import request behavior from the facade and target only listening helper-owned Servers or documented custom listeners.
- The four helper-built exceptions mount exactly at their fresh-app boundary, and `agents.test.ts` uses two distinct targets.
- Existing SSE/raw fixture ordering, Promise.all order, state-sharing sequences, and cleanup remain intact; the seven same-app collector calls use the owned stable listener and create no duplicate app listener.
- The exact 50-file cohort passes on Node 24.14.1 with the same test names and assertions.
- Static inventory finds 807 migrated known calls, no direct Supertest runtime import, and no remaining `request.Response` namespace reference in the owned files.

---

### Task 2.2: Migrate the 39 hook-built fixtures to swappable listeners

**Size:** large | **Priority:** high | **Dependencies:** 1.2 | **Parallel:** 1.3, 1.4, 1.5, 2.1, 3.1

## Owner and boundary

Owner: hook/local lane author. Exclusive scope is the 39 files below, including their request imports and type references. Do not edit shared helpers, package/config files, guard files, documentation, or another lane. Migrate exactly 644 known unbound calls.

## Exact owned cohort

- `apps/server/src/__tests__/app-security-headers.test.ts` — 13 calls
- `apps/server/src/__tests__/app-spa-fallback.test.ts` — 20 calls
- `apps/server/src/middleware/__tests__/extension-routes.test.ts` — 8 calls
- `apps/server/src/middleware/__tests__/host-guard.test.ts` — 15 calls
- `apps/server/src/routes/__tests__/activity.test.ts` — 5 calls
- `apps/server/src/routes/__tests__/admin.test.ts` — 14 calls
- `apps/server/src/routes/__tests__/config-dto-fallbacks.test.ts` — 2 calls
- `apps/server/src/routes/__tests__/config-mcp.test.ts` — 16 calls
- `apps/server/src/routes/__tests__/config-tunnel-dto.test.ts` — 8 calls
- `apps/server/src/routes/__tests__/default-trust-stop.integration.test.ts` — 18 calls
- `apps/server/src/routes/__tests__/extensions-load-approval.test.ts` — 25 calls
- `apps/server/src/routes/__tests__/extensions-secrets.test.ts` — 21 calls
- `apps/server/src/routes/__tests__/extensions.test.ts` — 25 calls
- `apps/server/src/routes/__tests__/marketplace.test.ts` — 94 calls
- `apps/server/src/routes/__tests__/mesh.test.ts` — 71 calls
- `apps/server/src/routes/__tests__/relay-bindings-conflict.test.ts` — 8 calls
- `apps/server/src/routes/__tests__/room-caller.test.ts` — 11 calls
- `apps/server/src/routes/__tests__/rooms-attachments.test.ts` — 22 calls
- `apps/server/src/routes/__tests__/self-approval-chain.test.ts` — 9 calls
- `apps/server/src/routes/__tests__/standing-grants-chain.test.ts` — 15 calls
- `apps/server/src/routes/__tests__/tasks-cron-validation.test.ts` — 12 calls
- `apps/server/src/routes/__tests__/tasks-file-write.test.ts` — 24 calls
- `apps/server/src/routes/__tests__/tasks-mutation-authority.test.ts` — 7 calls
- `apps/server/src/routes/__tests__/tasks-patch-bypass-escalation.test.ts` — 7 calls
- `apps/server/src/routes/__tests__/tasks-permission-escalation.test.ts` — 5 calls
- `apps/server/src/routes/__tests__/tasks-trigger-authority.test.ts` — 8 calls
- `apps/server/src/routes/__tests__/tasks-unattended-power.test.ts` — 11 calls
- `apps/server/src/routes/__tests__/tasks-write-policy.test.ts` — 25 calls
- `apps/server/src/routes/__tests__/tasks.test.ts` — 45 calls
- `apps/server/src/routes/__tests__/templates.test.ts` — 16 calls
- `apps/server/src/routes/__tests__/terminal.test.ts` — 8 calls
- `apps/server/src/routes/__tests__/test-control-agent-token.test.ts` — 4 calls
- `apps/server/src/routes/__tests__/test-control-persistent.test.ts` — 10 calls
- `apps/server/src/services/core/auth/__tests__/auth.integration.test.ts` — 5 calls
- `apps/server/src/services/core/auth/__tests__/session-gate-sse.integration.test.ts` — 6 calls
- `apps/server/src/services/core/auth/__tests__/session-gate.test.ts` — 20 calls
- `apps/server/src/services/core/external-mcp/__tests__/task-permission-mode.test.ts` — 2 calls
- `apps/server/src/services/rooms/attachments/__tests__/room-attachment-store.test.ts` — 4 calls
- `apps/server/src/services/tasks/__tests__/tasks-changed-broadcast.test.ts` — 5 calls

## Lifecycle rules

Create one `swappableServer()` per current owning module or `describe`. Mount the app at the existing `beforeAll` or `beforeEach` construction point, after its routes, middleware, DB/config dependencies, and mocks have been finalized. Keep all requests in a logical create/read, ask/grant/retry, or authorization sequence on the same mount. Do not add a universal reset or remount between dependent requests. Preserve every route, auth header, assertion, database/config setup, singleton reset, mock cleanup, and isolation boundary. Preserve the existing `Promise.all` groups in `templates.test.ts` and `extensions.test.ts`.

In `apps/server/src/services/core/external-mcp/__tests__/task-permission-mode.test.ts`, replace the existing `request.Response` namespace reference with a named facade `Response` type import. No other lane owns that edit.

## Acceptance criteria

- All 39 files import request behavior from the facade and send all 644 known calls to listening swappable targets.
- Each hook mounts only after its app is fully assembled, while dependent multi-request sequences share one mount.
- Existing Promise.all concurrency, authorization sequences, state reset order, and cleanup remain intact.
- The exact 39-file cohort passes on Node 24.14.1 with the same test names and assertions.
- Static inventory finds no direct Supertest runtime import, unbound request target, or `request.Response` namespace reference in the owned files.

---

### Task 2.3: Migrate the 28 local-factory fixtures and late-bound Servers

**Size:** large | **Priority:** high | **Dependencies:** 1.2 | **Parallel:** 1.3, 1.4, 1.5, 2.1, 3.1

## Owner and boundary

Owner: hook/local lane author. Exclusive scope is the 28 files below, including their request imports and type references. Do not edit shared helpers, package/config files, guard files, documentation, or another lane. Migrate exactly 389 known unbound calls. This task follows task 2.2 for the assigned author even though both are independently enabled by the facade.

## Exact owned cohort

- `apps/server/src/__tests__/a2a-routes.test.ts` — 24 calls
- `apps/server/src/__tests__/app-first-contact.test.ts` — 19 calls
- `apps/server/src/middleware/__tests__/extension-proxy-rate-limit.test.ts` — 11 calls
- `apps/server/src/middleware/__tests__/mcp-origin.test.ts` — 3 calls
- `apps/server/src/routes/__tests__/agent-connectors.test.ts` — 12 calls
- `apps/server/src/routes/__tests__/capabilities-catalog.test.ts` — 7 calls
- `apps/server/src/routes/__tests__/capabilities-invoke.test.ts` — 20 calls
- `apps/server/src/routes/__tests__/config.test.ts` — 1 calls
- `apps/server/src/routes/__tests__/connector-providers.test.ts` — 20 calls
- `apps/server/src/routes/__tests__/connectors.test.ts` — 44 calls
- `apps/server/src/routes/__tests__/discovery.test.ts` — 12 calls
- `apps/server/src/routes/__tests__/errors.test.ts` — 3 calls
- `apps/server/src/routes/__tests__/feedback.test.ts` — 25 calls
- `apps/server/src/routes/__tests__/health-deep.test.ts` — 4 calls
- `apps/server/src/routes/__tests__/mcp-capabilities-unverified-agent.test.ts` — 4 calls
- `apps/server/src/routes/__tests__/mcp-oauth.test.ts` — 5 calls
- `apps/server/src/routes/__tests__/notifications.test.ts` — 24 calls
- `apps/server/src/routes/__tests__/profile-avatar.test.ts` — 30 calls
- `apps/server/src/routes/__tests__/push.test.ts` — 13 calls
- `apps/server/src/routes/__tests__/relay-bindings-bridge.test.ts` — 12 calls
- `apps/server/src/routes/__tests__/room-capabilities-unverified-agent.test.ts` — 8 calls
- `apps/server/src/routes/__tests__/search.test.ts` — 23 calls
- `apps/server/src/routes/__tests__/session-connectors.test.ts` — 9 calls
- `apps/server/src/routes/__tests__/shapes.test.ts` — 20 calls
- `apps/server/src/routes/__tests__/team.test.ts` — 24 calls
- `apps/server/src/routes/__tests__/workspaces.test.ts` — 7 calls
- `apps/server/src/services/extensions/__tests__/extension-proxy.test.ts` — 4 calls
- `apps/server/src/services/relay/chat-bridge/__tests__/bridged-room-security.test.ts` — 1 calls

## Lifecycle rules

Create one owning-scope swappable target for each local-factory suite. Preserve every original factory evaluation and mount its newly built app at that same construction boundary, after the app's routes and backing state are complete. Keep dependent follow-up requests that already shared one app on the same mount; a later original factory evaluation may remount after the prior request has settled. Never remount between constructing a lazy Supertest chain and its `await`, `.then()`, or `.end()` dispatch. In `extension-proxy-rate-limit.test.ts`, mount the first limiter app for both requests sharing its budget, then mount the second limiter app; preserve both limiter instances. In `mcp-oauth.test.ts`, replace the five Servers built inside tests with one owning-scope swappable target; never register `listeningServer()` after a `beforeAll` has already started. In `extension-proxy.test.ts`, route only the four Supertest app calls through the swappable target and preserve `rawGetStatus` plus its real upstream listeners.

Replace all facade namespace type references in this lane with named imports: five references in `mcp-capabilities-unverified-agent.test.ts` and six in `room-capabilities-unverified-agent.test.ts`. Preserve routes, auth headers, assertions, DB/config construction, singleton resets, mocks, local state-sharing sequences, raw fixtures, and cleanup.

## Acceptance criteria

- All 28 files import request behavior from the facade and send all 389 known calls to listening swappable targets or explicit preserved custom listeners.
- The OAuth, limiter, extension-proxy, and dependent multi-request sequences retain their intended app/state identity.
- All eleven namespace type references in the two capability files use named `Test` or `Response` facade imports.
- The exact 28-file cohort passes on Node 24.14.1 with the same test names and assertions.
- Static inventory finds no direct Supertest runtime import or unbound Supertest target in the owned files.

---

## Phase 3: Mixed integration

### Task 3.1: Migrate the 16 mixed-lifecycle fixtures without flattening ownership

**Size:** large | **Priority:** high | **Dependencies:** 1.2 | **Parallel:** 1.3, 1.4, 1.5, 2.1, 2.2, 2.3

## Owner and boundary

Owner: facade/integration author. Exclusive migration scope is the 16 files below, including their request imports and type references. Migrate exactly 293 known unbound calls.

## Exact owned cohort

- `apps/server/src/middleware/__tests__/mcp-auth.integration.test.ts` — 3 calls
- `apps/server/src/routes/__tests__/approvals.test.ts` — 64 calls
- `apps/server/src/routes/__tests__/debug.test.ts` — 6 calls
- `apps/server/src/routes/__tests__/discovery.integration.test.ts` — 7 calls
- `apps/server/src/routes/__tests__/marketplace-approval-flow.test.ts` — 8 calls
- `apps/server/src/routes/__tests__/mesh-topology.test.ts` — 26 calls
- `apps/server/src/routes/__tests__/profile-name.test.ts` — 12 calls
- `apps/server/src/routes/__tests__/relay-binding-test.test.ts` — 10 calls
- `apps/server/src/routes/__tests__/relay-bindings-integration.test.ts` — 54 calls
- `apps/server/src/routes/__tests__/runtimes.test.ts` — 20 calls
- `apps/server/src/routes/__tests__/sessions-pending-interactions.test.ts` — 17 calls
- `apps/server/src/routes/__tests__/tunnel-cors.test.ts` — 14 calls
- `apps/server/src/routes/__tests__/tunnel.test.ts` — 27 calls
- `apps/server/src/routes/__tests__/unclaimed-chats.test.ts` — 22 calls
- `apps/server/src/services/connectors/providers/__tests__/nango-proxy-mcp.test.ts` — 2 calls
- `apps/server/src/services/runtimes/codex/__tests__/codex-ui-mcp-server.test.ts` — 1 calls

## Lifecycle rules

Choose fixed or swappable ownership separately for each existing owning `describe`, hook-built app, local factory, or helper parameter. Do not flatten distinct apps into one module target. A helper accepting an app or unbound Server must instead receive or close over the correct listening Server. Mount once for dependent approval, grant, retry, binding, tunnel, or runtime sequences, and remount only when a new logical app begins. Preserve every route, auth header, assertion, app/DB/config lifecycle, singleton reset, mock cleanup, caller identity, isolation boundary, and custom/raw listener.

Replace the facade namespace types owned by this lane: `Test` in `mcp-auth.integration.test.ts`, `Response` in `nango-proxy-mcp.test.ts`, and `Response` in `codex-ui-mcp-server.test.ts`. The Nango and Codex helper requests must still address their intended provider/runtime app; do not expose a generic listener or move provider/runtime behavior into shared test-utils.

## Acceptance criteria

- All 16 files import request behavior from the facade and send all 293 known calls to the correct listening target.
- Mixed files retain distinct targets or explicit remount boundaries for distinct app lifecycles.
- The three owned namespace references use named facade types.
- The exact 16-file cohort passes on Node 24.14.1 with the same test names and assertions.
- Static inventory finds no direct Supertest runtime import or unbound request target in the owned files.

---

### Task 3.2: Integrate all listener lanes and reconcile the complete 158-import surface

**Size:** medium | **Priority:** high | **Dependencies:** 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 3.1 | **Parallel:** none

## Owner

Owner: facade/integration author. Integrate the facade, guard, documentation, 25 stable imports, shared helper import, and four disjoint migration lane commits without rewriting another author's lifecycle choices. Resolve only concrete conflicts against the pinned implementation base.

## Completeness reconciliation

Use the frozen inventory to account for all 158 server test files with direct Supertest runtime imports: 133 migrated unbound-target files plus 25 already-stable files. Account for all 2,133 known unbound calls by lane totals 807 + 644 + 389 + 293. Account for all 19 namespace type references: two in Lane 1, one in Lane 2, eleven in Lane 3, three in Lane 4, and two in the stable `mcp-integration.test.ts` file. Confirm the shared `trigger-turn-helpers.ts` module imports the facade while retaining caller-owned Server targets.

Classify every remaining `supertest` string in `apps/server`: direct runtime imports must be zero; dependency metadata, prose, guard fixtures, and deliberate type/package references must be identified rather than blindly deleted. Classify every explicit listener that remains in the 133-file cohort as helper-owned or one of the finite external-upstream, raw protocol, dead-port/probe, IPv6, preview, OAuth, SSE, or other documented custom fixtures. Do not route custom protocol fixtures through the facade.

## Acceptance criteria

- Static counts reconcile to 133 unbound-target files, 25 stable-import files, 2,133 migrated known calls, and 19 named type migrations.
- No server test or server test helper directly imports Supertest runtime behavior.
- The composed ESLint guard applies in ordinary tests and all five confined owner directories without weakening prior bans.
- Every remaining explicit listener has a documented test-boundary reason and deterministic cleanup.
- Server and test-utils targeted typecheck/lint are ready for the final proof run; no package/config/helper edits exist outside the assigned integration files.

---

## Phase 4: Proof and review

### Task 4.1: Run final listener-origin proof, mutation checks, and repository verification

**Size:** large | **Priority:** high | **Dependencies:** 3.2 | **Parallel:** none

## Owner and proof inputs

Owner: facade/integration author. Use Node 24.14.1 for every command. Root serializes this task, the final commit/push, and review handoff. Do not add retries, timeouts, worker changes, loose environment overrides, Turbo changes, native rebuilds, paid flags, or live credentials.

Consume the completed, unchanged proof from tasks 1.2–3.2: facade and listening-helper regressions; the root/subpath/type-policy import-guard fixture; the 25-file stable-import cohort and shared-helper caller evidence; the 50/39/28/16 lane cohorts; all 19 named type migrations; completeness scans; and targeted server/test-utils typecheck and lint results. Do not rerun those focused cohorts or package checks when their integrated bytes are unchanged. If conflict resolution changes an implementation or a failure appears, repeat only the smallest focused check whose result could have changed and record that reason. Facade rejection, swappable remount, direct-import, subpath-bypass, and SDK-confinement mutation behavior should be consumed from the unchanged unit/guard proof; perform an additional temporary mutation only when an acceptance signal is otherwise missing, saving and restoring exact bytes without git stash or path checkout.

## Owned final evidence files

- `.dork/flow/evidence/listener-cohort-final-command.json`
- `.dork/flow/evidence/listener-cohort-final-trace-summary.json`

The prepared runner also emits its final realm directory, Vitest JSON, and log as subordinate raw evidence. Do not invent a second report format that can drift from these command and summary records.

## Integrated final gates

Run `.dork/flow/run-listener-cohort.mjs final` once with the exact same 133-file cohort, preload, command shape, and classification rules captured in task 1.1. Record candidate and collected file counts, pass/fail/skip totals, exit status, total listen/close/request-event counts, zero starts originating from Supertest `serverAddress()`, and the classification of every remaining start. Compare the baseline and final command/summary records directly in the completion proof. Preserve the final runner's `gitHead`, `gitTree`, `gitStatusPorcelain`, `trackedWorkingTreeContentSha256`, `trackedDiffSha256`, `stagedDiffSha256`, and every `untrackedFiles` path/hash entry; when the final tree is uncommitted, `trackedWorkingTreeContentSha256` and the diff hashes are part of the tested source identity and a HEAD/tree pair alone is insufficient.

After the integrated cohort passes, run exactly one root `pnpm verify`. This is the final repository gate and already covers the relevant package checks; do not precede it with redundant full lane or package reruns. A failing integrated cohort or verify may justify the smallest diagnostic rerun needed to identify and fix the failure.

## Acceptance criteria

- Every consumed focused result is tied to unchanged integrated bytes, or its affected focused check is rerun with a recorded integration reason.
- The final 133-file run collects all candidates, exits successfully, and reports zero Supertest-owned `serverAddress()` listener starts.
- Every remaining listener start is helper-owned or a reviewed custom-fixture category, with request-event and cleanup evidence.
- Baseline and final records provide a direct measured comparison without claiming reproduction of a nondeterministic socket/parser failure.
- The exact tested final source is recoverable whether committed or uncommitted.
- One root `pnpm verify` passes on Node 24.14.1.
- A fresh independent review receives the final diff and proof after the branch is pushed and before a pull request is opened.

---
