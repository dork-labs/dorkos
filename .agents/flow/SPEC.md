# flow — the contract

> The contract for the `/flow` engine. This is the **promotion surface**: the v1
> contracts documented here are what the P5 server-side Flow Engine — Extension
> (Linear DOR-88…) promotes the proven harness into. P5 is additive, not a
> rewrite.

This SPEC is scaffolded in P0 (Phase 0 — Scaffold); full content lands in later
phases. See [`README.md`](./README.md) for the manual.

## Stage model

_The canonical nine-stage spine: `capture · triage · ideate · specify ·
decompose · execute · verify · review · done`. Each stage projects to a tracker
`stage/*` label and (where applicable) a state category. `review` is a human
gate with no command. Defined by [`config.json`](./config.json) `stages`. Full
content lands in a later phase._

## `PMClient` interface (promotion surface, P5)

_In v1 the `PMClient` is realized as the `adapters/linear/` skill — a documented
**prose** contract; no typed code interface exists yet. The typed
`interface PMClient` documented here is what the P5 server build promotes that
prose contract into._

_Capability verbs (each mapped to the right tracker call by the adapter):
`getCurrentUser`, `getProjects`, `getEligibleWork`, `getInbox`, `getRelations`,
`claim`, `transition`, `comment`, `assignToHuman`, `attachEvidence`,
`needsInput`, `link`, `createSubIssue`. Plus the `WorkItem` normalization shape.
Full typed interface lands in a later phase._

## `FlowRun` record (promotion surface, P3)

_The durable run record keyed by issue (the session↔issue association), written
to `flow-state.json` (v1, disk) → server SQLite (v2). Defined in P3. Documented
here as part of the promotion surface._

## Config schema reference

The configuration contract is defined by the Zod schema (authored in task 0.3)
and generated to `config.schema.json`, referenced from
[`config.json`](./config.json) via `$schema`. The resolved defaults are
documented in the spec §9.
