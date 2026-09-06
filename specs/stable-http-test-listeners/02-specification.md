---
slug: stable-http-test-listeners
number: 260906-000529
created: 2026-09-06
status: specified
---

# Stable HTTP listeners for server test fixtures

**Status:** Specified (Frozen)
**Author:** Codex
**Date:** 2026-09-06
**Ideation:** `specs/stable-http-test-listeners/01-ideation.md`
**Tracker:** DOR-1804

## Overview

The server suite currently gives Supertest an Express app or a not-yet-bound `http.Server` at 2,133 known call sites across 133 test files. Supertest consequently creates or binds a port-zero listener for each request and closes the listener afterward. This specification migrates the complete known class to the existing file-scoped stable-listener helpers, adds a narrow test-utils request facade that rejects unbound targets, and adds a server-test import guard that prevents direct Supertest runtime use from restoring the pattern.

The change preserves each fixture's existing app, state, authorization, and request-concurrency lifecycle. Completion is measured by an observed full candidate cohort with zero listener starts originating in Supertest's `serverAddress()` path. The work does not depend on proving a particular kernel or socket-pool failure mechanism.

## Background / Problem Statement

Supertest 7.2.2 accepts functions, Servers, and URLs. Its installed implementation wraps a function target in `http.createServer()`, then `serverAddress()` calls `listen(0)` when the target has no address. `end()` closes the listener Supertest opened. This is convenient for a single request but gives transport ownership to each request across a large parallel suite.

The exact inventory resolved on DOR-1803 source commit `22b66c2c20c6ea70ac7e76c7eee77d7e85e31629` found:

- 2,681 total Supertest calls in 158 server test files.
- 2,128 Express targets in 132 files.
- 553 already-Server targets in 27 files.
- Five of those Server targets, all in `mcp-oauth.test.ts`, are still unbound when Supertest receives them.
- 2,133 known recurring-class Supertest calls in 133 files after DOR-1803's four fixture migrations.
- Seven `collectDurableEvents(app, ...)` calls in three Lane 1 files create a second listener for an app that the lane already migrates to a stable listener.
- 25 already-stable test files that need only the facade import/type migration.
- One Supertest-importing helper module under `routes/__tests__/helpers/`.
- Nineteen `request.Test` / `request.Response` namespace references that must become facade-exported named types.

Aggregate gates have intermittently reported `socket hang up`, HTTP parser errors, and responses inconsistent with the app assembled by the failing test. Focused reruns pass. A bounded Node 24.14.1 probe did not reproduce those faults, but it did prove the ownership difference: 256 requests against unbound apps produced 256 listener starts, closes, and unique ports; 256 requests through a stable listener produced one start, one close, and one port. DOR-1803 separately reduced four real fixtures from 130 listener starts to 4 and used server request events to prove those requests traversed the intended listener.

The exact OS-level failure mechanism remains unknown. Repeated bind/close churn is nevertheless an unnecessary, observable fixture behavior with a clear ownership correction. Small fixture patches have only moved aggregate failures to untouched files, so this work removes the class systematically and enforces the boundary.

The implementation base must start from `78b317e68c5b1534afe4432e7d3e8e784a753454` plus the merged DOR-1803 change, pinned to an actual SHA and tree before any DOR-1804 source edit. The `78b317e` base contains server changes in `routes/config.ts`, `services/core/auth/exposure-guard.ts`, and `services/core/config-manager.ts`; it is not treated as byte-equivalent to the older inventory baseline. The pre-edit candidate cohort trace runs on the actual prepared base so those intervening changes are represented in the comparison.

## Goals

- Route all 2,133 known unbound Supertest calls through a listener owned by the test file or owning `describe`.
- Point the seven same-app durable SSE collector calls at those existing stable listeners without changing their parser, options, frame assertions, or ordering.
- Preserve all current app/state construction, reset, authorization, and concurrent-request semantics.
- Move all 158 server test runtime imports and the one shared test-helper runtime import to an explicit test-utils facade.
- Replace all 19 namespace type references with facade-exported `Test` and `Response` types.
- Reject Express callables, unbound Servers, and non-HTTP URL strings before Supertest can create a listener.
- Preserve every existing SDK, `node-pty`, OpenTelemetry, and homedir import restriction while adding the Supertest import guard.
- Demonstrate zero Supertest-origin listener starts across the full 133-file candidate cohort and classify every remaining custom listener start.
- Leave a durable regression boundary so new server route tests cannot silently restore request-owned listeners.

## Non-Goals

- Changes to application or production behavior.
- Changes to route assertions, headers, request bodies, expected statuses, timeouts, retries, Vitest workers, Turbo concurrency, or strict environment filtering.
- Replacement of raw `node:http` clients and custom listeners that intentionally cover SSE, malformed requests, peer addresses, upstream forwarding, or IPv4/IPv6 behavior.
- A global monkeypatch of Supertest, Superagent, `http.Server`, or Node agents.
- A static identifier/AST-only rule that attempts to infer app lifecycles.
- A `request.agent()` facade before the repository has an actual cookie-persistence caller.
- A claim that the migration fixes all aggregate server flakes or proves an operating-system mechanism.
- Changes to paid-evaluation flags, keys, or allowlists.

## Technical Dependencies

