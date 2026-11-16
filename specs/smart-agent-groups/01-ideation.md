---
slug: smart-agent-groups
id: 260721-134155
created: 2026-07-21
status: ideation
linearIssue: DOR-338
---

# Smart Agent Groups from Mesh Metadata (Rule-Based Membership)

**Slug:** smart-agent-groups
**Author:** Claude (flow drain, DOR-338), commissioned by Dorian
**Date:** 2026-07-21

---

## 1) Intent & Assumptions

- **Task brief:** Telegram's rule-based folder model applied to agents (split from the sidebar-organization-v2 umbrella, follow-up to DOR-329 / PR #293): group membership derived from mesh metadata — namespace, runtime, status, last-active — instead of manual curation. Membership re-evaluates as agent state changes, so the group maintains itself (an idle agent silently leaves an "Active" smart group).
- **Assumptions:**
  - Design constraints already settled in DOR-329 are binding: sidebar groups stay presentation-only; the mesh remains source of truth; a smart group READS mesh metadata, never writes it — no coupling to topology, A2A permissions, or namespaces beyond display.
  - `SidebarGroupSchema` ships with stable ids; the discriminator is additive (`kind: 'manual' | 'smart'` + a rules object) with a config migration per `adding-config-fields`.
  - Multi-presence is structural for smart groups: an agent matching two rule sets appears in both (Telegram model, per DOR-329's settled constraints).
  - The sibling spec `agent-list-settings` (DOR-339) lands first and provides the shared attention/activity derivation module this feature's `status` and `lastActive` predicates consume.
- **Out of scope:**
  - Exclude-rules (Telegram's second rule set). v1 is include-only; exclusion via mute (DOR-339) covers the practical need.
  - Server-side rule evaluation or persistence of materialized membership — rules only in config; membership is always derived at render.
  - Folders-as-tabs presentation (Telegram renders folders as a tab strip; DorkOS keeps groups as sections — settled by DOR-329).
  - Any write path from a smart group to mesh state.

## 2) Pre-reading Log

- `research/20260716_cross_app_sidebar_organization_patterns.md` §4: Telegram — live membership = include minus exclude, re-evaluated continuously; multi-presence is structural; folders auto-surface on a data threshold. §9/takeaway 9: agents have rich metadata (runtime, project, status, last-active) so rule-based groups need zero maintenance.
- `specs/agent-sidebar-organization/02-specification.md`: `SidebarGroupSchema { id, name, agentPaths, sortMode, collapsed }` at `packages/shared/src/config-schema.ts:75`; the spec's Non-Goals name smart groups as "strongest v2 candidate; the schema deliberately leaves room (a future `kind` discriminator)". ADR 260717-001409 (sidebar state in user config) applies unchanged.
- `specs/agent-list-settings/01-ideation.md` (sibling, this drain): defines the `AttentionState` derivation module in `entities` — the substrate for `status`-shaped predicates here.
- `apps/client/src/layers/features/dashboard-sidebar/model/sort-agents.ts`: ordering already flows through pure model functions — rule evaluation should be a sibling pure module.

## 3) Codebase Map

- **Primary components/modules:** `packages/shared/src/config-schema.ts` (schema + discriminator), `features/dashboard-sidebar/model/` (new pure `evaluate-smart-group.ts`), `AgentGroupSection.tsx` (render + header affordances), group create/edit flow (add the "Smart group" path), `entities` mesh/agent queries (runtime, namespace, lastActive) + the DOR-339 attention module.
- **Shared dependencies:** config migration machinery (`conf`, semver-keyed — `adding-config-fields`); mesh agent metadata already present in the client's agent entities.
- **Data flow:** agents + mesh metadata + attention states → `evaluate-smart-group(rules, agents)` (pure, memoized) → derived member list → existing group section render. Config stores rules only; nothing materialized.
- **Potential blast radius:** sidebar + config schema. Rule evaluation is read-only over data the sidebar already fetches — no new server surface.

## 4) Research

- **Potential solutions (rule vocabulary v1):**
  1. **Full query builder** (arbitrary AND/OR trees over any metadata) — maximally expressive; heavy UI, easy to over-build, hard to keep honest in a sidebar menu.
  2. **Flat predicate set, AND-combined** — one rules object with optional fields: `runtime[]`, `namespace[]`, `status[]` (attention states), `lastActiveWithin` (duration), `pathPrefix`. A group matches agents satisfying ALL present predicates; each predicate with multiple values is an OR within the field. Telegram-simple, covers every motivating example ("Active now", "All Codex agents", "Everything under ~/clients/acme").
  3. **Presets only** (canned smart groups, no custom rules) — lowest scope; too rigid for the persona (Kai names his own mental model).
- **Recommendation:** option 2, with option 3's presets layered on top as one-click starters ("Active now", "By runtime") — progressive disclosure per the research (auto-suggest smart groups only once the fleet is large enough to need them).

## 5) Decisions

| #   | Decision                 | Choice                                                                                                                                                                                                                      | Rationale                                                                                                        |
| --- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1   | Schema shape             | Additive discriminator on `SidebarGroupSchema`: `kind: z.enum(['manual','smart']).default('manual')` + optional `rules` object (flat predicate set, decision above). `agentPaths` stays and is ignored for `kind: 'smart'`. | Zero migration risk for existing groups (default `'manual'`); one schema, one render path.                       |
| 2   | Evaluation site          | Client-side pure function, memoized on (rules, agents, attention) — re-evaluates as queries refresh; config never stores members.                                                                                           | "Membership re-evaluates as agent state changes" with no new server surface; mesh stays source of truth.         |
| 3   | Rule vocabulary v1       | `runtime[]`, `namespace[]`, `status[]`, `lastActiveWithin`, `pathPrefix` — AND across fields, OR within a field. No excludes, no nesting.                                                                                   | Covers all motivating cases at a sidebar-menu-sized UI; excludes deferred (mute covers exclusion pragmatically). |
| 4   | Interaction semantics    | Smart-group membership is not draggable (rule-owned). Dragging an agent onto a smart group is rejected with a hint. Header menu shows a plain-language rule summary ("Codex · active in last hour").                        | Honest UI: the rules own membership; pretending otherwise recreates Arc's mental-model confusion.                |
| 5   | Escape hatch             | "Convert to manual group" menu action materializes the current members into `agentPaths` and flips `kind`.                                                                                                                  | Cheap off-ramp; nobody gets trapped in a rule they can't hand-tune.                                              |
| 6   | Sort inside smart groups | Reuse `sortMode` minus `'manual'`; default `'recent'`.                                                                                                                                                                      | Manual order is meaningless for derived membership.                                                              |
| 7   | Empty smart groups       | Render with an inline "0 matching" state (not hidden).                                                                                                                                                                      | Silent disappearance is the cross-app anti-pattern; an empty smart group is information.                         |
| 8   | Dependency               | Builds after `agent-list-settings` (DOR-339): the attention module supplies `status`/activity predicates.                                                                                                                   | One signal model, two consumers — avoids drift.                                                                  |

## 6) Recommended Direction & Next Step

Proceed to SPECIFY, sequenced after `agent-list-settings`. The spec should pin: the exact `rules` Zod schema, the predicate-evaluation contract and memoization keys, the group-create UI flow (manual vs smart fork + presets), drag-rejection UX, the convert-to-manual materialization, config migration, and the test matrix (each predicate, AND/OR combination, live re-evaluation, multi-presence rendering, empty state).
