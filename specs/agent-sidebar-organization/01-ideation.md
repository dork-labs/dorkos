---
slug: agent-sidebar-organization
id: 260716-235616
created: 2026-07-16
status: ideation
linearIssue: DOR-329
---

# Agent Sidebar Organization: User-Defined Groups, Favorites, and Recent Sessions

**Slug:** agent-sidebar-organization
**Author:** Claude (flow, DOR-329), commissioned by Dorian
**Date:** 2026-07-16

---

## 1) Intent & Assumptions

- **Task brief:** Users with many agents can't arrange or group them in the left sidebar. Two core problems: (1) **grouping** — no way to set arbitrary user-defined groups (cf. Slack custom sidebar sections); (2) **finding recent sessions** quickly. Deliver world-class UI/UX: study Slack and other world-class apps, decide on sorting, grouping (drag-and-drop), favorites/multi-presence, discovery/FTUX from few agents to many, then build it.
- **Assumptions:**
  - The target surface is `DashboardSidebar` in the standalone web/desktop cockpit. Obsidian embedded mode never renders it and has a no-op `updateConfig`, so it is unaffected (verified: `apps/client/src/App.tsx` renders only `SessionSidebar`).
  - DorkOS is effectively single-operator per server instance; "per-user preference" and "per-instance preference" coincide today. Server-persisted config is the correct durability tier.
  - The existing "Pinned" mental model (pin icon, Pinned section) is kept — no rename to "Favorites" (churn without user value).
- **Out of scope (explicit, documented for future work):**
  - Rule-based "smart groups" (Telegram-style include/exclude rules) — strongest future candidate; agents have rich metadata (runtime, status, last-active).
  - Inline search/filter in the sidebar (Cmd+K palette remains the finder; it already has frecency).
  - Muting/hiding individual agents; count badges.
  - Nesting groups inside groups (research: every world-class app caps at 1–2 levels).
  - Emoji/color on groups (v2 polish candidate).
  - Session drag-and-drop; multi-group membership for one agent.
  - Obsidian plugin surface.

## 2) Pre-reading Log