- Node 24.14.1 for all focused, package, and repository checks.
- `supertest` 7.2.2 and `@types/supertest` 7.2.1, already direct dependencies of `@dorkos/test-utils`.
- Node `http.Server.listening` and `Server.address()` for runtime target validation.
- Existing `listeningServer()` and `swappableServer()` helpers from `@dorkos/test-utils/listening-server`, established by DOR-1803.
- ESLint flat config in `apps/server/eslint.config.js`; its `no-restricted-imports` options replace earlier options rather than merging.
- Existing executable config-guard pattern in `scripts/test-homedir-guard.sh` and suite-parity coverage in `scripts/__tests__/shell-suite-parity.test.ts`.

## Detailed Design

### 1. Typed Supertest facade

Add `packages/test-utils/src/supertest.ts` and export it as `@dorkos/test-utils/supertest`.

Its default `request` function accepts:

```ts
type StableSupertestTarget = Server | string;

function request(target: StableSupertestTarget): ReturnType<typeof supertest>;
```

The facade returns Supertest's request builder (`SuperTest<Test>` in the published type vocabulary), not an individual `Test`; `.get()`, `.post()`, and the other HTTP verb methods return `Test`. The implementation should use the exact `ReturnType<typeof supertest>` so the facade follows the installed factory declaration.

Before delegating to the real Supertest default export, it enforces:

1. A string must be an explicit `http://` or `https://` URL.
2. A non-string target must be an `http.Server`-compatible object with `listening === true` and a non-null `address()`.
3. A callable Express app fails with an actionable message directing the caller to `listeningServer()` or `swappableServer()`.
4. An unbound Server fails with an actionable message before Supertest can call `listen(0)`.

The module re-exports `Test` and `Response` types. Existing namespace references such as `request.Response` become named type imports. The facade does not export `agent()` and does not accept Supertest's second HTTP/2 options argument because the current server inventory uses neither.

The facade is explicit library code, not a monkeypatch. Direct Supertest remains available to other packages with different test needs; enforcement is scoped to server tests.

### 2. Stable listener lifecycles

Use the existing helpers without changing their ownership model:

- **Fixed app:** create/finalize the app at its current module or `describe` scope, call `listeningServer(app)` once in that same scope, and pass the returned Server to the facade. This is the Lane 1 default for 46 files.
- **Hook-built app:** create one `swappableServer()` in the owning scope, then call `target.mount(app)` at the existing app-construction point in `beforeAll` or `beforeEach`.
- **Local app factory:** create one swappable target for the owning suite. Preserve every original factory evaluation and mount each resulting app at that same construction boundary. Keep dependent create/read or ask/grant/retry requests that already shared one app on `target.server`; a later original factory evaluation may remount after the prior request has settled. Never remount between constructing a lazy Supertest chain and its `await`, `.then()`, or `.end()` dispatch.
- **Mixed file:** choose fixed or swappable ownership separately for each owning `describe` or helper parameter. Do not flatten distinct app lifecycles into one module-wide target.

`swappableServer()` deliberately retains its last mounted app. This supports valid `beforeAll` mounts and multi-request sequences. It must not gain a universal `beforeEach` reset. Its regression proves the initially unmapped state returns the helper's diagnostic response, then proves explicit mounts route requests to app A and app B in turn.

### 3. Migration lanes and ownership

The exact file lists are fixed in Appendix A.

| Lane           | Scope                                               |    Files |                                            Calls | Integration owner         |
| -------------- | --------------------------------------------------- | -------: | -----------------------------------------------: | ------------------------- |
| 1              | Module-initialized apps                             |       50 |                                              807 | Module-init lane author   |
| 2              | Hook-built apps                                     |       39 |                                              644 | Hook/local lane author    |
| 3              | Per-test factories and five late-bound Server calls |       28 |                                              389 | Hook/local lane author    |
| 4              | Mixed lifecycles and helper parameters              |       16 |                                              293 | Facade/integration author |
| Stable imports | Already-listening targets                           |       25 |                                      Import-only | Facade/integration author |
| Helper import  | `trigger-turn-helpers.ts`                           | 1 module | call sites remain on caller-owned stable Servers | Facade/integration author |

The 25 stable files already use a listening Server. Their target behavior is correct; only imports and their affected type references move to the facade. The 548 total stable-target calls in the inventory are not assigned to these files as a lane count because a file may contain both stable and unbound target classes.

Each lane is reviewed for the preservation rules below before integration:

- App and backing-state construction stays on its current lifecycle.
- Singleton resets and mock cleanup stay in their current hooks.
- A logical sequence mounts once and makes all dependent requests through the same mounted app.
- Existing `Promise.all` groups remain concurrent.
- Distinct apps in one file keep distinct stable targets or explicit remount points.
- Raw/custom network fixtures remain explicit and are not routed through the facade.

Four nominal Lane 1 files build a fresh app inside request helpers and therefore use a module-scoped swappable target despite their static `moduleInit` classification:

- `services/core/auth/__tests__/seed-legacy-mcp-key.test.ts`: `createOwner()` mounts the app built against the fresh auth/DB/config state from each `beforeEach` immediately before its sign-up sequence.
- `services/core/capabilities/__tests__/capability-conformance.test.ts`: `routeProbe()` mounts its identity-specific app once per probe; `requesterDecideProbe` must keep ask and grant on one mount.
- `services/core/external-mcp/__tests__/surface-parity.test.ts`: `fetchExternalTools()` mounts its fresh external MCP app once per call.
- `services/core/external-mcp/__tests__/tool-security.test.ts`: `fetchLiveTools()` mounts its fresh stateless app once per call and preserves the existing MCP transport cleanup.

