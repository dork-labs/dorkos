---
id: 260908-085032
title: One status model answers for the app and the terminal
status: proposed
created: 2026-09-08
spec: harness-sync-status
superseded-by: null
amends: null
---

# 260908-085032. One status model answers for the app and the terminal

## Status

Proposed (extracted from spec: `harness-sync-status`, DOR-1852).

## Context

Harness Sync can already answer every question a person has about what DorkOS shares with which agent tool —
in four separate calls. `project()` gives the plan, `checkPlan()` gives what has drifted and what is blocked,
`planWithConsent()` gives what consent withheld, and `inventorySourceTree()` gives every artifact a person
authored. The capabilities contract's VC-01 row states the gap precisely: _"nothing assembles the eight into
one answer."_ The only renderer is `packages/cli/src/harness-sync-command.ts`, which does the assembling
inline while it prints.

DorkOS is now adding a second renderer — a Skills page on the agent profile, a drift banner, and a "Not shared
with `<harness>`" panel. A third and a fourth are already scheduled: the `.agents/skills` watcher's report
(DOR-1850) and `dorkos harness adopt`'s (DOR-1853, whose position §16 D3 makes conditional on this surface
existing). If each renderer assembles the four inputs itself, they will disagree — and when a page and a
terminal describe one file differently, nothing tells a person which of them is current.

The obvious home for the assembly is `packages/harness`, beside `checkPlan`. It is the wrong one, and the
reason is not visible from the code: two of the eight states — a package's hooks held back pending approval,
and a conflict as the apply reports it — require the consent record, and `services/harness/hook-approval.ts`
already argued why the engine may not hold one: _"That package is a pure projection engine with no approval
primitive and no config store, and dragging both into it for one call site would be an architectural
regression."_

## Decision

We will assemble the eight-state status in **one module in the server's harness service** —
`apps/server/src/services/harness/status.ts`, beside the consent seam — and every renderer will read it rather
than the four inputs. It is a plain function over an options bag, taking the same `decisions` override
`planWithConsent` already accepts, so the CLI can call it from a separate process by passing the copy it reads
straight off `config.json` (DOR-678).

The model is a **projection of the plan and nothing more**. Where a chip says a harness cannot see a file, the
sentence is the plan's own `reason` string, unchanged, and the page never re-derives a harness's behaviour.
Two consequences follow deliberately: a wrong chip is a bug in the projector and is fixed there, and
`harnessCoverage()` — the vendor-facts walk — stays out of the read path, because it is the oracle a
projection is measured against and running a second model of six vendors' behaviour on screen is how the two
come to disagree.

Precedence between states is written down once, as an ordered table, because the pairs that overlap mean
opposite things to a person: `conflict` outranks `drifted` ("re-running will never fix this" beats "re-run and
it fixes itself"), and `pending-approval` outranks everything below it. Seven of the eight are per-harness
answers; `unmanaged (adoptable)` is a fact about where a file lives, so it belongs to the row rather than to
any harness column.

Two supporting moves make the single model reachable. The harness vocabulary — `HARNESS_IDS`,
`HarnessIdSchema`, `HarnessId`, `HARNESS_LABELS` — moves down into `@dorkos/shared`, with
`packages/harness/src/manifest/schema.ts` re-exporting it, because the browser cannot import a Node filesystem
engine and `@dorkos/shared` cannot depend on `@dorkos/harness` without closing a cycle through
`@dorkos/skills`. And the response schema restates the engine's `ArtifactType` and `Provenance` rather than
moving them, with a `satisfies Record<ArtifactType, …>` mapping table so the compiler names the gap when a
kind is added.

## Consequences

### Positive

- One derivation table, walked by one test, decides what every surface says. A page and a terminal describing
  one file differently becomes a compile-or-test failure rather than a support question.
- The CLI's renderers can be ported onto the model without redesigning it, and the two later renderers
  (DOR-1850's watcher report, DOR-1853's adopt report) inherit it instead of inventing a third and fourth.
- The engine stays a pure projection engine. No approval primitive, no config store, no reason for
  `packages/harness` to grow either.
- Consent-aware derivation sits next to the consent seam, where the guard test that keeps `project()` behind
  one door can see it.
- Because the model is a projection, an incorrect answer has exactly one place it can be wrong, and fixing it
  there fixes every surface at once.

### Negative

- The status model is in the server, so a future surface outside the server — a desktop-only view, another
  process — reaches it over HTTP or not at all. Acceptable while every renderer is either the app or a CLI
  that can pass its own `decisions`.
- The CLI does not read it on day one. Until it is ported, the "one model, two renderers" claim is a direction
  with a test behind it rather than a structural fact, and the two can drift in the meantime.
- Two vocabularies for artifact kinds now exist — the engine's and the response schema's — held together by a
  mapping table rather than by being one type. The table is compile-checked, but it is a second place to edit
  when a kind is added.
- Moving `HARNESS_IDS` into `@dorkos/shared` puts harness vocabulary in a package that knows nothing about
  harnesses, and makes `packages/harness/src/manifest/schema.ts` partly a re-export shim.
- Refusing `harnessCoverage()` in the read path means the page cannot say "this harness would actually load
  this file", only "the plan says this is where it goes". That is the weaker claim, and it is the honest one
  until the real-harness smoke tier calibrates the table.
