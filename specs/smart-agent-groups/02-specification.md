---
slug: smart-agent-groups
id: 260721-134155
created: 2026-07-21
status: specified
linearIssue: DOR-338
---

# Smart Agent Groups from Mesh Metadata (Rule-Based Membership)

**Status:** Approved (flow drain, gates delegated)
**Author:** Claude (flow, DOR-338), commissioned by Dorian
**Date:** 2026-07-21

## Overview

Telegram's rule-based folder model applied to agents: a sidebar group whose membership is **derived from metadata** — runtime, namespace, attention state, last-active, path prefix — instead of hand-curated. Membership re-evaluates live as agent state changes; an idle agent silently leaves an "Active now" smart group. Additive `kind: 'manual' | 'smart'` discriminator + a flat `rules` object on `SidebarGroupSchema`; evaluation is a pure, memoized client-side function; config stores rules, never members.

Decisions and rationale: `01-ideation.md` §5. Research: `research/20260716_cross_app_sidebar_organization_patterns.md` §4, §9.

## Background / Problem Statement

Manual groups (DOR-329) demand curation that decays as fleets change: agents get added, go dormant, switch projects — the group stays stale. Agents carry rich metadata the sidebar already fetches, so rule-derived groups maintain themselves at zero upkeep. DOR-329's spec named this "the strongest v2 candidate" and deliberately left schema room.

## Goals

- `kind` discriminator + `rules` on `SidebarGroupSchema`, fully additive (existing groups default `'manual'`, zero migration risk).
- Rule vocabulary v1: `runtime[]`, `namespace[]`, `status[]` (attention states), `lastActiveWithinMs`, `pathPrefix` — AND across fields, OR within a field.
- Live client-side evaluation, memoized; multi-presence structural (an agent may match several smart groups and still live in its manual group).
- Honest UI: rule summary in the header, drag-onto rejected with a hint, "0 matching" empty state, one-click "Convert to manual group" escape hatch.
- Presets ("Active now", one per runtime) as one-click starters in the group-create flow.

## Non-Goals