`agents.test.ts` is the fixed-app exception within Lane 1: its module app and describe-owned `appWithMesh` receive distinct stable Servers so the 39 requests continue to address the intended router without describe-order dependence.

### 4. Finite exception designs

- **`read-cursors.test.ts`, `rooms-events.test.ts`, `rooms-reactions.test.ts`:** one helper-managed listener serves both Supertest and SSE/raw HTTP. Preserve subscribe-first ordering and active-stream cleanup.
  The baseline classified seven listener starts from `collectDurableEvents(app, ...)` in files whose same app already belongs to Lane 1:

| File                                | Calls | Stable target                       |
| ----------------------------------- | ----: | ----------------------------------- |
| `command-intents.test.ts`           |     1 | the file's helper-owned Server URL  |
| `sessions-list-aggregation.test.ts` |     4 | the file's helper-owned Server URL  |
| `sessions-multi-runtime.test.ts`    |     2 | the file's helper-owned Server URL  |
| **Total**                           | **7** | no second listener for the same app |

Replace these calls with `collectDurableEventsAt(baseUrl, ...)`, using the URL of the same stable Server already owned by each file. This keeps the existing raw SSE parser and every option, predicate, frame assertion, cold/resume sequence, and request order while removing seven duplicate same-app listeners. It does not change `collectDurableEvents` or widen the migration to other raw protocol fixtures.

- **`workbench-serve.test.ts`:** stabilize the app under test; preserve upstream, probe, and IPv6 listeners.
- **`extension-proxy.test.ts`:** route four Supertest app calls through a swappable target; preserve `rawGetStatus` and real upstream listeners.
- **`extension-proxy-rate-limit.test.ts`:** mount the first limiter app for both requests that share its budget, then mount the second limiter app. Preserve both limiter instances.
- **`agents.test.ts`:** retain two distinct module apps through two stable Servers or two explicit targets.
- **`mcp-oauth.test.ts`:** replace five helper Servers constructed inside tests with one owning-scope swappable target. A `listeningServer()` registered after `beforeAll` has already begun is not a bound target.
- **Concurrent groups:** preserve the nine `Promise.all` groups in `rooms-cascade`, `rooms-files`, `rooms-update-gate`, `rooms`, `templates`, and `extensions`.

### 5. Server import guard without confinement regressions

Add a named Supertest runtime-import ban for server test files and modules under test helper directories. Cover both the package root `supertest` and legal package subpaths `supertest/*`, matching the existing confinement rules' root-plus-subpath posture. Its error directs callers to `@dorkos/test-utils/supertest`.

The guard bans runtime imports. Migrate all current namespace type references to the facade's named exports so no direct type import is needed. If the implementation uses ESLint's type-import carve-out, preserve it explicitly and prove a type-only import remains type-only; never let that carve-out admit a runtime default or named value import.

Do not add a final blanket test block that replaces `no-restricted-imports`. Instead, compose the ban into the existing flat-config structure:

- A generic server-test block carries `patterns: ALL_CONFINED` plus the Supertest path ban.
- Each `confineDirectory()` test block carries its directory-specific `patterns` plus the same Supertest path ban.
- Source blocks retain `HOMEDIR_BANS` and their current confinement behavior.
- The final `testConfig` has no `no-restricted-imports` entry today; if that changes during implementation, calculate and inspect the effective config before accepting the rule.

Add an executable guard fixture using `eslint --stdin --stdin-filename`, following `scripts/test-homedir-guard.sh`. It asserts:

- Direct `import request from 'supertest'` and a representative runtime import from `supertest/*` fail at error severity in an ordinary route test.
- The same import fails in every owner-directory test block (`terminal`, `observability`, and the three runtime adapters).
- The facade import passes in those paths.
- A representative prior cross-runtime SDK import still fails in every owner-directory test block after the new ban is added.
- Each runtime's own allowed SDK remains allowed.
- ESLint exits non-zero for the banned import; matching report text alone is not enough.

Register the guard in the root `test:scripts` chain and the scripts-test workflow. The existing shell-suite parity regression must see it on both surfaces.

### 6. Testing rule documentation

Update `.claude/rules/testing.md` with the server route-test contract:

- Import request and response types through `@dorkos/test-utils/supertest`.
- Give the facade only a listening Server or explicit HTTP(S) URL.
- Use `listeningServer()` for fixed apps and `swappableServer()` for rebuilt apps.
- Mount once per logical state-sharing sequence.
- Preserve explicit raw/custom listeners for protocol-boundary tests.

Correct any helper prose that states a specific global-agent or OS mechanism as established fact. Retain the observed aggregate failures, measured bind/close reduction, and explicit uncertainty.

### 7. Completeness evidence

Use an ignored, local-only Node 24 preload during the full 133-file candidate cohort to observe `http.Server.listen()` and `close()` without changing request behavior. For every listener start, record only a normalized origin category and count; do not print response bodies, credentials, or arbitrary app data.

Run this exact cohort twice:

1. **Pinned-base trace:** after preparing and pinning the actual `78b317e` plus merged DOR-1803 base, before any DOR-1804 source edit.
2. **Final trace:** after all migration lanes integrate, using the same 133-file list, preload, command shape, Node version, and classification rules.

Required final report:

