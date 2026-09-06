---
slug: stable-http-test-listeners
number: 260906-000529
created: 2026-09-06
status: ideation
---

# Stable HTTP listeners for server test fixtures

**Slug:** stable-http-test-listeners
**Author:** Codex
**Date:** 2026-09-06

---

## 1) Intent & Assumptions

- **Task brief:** Finish the recurring Supertest listener-fixture class across the server test suite. Migrate every known request that currently hands Supertest an Express app or an unbound `http.Server` to an existing stable-listener lifecycle, then add a typed request boundary and lint guard that prevent the pattern from returning.
- **Tracker:** DOR-1804, “Require stable HTTP listeners across server test fixtures,” parent DOR-1007.
- **Prerequisite:** DOR-1803 / PR #1608 establishes and validates `listeningServer()` and `swappableServer()` in four recurring failure fixtures. Its pushed source commit is `22b66c2c20c6ea70ac7e76c7eee77d7e85e31629`; the inventory was resolved against that tree, with comparison baseline `912ee15e05ca7786d3eaa3badc33908f79be80fc`.
- **Assumptions:**
  - The installed Supertest 7.2.2 implementation remains the behavioral authority: a function target becomes a new `http.Server`, and `serverAddress()` calls `listen(0)` whenever its Server target has no address. Supertest closes only the listener it opened.
  - `listeningServer()` is the right lifecycle for an app created once for an owning module or `describe`; `swappableServer()` is the right lifecycle where tests intentionally rebuild or replace the app.
  - Fresh apps, stores, config directories, mocks, caller middleware, singleton resets, and authorization setup keep their existing `beforeAll`, `beforeEach`, or per-test ownership. The migration changes the transport fixture, not domain isolation.
  - The type-aware inventory is the strongest available static census, including test files excluded from the normal server TypeScript program. It is not proof that no exotic runtime alias exists, so the final listener-origin trace is the completeness oracle.
  - DOR-1803 lands before the implementation branch is integrated. Its four migrated fixtures are therefore absent from the remaining 133-file migration.
- **Out of scope:**
  - Production or application behavior.
  - Timeouts, retries, Vitest workers, Turbo scheduling, or assertion weakening.
  - Global monkeypatches of Supertest, Superagent, `http.Server`, or Node agents.
  - Replacing raw `node:http` requests or custom listeners that intentionally test SSE, malformed request lines, peer addresses, upstream forwarding, or port-family behavior.
  - Adding `request.agent()` support without a real cookie-state use case; the current inventory contains zero agent calls.
  - Proving a particular operating-system, socket-pool, or port-reuse mechanism, or claiming this change fixes every aggregate server failure.

## 2) Pre-reading Log

- `.dork/flow/systemic-listener-inventory.json`: exact disjoint lane lists and 2,133 call sites, all 158 Supertest test imports, 19 namespace type references, exception matrix, baseline reconciliation, and proof plan.
- `.dork/flow/systemic-listener-inventory.md`: short inventory summary and the bounded probe result.
- `.claude/rules/testing.md`: colocated Vitest conventions, meaningful regression requirements, and the ban on tests that merely mirror implementation.
- `packages/test-utils/src/listening-server.ts`: existing file-scoped `listeningServer()` and swappable-app `swappableServer()` lifecycles. The helper owns bind in `beforeAll` and connection teardown plus close in `afterAll`.
- `packages/test-utils/package.json`: `supertest` and its types are already direct test-utils dependencies; a package subpath can own the facade without adding a dependency.
- `node_modules/.pnpm/supertest@7.2.2/node_modules/supertest/lib/test.js`: a function target is wrapped with `http.createServer`; `serverAddress()` binds an unbound Server with `listen(0)`; `end()` closes the listener recorded in `_server`.
- `apps/server/eslint.config.js`: flat-config `no-restricted-imports` options replace rather than merge. The server has global and per-owner-directory blocks for SDK, `node-pty`, OpenTelemetry, and `os.homedir()` confinement. Any Supertest restriction must compose with every existing block.
- `scripts/test-homedir-guard.sh`: executable fixture pattern that proves a new restricted-import rule without silently dropping prior restrictions. Its cross-directory SDK checks are the relevant regression model.
- DOR-1803 focused evidence: four migrated fixtures reduced listener starts from 130 to 4. The boundary mutation `request(server)` → `request(app)` reduced observed shared-server request events from two to zero and failed the intended regression.
- `.dork/flow/evidence/listener-boundary-probe-node24-v2.log` in the DOR-1803 author worktree: 256 unbound requests caused 256 binds, 256 closes, and 256 unique listener ports; 256 stable requests caused one bind, one close, and one listener port. Neither variant failed.
- `decisions/`: no existing ADR establishes this test-only boundary. Existing ADRs govern production architecture or specific domain fixtures, not Supertest target ownership.

## 3) Codebase Map

### Primary components

