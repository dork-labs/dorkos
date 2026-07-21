---
slug: agent-list-settings
id: 260721-134154
created: 2026-07-21
status: implemented
linearIssue: DOR-339
---

# Implementation Notes — Agent List Settings

**Worktree:** `.claude/worktrees/agent-list-settings` · **Branch:** `feat/agent-list-settings` (based on `origin/main` at `d052e971c`)

## How it was built

Single-agent, four sequential phases (spec §Implementation Phases), each committed independently, TDD per module:

| Phase                 | Commit      | What landed                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 Attention substrate | `a31233834` | `entities/session/model/agent-attention.ts` (`AttentionState`, `ATTENTION_THRESHOLDS`, pure `deriveAttention`, `foldLiveKindsByPath`, `useAgentAttentionMap`); `SidebarDisplayFilterSchema` + `displayFilter`/`muted` on groups + `muted[]`/`ungroupedDisplayFilter` on prefs; `backfillSidebarSettingsDefaults` conf migration keyed `0.55.0`; mutation helpers `setGroupDisplayFilter`/`setGroupMuted`/`setUngroupedDisplayFilter`/`mutePath`/`unmutePath`.                     |
| 2 Filter + reveal     | `fb77e75b2` | `features/dashboard-sidebar/model/filter-agents.ts` (pure `filterSectionAgents`, the mute-downgrade matrix); `DisplayFilterMenu.tsx` (shared "Show" submenu), wired into `GroupHeader.tsx` and the new `UngroupedSectionMenu.tsx`; `RevealRow.tsx` ghost row; `AgentGroupSection.tsx` / `UngroupedSection.tsx` rewired to filter-then-sort; pulled the `useAgentsAggregateStatus` mute-exclusion refactor forward from P3 since the rollup dot needed the shared fold to compile. |
| 3 Mute end-to-end     | `899834652` | "Mute agent"/"Unmute agent" on `AgentRowMenuItems.tsx`; "Mute group"/"Unmute group" on `GroupHeader.tsx`; `AgentListItem.tsx` renders muted (dim + `BellOff` glyph, badge dropped, border forced idle-shaped); `DashboardSidebar.tsx` computes one `effectiveMutedForRender` set (individual OR containing-group) so a pinned copy renders muted identically to its home row.                                                                                                     |
| 4 Ship                | this PR     | `docs/guides/sidebar-settings.mdx` + nav entry + `contributing/INDEX.md` coverage row; changelog fragment; this file; manifest → `implemented`.                                                                                                                                                                                                                                                                                                                                   |

## Verification evidence

