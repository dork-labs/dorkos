---
slug: evals-runtime-legs
number: 260920-230219
created: 2026-09-20
status: specified
linear-issue: DOR-2207
---

# The eval harness runs a rooms case on the runtime you asked for

**Status:** Approved
**Author:** the DOR-2207 orchestrator
**Date:** 2026-09-20

## Overview

`pnpm evals -- --suite rooms --runtime opencode` today runs every room turn on
claude-code. This spec makes a room turn follow the run's `--runtime`, and adds
the money gate a Codex leg needs, so the Codex and OpenCode judgment legs that
DOR-2099 (spec `tool-only-room-replies` A6) and DOR-1643 left owed can actually
be run. Ideation is folded into this document: the problem was found by running
the leg, and the cause is pinned to one line.

## Background / Problem Statement

On 2026-09-20 the operator authorised the OpenCode leg and we ran the rooms suite
with `--runtime opencode` through OpenRouter. The server booted, the key resolved,
and every case failed the same way. The sandbox log showed each room turn running
on claude-code — `[Runtimes] A turn failed on its sign-in ... runtime: "claude-code"` —
which has no sign-in inside the sandbox (the `CLAUDE_CONFIG_DIR` pin, DOR-1712),
so each turn died before reaching a model.

**The cause is one line.** `packages/evals/src/suite/rooms-setup.ts`
`seedRoomAgents` writes `runtime: 'claude-code'` into every seeded agent manifest.
Its comment says this is "a runtime this harness does not register, so the session
the room binds runs on the server DEFAULT". That was true on the `test-mode` tier
(claude-code is not registered there, so the default wins) and it is false on every
credentialed tier: claude-code is registered, so
`resolveTurnRuntimeType` → `resolveAgentRuntimeType` returns the manifest's
`claude-code` and `--runtime` never reaches a room turn. `--runtime` only binds the
one session the harness drives itself (`drive.ts`), which rooms cases never use.

So the rooms suite has only ever been measured on claude-code, and every number in
`rooms-judgment.ts` is a claude-code number.

**A Codex leg has two further gaps.**