- Candidate file count, collected file count, pass/fail/skip totals, and command exit status.
- Total listen/close counts.
- Zero starts whose stack originates in `supertest/lib/test.js` `serverAddress()`.
- Every remaining start classified as `listeningServer`/`swappableServer` or one of the documented custom-fixture categories.
- A direct pinned-base-versus-final comparison from the same 133-file cohort. The archived DOR-1803 inventory and 256-request probe provide supporting context but do not substitute for the pinned-base cohort.
- The pinned base SHA/tree and final SHA/tree. Do not require a nondeterministic parser or socket failure to reproduce.

The durable prevention remains the facade and lint guard; the preload is bounded verification evidence rather than a global test-runtime patch.

## User Experience

There is no product interaction or API change. Developers writing server HTTP tests receive a clear, immediate error when they pass an Express app or unbound Server to the request facade, plus a lint error if they bypass it with a direct Supertest runtime import. Existing tests keep their route behavior and assertions while using a stable listener owned by the fixture.

## Testing Strategy

### Unit tests

- Facade accepts an already-listening Server and the handler observes the request.
- Facade accepts an explicit loopback HTTP URL.
- Facade rejects an Express callable before delegation.
- Facade rejects an unbound `createServer()` before delegation.
- Facade rejects non-HTTP URL strings.
- Typecheck proves named `Test` and `Response` exports support the 19 migrated type positions.
- `swappableServer()` starts unmapped and returns its diagnostic response, then routes to two explicitly mounted apps in sequence.

The handler-observation assertion is required: checking only `server.listening` would remain green if a mutation changed `request(server)` back to `request(app)`.

### Integration tests

- Run each lane's exact focused file cohort on Node 24.14.1 after its migration.
- Run the executable import-guard fixture and inspect error-severity verdicts and process exits.
- Run server and test-utils typecheck/lint. Do not treat the quarantined-file typecheck as full coverage; lint and runtime guards cover that gap.
- Before edits, run the exact 133-file candidate cohort with the listener-origin preload on the pinned implementation base. After all lanes integrate, run the same cohort again and require zero Supertest-origin starts.
- Run one repository `pnpm verify` gate with strict environment filtering and exact output captured. Because the affected server package runs through this gate, do not add a redundant separate full-server gate or repeat broad gates merely to turn a nondeterministic red green.

### Representative mutations

1. Change a real migrated request target from its stable Server to the Express app: facade/runtime or lint/type boundary must fail, and the real server request-event assertion must fail if the facade is bypassed.
2. Give the facade an unbound Server: the unbound-target regression must fail before Supertest binds it.
3. Restore a direct `supertest` runtime import in an ordinary test and in a runtime-owner test: the guard fixture must fail both.
4. Remove a prior cross-runtime SDK pattern from one owner test block while keeping the new Supertest ban: the guard fixture must fail, proving the new config did not hide the old hard rule.
5. Start a swappable target without mounting it: assert the diagnostic response; then mount app A and app B and assert each distinct response. Do not assume the target resets between tests.
6. Restore any `request(app)` call in the candidate cohort while bypassing the facade: the listener-origin proof must observe a Supertest-origin start.

### E2E tests

No browser test is needed; the change is confined to server test infrastructure.

### Mocking strategy

Facade tests use loopback-only Node HTTP handlers and request-event observers. The listener-origin preload observes lifecycle calls and stack origins but does not stub network behavior. Existing route mocks remain unchanged.

## Performance Considerations

The migration removes 2,133 Supertest request-owned listener lifecycles from the known class and seven duplicate same-app SSE listener lifecycles observed in the baseline. A test file instead holds one or a small finite number of listeners for its execution lifetime. Vitest may run several files in parallel, but each worker closes helper-owned active connections and listeners in `afterAll`. The acceptance report records actual listener counts rather than projecting savings from static call counts.

## Security Considerations

The facade accepts only already-listening Servers or explicit HTTP(S) URLs and is used in tests. No production listener, authentication flow, paid credential, environment allowlist, or network exposure changes. Verification probes are loopback-only and record counts/origins without bodies or secrets. Authorization headers and assertions in route tests remain unchanged.

## Documentation

- Update `.claude/rules/testing.md` with the stable-listener contract and examples.
- Keep test-utils TSDoc accurate about observed evidence and the unproved low-level mechanism.
- No changelog fragment is needed because the change affects internal test infrastructure only; the PR should use the repository's approved skip-changelog path.
- No standalone ADR is warranted. The work reuses an existing test lifecycle and adds a package-local enforcement boundary; it changes no production architecture or long-lived product contract.

## Implementation Phases

- **Phase 1 — Foundation:** add the typed facade, exports, focused regressions, composed ESLint guard, executable guard fixture, scripts-test registration, and testing-rule documentation. Migrate the 25 already-stable imports and the shared `trigger-turn-helpers.ts` import so the guard can turn on without exceptions.
- **Phase 2 — Mechanical lanes:** migrate Lane 1 module-initialized fixtures and Lanes 2–3 hook/local fixtures in isolated batches. Preserve every file's lifecycle and run its exact focused cohort before handoff.
- **Phase 3 — Mixed integration:** migrate Lane 4 and the finite custom-listener exceptions, integrate all lane commits, replace the 19 type references, and resolve only concrete lifecycle conflicts.
- **Phase 4 — Proof and review:** compare the pre-edit and final runs of the same whole-candidate listener-origin cohort, run focused regressions and mutation checks, then one full repository verify. Submit the pushed result to fresh independent review before the PR opens.

## Open Questions