- Exclude-rules (Telegram's second set) — mute (DOR-339) covers practical exclusion; revisit on evidence.
- Server-side evaluation, persistence of materialized membership, or any write path from smart groups to mesh state.
- Folders-as-tabs presentation; rule nesting or OR-trees; per-folder pinning.
- Obsidian embedded mode (unchanged from DOR-329).

## Technical Dependencies

Existing only: `agent-list-settings`' attention module (`AttentionState`, `useAgentAttentionMap`) — **hard dependency, build after DOR-339**; agent entities (runtime, namespace, projectPath, mesh metadata); Zod 4 + `conf` migration machinery. No new packages, no new endpoints.

## Detailed Design

### 1. Schema — `packages/shared/src/config-schema.ts` (additive)

```ts
export const SmartGroupRulesSchema = z.object({
  /** Match any of these runtimes (OR). Absent field = no constraint. */
  runtimes: z.array(z.string()).optional(),
  /** Match any of these mesh namespaces (OR). */
  namespaces: z.array(z.string()).optional(),
  /** Match any of these attention states (OR). */
  statuses: z.array(z.enum(['needs-attention', 'active', 'idle', 'inactive'])).optional(),
  /** Activity within this window (ms). */
  lastActiveWithinMs: z.number().int().positive().optional(),
  /** projectPath starts-with match. */
  pathPrefix: z.string().min(1).optional(),
});

export const SidebarGroupSchema = z.object({
  // ...existing fields unchanged...
  /** Manual groups own agentPaths; smart groups derive members from rules. */
  kind: z.enum(['manual', 'smart']).default('manual'),
  /** Present iff kind === 'smart'. At least one field must be set (refine). */
  rules: SmartGroupRulesSchema.optional(),
});
```

Cross-field refine on `SidebarGroupSchema`: `kind: 'smart'` requires `rules` with ≥1 constraint; `kind: 'manual'` ignores `rules`. For smart groups `agentPaths` is ignored (kept as-is — it becomes the materialization target for convert-to-manual). `sortMode: 'manual'` is invalid for smart groups; group-create forces `'recent'` default and the render path falls back `manual → recent` defensively. Semver-keyed `conf` migration per `adding-config-fields`.

### 2. Evaluation — `features/dashboard-sidebar/model/evaluate-smart-group.ts` (new, pure)

```ts
export interface SmartGroupCandidate {
  projectPath: string;
  runtime: string;
  namespace: string | null;
  attention: AttentionState;
  lastActivityAt: number | null;
}
export function evaluateSmartGroup(
  rules: SmartGroupRules,
  candidates: SmartGroupCandidate[],
  now: number
): string[]; // matching projectPaths
```

Semantics: a candidate matches when EVERY present rule field passes; within a field, ANY listed value passes. `lastActiveWithinMs` compares against `lastActivityAt` (null never matches). `pathPrefix` is a plain `startsWith`. Deterministic, no I/O, `now` injected (testability). The sidebar builds `candidates` once per render from data it already holds (agents list + attention map + activity) and memoizes evaluation per group on (rules identity, candidates identity). Attention-state churn already flows through the existing store subscription — no new invalidation machinery; memoization keys make re-evaluation cheap, and status flicker is inherited from the attention module's thresholds (no extra debounce in v1; watch-item below).

### 3. Rendering & interaction

- Smart groups render as normal sections; members resolve via `evaluateSmartGroup`; multi-presence: presence in a smart group never removes the agent from its manual group/ungrouped list (same rule as Pinned).
- Header: a small rule glyph + plain-language summary line in the header menu ("Codex · active in last hour"), generated by a `describeRules(rules)` helper (unit-tested; the summary is the UI's honesty contract).
- Drag-and-drop: smart groups are not valid drop targets; on attempted drop, reject with a brief inline hint ("Membership is rule-based — edit rules instead"). Member rows inside a smart group are not draggable-out (they may still be dragged from their manual home).
- Empty state: "0 matching" ghost row (information, not disappearance).
- Reordering/collapse/mute/displayFilter (DOR-339 fields) apply to smart groups exactly as to manual ones — the discriminator only changes member _sourcing_.

### 4. Create/edit flow + presets

Group-create dialog forks: "Manual" (existing flow) | "Smart". Smart fork shows the rule form — a checkbox set per runtime present in the fleet, namespace multi-select (only if >1 namespace exists), status multi-select, an activity-window select (1h / 24h / 7d), and a path-prefix input. Presets render above the form as one-click chips: **Active now** (`statuses: ['needs-attention','active']`), **By runtime** (one chip per runtime with ≥2 agents). Edit reopens the same form from the header menu ("Edit rules"). **Convert to manual group**: materializes the currently-matching paths into `agentPaths`, flips `kind`, keeps name/collapse/sort.

### 5. Progressive disclosure

The "Smart" fork and preset chips appear only when the fleet has ≥8 agents or ≥2 runtimes (constant, same spirit as DOR-329's `groupsHintDismissed` threshold chrome). Below that, manual create is unchanged — small cockpits see zero new chrome.

## User Experience

Kai runs 25 agents across 3 runtimes. One click on the "By runtime · Codex" preset yields a self-maintaining Codex section. His "Active now" smart group is his morning triage view — agents drop out as they go idle, no gardening. Dragging an agent onto it bounces with the hint; converting it to manual freezes today's members for hand-tuning.

## Testing Strategy

- `evaluate-smart-group.test.ts`: each predicate alone; AND-across-fields; OR-within-field; null activity; boundary of `lastActiveWithinMs`; empty rules rejected at schema level; determinism on identical input.
- `describeRules` summary snapshots (every field combination reads sanely).
- `config-schema.test.ts`: discriminator defaults, refine rejections (`smart` without rules, empty rules object), legacy configs parse.
- Component (RTL + mock Transport): smart section renders derived members; live re-evaluation on store change (attention flip moves an agent out); multi-presence duplicates render; drop rejection hint; convert-to-manual materialization writes exact current members; empty state; preset chips create correct rules; disclosure threshold hides the fork for small fleets.
- DOR-329 + DOR-339 sidebar suites stay green (all-default configs behave identically).

## Performance Considerations

Evaluation is O(groups × agents) pure array work, memoized — trivial at 100 agents. No new subscriptions (attention map is shared). Candidates array identity is stabilized so unrelated store updates skip re-evaluation.

## Security Considerations

None — read-only presentation over already-fetched data; rules live in user config like every other sidebar pref.

## Documentation

Docs site sidebar guide gains a "Smart groups" section (`writing-for-humans`); changelog fragment (user-facing).

## Implementation Phases

1. Schema + refine + migration + `evaluateSmartGroup` + `describeRules` (pure core, fully tested).
2. Render path + multi-presence + empty state + drop rejection.
3. Create/edit flow + presets + disclosure threshold + convert-to-manual.
4. Docs + fragment + `04-implementation.md`.

Single worktree; strictly after `agent-list-settings` (DOR-339) lands.

## Open Questions

None blocking. Watch-items: status-flicker UX at the `active/idle` boundary (inherits attention thresholds; add hysteresis there if real use flickers), and whether namespace data is populated broadly enough to show that rule field by default.

## Related ADRs

- New (extract at implementation): smart-group membership is rule-derived client-side from config-stored rules, never materialized/persisted — mesh stays source of truth, sidebar stays presentation-only.
- ADR 260717-001409 (sidebar state in user config) — extended unchanged.

## References

- `specs/agent-sidebar-organization/` (DOR-329); `specs/agent-list-settings/` (DOR-339, dependency).
- `research/20260716_cross_app_sidebar_organization_patterns.md` §4 (Telegram), §9.
