---
number: 310
title: 'Runtime-Owned Session Storage with Registry-Aggregated Listing'
status: accepted
created: 2026-07-02
spec: additional-agent-runtimes
superseded-by: null
---

# 310. Runtime-Owned Session Storage with Registry-Aggregated Listing

## Status

Accepted (implemented in spec: additional-agent-runtimes). One clause is **proposed for partial supersession** by
[260728-214214](260728-214214-message-search-is-a-derived-rebuildable-index.md), which is `status: proposed` and **not yet
implemented**. Until it is accepted and the index ships, everything below governs unchanged; this note exists so a
reader meeting the bullet does not have to rediscover the argument.

**The scope of the supersession is one sentence**, in Consequences → Negative:

> Cross-runtime features (global search, unified export) must fan out per runtime rather than query one store.

That clause **would be narrowed, not reinterpreted**, to what it was protecting: cross-runtime **authority** stays
runtime-owned; cross-runtime **query** may be served from a derived, rebuildable index. Message search would read
every runtime's store per runtime, through that runtime's own projection — the fan-out this ADR requires —
and cache the result in an index that queries answer from once. What would no longer hold is that a
cross-runtime feature must re-derive the fan-out on every request. The bullet above was written on
2026-07-02, when "cross-runtime feature" meant **listing**; `:62` concedes that aggregation inherits every
backend's latency, `260717-001410:22` pins that at 2s per runtime, and `260717-001410:34` had already
recorded that fan-out alone would not scale ("fleets of hundreds will need a server-side cache"). That cache
is what 260728-214214 proposes to build.

**Everything else here stands unchanged and remains the governing decision:** session storage is
runtime-owned; there is no unified DorkOS transcript store and none is being created, because a derived
index is not a store of record and no runtime writes to it or reads from it; `GET /api/sessions` aggregates
across runtimes with per-runtime degradation and `warnings[]`; sessions stay visible to native tooling. The
two other Negative consequences are untouched and are inherited by the index, which degrades per source with
warnings exactly as listing does.

**This ADR deliberately keeps `status: accepted` and `superseded-by: null`.** A status is an instruction
about whether to rely on the document, not a description of its history, and a reader must still rely on
almost all of this one — it is the decision that stops DorkOS becoming the second writer of another
product's transcripts, which is the premise the new ADR is built on rather than against. (`writing-adrs`,
"Partial supersession".)

## Context

Claude Code sessions derive entirely from SDK JSONL files; test-mode sessions live in the in-process EventLog. With OpenCode (its own SQLite store, read via SDK) and Codex (thread files under `~/.codex/sessions`) arriving, the question is whether DorkOS should unify transcripts into one owned store or keep storage runtime-owned. Meanwhile `GET /api/sessions` lists from `runtimeRegistry.getDefault()` only (`routes/sessions.ts:64`), and `subscribeSessionList` watches only Claude's project directory — single-runtime assumptions that break the moment a second production runtime registers.

## Decision

Session storage stays **runtime-owned**: each adapter implements `listSessions`/`getMessageHistory`/`getSessionSnapshot` against its backend's native storage, exactly as the claude-code (JSONL) and test-mode (EventLog) implementations already do. There is no unified DorkOS transcript store. Cross-runtime uniformity comes from the existing shared layers: `session_metadata` (runtime binding, ADR-0255), the EventLog + `SessionStateProjector` for live turn state, and the per-session SSE delivery path. The session **listing and list-subscription layers move from default-runtime calls to registry aggregation**: merge `listSessions` across all registered runtimes (tagging each session with its runtime type) and fan-in each runtime's `subscribeSessionList` events into the global stream.

## Consequences

### Positive

- Zero migration risk and no dual-write consistency problem; each backend remains the source of truth for its own transcripts.
- Follows the proven pattern (two existing runtimes already work this way); the conformance suite can assert the contract per runtime.
- Sessions remain visible to native tooling (`claude`, `opencode`, `codex` CLIs) — DorkOS augments rather than captures.

### Negative

- List aggregation inherits each backend's listing performance and failure modes; a slow/failed runtime must degrade gracefully (partial list + warning, never a blank screen).
- Cross-runtime features (global search, unified export) must fan out per runtime rather than query one store.
- Session list ordering/pagination semantics must be defined at the aggregation layer.
