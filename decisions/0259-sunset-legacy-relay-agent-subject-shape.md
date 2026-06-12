---
number: 259
title: Sunset the Legacy `relay.agent.<sessionId>` Subject Shape
status: accepted
created: 2026-04-16
spec: null
superseded-by: null
---

# 0259. Sunset the Legacy `relay.agent.<sessionId>` Subject Shape

## Status

Accepted — 2026-04-16

## Context

Spec #244 introduced runtime-scoped relay subjects of the shape
`relay.agent.<runtimeType>.<sessionId>` (ADR 0256) but retained the legacy
three-part shape `relay.agent.<sessionId>` for backward compatibility. The
legacy shape is still emitted on two code paths:

1. `BindingRouter` when no `runtimeResolver` is wired or when resolution
   throws. The default composition root now passes a resolver, so this path
   is effectively dead outside of tests and early-boot fallback.
2. Direct agent-to-agent relay sends addressed by mesh `agentId` — historical
   behavior from before sessions were runtime-owned.

The adapter-registry currently carries a **longest-matching-prefix-wins**
rule (see `packages/relay/src/adapter-registry.ts::getBySubject`) that makes
the two shapes coexist correctly today: `relay.agent.claude-code.` wins over
`relay.agent.` whenever a session-scoped subject arrives, so the legacy
catch-all on `ClaudeCodeAdapter.subjectPrefix` is safe but load-bearing.

Concretely, the baggage of keeping the legacy shape is:

- `parseAgentSubject` carries a UUID-shape heuristic for disambiguation
  (ADR 0256). Removing the heuristic simplifies the parser materially.
- `ClaudeCodeAdapter.subjectPrefix` declares the broader legacy prefix
  `'relay.agent.'`, which acts as a default route for any runtime that
  hasn't been explicitly wired — hiding composition-root bugs.
- Mesh's topology enrichment in `apps/server/src/routes/mesh.ts` shares the
  second-segment namespace with runtime-scoped subjects, creating a
  collision edge case that we patched defensively (see commit 2026-04-16).
- Future runtime adapters ship with a copy-paste temptation to register the
  legacy prefix "just in case", diluting routing clarity.

We want an observable sunset timeline — a commitment to removing the legacy
branch so the parser, adapter prefixes, and mesh enrichment can be
simplified.

## Decision

We commit to the following sunset plan for the legacy
`relay.agent.<sessionId>` subject shape and the legacy catch-all prefix on
`ClaudeCodeAdapter`:

**Phase 1 — Signal (ships with this ADR, release 2026.Q2):**

- `parseAgentSubject` emits a **one-shot `console.warn`** per process the
  first time it returns a `legacy`-shape parse. Silenced in `VITEST` /
  `NODE_ENV=test` to keep CI stderr clean; tests assert the behavior via
  a spy. See `packages/relay/src/lib/subject-parser.ts`.
- No behavior change: legacy subjects still parse and route correctly.

**Phase 2 — Deprecate (release 2026.Q3, ~2 minor releases after Phase 1):**

- The warning is promoted to **every** legacy-shape parse (not one-shot)
  and includes a stack frame of the calling site (via
  `new Error().stack`) to surface the caller in logs.
- `BindingRouter`'s "no resolver wired" branch is removed: callers without
  a runtime resolver must opt in explicitly via a new
  `legacyFallback: true` flag; the flag is deprecated on arrival.
- `CHANGELOG` carries a migration note for integrators who still build
  `relay.agent.<sessionId>` subjects by hand.

**Phase 3 — Remove (release 2026.Q4, minimum 6 months from Phase 1):**

- `parseAgentSubject` returns `null` for three-part subjects and drops the
  UUID-shape heuristic entirely. The `format: 'legacy'` variant is
  deleted from `ParsedAgentSubject`.
- `ClaudeCodeAdapter.subjectPrefix` no longer includes `'relay.agent.'` —
  the adapter only handles its runtime-scoped prefix and
  `relay.system.tasks.`.
- The `BindingRouter` fallback branch is removed; a missing runtime
  resolver is a construction-time error.
- ADR 0256's "disambiguation heuristic" section is marked historical.

**Removal trigger:** proceed to Phase 3 when all three hold:

1. Zero legacy-shape warnings observed in production logs for two
   consecutive weeks.
2. All first-party apps (server, CLI, Electron, Obsidian plugin, site)
   have shipped a release that post-dates Phase 2.
3. The CHANGELOG notice has been live for at least one full minor-release
   window.

If any of the three fail, the removal slips one minor release and the
trigger is re-evaluated.

## Consequences

### Positive

- Parser becomes materially simpler: no UUID heuristic, no dual-shape
  parse tree, no `format` discriminator.
- Adapter routing no longer depends on longest-matching-prefix-wins to
  hide a broad legacy catch-all — registrations become declarative and
  self-documenting.
- Mesh topology enrichment no longer has to guard against a shared
  subject vocabulary with runtime-scoped dispatch.
- Construction-time contract clarifies: a server without a runtime
  resolver is a configuration error, not a silent legacy fallback.

### Negative

- External integrators (third-party relay clients, local tooling) that
  built subjects by hand must be migrated. The signal/deprecate/remove
  cadence is explicitly designed to make this visible.
- Phase 2 may introduce log noise for sites that did not act on Phase
  1 — deliberate, to force the issue before Phase 3.
- The ADR adds a scheduled removal task to the project backlog; if we
  never ship Phase 3, the warning becomes permanent background noise.

### Neutral

- Runtime-scoped subjects (`relay.agent.<runtimeType>.<sessionId>`)
  remain the canonical shape — no change to hot-path behavior.
- The adapter-registry's longest-matching-prefix-wins rule stays in
  place; it's independently useful for multi-runtime routing even after
  the legacy catch-all is removed.

## Implementation notes

- Tracking: add a `legacy-subject-sunset` label to the repo and gate
  Phase 2 / Phase 3 merges on it so the plan stays visible.
- The `setLegacySubjectWarningSilenced` export on the parser is
  intentionally `@internal` — it exists to let specific test suites opt
  the warning back in, not to give production code a permanent escape
  hatch. Do not use it outside tests.