- `packages/test-utils/src/listening-server.ts` — stable listener lifecycle helpers.
- `packages/test-utils/src/` plus package exports — proposed typed Supertest facade and facade regressions.
- `apps/server/eslint.config.js` — proposed direct-runtime-import restriction for server tests and their helper modules.
- `scripts/` and `scripts/__tests__/` — executable lint-config regression proving both the new Supertest restriction and existing SDK confinement remain active.
- `apps/server/src/**/__tests__/**/*.test.ts` and colocated `*.test.ts` files — 133 known files that still give Supertest an unbound target after DOR-1803.

### Resolved migration lanes

| Lane      | Lifecycle shape                                  |   Files |     Calls | Target lifecycle                                                                |
| --------- | ------------------------------------------------ | ------: | --------: | ------------------------------------------------------------------------------- |
| 1         | Module-initialized apps                          |      50 |       807 | `listeningServer()` per owning app                                              |
| 2         | Apps rebuilt in `beforeAll` or `beforeEach`      |      39 |       644 | `swappableServer()`; mount at the existing build point                          |
| 3         | Per-test/local factories plus late-bound Servers |      28 |       389 | `swappableServer()` scoped to the owning suite; mount once per logical sequence |
| 4         | Mixed lifecycles and helper parameters           |      16 |       293 | Explicit fixed/swappable target per owning `describe` or helper contract        |
| **Total** |                                                  | **133** | **2,133** |                                                                                 |

The current suite has 2,681 Supertest calls in 158 test files. Type analysis classifies 2,128 calls in 132 files as Express targets and 553 calls in 27 files as Server targets. Five Server calls in `routes/__tests__/mcp-oauth.test.ts` are still unbound because the helper is constructed inside each `it`, after its registered `beforeAll` phase. Those five join the 2,128 Express targets to form the known recurring class.

The exact `request(app)` baseline at `912ee15e0` is 1,952 calls in 126 files. That is six more sites than the earlier approximate report of 1,946. DOR-1803 migrates 63 exact sites in four files, leaving 1,889 exact sites in 122 files. Identifier text misses inline factories, named apps, helper parameters, and the five late-bound Server targets, so it is not the acceptance oracle.

### Type and lint boundary

- All 158 test files import the default Supertest runtime as local name `request`; one non-test helper module under `__tests__/helpers/` also imports it.
- Nineteen sites use `request.Test` or `request.Response`; the facade must re-export equivalent named types so runtime imports can move without losing type clarity.
- Twenty-seven Supertest test files are currently excluded as roots from `apps/server/tsconfig.json`; a type-only contract cannot cover the whole suite. The lint import guard and facade runtime validation close that gap.
- There are no `request.agent()` sites, explicit URL targets, second request options arguments, or Vitest concurrent declarations. Nine `Promise.all` groups all target one app and must remain concurrent.

### Finite custom-listener exceptions

- `read-cursors.test.ts`, `rooms-events.test.ts`, and `rooms-reactions.test.ts`: reuse one helper-managed listener for Supertest and SSE/raw HTTP, preserving subscribe-first ordering and active-stream cleanup.
- `workbench-serve.test.ts`: stabilize only the app under test; preserve upstream, probe, and IPv6 listener fixtures.
- `extension-proxy.test.ts`: move four Supertest app calls to a swappable target; preserve `rawGetStatus` and actual upstream listeners.
- `extension-proxy-rate-limit.test.ts`: mount the first limiter app for both stateful requests, then the second app; preserve each limiter instance and its budget state.
- `agents.test.ts`: retain two distinct module apps through two stable servers or explicit mount points.
- `mcp-oauth.test.ts`: replace the five per-test late-bound helper Servers with one module-scoped swappable target.
- Promise concurrency in `rooms-cascade`, `rooms-files`, `rooms-update-gate`, `rooms`, `templates`, and `extensions` remains intact.

### Data flow

```text
existing app construction and reset lifecycle
  → listeningServer(app) OR swappableTarget.mount(app)
  → typed request facade validates an already-listening Server
  → Supertest receives that Server
  → existing route request, headers, body, assertions, and concurrency
  → helper-owned afterAll closes active connections and the listener
```

### Feature flags and configuration

No product flags, environment variables, credentials, or paid evaluations are involved. Verification uses Node 24.14.1 and the existing strict Turbo environment.

### Potential blast radius

- Test runtime imports and request targets across 158 server test files.
- Test-only exports and helper regressions in `@dorkos/test-utils`.
- Server ESLint flat-config composition plus one executable config guard.
- No production bundle, API, persisted data, or user-facing behavior.

## 4) Root Cause Analysis

1. Supertest receives a non-listening Express app or Server.
2. Supertest creates or binds a listener on port zero for that request.
3. Supertest closes the listener it opened when the request finishes.
4. The aggregate server suite repeats this ownership cycle thousands of times across parallel workers.