- ~~Should the request facade expose `agent()`?~~ **(RESOLVED)** No. There are zero current callers. Add it later only for a concrete cookie-persistence case with the same stable-target contract.
- ~~Should `swappableServer()` reset automatically before each test?~~ **(RESOLVED)** No. Valid `beforeAll` mounts and multi-request state sequences depend on retained mounting. Prove the initially unmapped state and explicit remount behavior instead.
- ~~Should a new final ESLint test block simply ban Supertest?~~ **(RESOLVED)** No. Flat-config rule options replace earlier options. Compose the path ban into the generic test block and every confinement-owner test block, with executable regressions for both the new and prior bans.
- ~~Does the evidence justify an OS/socket-race claim?~~ **(RESOLVED)** No. The evidence proves listener churn and its removal. The final report must retain uncertainty about the low-level cause and broader aggregate failures.
- ~~Does this require an ADR?~~ **(RESOLVED)** No. The change is test-only and applies an existing helper lifecycle; the specification is the durable design record.

## Related ADRs

No new ADR is created. Existing production ADRs do not constrain the request-target test boundary beyond the route-specific behavior the migrated tests already assert.

## References

- DOR-1804 — Require stable HTTP listeners across server test fixtures.
- DOR-1803 / PR #1608 — four-fixture stable-listener precursor.
- Pinned comparison baseline: `912ee15e05ca7786d3eaa3badc33908f79be80fc`.
- Inventory source: `22b66c2c20c6ea70ac7e76c7eee77d7e85e31629`, tree `641d0bc38aebc043af4bf5607f152d230a954282`.
- Implementation parent before DOR-1803 integration: `78b317e68c5b1534afe4432e7d3e8e784a753454`; record the actual combined base SHA/tree after DOR-1803 is merged or integrated and before DOR-1804 edits.
- Archived inventory: `.dork/flow/systemic-listener-inventory.json` and `.md` in the DOR-1804 worktree; the exact durable lane file lists follow below.
- Installed Supertest implementation: `node_modules/.pnpm/supertest@7.2.2/node_modules/supertest/lib/test.js`.
- Existing helpers: `packages/test-utils/src/listening-server.ts`.
- Testing rules: `.claude/rules/testing.md`.
- Server lint config: `apps/server/eslint.config.js`.

## Appendix A — Exact migration file lists

The following lists are disjoint. Together the four migration lanes contain all 133 known unbound-target files. The stable-import list contains the remaining 25 Supertest test files, for all 158 test imports.

### Lane 1 — module-initialized apps (50 files / 807 calls)

- `apps/server/src/routes/__tests__/agents-creation.test.ts` — 30 calls (moduleInit 30)
- `apps/server/src/routes/__tests__/agents.test.ts` — 39 calls (moduleInit 39)
- `apps/server/src/routes/__tests__/capabilities.test.ts` — 5 calls (moduleInit 5)
- `apps/server/src/routes/__tests__/command-intents.test.ts` — 6 calls (moduleInit 6)
- `apps/server/src/routes/__tests__/commands.test.ts` — 11 calls (moduleInit 11)
- `apps/server/src/routes/__tests__/diff-boundary.test.ts` — 19 calls (moduleInit 19)
- `apps/server/src/routes/__tests__/directory.test.ts` — 21 calls (moduleInit 21)
- `apps/server/src/routes/__tests__/files-copy-reveal.test.ts` — 19 calls (moduleInit 19)
- `apps/server/src/routes/__tests__/files-workbench-boundary.test.ts` — 12 calls (moduleInit 12)
- `apps/server/src/routes/__tests__/files-workbench.test.ts` — 30 calls (moduleInit 30)
- `apps/server/src/routes/__tests__/files.test.ts` — 24 calls (moduleInit 24)
- `apps/server/src/routes/__tests__/git.test.ts` — 2 calls (moduleInit 2)
- `apps/server/src/routes/__tests__/health.test.ts` — 3 calls (moduleInit 3)
- `apps/server/src/routes/__tests__/mcp-config.test.ts` — 4 calls (moduleInit 4)
- `apps/server/src/routes/__tests__/models.test.ts` — 5 calls (moduleInit 5)
- `apps/server/src/routes/__tests__/non-claude-default-runtime.test.ts` — 5 calls (moduleInit 5)
- `apps/server/src/routes/__tests__/read-cursors.test.ts` — 33 calls (moduleInit 33)
- `apps/server/src/routes/__tests__/rooms-cascade.test.ts` — 14 calls (moduleInit 14)
- `apps/server/src/routes/__tests__/rooms-communities.test.ts` — 3 calls (moduleInit 3)
- `apps/server/src/routes/__tests__/rooms-events.test.ts` — 27 calls (moduleInit 27)
- `apps/server/src/routes/__tests__/rooms-export.test.ts` — 12 calls (moduleInit 12)
- `apps/server/src/routes/__tests__/rooms-files.test.ts` — 33 calls (moduleInit 33)
- `apps/server/src/routes/__tests__/rooms-reactions.test.ts` — 19 calls (moduleInit 19)
- `apps/server/src/routes/__tests__/rooms-repo.test.ts` — 34 calls (moduleInit 34)
- `apps/server/src/routes/__tests__/rooms-update-gate.test.ts` — 11 calls (moduleInit 11)
- `apps/server/src/routes/__tests__/rooms.test.ts` — 175 calls (moduleInit 175)
- `apps/server/src/routes/__tests__/session-attachments.test.ts` — 12 calls (moduleInit 12)
- `apps/server/src/routes/__tests__/session-devtools.test.ts` — 2 calls (moduleInit 2)
- `apps/server/src/routes/__tests__/sessions-boundary.test.ts` — 12 calls (moduleInit 12)
- `apps/server/src/routes/__tests__/sessions-daily-counts.test.ts` — 5 calls (moduleInit 5)
- `apps/server/src/routes/__tests__/sessions-dispatch-correlation.test.ts` — 8 calls (moduleInit 8)
- `apps/server/src/routes/__tests__/sessions-interactive.test.ts` — 20 calls (moduleInit 20)
- `apps/server/src/routes/__tests__/sessions-kickoff-filter.test.ts` — 6 calls (moduleInit 6)
- `apps/server/src/routes/__tests__/sessions-list-aggregation.test.ts` — 17 calls (moduleInit 17)
- `apps/server/src/routes/__tests__/sessions-mcp-app-resource.test.ts` — 5 calls (moduleInit 5)
- `apps/server/src/routes/__tests__/sessions-model-gate-unbound.test.ts` — 1 calls (moduleInit 1)
- `apps/server/src/routes/__tests__/sessions-multi-runtime.test.ts` — 28 calls (moduleInit 28)
- `apps/server/src/routes/__tests__/sessions-permission-mode-parity.test.ts` — 12 calls (moduleInit 12)
- `apps/server/src/routes/__tests__/sessions-recent.test.ts` — 12 calls (moduleInit 12)
- `apps/server/src/routes/__tests__/sessions-ui-action.test.ts` — 14 calls (moduleInit 14)
- `apps/server/src/routes/__tests__/subagents.test.ts` — 3 calls (moduleInit 3)
- `apps/server/src/routes/__tests__/system-memory.test.ts` — 3 calls (moduleInit 3)
- `apps/server/src/routes/__tests__/system-unattended-autonomy.test.ts` — 4 calls (moduleInit 4)
- `apps/server/src/routes/__tests__/system.test.ts` — 8 calls (moduleInit 8)
- `apps/server/src/routes/__tests__/uploads.test.ts` — 11 calls (moduleInit 11)
- `apps/server/src/routes/__tests__/workbench-serve.test.ts` — 22 calls (moduleInit 22)
- `apps/server/src/services/core/auth/__tests__/seed-legacy-mcp-key.test.ts` — 1 calls (moduleInit 1)
- `apps/server/src/services/core/capabilities/__tests__/capability-conformance.test.ts` — 3 calls (moduleInit 3)
- `apps/server/src/services/core/external-mcp/__tests__/surface-parity.test.ts` — 1 calls (moduleInit 1)
- `apps/server/src/services/core/external-mcp/__tests__/tool-security.test.ts` — 1 calls (moduleInit 1)

