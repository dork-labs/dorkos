---
slug: agent-list-settings
id: 260721-134154
created: 2026-07-21
status: ideation
linearIssue: DOR-339
---

# Agent List Settings: Per-Group Display Filters, Inactive Reveal, and Muting

**Slug:** agent-list-settings
**Author:** Claude (flow drain, DOR-339), commissioned by Dorian
**Date:** 2026-07-21

---

## 1) Intent & Assumptions

- **Task brief:** Three sidebar settings that share one attention-signal model and ship together (split from the sidebar-organization-v2 umbrella, follow-up to DOR-329 / PR #293): (1) a per-group display filter — All / Active recently / Needs attention; (2) an explicit "N inactive agents" reveal row instead of silent hiding; (3) muting a group or agent, where mute owns ALL signals at once (badge, rollup dot, position) with no partial states.
- **Assumptions:**
  - DOR-329's sidebar groups (`SidebarGroupSchema`, `ui.sidebar` server config) are the substrate; every new field is additive.
  - The attention data already exists client-side: `agentActivity` from `GET /api/sessions/recent` (entities/session) and `useAgentsAggregateStatus`. No new server endpoint is required.
  - DOR-340 (sidebar engineering follow-ups, in flight) lands first; this feature builds on the tidied `ui/dnd/` layout.
- **Out of scope:**
  - Global frequency-based auto-sort of the agent list — **rejected per ADR-0242** (spatial memory); do not revisit without new evidence. Behavior-driven ordering stays in Cmd+K frecency and the opt-in per-group Recent sort.
  - Unread/count badges (still a deferred Non-Goal from the prior sidebar spec; the filter works off attention states, not counts).
  - Smart rule-based groups — sibling spec `smart-agent-groups` (DOR-338), which consumes the signal model this spec defines.
  - Notification/sound behavior; mute here is a sidebar-signal concept only.

## 2) Pre-reading Log

- `specs/agent-sidebar-organization/02-specification.md`: the DOR-329 data model — `SidebarGroupSchema { id, name, agentPaths, sortMode, collapsed }`, `SidebarPrefsSchema { pinned, groups, ungroupedSortMode }` in `packages/shared/src/config-schema.ts:75`; settings live in-context in group header menus; collapsed groups roll member activity up to a header dot.
- `research/20260716_slack_sidebar_organization_ux.md`: the per-section display filter (All / Unreads / Mentions) is Slack's most-loved primitive; Slack's most reproducible complaint is the muted-but-still-badged contradiction — partial mute states break trust.
- `research/20260716_cross_app_sidebar_organization_patterns.md` §10: hiding must always leave a discoverable trail — conditional reveal rows, never silent disappearance.
- `apps/client/src/layers/features/dashboard-sidebar/`: `DashboardSidebar.tsx`, `AgentGroupSection.tsx`, `model/sort-agents.ts` — per-group sort already flows through a pure model function; filters can mirror that shape.
- ADR-0242 (agent list ordering): global auto-sort rejected for spatial memory reasons — constraint carried into Out of scope.

## 3) Codebase Map

- **Primary components/modules:** `features/dashboard-sidebar/ui/AgentGroupSection.tsx` (per-group render + header menu), `model/sort-agents.ts` (pure ordering; add a sibling `filter-agents.ts`), `entities/session` (`use-recent-sessions`, activity), `useAgentsAggregateStatus` (aggregate attention states).
- **Shared dependencies:** `packages/shared/src/config-schema.ts` (`SidebarGroupSchema`, `SidebarPrefsSchema`) + `conf` migration in the server config manager (`adding-config-fields` skill governs the lifecycle).
- **Data flow:** agents list + `agentActivity` + aggregate status → derive per-agent `AttentionState` → per-group filter/mute application (pure model fn) → section render; config mutations ride the existing `updateConfig` transport path (no-op on Obsidian DirectTransport, same as DOR-329).
- **Potential blast radius:** sidebar only; the attention-derivation module lands in `entities` (FSD: consumed by features/dashboard-sidebar now, smart groups later).

## 4) Research

- **Potential solutions:**
  1. **Per-surface ad-hoc booleans** (a `hideInactive` flag here, a `muted` flag there) — cheapest, but reproduces Slack's partial-state contradiction; rejected.
  2. **One attention-signal model + three consumers** — a single derivation (`AttentionState = needs-attention | active | idle | inactive`, plus `muted` as an overlay) that the filter, the reveal row, the rollup dot, and mute all read. Slightly more upfront design; every later surface (smart groups, fleet page) reuses it.
- **Recommendation:** option 2 — it is the issue's own framing ("three settings that share one attention-signal model") and the only shape that makes mute atomic.

## 5) Decisions

| #   | Decision                 | Choice                                                                                                                                                                                                                                                                                       | Rationale                                                                                                     |
| --- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 1   | Attention model          | One pure derivation module in `entities`: per-agent `AttentionState` = `needs-attention` (awaiting approval / blocked) > `active` (session activity within a recency window) > `idle` > `inactive` (no activity beyond a long threshold). `muted` is an orthogonal overlay, not a state.     | Single source of truth; filter, reveal, rollup, and mute stay consistent by construction.                     |
| 2   | Filter storage + values  | Additive `displayFilter: z.enum(['all','active','attention']).default('all')` on `SidebarGroupSchema`; ungrouped section gets a parallel field on `SidebarPrefsSchema`.                                                                                                                      | Mirrors the per-group `sortMode` pattern shipped in DOR-329; server-persisted, cross-client.                  |
| 3   | Hidden ≠ silent          | Whenever a filter or the inactive threshold hides agents, render one collapsed row: "N hidden" (filter) / "N inactive agents" (inactive). Clicking reveals inline until collapse.                                                                                                            | The Slack lesson and cross-app research: silent hiding is the reproducible complaint; reveal rows are honest. |
| 4   | Mute semantics           | `SidebarPrefsSchema.muted: string[]` (agent projectPaths) + additive `muted: boolean` on groups. Muted = drops ALL signals (attention badge, group rollup dot contribution, any attention-driven positioning) and renders dimmed, but stays in place and stays clickable. No partial states. | The issue's hard requirement; atomicity is what makes mute trustworthy.                                       |
| 5   | Where settings live      | In-context: group header dropdown gains a "Show" submenu (filter) + "Mute group"; agent row context menu gains "Mute agent". No new settings page.                                                                                                                                           | DOR-329 pattern; the control lives where its effect is seen.                                                  |
| 6   | Mute vs filter interplay | A muted agent still counts for "All" and is listed dimmed; it is excluded from "Needs attention" (mute suppresses that signal by definition).                                                                                                                                                | Follows directly from decision 4's "mute owns all signals".                                                   |
| 7   | Sequencing               | This spec lands before `smart-agent-groups` (DOR-338); the attention module is the shared substrate both consume.                                                                                                                                                                            | Avoids DOR-338 inventing a second signal model.                                                               |

## 6) Recommended Direction & Next Step

Proceed to SPECIFY. The design is additive on DOR-329's schema (three new fields + one entities module + menu wiring), the risk is low, and the one genuinely product-shaped call (mute atomicity) is fixed by the issue itself. The spec should pin: exact recency/inactive thresholds (propose: active = activity within 1h; inactive = none within 7 days, both constants in the attention module), config migration steps per `adding-config-fields`, and test coverage for the filter/mute/reveal interplay matrix.