1. The child-process launcher pins `CODEX_HOME` to an empty sandbox dir (correct:
   an eval must never write into the operator's real Codex store), so the
   operator's ChatGPT login is invisible. A Codex leg needs a key forwarded into
   the sandbox env. The installed `@openai/codex-sdk` (0.154.0) reads
   `CODEX_API_KEY`; the runtime's own dependency check names the same variable.
2. `spendsOnExternalProvider` knows `real-provider`, `opencode` and `--provider`.
   `--runtime codex` bills OpenAI with no flag asked. That is a hole in the money
   rule (AGENTS.md "Five paths in the repo spend real money"): the flag is the
   decision, the key is the instrument, and a key alone must arm nothing.

## Goals

- A rooms case run with `--runtime <r>` seats its agents on runtime `<r>`, so the
  room turn is served by that runtime. Nothing else about the case changes.
- `--runtime codex` is gated by its own flag beside its own key, refuses to boot
  without the flag, errors (never passes) with the flag and no key, refuses
  docker isolation, and forwards the key into the sandbox server env.
- The money table in `AGENTS.md` and the turbo firewall test cover the new pair.
- The stale comment in `seedRoomAgents` is replaced by a true one.

## Non-Goals

- Running the paid legs. That is the operator's spend decision, made after this
  merges (the DONE comment on DOR-2207 records how).
- A Codex provider knob (routing Codex through OpenRouter). Codex bills OpenAI.
- Touching `suite/agents.ts` `seedNewbornAgent`: the design-your-own interview is
  a claude-code-only case by construction (it rewrites a Claude soul). Leave it.
- Changing any eval case, oracle, or drill.

## Technical Dependencies

- `@openai/codex-sdk` 0.154.0 — reads `CODEX_API_KEY` from the environment the
  server hands the Codex subprocess. The implementer confirms the read site in the
  installed SDK before relying on it and cites the file in the task record.
- No new packages.

## Detailed Design

### D1. The seeded manifest's runtime follows the run

- `EvalSandbox` (`packages/evals/src/types.ts`) gains `runtime?: EvalRuntime`:
  the run's `--runtime`, when one was given. `run-eval.ts` sets it when it builds
  the sandbox handed to `evalCase.seed`.
- `seedRoomAgents` writes `runtime: sandbox.runtime ?? 'claude-code'`.
  - `--runtime opencode` → `'opencode'`; `--runtime codex` → `'codex'`;
    `--runtime claude-code` or none → `'claude-code'`.
  - On the `test-mode` tier none of the three is registered, so the server
    default (`test-mode`) still wins, exactly as today. The new comment says this
    is the reason the fallback stays `'claude-code'` rather than `undefined`.
- **Why the manifest and not the session hint.** A room turn's session is minted
  by the room runner, not by the harness; there is no request the harness could
  put a `runtime` hint on. The manifest is the one input `resolveAgentRuntimeType`
  reads, and it is written before the server boots (file-first, ADR-0043), so it
  works on every tier without knowing which one it is on.
- A unit test on `seedRoomAgents`: for each of the three runtimes and for
  `undefined`, the written `agent.json` carries the expected `runtime`. This is
  the test that would have been red on 2026-09-20.
- A run-level assertion, so the property cannot regress silently: on a
  credentialed rooms case the harness reads the room turn's session runtime from
  the server (`GET /api/sessions` tags each session with `runtime`) and the case
  record notes it. If a lighter seam already exists (the sandbox server log line
  `[rooms] an agent finished a room turn` carries the session id), use that; the
  implementer picks the one that is checkable without a paid run and says which.

### D2. A Codex money gate, same shape as the OpenRouter one

- New constants in `credentials.ts`: `PAID_CODEX_OPT_IN_VAR = 'DORKOS_EVALS_PAID_CODEX'`
  and `CODEX_API_KEY_VAR = 'CODEX_API_KEY'`, read at MODULE scope like the
  existing pair (so no other file's `vi.stubEnv` can blank them).
- `spendsOnExternalProvider(tier, runtime, provider)` is replaced by a function
  that answers **which** paid path a run reaches, not just whether:
  `paidPathFor(tier, runtime, provider): 'openrouter' | 'codex' | null`.
  - `'openrouter'` when `tier === 'real-provider'`, `runtime === 'opencode'`, or
    `provider !== undefined` (unchanged behaviour).
  - `'codex'` when `runtime === 'codex'`.
  - `null` otherwise.
  - Keep a `spendsOnExternalProvider` wrapper only if a caller outside the
    runner still needs the boolean; otherwise delete it and update every caller.
- `resolvePaidProviderCredential` generalises to take the path: the `'codex'`
  path checks `PAID_CODEX_OPT_IN_VAR` then `CODEX_API_KEY_VAR`, and returns
  `{ source: 'codex-api-key', env: { CODEX_API_KEY: key }, portable: true }`. The
  three messages (`optIn`, `noKey`, `refusesDocker`) name the pair for the path
  the run is on — a person who typed `--runtime codex` must read `CODEX_API_KEY`,
  never `OPENROUTER_API_KEY`.
- Docker refusal applies to the codex path for the same reason as OpenRouter:
  the eval container has no network.
- The key rides `credential.env` into the launched server's environment, which
  the Codex SDK subprocess inherits. The implementer proves the forwarding with a
  launcher test in the shape of the existing OpenRouter one, and cites the SDK
  line that reads `CODEX_API_KEY`.
- `bin/evals.ts` header comment and the `real-provider` paragraph in
  `packages/evals/README.md` gain the codex pair. The README gets a short
  "Running the Codex leg" recipe beside the OpenRouter one.

### D3. The firewall and the money table

- `paid-provider.test.ts`: the turbo walk adds `DORKOS_EVALS_PAID_CODEX` and
  `CODEX_API_KEY` to the names no task may expose; the four-square tests
  (flag×key) are repeated for the codex path; the messages test asserts the codex
  messages name the codex pair and not the OpenRouter one.
- `AGENTS.md` money table: a new row for `--runtime codex` on any eval tier,
  flag `DORKOS_EVALS_PAID_CODEX=1`, key `CODEX_API_KEY`. The sentence "Five paths"
  becomes "Six paths" and "these nine names" becomes eleven. The banned-words and
  vocab guards scan AGENTS.md, so the edit stays in the table's existing register.

### Code structure

- `packages/evals/src/types.ts` — `EvalSandbox.runtime`.
- `packages/evals/src/runner/run-eval.ts` — sets it.
- `packages/evals/src/suite/rooms-setup.ts` — reads it; comment rewritten.
- `packages/evals/src/suite/__tests__/rooms-setup.test.ts` — new (or extend an
  existing rooms-setup test if one exists).
- `packages/evals/src/runner/credentials.ts`, `run-eval.ts`, `bin/evals.ts`,
  `runner/__tests__/paid-provider.test.ts`,
  `runner/isolation/__tests__/child-process-launcher.test.ts`.
- `packages/evals/README.md`, `AGENTS.md`.
- `changelog/unreleased/<id>-<slug>.md` — one fragment with a `covers:` block
  naming this PR's title.

## User Experience

An operator who runs the OpenCode leg types what the README already says and the
room turns are served by OpenCode. An operator who runs the Codex leg types:

```bash
DORKOS_EVALS_PAID_CODEX=1 CODEX_API_KEY=… pnpm evals -- --suite rooms --tier claude-code-cheap --runtime codex --budget 0.50
```

Without the flag the run stops before booting anything and says which flag and
which key it wants. With the flag and no key every case is a runner error. With
`--isolation docker` it refuses and names `child-process`.

## Testing Strategy

- **Unit:** `seedRoomAgents` × 4 runtimes; `paidPathFor` truth table (tier ×
  runtime × provider); codex four-square; codex messages name the codex pair;
  docker refusal on the codex path; launcher forwards `CODEX_API_KEY`.
- **Firewall:** the turbo walk covers the two new names.
- **The test that fails for the right reason:** the `seedRoomAgents` test is
  written first and shown red against the current seeder before the fix.
- **Not in CI, on purpose:** the paid legs. The DONE comment on DOR-2207 gives the
  two commands; the operator runs them.

## Performance Considerations

None. One field on a sandbox object; one string in a manifest.

## Security Considerations

The codex key is a runner secret read once at module scope, passed to the sandbox
server env only, never written to disk or a report. Same handling as
`OPENROUTER_API_KEY`. No task in `turbo.json` may expose either new name; the
firewall test pins that.

## Documentation

`packages/evals/README.md` (codex recipe, and the runtime paragraph says a rooms
case's agents follow `--runtime`), `AGENTS.md` money table, `bin/evals.ts` header.

## Decisions register

| #   | Decision                                                          | Ruled by     |
| --- | ----------------------------------------------------------------- | ------------ |
| D1  | Runtime rides the seeded manifest, fallback stays `'claude-code'` | Orchestrator |
| D2  | Codex gate is its own flag beside `CODEX_API_KEY`, same shape     | Money rule   |
| D2  | `paidPathFor` returns the path, replacing the boolean             | Orchestrator |
| —   | No Codex provider knob; `seedNewbornAgent` untouched              | Orchestrator |