### Lane 2 — hook-built apps (39 files / 644 calls)

- `apps/server/src/__tests__/app-security-headers.test.ts` — 13 calls (beforeAll 13)
- `apps/server/src/__tests__/app-spa-fallback.test.ts` — 20 calls (beforeAll 20)
- `apps/server/src/middleware/__tests__/extension-routes.test.ts` — 8 calls (beforeEach 8)
- `apps/server/src/middleware/__tests__/host-guard.test.ts` — 15 calls (beforeEach 15)
- `apps/server/src/routes/__tests__/activity.test.ts` — 5 calls (beforeEach 5)
- `apps/server/src/routes/__tests__/admin.test.ts` — 14 calls (beforeEach 14)
- `apps/server/src/routes/__tests__/config-dto-fallbacks.test.ts` — 2 calls (beforeEach 2)
- `apps/server/src/routes/__tests__/config-mcp.test.ts` — 16 calls (beforeEach 16)
- `apps/server/src/routes/__tests__/config-tunnel-dto.test.ts` — 8 calls (beforeEach 8)
- `apps/server/src/routes/__tests__/default-trust-stop.integration.test.ts` — 18 calls (beforeEach 18)
- `apps/server/src/routes/__tests__/extensions-load-approval.test.ts` — 25 calls (beforeEach 25)
- `apps/server/src/routes/__tests__/extensions-secrets.test.ts` — 21 calls (beforeEach 21)
- `apps/server/src/routes/__tests__/extensions.test.ts` — 25 calls (beforeEach 25)
- `apps/server/src/routes/__tests__/marketplace.test.ts` — 94 calls (beforeEach 94)
- `apps/server/src/routes/__tests__/mesh.test.ts` — 71 calls (beforeEach 71)
- `apps/server/src/routes/__tests__/relay-bindings-conflict.test.ts` — 8 calls (beforeEach 8)
- `apps/server/src/routes/__tests__/room-caller.test.ts` — 11 calls (beforeAll 11)
- `apps/server/src/routes/__tests__/rooms-attachments.test.ts` — 22 calls (beforeEach 22)
- `apps/server/src/routes/__tests__/self-approval-chain.test.ts` — 9 calls (beforeAll 9)
- `apps/server/src/routes/__tests__/standing-grants-chain.test.ts` — 15 calls (beforeAll 15)
- `apps/server/src/routes/__tests__/tasks-cron-validation.test.ts` — 12 calls (beforeEach 12)
- `apps/server/src/routes/__tests__/tasks-file-write.test.ts` — 24 calls (beforeEach 24)
- `apps/server/src/routes/__tests__/tasks-mutation-authority.test.ts` — 7 calls (beforeEach 7)
- `apps/server/src/routes/__tests__/tasks-patch-bypass-escalation.test.ts` — 7 calls (beforeEach 7)
- `apps/server/src/routes/__tests__/tasks-permission-escalation.test.ts` — 5 calls (beforeEach 5)
- `apps/server/src/routes/__tests__/tasks-trigger-authority.test.ts` — 8 calls (beforeEach 8)
- `apps/server/src/routes/__tests__/tasks-unattended-power.test.ts` — 11 calls (beforeEach 11)
- `apps/server/src/routes/__tests__/tasks-write-policy.test.ts` — 25 calls (beforeEach 25)
- `apps/server/src/routes/__tests__/tasks.test.ts` — 45 calls (beforeEach 45)
- `apps/server/src/routes/__tests__/templates.test.ts` — 16 calls (beforeEach 16)
- `apps/server/src/routes/__tests__/terminal.test.ts` — 8 calls (beforeEach 8)
- `apps/server/src/routes/__tests__/test-control-agent-token.test.ts` — 4 calls (beforeEach 4)
- `apps/server/src/routes/__tests__/test-control-persistent.test.ts` — 10 calls (beforeEach 10)
- `apps/server/src/services/core/auth/__tests__/auth.integration.test.ts` — 5 calls (beforeAll 5)
- `apps/server/src/services/core/auth/__tests__/session-gate-sse.integration.test.ts` — 6 calls (beforeAll 6)
- `apps/server/src/services/core/auth/__tests__/session-gate.test.ts` — 20 calls (beforeAll 20)
- `apps/server/src/services/core/external-mcp/__tests__/task-permission-mode.test.ts` — 2 calls (beforeEach 2)
- `apps/server/src/services/rooms/attachments/__tests__/room-attachment-store.test.ts` — 4 calls (beforeEach 4)
- `apps/server/src/services/tasks/__tests__/tasks-changed-broadcast.test.ts` — 5 calls (beforeEach 5)