- `research/20260716_slack_sidebar_organization_ux.md` (new, this task): Slack custom sections deep-dive. Most-loved primitives: **per-section sort** (A-Z / Recency / Priority) and **per-section unread filter**. Top complaints: single-bucket membership, muted-yet-badged contradiction, sort prefs stored client-side silently resetting (sections persist server-side and are trusted), the 2023 redesign backlash (ambiguous "Activity" label, no rollback). Slack's own FTUX research: **default sections to open** — collapsed defaults killed feature discovery. Quick Switcher frecency formula is public and battle-tested.
- `research/20260716_cross_app_sidebar_organization_patterns.md` (new, this task): Discord (drag-only folder creation, unread rollup to collapsed folders), Notion/Linear/Finder (convergent **multi-presence favorites** — the item stays in its home location; NN/g research explicitly endorses duplication over relocation), Telegram (rule-based membership), Spotify (**"Custom order" coexists with auto-sort modes; switching never destroys manual order**), Arc (cautionary tale: stacked overlapping primitives = documented user confusion), WCAG 2.2 §2.5.7 (drag needs a single-pointer alternative), `@dnd-kit` as the React 19 accessible-dnd consensus.
- `specs/agent-sidebar-redesign/02-specification.md`: the direct predecessor. Its **Non-Goals list is literally this task's feature list**: "Custom named sections (Slack-style user-created groups)", "Drag-to-reorder agents", "Server-side persistence of pin state", "Frecency-based sidebar ordering". Its component tree and data flow still match the code. Its open question — the duplicated ContextMenu/DropdownMenu per agent row — is still unresolved and must be fixed here, not worsened.
- `specs/agent-centric-ux/`: origin of palette-only frecency (`use-agent-frecency.ts`, Slack's bucket algorithm, already in the codebase, feature-locked inside `features/command-palette`).
- `.claude/rules/agent-storage.md` (ADR-0043): `.dork/agent.json` is source of truth; DB-only writes get reconciled away every 5 min. Relevant because it _rules out_ a casual "add a group column" design.
- `contributing/configuration.md` + `adding-config-fields` skill: `UserConfigSchema` changes need Zod field → defaults → semver-keyed conf migration → docs → tests.
- ADR-0310: session storage is runtime-owned; cross-runtime features must fan out per runtime with per-runtime degradation (`warnings[]`).

## 3) Codebase Map

- **Primary components:** `apps/client/src/layers/features/dashboard-sidebar/ui/DashboardSidebar.tsx` (395 lines — near the split threshold; extraction is part of this work), `AgentListItem.tsx`, `AgentContextMenu.tsx`, `AddAgentMenu.tsx`, `AgentOnboardingCard.tsx`. Dead code: `RecentAgentItem.tsx` (zero non-test consumers) — delete it.
- **Data flow (agents):** `useMeshAgentPaths()` (30s stale) → `useResolvedAgents(paths)` (batch resolve, 60s stale) → alphabetical sort by disambiguated display name → Pinned section (localStorage `pinnedAgentPaths`, pin order, **exclusive** — pinned agents leave the main list) + rest.
- **Data flow (sessions):** per-agent only. `useAgentSessions(projectPath)` → `selectAgentSessions` (canonical membership rule, DOR-203: exact cwd match, updatedAt desc). **No "all sessions across all agents" primitive exists anywhere** — `GET /api/sessions` without `cwd` means the vault root's own sessions, not "all".
- **State:** Zustand app-store slices; persisted fields hand-roll localStorage read/write; `resetPreferences()` is the single cleanup choke point. Server-synced UI prefs precedent: `UserConfigSchema.ui.dismissedUpgradeVersions` written via `transport.updateConfig()` (`SidebarFooterBar.tsx`), generic `useUpdateConfig()` hook exists.
- **Design system:** shadcn `SidebarGroup`/`SidebarGroupLabel`/`SidebarMenu*` primitives already power temporal session grouping — the natural building blocks for group sections. Radix ContextMenu + DropdownMenu (duplicated per row — must unify the item list). Motion via `motion/react`. Shortcuts registry `shared/lib/shortcuts.ts`.
- **Feature flags/config:** none relevant; `agents.defaultAgent` auto-pin on first run exists.
- **Potential blast radius:** `DashboardSidebar` + subcomponents (extraction), app-store core slice (pin state removal + migration), `UserConfigSchema` + conf migration, `routes/sessions.ts` + new session service, `entities/config` + `entities/session` hooks, `packages/shared` schemas, tests across all of it. No `AgentManifestSchema` / DB / mesh changes.
- **DnD:** no dnd library installed anywhere in the repo — new dependency (`@dnd-kit/core` + `@dnd-kit/sortable`) must be introduced.

## 4) Research

(Section 4 of the template — Root Cause Analysis — omitted; not a bug fix.)

- **Potential solutions considered:**
  1. **Where organization state lives**
     - (a) localStorage (status quo for pins): fast, but per-browser; lost across devices/browsers; the exact failure mode Slack users complain about with sort prefs. Rejected.
     - (b) **`UserConfigSchema.ui.sidebar` via `PATCH /api/config`** (chosen): server-persisted, syncs every client hitting the instance (web, desktop app), follows the `dismissedUpgradeVersions` precedent, governed migration path, no new endpoint needed.
     - (c) `AgentManifestSchema` field (file-first per ADR-0043): wrong semantics — a group is a _personal cockpit preference_, not a property of the agent itself; would also leak one user's filing system into `.dork/agent.json` in the repo.
  2. **Grouping model**
     - (a) Multi-group membership / tags: maximal flexibility, but ambiguous drag semantics and duplicated expandable rows everywhere; Arc lesson says overlapping primitives confuse. Rejected for v1.
     - (b) **Single-parent groups + multi-presence Pinned** (chosen): Slack's proven model, with its top complaint (no cross-cutting placement) answered the way Notion/Linear/Finder answer it — the Pinned section holds _references_; a pinned agent stays visible in its home group.
  3. **Recent-session discovery**
     - (a) Frecency-ranked session list: frecency suits repeatedly-revisited items (agents, channels); sessions are episodic — recency dominates relevance. Rejected; frecency stays palette-side for agents.
     - (b) **"Recent" sidebar section, cross-agent, recency-ranked (updatedAt desc), capped small** (chosen), backed by a new server endpoint `GET /api/sessions/recent` that fans out per agent path × runtime (ADR-0310 degradation contract, `warnings[]`), and returns a per-agent `lastActivityAt` map as a free by-product — which also powers per-group "Recent activity" sort.
     - (c) Client-side fan-out (N queries): duplicated logic, chatty. Rejected.
  4. **Reordering interaction**
     - **dnd-kit** (KeyboardSensor = WCAG 2.2 §2.5.7 keyboard protocol out of the box; ~6KB; the 2026 React consensus) + **context-menu "Move to group" as the single-pointer alternative** (also the mobile path — the sidebar is a Sheet on mobile where drag conflicts with scroll).

- **Recommendation (the proposed approach):**

  **Sidebar top-to-bottom:** Search row → **Recent** (cross-agent recent sessions, appears only when ≥2 agents have sessions) → **Pinned** (multi-presence references, manual order) → **user-defined groups** (each: name header, chevron, per-group sort, persisted collapse, activity rollup dot when collapsed) → **Agents** (ungrouped; renders header-less flat list until the first group or pin exists — progressive disclosure).

  **Interactions:** create groups via "+ New group" (section-header affordance) or context menu → "Move to group → New group…"; drag agents between groups / into Pinned / to reorder; keyboard + menu alternatives everywhere; per-group sort menu (Manual / Recent activity / Name) where switching modes never destroys manual order (Spotify rule); group rename/delete via header menu (delete returns members to Agents, never deletes agents); one-time dismissible hint when ≥8 agents and 0 groups.

  **Data:** `ui.sidebar` config section (groups, pinned, per-group sort + collapse, ungrouped prefs, hint dismissal) with a one-time client-side migration seeding `pinned` from the legacy localStorage `pinnedAgentPaths` (then the legacy store is removed — no tolerated legacy patterns). New `GET /api/sessions/recent?limit=` endpoint with `{ sessions, agentActivity, warnings }`.

## 5) Decisions

| #   | Decision                   | Choice                                                                                                         | Rationale                                                                                                                                       |
| --- | -------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Persistence tier           | `UserConfigSchema.ui.sidebar` (server config), not localStorage, not agent manifest                            | Slack evidence: server-persisted sections are trusted, client-local prefs silently reset. Groups are personal UI prefs, not agent properties.   |
| 2   | Group membership model     | Single-parent groups; agent in ≤1 group                                                                        | Slack's proven model; avoids ambiguous drag semantics; Arc cautionary tale.                                                                     |
| 3   | Cross-cutting placement    | Pinned is multi-presence (a pinned agent also stays in its home group)                                         | Notion/Linear/Finder convergence + NN/g duplication-over-relocation research; answers Slack's #1 complaint without tag complexity.              |
| 4   | Recents ranking            | Pure recency (updatedAt desc), cap 5, cross-agent                                                              | Sessions are episodic; frecency reserved for agent-level palette ranking (already exists).                                                      |
| 5   | Recents data source        | New `GET /api/sessions/recent` fan-out endpoint with `agentActivity` map + ADR-0310 `warnings[]`               | No existing cross-agent primitive; server-side is the reusable, single-implementation home; per-agent activity powers group "Recent" sort free. |
| 6   | Per-group sort             | Manual / Recent activity / Name; manual order durable across mode switches                                     | Slack's most-loved primitive + Spotify's non-destructive custom order.                                                                          |
| 7   | DnD library                | `@dnd-kit/core` + `@dnd-kit/sortable`, KeyboardSensor enabled                                                  | 2026 consensus, accessible by default, WCAG 2.2 §2.5.7 satisfied together with menu alternative.                                                |
| 8   | Mobile reorder path        | Context menu (long-press) only; no touch drag                                                                  | Sidebar is a Sheet on mobile; drag conflicts with scroll; WCAG single-pointer path doubles as the mobile UX.                                    |
| 9   | Progressive disclosure     | No group chrome until first group/pin; Recent appears at ≥2 agents with sessions; hint at ≥8 agents & 0 groups | Telegram/Notion conditional rendering on data; Slack FTUX research (default open, discovery over density).                                      |
| 10  | Label naming               | Keep "Pinned" (not "Favorites"); ungrouped section labeled "Agents"                                            | Existing product mental model; avoid ambiguous catch-all labels ("Other").                                                                      |
| 11  | Legacy pin state           | One-time migration localStorage → config, then remove `pinnedAgentPaths` store entirely                        | Codebase excellence rule: no tolerated legacy patterns; `resetPreferences()` updated.                                                           |
| 12  | Row menus                  | Unify context-menu + dropdown item lists into one shared component before adding new items                     | Fixes the prior spec's unresolved drift landmine instead of doubling it.                                                                        |
| 13  | Scope                      | Standalone web/desktop only; Obsidian untouched                                                                | `DashboardSidebar` never renders embedded; `updateConfig` is a no-op there.                                                                     |
| 14  | Stale paths in groups/pins | Filter at render; never auto-prune on write                                                                    | Mesh roster can be temporarily incomplete mid-scan; silently discarding user curation is the cardinal sin (Spotify/Slack evidence).             |

No open questions requiring the operator — all ambiguities resolved with researched rationale above.

**Next step:** SPECIFY (`02-specification.md`).
