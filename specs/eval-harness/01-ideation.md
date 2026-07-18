---
slug: eval-harness
id: 260718-044329
created: 2026-07-17
status: ideation
linearIssue: DOR-357
---

# Eval Harness v1 (`packages/evals`)

**Slug:** eval-harness
**Author:** spec-eval-harness (IDEATE stage, DorkOS Shapes program W4)
**Date:** 2026-07-17
**Tracker:** DOR-357 · Shapes program, workstream W4 · depends on D5 (eval-cadence policy)

---

## 1) Intent & Assumptions

- **Task brief:** Build `packages/evals` — a headless eval runner that sends a
  natural-language prompt to a **real DorkOS agent session** running against a
  **credentialed runtime**, collects the durable per-session SSE stream, and
  **asserts on API / filesystem outcomes** (files exist, DB rows changed, an MCP
  tool actually ran) — never on transcript vibes. Ship the eval suite v1: the
  **12 core evals** (marketplace install / search / build-extension /
  modify-extension / uninstall / control_ui / widget round-trip /
  task-scheduling / relay-notification / agent-create / switch-agent /
  safety-refusal) plus the **2 connector evals** ("Connect to my Gmail" →
  default MCP gateway; "Connect to Slack" → the Relay Slack adapter, a **routing**
  eval). Wire CI to the D5 eval cadence: per-PR label-gated smoke → nightly full
  → memoized release gate → weekly deep. This is **"everything via prompting"
  made testable** and **the demo-claim gate made executable**
  (`plans/shapes-program.md` W4 + D5; `meta/positioning-202607/09-gtm-plan.md`
  §2.0).

- **Assumptions** (each flagged where it is load-bearing):
  1. **The runner drives the HTTP API, not the browser.** `apps/e2e`
     (Playwright) owns DOM/visual assertions; evals own outcome assertions. No
     browser, no Vite client. _(Assumption: confirmed against the W4 brief and
     the "explicitly not doing" list — apps/e2e owns browser e2e.)_
  2. **Two runtime tiers per eval class.** Structure/plumbing evals that need a
     deterministic agent run against `test-mode`
     (`apps/server/src/services/runtimes/test-mode/test-mode-runtime.ts`);
     judgment evals — the ones that prove the model _chooses_ the right tool from
     a natural-language prompt — run against **real `claude-code` with a cheap
     model** (Haiku-class). The cost tier is a per-eval property.
  3. **The connector gateway (W5) is not built yet.** The two connector evals
     encode the **routing contract** as spec-of-record. In v1 they run against a
     **mock connector surface** and assert the _routing decision_ (which MCP
     server / adapter the agent selected), and they ship **`quarantined` /
     pending** until W5 lands the `ConnectorProvider`. _(Assumption, flagged: the
     "default MCP gateway" and the generic-vs-Relay-Slack routing target are W5
     artifacts; see §5 and the connector-eval rows in `02-specification.md`.)_
  4. **The memoized release gate reuses Turbo's affected mechanism** rather than
     inventing a bespoke one — `pnpm verify` already runs
     `turbo run … --affected` (`package.json`), so the gate pins a green result
     to a base commit SHA + an eval-relevant path set computed the same way.
  5. **A budget cap is enforced _in the runner_** from the runtime's own
     usage/cost reporting (`UsageStatusSchema` on the `session_status` event),
     not bolted on after the fact.