### Lane 3 — local factory apps and late-bound Servers (28 files / 389 calls)

- `apps/server/src/__tests__/a2a-routes.test.ts` — 24 calls (local 24)
- `apps/server/src/__tests__/app-first-contact.test.ts` — 19 calls (local 19)
- `apps/server/src/middleware/__tests__/extension-proxy-rate-limit.test.ts` — 11 calls (local 11)
- `apps/server/src/middleware/__tests__/mcp-origin.test.ts` — 3 calls (local 3)
- `apps/server/src/routes/__tests__/agent-connectors.test.ts` — 12 calls (local 12)
- `apps/server/src/routes/__tests__/capabilities-catalog.test.ts` — 7 calls (local 7)
- `apps/server/src/routes/__tests__/capabilities-invoke.test.ts` — 20 calls (local 20)
- `apps/server/src/routes/__tests__/config.test.ts` — 1 calls (local 1)
- `apps/server/src/routes/__tests__/connector-providers.test.ts` — 20 calls (local 20)
- `apps/server/src/routes/__tests__/connectors.test.ts` — 44 calls (local 44)
- `apps/server/src/routes/__tests__/discovery.test.ts` — 12 calls (local 12)
- `apps/server/src/routes/__tests__/errors.test.ts` — 3 calls (local 3)
- `apps/server/src/routes/__tests__/feedback.test.ts` — 25 calls (local 25)
- `apps/server/src/routes/__tests__/health-deep.test.ts` — 4 calls (local 4)
- `apps/server/src/routes/__tests__/mcp-capabilities-unverified-agent.test.ts` — 4 calls (local 4)
- `apps/server/src/routes/__tests__/mcp-oauth.test.ts` — 5 calls (localUnboundHttpServer 5)
- `apps/server/src/routes/__tests__/notifications.test.ts` — 24 calls (local 24)
- `apps/server/src/routes/__tests__/profile-avatar.test.ts` — 30 calls (local 30)
- `apps/server/src/routes/__tests__/push.test.ts` — 13 calls (local 13)
- `apps/server/src/routes/__tests__/relay-bindings-bridge.test.ts` — 12 calls (local 12)
- `apps/server/src/routes/__tests__/room-capabilities-unverified-agent.test.ts` — 8 calls (local 8)
- `apps/server/src/routes/__tests__/search.test.ts` — 23 calls (local 23)
- `apps/server/src/routes/__tests__/session-connectors.test.ts` — 9 calls (local 9)
- `apps/server/src/routes/__tests__/shapes.test.ts` — 20 calls (local 20)
- `apps/server/src/routes/__tests__/team.test.ts` — 24 calls (local 24)
- `apps/server/src/routes/__tests__/workspaces.test.ts` — 7 calls (local 7)
- `apps/server/src/services/extensions/__tests__/extension-proxy.test.ts` — 4 calls (local 4)
- `apps/server/src/services/relay/chat-bridge/__tests__/bridged-room-security.test.ts` — 1 calls (local 1)

### Lane 4 — mixed lifecycles and helper parameters (16 files / 293 calls)

