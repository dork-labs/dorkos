---
slug: agent-list-settings
id: 260721-134154
created: 2026-07-21
status: specified
linearIssue: DOR-339
---

# Agent List Settings: Per-Group Display Filters, Inactive Reveal, and Muting

**Status:** Approved (flow drain, gates delegated)
**Author:** Claude (flow, DOR-339), commissioned by Dorian
**Date:** 2026-07-21

## Overview

Three sidebar settings that share one attention-signal model: a per-group **display filter** (All / Active / Needs attention), an explicit **"N inactive" reveal row** (never silent hiding), and **muting** for groups and agents where mute owns every signal at once. All state is additive on the DOR-329 `ui.sidebar` server config. One new pure derivation module in `entities/session` becomes the single source of attention truth; the sibling spec `smart-agent-groups` (DOR-338) consumes it later.

Decisions and rationale: `01-ideation.md` §5. Research grounding: `research/20260716_slack_sidebar_organization_ux.md`, `research/20260716_cross_app_sidebar_organization_patterns.md` §10.

## Background / Problem Statement

DOR-329 shipped groups, pinning, and recents. Fleets past ~10 agents now face signal problems, not structure problems: dormant agents crowd active ones, "which agent needs me?" has no first-class answer, and there is no way to silence a noisy group without losing it. Slack's research lesson is binding: per-section display filters are its most-loved primitive, and its muted-but-still-badged contradiction is its most reproducible complaint — partial mute states break trust.

## Goals

- Per-agent `AttentionState` derived in one place, consumed by filters, reveal rows, rollup dots, and mute.
- Per-group display filter (All / Active / Needs attention), persisted per group, with an honest "N hidden" reveal row.
- Inactive agents collapse into an "N inactive agents" reveal row per section (default-on at a conservative threshold).
- Mute (agent-level and group-level): drops the attention badge, the rollup-dot contribution, and any attention-driven emphasis atomically; renders dimmed; stays in place and clickable.
- All state in `ui.sidebar` (`SidebarPrefsSchema`), synced across clients; config migration per `adding-config-fields`.

## Non-Goals

- Global frequency-based auto-sort (rejected, ADR-0242 — spatial memory).
- Unread/count badges; notification or sound behavior (mute is sidebar-signal only).
- Rule-based smart groups (sibling spec `smart-agent-groups`).
- Obsidian embedded mode (no `DashboardSidebar`; `updateConfig` no-op on DirectTransport — unchanged from DOR-329).

## Technical Dependencies

Existing only: `useSessionListStore` + `borderKindFromLifecycle` (live lifecycle), `RecentSessionsResponse.agentActivity` from `GET /api/sessions/recent` (historical recency), Zod 4 config schema + `conf` migrations, Radix menus, shadcn sidebar primitives. **No new dependencies; no new server endpoints.**

## Detailed Design

### 1. Attention model — `entities/session/model/agent-attention.ts` (new)

```ts
/** Ordered by precedence: the first matching state wins. */
export type AttentionState = 'needs-attention' | 'active' | 'idle' | 'inactive';

export const ATTENTION_THRESHOLDS = {
  /** Activity within this window ⇒ 'active'. */
  activeWithinMs: 60 * 60 * 1000, // 1h
  /** No activity beyond this window ⇒ 'inactive'. */
  inactiveAfterMs: 7 * 24 * 60 * 60 * 1000, // 7d
} as const;
```

- `needs-attention`: any live session for the agent's path whose lifecycle maps (via `borderKindFromLifecycle`) to `pendingApproval` — or `streaming`? No: streaming = `active`. `pendingApproval` only, plus a session in a blocked/error terminal awaiting retry if the lifecycle exposes it (implementer: enumerate `borderKindFromLifecycle` outputs; map `pendingApproval` → `needs-attention`, `streaming` → `active`, all else falls through to recency).
- `active`: streaming now, or `agentActivity` timestamp within `activeWithinMs`.
- `idle`: activity between the two thresholds.
- `inactive`: no activity within `inactiveAfterMs` (or no activity data at all).

Two exports:

- `deriveAttention(input: { liveKinds: BorderKind[]; lastActivityAt: number | null; now: number }): AttentionState` — pure, unit-testable.
- `useAgentAttentionMap(paths: string[]): Record<string, AttentionState>` — one store subscription (the `useAgentsAggregateStatus` aggregation pattern: fold `statusCwds`/`statuses` once, join with `agentActivity` from `useRecentSessions`), memoized on a joined-path key. O(1) subscriptions regardless of fleet size.

`useAgentsAggregateStatus` (the collapsed-group rollup) is refactored to read the same fold internally, gaining a `mutedPaths` exclusion parameter (decision 4: muted members do not light the rollup dot). Public signature stays backward-compatible via an options object.

### 2. Schema — `packages/shared/src/config-schema.ts` (additive)

```ts
export const SidebarDisplayFilterSchema = z.enum(['all', 'active', 'attention']);

export const SidebarGroupSchema = z.object({
  // ...existing fields unchanged...
  /** Which members render: all, active-recently, or needs-attention only. */
  displayFilter: SidebarDisplayFilterSchema.default('all'),
  /** Muted groups drop every attention signal for all members at once. */
  muted: z.boolean().default(false),
});

export const SidebarPrefsSchema = z.object({
  // ...existing fields unchanged...
  /** Muted agent projectPaths. Mute owns ALL signals; no partial states. */
  muted: z.array(z.string()).default(() => []),
  /** Display filter for the ungrouped "Agents" section. */
  ungroupedDisplayFilter: SidebarDisplayFilterSchema.default('all'),
});
```