- **Out of scope (v1):**
  - Browser/DOM e2e — that is `apps/e2e`'s job; evals never open a page.
  - **Shape-specific evals** — deferred until W2 (the shape primitive) lands.
  - Model-quality benchmarking / leaderboards; load or latency testing of a
    provider.
  - Building the connector gateway itself (W5) — v1 only encodes its eval
    contract.
  - A results dashboard UI — that is P5(b) in the Shapes program (a _shape_ built
    _on_ this harness's output), not the harness.

## 2) Pre-reading Log

- `plans/shapes-program.md` — W4 scope (runner + 12 core + 2 connector evals),
  D5 eval-cadence policy (per-PR label-gated smoke → nightly full → **memoized**
  release gate → weekly deep; `--skip-evals` hatch with guardrails; budget caps
  `~$1–3/full run`, `~$30–90/mo` nightly; transcripts as JSONL; failures
  auto-file tracker items; flaky quarantine), and success criterion #1 ("one
  prompt installs / modifies / uninstalls a shape — proven by green evals in
  CI").
- `apps/e2e/tests/chat/send-message.spec.ts` — the **real-runtime precedent**:
  `@integration`-tagged, 90 s timeout, sends a prompt and waits for a real
  streamed response. Confirms real-runtime tests already exist and how they are
  scoped/timed. Evals reuse the _prompt→run→assert_ shape but assert on API/FS,
  not DOM.
- `packages/test-utils/src/sse-test-helpers.ts` — `collectDurableEvents(app, sessionId, { until, after, lastEventId })`: opens `GET /api/sessions/:id/events` against a **real listening server** via `app.listen(0)` and `http.request`, parses SSE frames (id/event/data), and resolves on an `until` predicate. This is the exact collection primitive the runner extends (the harness runs the server on a real port and connects over HTTP). Note: it _creates_ the server, so the credentialed child-process tier needs a URL-targeting sibling that reuses the same parser.
- `packages/test-utils/src/runtime-conformance.ts` — the `runtimeConformance`
  contract suite: every turn's stream is well-formed `StreamEvent`s ending in a
  terminal `done`; `session_status.usage` parses against `UsageStatusSchema`
  (the budget-cap signal); typed `error` before `done` on failure. The eval
  runner consumes the _same_ stream contract, so its stop-condition (`until` =
  saw terminal `done`) and its usage/cost extraction are already specified.
- `apps/server/src/routes/sessions.ts` — `POST /api/sessions/:id/messages` is
  **trigger-only, `202 Accepted`** with the canonical session id (lines 352–493);
  turn delivery rides `GET /api/sessions/:id/events` (durable SSE:
  snapshot → gap-free replay via `Last-Event-ID`/`?after=` → live `seq`'d
  events). `409 SESSION_LOCKED` when busy. This is the runner's drive loop.
- `apps/server/src/services/runtimes/test-mode/test-mode-runtime.ts` +
  `scenario-store.ts` — zero-latency stateless runtime, registered when
  `DORKOS_TEST_RUNTIME=true`; scenarios are driven via `POST /api/test/scenario`.
  The structural tier's deterministic backend.
- `apps/server/src/index.ts` — runtime registration (lines 440–471): test-mode
  when `DORKOS_TEST_RUNTIME`, else `ClaudeCodeRuntime` as default;
  `applyConfiguredDefaultRuntime` honors a configured default. The runner picks
  the tier by setting these envs when it boots the server.
- `apps/server/src/services/marketplace-mcp/` — the **8 marketplace MCP tools**
  (`tool-search`, `tool-recommend`, `tool-get`, `tool-install`,
  `tool-uninstall`, `tool-list-installed`, `tool-list-marketplaces`,
  `tool-create-package`). These are the _oracles_ for the marketplace evals: a
  successful "install X" run is proven by the install transaction's on-disk
  result + `tool-list-installed`, not by the chat text.
- `apps/server/src/services/marketplace/transaction.ts` (per AGENTS.md +
  ADR-0304) — file-scoped, git-free install transaction (stage → backup →
  atomic rename → restore-on-failure). The install/uninstall oracle is this
  transaction's committed filesystem state.
- `.github/workflows/claude-code-review.yml` — the **label-gate precedent**:
  triggers on `labeled`, gates the job on `github.event.label.name == 're-review'`,
  and auto-clears the label. The per-PR smoke tier mirrors this exactly with an
  `evals` label.
- `.github/workflows/cli-smoke-test.yml` — the **`paths:` filter precedent**
  (run only when specific paths change) and the Node 22/24 matrix + tarball
  artifact pattern the eval jobs reuse for structure.
- `turbo.json` + root `package.json` `verify` script (`turbo run … --affected`)
  — how "affected-only" is computed in this repo; the memoized release gate
  reuses this, not a bespoke mapping.
- `.claude/commands/system/release.md` — the release command the gate hooks
  into: Phase 2 pre-flight (clean tree, on `main`), Phase 6 executes the tag.
  The eval gate is a **new pre-flight check** between changelog completeness and
  tagging, with the `--skip-evals` hatch recorded in the release's internal
  notes.
- `.dork/plugins/flow/scripts/tasks-schema.ts` — the `03-tasks.json` contract
  (canonical size scale `xs`–`xl`, per-task `issue` provenance, `.strict()`).

## 3) Codebase Map

- **Primary new module:** `packages/evals/` (new workspace package, `@dorkos/evals`).
  - `src/runner/` — server boot (tier-selected runtime) + drive loop
    (POST trigger → SSE collect → oracle → score) + budget-cap guard.
  - `src/suite/` — the eval definitions (one file per eval or per family), each a
    typed `EvalCase { id, prompt, runtimeTier, costClass, oracle, scoring }`.
  - `src/oracles/` — reusable outcome checks (filesystem exists/changed, HTTP GET
    assert, DB row present, MCP-tool-invoked-in-stream).
  - `src/report/` — JSONL transcript writer + machine-readable results summary.
  - `bin/` — CLI entry (`dorkos-evals run --suite … --tier … --budget …`).
- **Shared dependencies (reused, not rebuilt):**
  - `@dorkos/test-utils` → `collectDurableEvents` (SSE collection),
    `runtimeConformance`-adjacent stream contract, `FakeAgentRuntime` (for the
    runner's _own_ unit tests).
  - `@dorkos/shared` → `StreamEvent`, `UsageStatusSchema`, `SessionSnapshot`
    types; the trigger/events HTTP contract.
  - The real Express app (`createApp`/`finalizeApp`) + `runtimeRegistry` — booted
    in-process for the structural tier and as a child process (credentialed) for
    the judgment tier.
- **Data flow (one eval):**
  `seed sandbox (temp DORK_HOME + temp project cwd)` →
  `boot server (tier runtime)` →
  `POST /api/sessions/:id/messages {content: prompt, cwd: sandbox}` (202) →
  `collectDurableEvents(until = terminal 'done' | budget exceeded)` →
  `oracle(sandbox, DORK_HOME, api)` → `score (pass/fail [+ rubric])` →
  `write transcript.jsonl + result`.
- **Feature flags / env:** `DORKOS_TEST_RUNTIME` (structural tier),
  `DORKOS_DEFAULT_RUNTIME` / configured default (judgment tier picks
  `claude-code` + a cheap model), `DORK_HOME` (per-eval sandbox home — the
  `lib/dork-home.ts` single source of truth; `os.homedir()` is banned),
  `ANTHROPIC_API_KEY` (judgment/deep tiers only), a per-run `EVALS_BUDGET_USD`
  cap.
- **Feature flags/config owners:** eval-cadence CI config lives in a new
  `.github/workflows/evals.yml`; the release-gate hook is a check in
  `.claude/commands/system/release.md`; memoized results are stored under a
  gitignored cache keyed by SHA + path-set hash.
- **Potential blast radius:** additive. New package + new workflow + one new
  pre-flight check in the release command. No production runtime code changes.
  Two small additive shared-surface touches: (a) a possible extension to
  `@dorkos/test-utils` if the runner needs an HTTP-port variant of the SSE
  collector (kept in `packages/evals` if it does not generalize cleanly), and
  (b) `apps/server/package.json` must **expose `createApp`/`finalizeApp`**
  (`src/app.ts:70`/`:158`) — its `exports` map today carries only `.` plus two
  service subpaths, so those symbols are not importable by another workspace
  package as-is; the in-process boot needs a re-export from `index.ts` or a
  `./app` subpath (export-map addition only, no behavior change).

## 4) Root Cause Analysis

Not a bug fix — omitted.

## 5) Research

**Problem framing.** An eval must answer "did the agent _do the thing_?", which
for a coding-agent OS means "did the right side effect happen?" — a file was
written, a DB row appeared, an MCP tool fired, a message was published. Asserting
on the assistant's prose ("it _said_ it installed the plugin") is the classic
eval failure mode and is explicitly banned by the W4 quality bar. So every eval
is anchored to an **oracle**: a check on API state or filesystem state that is
true iff the behavior occurred.

**Solution options considered:**

1. **In-process server vs. child-process server.**
   - _In-process_ (`createApp` + `app.listen(0)`, register the runtime directly):
     matches `collectDurableEvents` exactly, gives the oracle direct filesystem
     access to the sandbox, fast. Great for the **structural (test-mode)** tier.
   - _Child-process_ (boot the built server / CLI, hit over HTTP): the honest
     production path for a **credentialed real runtime** that shells out to the
     `claude` binary and loads real MCP tools; isolates crashes; mirrors how a
     user actually runs DorkOS.
   - **Recommendation:** support both behind one `HarnessServer` abstraction —
     in-process for `test-mode`, child-process for `claude-code`. Both expose the
     same `{ baseUrl, dorkHome, dispose() }` so the drive loop and oracles are
     tier-agnostic.

2. **SSE collection.** Reuse `collectDurableEvents`'s frame parser and `until`
   predicate; point it at the real port. Stop on the terminal `done` event (the
   `runtimeConformance` contract guarantees every turn ends in one) or on a
   wall-clock/turn-count ceiling. Multi-turn evals loop: POST, collect to `done`,
   run an intermediate oracle, POST again.

3. **Scoring.** Two modes:
   - _Oracle (pass/fail)_ — the default and the majority. Deterministic:
     `assert file exists`, `assert GET /api/... returns X`, `assert tool T
appeared in the stream`. No model in the loop.
   - _Rubric (LLM-judge)_ — only where the outcome is inherently a judgment
     (e.g. `safety-refusal`: "did the agent decline and not perform the harmful
     action?"). A cheap-model judge scores against a fixed rubric, and even then
     the _primary_ signal is an oracle (the harmful side effect did **not**
     happen), with the judge as a secondary check. Judge prompts are versioned.

4. **Budget cap.** The runner accumulates `total_cost_usd` from each turn's
   `session_status.usage` (`UsageStatusSchema`) and aborts the run (marking
   remaining evals `skipped-over-budget`) when the per-run cap is exceeded. A
   per-eval soft ceiling catches a single runaway turn.

5. **Connector evals under a not-yet-built gateway (W5).** The routing _contract_
   is stable even though the gateway is not: "Connect to my Gmail" must resolve
   to the **default MCP gateway** connector path, and "Connect to Slack" must
   resolve to the **Relay Slack adapter** (`packages/relay` adapter-manager),
   _not_ the generic gateway — because Slack is a first-class Relay channel with
   consent + streaming, and routing it through the generic gateway would be a
   regression. v1 encodes both as evals against a **mock connector surface**,
   asserts the _selected route_, and ships them `quarantined`/pending so they do
   not gate CI until W5 provides the real `ConnectorProvider`. This makes the
   harness the executable spec the gateway must satisfy.

**Recommendation:** an in-process/child-process dual-mode runner, oracle-first
scoring with a narrow rubric carve-out, runner-enforced budget, JSONL
transcripts, and CI wired to the D5 cadence with the connector pair quarantined
until W5.

## 6) Decisions

| #   | Decision                | Choice                                                                                                                                                                                  | Rationale                                                                                                    |
| --- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1   | Where the harness lives | New workspace package `packages/evals` (`@dorkos/evals`), CLI-runnable                                                                                                                  | Matches monorepo structure; keeps eval deps out of shipped packages; W4 names `packages/evals` explicitly    |
| 2   | What an eval asserts    | An **oracle** on API/filesystem state; transcript text is never the pass signal                                                                                                         | The W4 quality bar; avoids the "it said it did it" failure mode                                              |
| 3   | Runtime tiers           | `test-mode` for structural evals; real `claude-code` + cheap model for judgment evals; real providers only in the weekly deep tier                                                      | Cost + determinism where structure is enough; real model where _tool choice from NL_ is the thing under test |
| 4   | Server topology         | Dual-mode `HarnessServer`: in-process for test-mode, child-process for credentialed real runtime                                                                                        | In-process reuses `collectDurableEvents` + direct FS oracles; child-process is the honest credentialed path  |
| 5   | Drive contract          | POST `/messages` (202) → collect `GET /events` until terminal `done` or budget/timeout                                                                                                  | The real ADR-0264 delivery contract; already proven by `collectDurableEvents` + `runtimeConformance`         |
| 6   | Scoring                 | Oracle pass/fail default; versioned LLM-judge rubric only where the outcome is inherently judgment (safety-refusal), always paired with a negative-side-effect oracle                   | Deterministic where possible; honest where not                                                               |
| 7   | Budget                  | Enforced in the runner from `session_status.usage` cost; per-run cap + per-eval soft ceiling                                                                                            | D5 budget caps; uses the runtime's own reported cost, no external meter                                      |
| 8   | Transcripts             | Every eval writes a JSONL transcript (prompt, every collected frame, oracle result) as a CI artifact                                                                                    | D5 "transcripts as JSONL artifacts"; the debugging + audit trail                                             |
| 9   | Connector evals vs. W5  | Ship both connector evals now, against a mock connector surface, asserting the routing decision; mark `quarantined`/pending until W5's `ConnectorProvider` lands                        | The routing contract is stable; the harness becomes the gateway's executable spec without blocking on it     |
| 10  | CI cadence              | Per-PR label-gated smoke (`evals` label, mirrors `re-review`) + `paths:` auto-trigger → nightly full on `main` → memoized release gate → weekly deep (real providers)                   | Exactly D5; reuses existing label-gate + `paths:` + Turbo-affected precedents                                |
| 11  | Memoized release gate   | Pin a green result to `{baseSHA, eval-relevant-path-set-hash}` via Turbo-affected mapping; docs-only diffs reuse green instantly; touched diffs re-run only affected evals              | D5 "memoized, not skipped"; same discipline as `pnpm verify`                                                 |
| 12  | Skip hatch              | `system:release --skip-evals`: reason required + recorded, smoke still runs, disallowed when the diff touches a marketing-gated pillar path, leaves "gate debt" the next nightly clears | D5 hatch-with-guardrails, verbatim                                                                           |
| 13  | Flake policy            | Single red → retry once; still red → `quarantine` list (runs, reported, non-gating) → never silently skipped                                                                            | D5 flake policy                                                                                              |
| 14  | v1 non-goals            | No browser e2e (apps/e2e owns it); no shape-specific evals until W2                                                                                                                     | Avoid duplicating the Playwright suite; shapes don't exist yet                                               |