- `apps/server/src/middleware/__tests__/mcp-auth.integration.test.ts` — 3 calls (helper 1, beforeAll 2)
- `apps/server/src/routes/__tests__/approvals.test.ts` — 64 calls (beforeEach 32, local 32)
- `apps/server/src/routes/__tests__/debug.test.ts` — 6 calls (helper 1, local 5)
- `apps/server/src/routes/__tests__/discovery.integration.test.ts` — 7 calls (helper 1, local 6)
- `apps/server/src/routes/__tests__/marketplace-approval-flow.test.ts` — 8 calls (beforeEach 5, local 3)
- `apps/server/src/routes/__tests__/mesh-topology.test.ts` — 26 calls (beforeEach 20, moduleInit 6)
- `apps/server/src/routes/__tests__/profile-name.test.ts` — 12 calls (helper 2, local 10)
- `apps/server/src/routes/__tests__/relay-binding-test.test.ts` — 10 calls (moduleInit 8, local 2)
- `apps/server/src/routes/__tests__/relay-bindings-integration.test.ts` — 54 calls (beforeEach 35, local 19)
- `apps/server/src/routes/__tests__/runtimes.test.ts` — 20 calls (moduleInit 16, local 4)
- `apps/server/src/routes/__tests__/sessions-pending-interactions.test.ts` — 17 calls (local 16, helper 1)
- `apps/server/src/routes/__tests__/tunnel-cors.test.ts` — 14 calls (moduleInit 13, local 1)
- `apps/server/src/routes/__tests__/tunnel.test.ts` — 27 calls (moduleInit 25, local 2)
- `apps/server/src/routes/__tests__/unclaimed-chats.test.ts` — 22 calls (beforeEach 12, local 10)
- `apps/server/src/services/connectors/providers/__tests__/nango-proxy-mcp.test.ts` — 2 calls (helper 1, local 1)
- `apps/server/src/services/runtimes/codex/__tests__/codex-ui-mcp-server.test.ts` — 1 calls (helper 1)

### Already-stable facade import migrations (25 test files)

- `apps/server/src/lib/__tests__/local-caller.test.ts` — runtime import at line 12
- `apps/server/src/middleware/__tests__/auth-rate-limit.test.ts` — runtime import at line 5
- `apps/server/src/routes/__tests__/agents-conventions.test.ts` — runtime import at line 75
- `apps/server/src/routes/__tests__/cloud.test.ts` — runtime import at line 3
- `apps/server/src/routes/__tests__/local-caller-parity.test.ts` — runtime import at line 53
- `apps/server/src/routes/__tests__/mcp-integration.test.ts` — runtime import at line 3
- `apps/server/src/routes/__tests__/mcp.test.ts` — runtime import at line 3
- `apps/server/src/routes/__tests__/mock-mcp-oauth-server.test.ts` — runtime import at line 22
- `apps/server/src/routes/__tests__/relay.test.ts` — runtime import at line 3
- `apps/server/src/routes/__tests__/room-caller-unverified-agent.test.ts` — runtime import at line 33
- `apps/server/src/routes/__tests__/rooms-holds.test.ts` — runtime import at line 18
- `apps/server/src/routes/__tests__/rooms-sessions.test.ts` — runtime import at line 26
- `apps/server/src/routes/__tests__/runtimes-connect.test.ts` — runtime import at line 53
- `apps/server/src/routes/__tests__/sessions-account-hint.test.ts` — runtime import at line 76
- `apps/server/src/routes/__tests__/sessions-approval-live.test.ts` — runtime import at line 74
- `apps/server/src/routes/__tests__/sessions-cross-client.test.ts` — runtime import at line 95
- `apps/server/src/routes/__tests__/sessions-cwd-resolution.test.ts` — runtime import at line 144
- `apps/server/src/routes/__tests__/sessions-cwdless-stream.test.ts` — runtime import at line 93
- `apps/server/src/routes/__tests__/sessions-image-attachments.test.ts` — runtime import at line 78
- `apps/server/src/routes/__tests__/sessions-queue.test.ts` — runtime import at line 71
- `apps/server/src/routes/__tests__/sessions-retired-id.test.ts` — runtime import at line 74
- `apps/server/src/routes/__tests__/sessions-streaming.test.ts` — runtime import at line 67
- `apps/server/src/routes/__tests__/sessions-trigger.test.ts` — runtime import at line 69
- `apps/server/src/routes/__tests__/sessions-turn-serialization.test.ts` — runtime import at line 77
- `apps/server/src/routes/__tests__/sessions.test.ts` — runtime import at line 96

### Shared test-helper facade import migration

- `apps/server/src/routes/__tests__/helpers/trigger-turn-helpers.ts` — runtime import at line 9

## Appendix B — Type-reference migration

All 19 namespace references move from `request.Test` / `request.Response` to named facade-exported types. The exact file/count list is generated from the resolved inventory.

- `apps/server/src/middleware/__tests__/mcp-auth.integration.test.ts` — line 85 `Test`
- `apps/server/src/routes/__tests__/mcp-capabilities-unverified-agent.test.ts` — line 140 `Response`, line 152 `Response`, line 225 `Response`, line 313 `Test`, line 334 `Response`
- `apps/server/src/routes/__tests__/mcp-integration.test.ts` — line 308 `Test`, line 403 `Response`
- `apps/server/src/routes/__tests__/room-capabilities-unverified-agent.test.ts` — line 176 `Response`, line 188 `Response`, line 209 `Response`, line 396 `Test`, line 608 `Test`, line 618 `Response`
- `apps/server/src/services/connectors/providers/__tests__/nango-proxy-mcp.test.ts` — line 59 `Response`
- `apps/server/src/services/core/external-mcp/__tests__/surface-parity.test.ts` — line 89 `Response`
- `apps/server/src/services/core/external-mcp/__tests__/task-permission-mode.test.ts` — line 64 `Response`
- `apps/server/src/services/core/external-mcp/__tests__/tool-security.test.ts` — line 305 `Response`
- `apps/server/src/services/runtimes/codex/__tests__/codex-ui-mcp-server.test.ts` — line 41 `Response`