All fields default — existing configs parse unchanged. Still: add the semver-keyed `conf` migration entry per `adding-config-fields` (the skill's checklist governs defaults + docs + tests). `SIDEBAR_PREFS_DEFAULTS` picks the new fields up automatically via `parse({})`.

### 3. Filter + reveal application — `features/dashboard-sidebar/model/filter-agents.ts` (new, pure)

```ts
export interface FilteredSection {
  visible: AgentEntry[];
  /** Hidden by the display filter (reveal row: "N hidden"). */
  filteredOut: AgentEntry[];
  /** 'all' filter only: inactive members collapsed behind "N inactive agents". */
  inactive: AgentEntry[];
}
export function filterSectionAgents(
  agents: AgentEntry[],
  opts: {
    filter: SidebarDisplayFilter;
    attention: Record<string, AttentionState>;
    mutedPaths: ReadonlySet<string>;
    groupMuted: boolean;
  }
): FilteredSection;
```

Rules (the interplay matrix — test exhaustively):

| filter      | visible                                                                 | filteredOut | inactive row                |
| ----------- | ----------------------------------------------------------------------- | ----------- | --------------------------- |
| `all`       | everything except `inactive`-state members                              | — (empty)   | `inactive`-state members    |
| `active`    | `needs-attention` + `active` (muted: dimmed, kept if state qualifies\*) | the rest    | — (subsumed by filteredOut) |
| `attention` | unmuted `needs-attention` members                                       | the rest    | —                           |

\* Mute suppresses the `needs-attention` signal by definition (ideation decision 6): a muted agent's effective state for filtering/badging is capped at `active`. Implemented inside `filterSectionAgents` by downgrading before matching — the ONE place mute semantics live.

Reveal rows render as a ghost row at section bottom: `"3 hidden"` / `"5 inactive agents"`; click expands inline (local component state, not persisted — reveal is a peek, not a mode). Zero hidden ⇒ no row. Sorting applies after filtering (existing `sort-agents.ts` untouched).

### 4. Mute wiring

- Agent row context menu: "Mute agent" / "Unmute agent" → toggles path in `ui.sidebar.muted`.
- Group header menu: "Mute group" toggle → `groups[i].muted`.
- Muted rendering: `opacity` dim on the row + a small mute glyph after the name; no attention badge; excluded from rollup dots (via the `useAgentsAggregateStatus` exclusion); attention-driven emphasis suppressed. Pinned copies of a muted agent render muted too (one agent, one mute state).
- Group mute is a lens over members: it does not write member paths into `muted` (unmuting the group restores individual states untouched).

### 5. Settings surfaces

Group header dropdown gains a "Show" radio submenu (All / Active / Needs attention) above the existing sort submenu; same menu for the ungrouped section header (existing pattern). No new settings page. Menu items carry the same keyboard/a11y affordances as the DOR-329 menus (Radix defaults).

## User Experience

A fleet of 30 with 4 dormant agents: default view shows 26 rows + "4 inactive agents". Switching the "Clients" group to _Needs attention_ collapses it to the two agents awaiting approval. Muting the noisy "Experiments" group: its rollup dot goes dark, badges vanish, rows dim — but nothing moves and nothing disappears. Every hidden agent is one click away behind an honest count row.

## Testing Strategy

- `agent-attention.test.ts`: `deriveAttention` matrix (each state boundary, exact thresholds, null activity), hook fold with mock store (multi-session per path takes the hottest state; muted exclusion).
- `filter-agents.test.ts`: the full filter × mute × state matrix from §3's table, incl. muted-`needs-attention` downgrade, empty results, reveal-row counts.
- `config-schema.test.ts`: new defaults, legacy config parse (no fields), round-trip.
- Component tests (RTL + mock Transport per `.claude/rules/testing.md`): reveal-row expand/collapse, menu wiring writes config, muted rendering drops badge + dims, group-mute leaves member `muted[]` untouched.
- Existing DOR-329 sidebar tests must stay green (filter defaults to `all` ⇒ zero behavior change until a user opts in — except the inactive reveal, which existing tests must be updated to expect only if fixture data crosses the 7-day threshold; keep fixtures fresh-dated to avoid churn).

## Performance Considerations

One store subscription for the whole attention map (the DOR-329 aggregation pattern); pure filter functions memoized per section on (members, filter, muted, attention-map identity). No per-row subscriptions added.

## Security Considerations

None — client-side presentation over data already fetched; config writes ride the existing authenticated config route.

## Documentation

- Docs site sidebar guide (`docs/` cockpit section): filters, inactive reveal, muting — `writing-for-humans` register.
- Changelog fragment (user-facing).

## Implementation Phases

1. **Attention module + schema** (entities + shared + migration + tests) — the substrate.
2. **Filter + reveal** (pure model fn + section render + menus + tests).
3. **Mute** (config wiring + rendering + rollup exclusion + tests).
4. Docs + fragment + `04-implementation.md`.

Single worktree, sequenced after DOR-340's sidebar refactor merges (same directory).

## Open Questions

None blocking. One watch-item: if `borderKindFromLifecycle` exposes an error/blocked kind distinct from `pendingApproval`, fold it into `needs-attention` (implementer verifies the enum at build time).

## Related ADRs

- ADR-0242 (no global auto-sort — constraint honored).
- ADR 260717-001409 (sidebar state in user config — extended, unchanged in principle).

## References

- `specs/agent-sidebar-organization/` (DOR-329) — substrate spec.
- `research/20260716_slack_sidebar_organization_ux.md`; `research/20260716_cross_app_sidebar_organization_patterns.md` §10.