**Observed:** aggregate gates have intermittently reported `socket hang up`, `Parse Error: Expected HTTP/, RTSP/ or ICE/`, and responses impossible for the app assembled by the failing test. The affected focused files pass when isolated. The failures recur outside the four DOR-1803 fixtures as the aggregate suite moves on.

**Expected:** each test file or owning suite binds a deliberate listener once, Supertest sends every applicable request through that listener, and only the fixture owner closes it after the suite.

**Established evidence:** Supertest’s source proves the per-request bind/close behavior. The bounded probe proves 256 unbound requests create 256 listener lifecycles and 256 ports, while a stable target creates one lifecycle and one port. DOR-1803 proves requests reach the stable listener and reduces listener starts in four real fixtures from 130 to 4.

**Unestablished mechanism:** neither the probe nor the focused cohorts reproduced the parser or socket failure. The exact kernel/socket mechanism and the causal contribution to each aggregate failure remain unproved.

**Decision:** remove the objectively unnecessary transport churn across the known class and enforce the ownership boundary. Judge completeness by actual listener origins, not by claiming a low-level cause or waiting for a nondeterministic fault.

## 5) Research

1. **Systematic migration plus typed facade and import guard — recommended.**
   - Pros: uses proven helpers; preserves app isolation; catches both typed and quarantined files; prevents future direct Supertest calls with unbound targets; provides a runtime error at the misuse boundary.
   - Cons: broad mechanical migration across 133 files; requires careful lifecycle review and a composed ESLint rule.
2. **Migrate current call sites without prevention.**
   - Pros: smaller helper/config change.
   - Cons: any future `request(app)` silently restores per-request listener ownership; identifier-based inventory would need repeated audits.
3. **Static AST/dataflow guard only.**
   - Pros: leaves imports unchanged.
   - Cons: fragile across aliases, helper parameters, and factory expressions; reproduces the same incomplete reasoning the type-aware inventory had to overcome.
4. **Global Supertest or Node monkeypatch.**
   - Pros: central interception.
   - Cons: hidden behavior, cross-test risk, and weak ownership semantics; rejected.
5. **Reduce workers, serialize tests, raise timeouts, or retry failures.**
   - Pros: may reduce observed pressure.
   - Cons: leaves 2,133 unintended listener lifecycles, weakens feedback, and does not establish correctness; rejected.

## 6) Decisions

| #   | Decision               | Choice                                                                                  | Rationale                                                                                                                                                                                       |
| --- | ---------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Migration scope        | All 133 known remaining files / 2,133 known unbound calls                               | Recurring failures have moved between untouched fixtures; another small patch would preserve the class.                                                                                         |
| 2   | Fixed-app lifecycle    | Existing `listeningServer()`                                                            | One app and one listener share the owning module/describe lifetime.                                                                                                                             |
| 3   | Rebuilt-app lifecycle  | Existing `swappableServer()`                                                            | Tests retain fresh app/state construction while the HTTP listener remains stable.                                                                                                               |
| 4   | Request boundary       | Narrow `@dorkos/test-utils/supertest` facade                                            | It accepts only an already-listening Server or explicit HTTP(S) URL and fails loudly on an Express app or unbound Server.                                                                       |
| 5   | Agent API              | Omit `request.agent()`                                                                  | No current caller needs cookie persistence; add it only with a real case and an equally strict target contract.                                                                                 |
| 6   | Prevention             | Runtime validation plus server-test import guard                                        | Type checks do not cover 27 quarantined Supertest files; the two controls cover different holes.                                                                                                |
| 7   | ESLint composition     | Preserve every existing confinement pattern in every affected flat-config block         | `no-restricted-imports` options replace rather than merge; adding a blanket test override would silently drop SDK and native-addon bans.                                                        |
| 8   | Lint regression        | Prove the new ban and a prior cross-runtime SDK ban both fail in owner test directories | A passing new rule is insufficient if it erased an existing hard rule.                                                                                                                          |
| 9   | Swappable target state | No universal implicit reset                                                             | Some suites intentionally mount once in `beforeAll` or share an app across a request sequence. Tests should prove an initially unmapped target fails and remounting routes to the intended app. |
| 10  | Concurrency            | Preserve all existing `Promise.all` request groups                                      | Stable listeners support concurrent requests; serializing assertions would change coverage.                                                                                                     |
| 11  | Completion oracle      | Whole-candidate listener-origin trace                                                   | Require zero listener starts whose stack originates in Supertest’s `serverAddress()` and classify every remaining custom listener origin.                                                       |
| 12  | Failure claims         | Report only measured churn removal and observed gate results                            | The exact socket/OS mechanism was not reproduced, and the migration is not evidence that every load failure is fixed.                                                                           |
| 13  | ADR                    | No standalone ADR                                                                       | This is a test-only application of an existing helper lifecycle and a local enforcement boundary; it does not change production architecture or a durable product contract.                     |

No ambiguities remain. The resolved inventory, finite exceptions, facade boundary, guard composition, and proof plan are sufficient to move to specification.