- **Targeted suites** (`pnpm vitest run apps/client/src/layers/features/dashboard-sidebar apps/client/src/layers/entities/session apps/client/src/layers/entities/config`): 42 files / 458 tests green, including every pre-existing DOR-329 suite (filter defaults to `all` ⇒ those fixtures render unchanged via a mocked `useAgentAttentionMap` returning `active`, per the spec's "keep fixtures fresh" testing guidance).
- **Config migration + schema** (`pnpm vitest run apps/server/src/services/core/__tests__/config-manager.test.ts packages/shared/src/__tests__/config-schema.test.ts`): 182 tests green, incl. the `backfillSidebarSettingsDefaults` upgrade-path tests (adds-when-missing, idempotent, no-ops when `ui`/`ui.sidebar` absent) and the `CONFIG_MIGRATIONS` key invariant added in review (below).
- **Typecheck:** `@dorkos/client`, `@dorkos/shared`, `@dorkos/server` all clean (`tsc --noEmit`, 0 errors).
- **Lint:** `@dorkos/client` 0 errors / 73 warnings (all pre-existing, none in touched files); `@dorkos/shared` 0 errors / 1 pre-existing warning.
- **Build:** `@dorkos/shared` builds clean (config-schema additions compile through the published subpath).

## Spec conformance — implementer-delegated decisions

1. **`borderKindFromLifecycle` → `AttentionState` mapping** (spec §1 + Open Questions watch-item). Enumerated the function's actual output: `'streaming' | 'pendingApproval' | 'error' | null`. Mapped `streaming` → `active`, and both `pendingApproval` **and** `error` → `needs-attention` — `error` is exactly the "blocked/error kind distinct from `pendingApproval`" the Open Questions section anticipated, and a failed turn is just as blocking as a pending approval. Documented in `agent-attention.ts`'s TSDoc on `deriveAttention`.
2. **`AttentionState` boundary inclusivity.** `elapsed <= activeWithinMs` → `active` (inclusive); `elapsed > inactiveAfterMs` → `inactive` (exclusive at the boundary, so exactly 7 days is still `idle`). Exercised by the `deriveAttention` boundary tests.
3. **`AgentEntry` type** (spec §3 pseudocode). Defined as `type AgentEntry = string` (a bare project path) rather than an object — matches how `sort-agents.ts` and the rest of the sidebar already treat section members as bare paths; no caller needed richer entries.
4. **Ungrouped section's "Show" menu placement.** The ungrouped section had no existing header settings menu at all (`ungroupedSortMode`/`setUngroupedSortMode` exist in the schema and mutation helpers but were never wired to any UI before this spec). Added a new `UngroupedSectionMenu.tsx` "…" button next to the "Agents" label, containing only the "Show" submenu — mirrors `GroupHeader`'s pattern but does not also add a "Sort by" control, since wiring the pre-existing dead `ungroupedSortMode` field is a separate, out-of-scope gap this spec didn't ask for.
5. **Mute rendering: "attention-driven emphasis suppressed."** Interpreted as covering both the activity badge AND the border-left color/pulse (not just the badge): a muted `AgentListItem` renders as if its live status were `idle`, regardless of actual session activity, forcing badge, color, and pulse to drop together atomically rather than needing three separate suppression checks.
6. **Effective mute set for rendering vs. filtering.** `filterSectionAgents` takes `mutedPaths` (individual only) + `groupMuted` (the containing group's own flag) as the spec's signature specifies. Rendering (dim + glyph on `AgentListItem`) instead reads one flattened `effectiveMutedForRender` set (individual **or** any containing group's mute) computed once in `DashboardSidebar`, so a pinned copy of an agent in a muted group renders muted identically to its home-group row ("one agent, one mute state").
7. **Migration version key.** Originally keyed `backfillSidebarSettingsDefaults` to `'0.54.0'` (root `VERSION` read `0.53.0`, already tagged, at branch time) — matching the `adding-config-fields` skill's "next unreleased version" convention used by the two prior sidebar migrations (`0.50.0`, `0.52.0`). **Corrected during review** — see below.

## Post-review fixes

The PR #382 review found one critical issue and two nits, all fixed in place on this branch:

- **Critical — stale migration key.** `v0.54.0` was tagged and released on `main` while this branch was still open, so decision 7's premise ("0.54.0 is the next unreleased version") went stale mid-flight. `conf` only runs a migration key that falls in `(storedVersion, projectVersion]`; a user who upgraded through the real 0.54.0 release is stamped `0.54.0`, so the `'0.54.0'` key sat at the boundary instead of strictly above it and was silently excluded — `backfillSidebarSettingsDefaults` would never have run for essentially every upgrading user, leaving `displayFilter`/`ungroupedDisplayFilter` `undefined` and `filterSectionAgents` falling through to its `'attention'` branch (existing users' sidebars would collapse to needs-attention-only behind a reveal row). Re-keyed to `'0.55.0'` in `config-manager.ts`, updated the migration comment, and corrected this file.
- **Regression guard (nit, but load-bearing).** Added a `CONFIG_MIGRATIONS` key-invariant test (`config-manager.test.ts`, describe block "CONFIG_MIGRATIONS key invariant (DOR-339 regression guard)"): the most-recently-appended migration key must be strictly newer than every already-released version. Ground-truthed against `git tag -l "v*"` (shared across every worktree of this checkout regardless of which commit a branch is sitting on, unlike a branch's own possibly-stale `package.json`), falling back to `package.json`'s version if git is unavailable. **Verified it actually catches the bug class**: temporarily reverted the key to `'0.54.0'` and confirmed the test fails with a clear message; restored `'0.55.0'` and confirmed it passes. Caught one bug in its own first draft along the way — the initial version picked "newest" via `semver.gt` reduction over all keys, which incorrectly selected the legacy `'1.0.0'` bootstrap key (semver-greater than any `0.x.x` release key despite being chronologically first); fixed to take the last-inserted object key instead, matching the file's own append-only discipline.
- **Nit — changelog jargon.** "rollup dot" → "activity dot" in the changelog fragment (the docs guide's own term).

## Deviations from the frozen spec (all reasoned above or low-risk)

- No new docs page existed for DOR-329's own groups/pinning feature; rather than let this spec's filter/mute guide read as a fragment, `docs/guides/sidebar-settings.mdx` briefly orients on groups/pinning before covering the new filter/reveal/mute surfaces, then links to `docs/guides/agents.mdx` for identity.
- `docs/getting-started/configuration.mdx` (the CLI/server-facing config reference) was **not** touched — `ui.sidebar`/`ui.shapes` were never mirrored there either (confirmed: no existing `ui.sidebar` row), since that page covers CLI/env-settable config, not client-only UI preferences.

## Follow-ups (not blocking)

- Revealed ghost-row agents (behind "N hidden" / "N inactive agents") render via the same row component but are not registered in the section's drag-and-drop `SortableList` — reordering a currently-hidden agent isn't supported while it's in the revealed state. Matches the spec's "reveal is a peek, not a mode," but worth a follow-up if manual reordering of hidden agents becomes a request.
- `smart-agent-groups` (DOR-338) is the next consumer of the `agent-attention` module per spec §Sequencing.
