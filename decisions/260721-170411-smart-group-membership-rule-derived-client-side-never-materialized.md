---
id: 260721-170411
title: Smart-group membership is rule-derived client-side from config-stored rules, never materialized
status: accepted
created: 2026-07-21
spec: smart-agent-groups
extractedFrom: smart-agent-groups
specSlug: smart-agent-groups
superseded-by: null
---

# 260721-170411. Smart-group membership is rule-derived client-side from config-stored rules, never materialized

## Status

Accepted

## Context

DOR-329 gave the sidebar user-defined, manually-curated groups (`kind: 'manual'`, an ordered `agentPaths` list) and deliberately left schema room for a second kind whose membership follows the fleet instead of decaying as it changes. The sidebar already fetches everything a membership rule would need per agent — runtime, mesh namespace, attention state (DOR-339's `AttentionState`), and recent-session activity — so the question was where that evaluation should live and what, if anything, gets persisted.

Two shapes were on the table: (1) evaluate rules client-side on every render from data already in memory, storing only the rule set; or (2) evaluate server-side (or client-side) and persist the resulting member list, refreshing it on some cadence or via a write path back into config. The second shape needs a server surface (an endpoint, a job, or a write-triggering effect) and introduces a staleness window — the exact "membership decays" problem DOR-329 named as the reason to build this in the first place.

## Decision

Smart-group membership is a pure function of `(rules, candidates, now)` — `evaluateSmartGroup` in `features/dashboard-sidebar/model/evaluate-smart-group.ts` — run entirely client-side on every render, memoized on rules and candidate-array identity. `ui.sidebar.groups[].rules` (the new `SmartGroupRulesSchema`) is the only thing persisted; no member list, no cache, no server endpoint. Mesh (via already-fetched agent manifests), the attention module, and recent-session activity stay the single source of truth for what an agent _is_; the sidebar is presentation-only over that state, exactly as it already was for the ungrouped list and manual groups. Multi-presence follows structurally from this: because a smart group's own `agentPaths` is untouched (kept only as the "Convert to manual group" materialization target), an agent matching a rule was never _moved_ anywhere — it simply also renders in the smart section.

## Consequences

### Positive

- Zero staleness: a group's membership is exactly correct as of the current render, with no refresh cadence, cache-invalidation path, or write-after-read race to reason about.
- Zero new server surface: no endpoint, no background job, no additional load on `~/.dork/config.json`. The evaluation cost is O(groups × agents) pure array work — trivial at the fleet sizes DorkOS targets.
- Config stays small and portable: a rule object is a few bytes; a synced/exported `ui.sidebar` never carries a stale member snapshot from a different machine's fleet.
- Multi-presence and the empty ("0 matching") state fall out of the model for free rather than requiring special-cased UI logic — there is no member list to reconcile against the manual-group case.

### Negative

- Every consumer of "this group's members" (rendering, the collapsed-group activity dot, drag rejection, convert-to-manual) must call `evaluateSmartGroup` itself rather than reading a stored field — a small but real discipline cost enforced by the type system having no `agentPaths` equivalent for `kind: 'smart'`.
- No server-side or cross-client notion of smart-group membership exists — an MCP tool or a future headless surface that wants "who's in this smart group" must ship its own copy of the evaluator (or wait for a shared package), not query an endpoint.
- Evaluation is necessarily O(agents) per group per render; acceptable today, but a fleet large enough to make this measurable (not observed at current scale) would need a materialized-cache follow-up, which this decision explicitly defers rather than pre-builds.
