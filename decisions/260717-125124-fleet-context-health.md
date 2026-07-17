---
id: 260717-125124
title: Fleet-level context health — best-effort list reading + live override, honest per-runtime degradation
status: proposed
created: 2026-07-17
spec: fleet-context-health
superseded-by: null
---

# 260717-125124. Fleet-level context health — best-effort list reading + live override, honest per-runtime degradation

## Status

Proposed (spec: fleet-context-health, DOR-113)

## Context

Operators run many agents at once but could only see how full a session's
context window was for the **one open session** (the chat status-bar
`ContextItem`). Nothing showed, across the fleet, which sessions were near their
context ceiling or had just auto-compacted. The obvious framing — "the data
already exists per turn; this is aggregation + display" — is only half true: per-turn
context usage exists on the live `session_status` fan-out and in the single-session
`getSession` read, but **no runtime populated a context reading on the
`GET /api/sessions` list wire**. The `Session.contextTokens` DTO field existed yet
was filled only by the single-session path, never by any runtime's `listSessions`.

The honest per-runtime reality is the design constraint, not an edge case:
claude-code can derive a best-effort reading cheaply from its JSONL tail, but
codex carries no context tokens on its list rows (and has no compaction concept),
and opencode reports usage only while a session is live. Any design that showed a
number for every row would have to fabricate one for codex/opencode closed
sessions — the opposite of honest. Separately, the client already had **four**
copies of the percent-derivation formula plus a hand-synced threshold constant; a
naive fleet gauge would have been a fifth copy waiting to drift.

## Decision

Ship fleet context health as a **two-layer data path** with a client-side merge,
extending ADR-0310's per-runtime session-list degradation to a new _displayed_
dimension — with **no** new `RuntimeCapabilities` flag.

1. **Durable/closed layer (server).** claude-code folds its existing 16 KB tail
   read into the mtime-cached list path (`extractSessionMeta`), so a closed-tab
   session carries `contextTokens` and a new optional `lastAutoCompactAt`
   (the most recent `compact_boundary` with `trigger:'auto'` visible in the
   readable tail). The added cost is one 16 KB read per _changed_ claude-code
   session per list call — `O(changed files)`, bounded by the `mtimeMs` cache.
   codex/opencode `listSessions` are untouched; their closed rows omit the fields.
   Both new fields are optional and additive (non-viral): no consumer breaks, no
   `conf` migration, no SQLite change.

2. **Live-freshness layer (client).** Open sessions ride the shipped
   `session_status` fan-out (ADR-0263/0264). The client retains the last live
   reading per session in a store map that survives settle, and a per-session
   resolver merges the two sources with **live-wins** precedence: a live reading
   beats the list reading; the list reading (`contextTokens ÷ model catalog
window`) is used otherwise; neither present (or no catalog window for the
   model) resolves to an honest **"unknown"** — never a fabricated 0%.

3. **One shared percent source.** The four historical percent copies and the
   duplicated threshold are consolidated into one `entities/session` module
   (formula + amber-≥80 / red-≥95 thresholds + severity), which both new
   surfaces — a quiet per-row gauge and a fleet summary bar fed by a
   runtime-neutral rollup selector — import. Percent stays a client catalog join
   (`ModelOption.contextWindow`); the DTO carries no `maxTokens` and the server
   computes no percent.

Honesty is carried by **field-absence + the ADR-0310 `warnings[]`**, not a
capability flag: a missing reading renders as a deliberate muted "unknown"
glyph, and a whole-runtime listing failure already surfaces as a `warnings[]`
entry the fleet bar need not re-report.

## Consequences

### Positive

- Operators see, at a glance across the fleet, which agents are near their
  context ceiling and which just auto-compacted — a mission-control differentiator
  no other coding-agent cockpit offers.
- Cheap and bounded: the reading rides machinery that already exists
  (`readTailStatus`, `sumContextTokens`, the `session_status` fan-out, the model
  catalog), gated by the mtime cache; no new store, route, or auth surface.
- Exactly one client percent-derivation + threshold source remains, so the gauge,
  the compaction chip (DOR-112), and the fleet surfaces can never drift.
- Degrades honestly per runtime without a new capability constant to keep in sync
  across four caps definitions.

### Negative

- The "auto-compacted recently" marker is tail-derived, so it disappears once the
  boundary scrolls past the ~16 KB tail as a session grows — a disclosed
  limitation, not durable recency.
- Codex/opencode closed rows read "unknown" until opened; the fleet view is fullest
  for claude-code. This is truthful, but it is an asymmetry to communicate.
- Per-list tail reads add `O(changed claude-code sessions)` I/O; a very active
  fleet should be measured before reaching for the deferred batched endpoint.

### Deferred (explicitly out of scope)

- Durable `lastCompactedAt` persistence surviving restart with exact recency.
- The agents-dashboard context tile (the rollup selector is built v1-ready for it).
- A codex registry patch to capture its live token count for closed rows.
- opencode per-session message reads to synthesize a closed-session reading.
- A batched `GET /api/sessions/context-health?ids=…` endpoint.

## Related

- **Extends ADR-0310** (runtime-owned storage + per-runtime session-list
  degradation) — this feature rides that aggregation and extends its honest
  degradation model (`warnings[]` + field-absence) to a new displayed dimension.
- **Rides ADR-0263 / ADR-0264** (durable session projection + single delivery) —
  the `session_status` fan-out that supplies the live-freshness override.
- **DOR-112** (`CompactionChip`) — the one-click compaction fix the fleet view
  links into; the threshold agreement the review forced is hardened here by the
  shared constant.
- **DOR-100** (`UsageStatus`) — the cost/spend sibling dimension; coordinated,
  not merged.
