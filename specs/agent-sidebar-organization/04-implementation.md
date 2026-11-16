---
slug: agent-sidebar-organization
id: 260716-235616
created: 2026-07-17
status: implemented
linearIssue: DOR-329
---

# Implementation Notes — Agent Sidebar Organization

**Worktree:** `~/.dork/workspaces/dorkos/feat-dor-329-agent-sidebar-organization` · **Branch:** `feat/dor-329-agent-sidebar-organization` (based on local `main` at `812d5ed1f`)

## How it was built

Orchestrated three-phase execution by named agents, each phase independently code-reviewed against `REVIEW.md` before the next began, then live browser verification against the dev server:

| Phase                                                                                                                                      | Agent   | Commits                               | Review verdict → fixes                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 Foundation (config schema + migration, recent-sessions fan-out endpoint, transport, `use-sidebar-prefs` optimistic hooks, pin migration) | Foundry | `44d7d610a`, `fa991f9f4`, `b2245f070` | APPROVE, 5 nits → `5666f8564` (incl. a real fix: pending-head composition so same-tick `update()` calls can't clobber each other)                                                                                                          |
| 2 UI core (sections, group CRUD, unified row menus, progressive disclosure, activity rollup)                                               | Loom    | `c4fa2af08`, `2b4d8ebdc`, `72e4a474a` | APPROVE, 2 nits + 1 rec → `7c35b6dac` (group CRUD tests, focus ring, full-tree menu parity)                                                                                                                                                |
| 3 DnD + polish (dnd-kit, keyboard + announcements, hint card, changelog)                                                                   | Torque  | `72fb01070`, `b14cf9bd3`, `8e6810e39` | APPROVE, 4 nits → `c6e621eaa` (void-drop docs alignment, group exit motion) + a real keyboard-sensor fix: `setActivatorNodeRef` was unwired, so Space in nested controls (incl. the rename input) would start a drag; now guarded + tested |
| Live-verification fix                                                                                                                      | Loom    | `2381c4c9b`                           | Real-pointer-only bug: Radix menu close restores focus to the trigger, blur-cancelling menu-launched inline editors (group create/rename). Fixed with a one-shot `use-menu-close-focus-guard` armed only by editor-opening actions.        |

## Verification evidence

- **`pnpm verify` (affected):** 23/24 turbo tasks green on first run; the one red was 11 unhandled errors from the untouched `chat/use-session-submit.test.tsx` with all 5217 tests passing — passes in isolation and the full suite re-ran clean (exit 0, 0 errors), i.e. a pre-existing dev-env flake, not introduced by this branch.
- **Targeted suites:** dashboard-sidebar feature 14 files / 141 tests green; server recent-sessions + config 100+ tests green; client/server/shared typecheck + lint clean.
- **Live browser pass** (Playwright against the worktree dev server, 9 seeded agents, all 10 checks green, 0 console errors):
  1. hint card appears at ≥8 agents / 0 groups; 2. Recent section hidden with no sessions; 3. group created via context menu inline input; 4. members moved via Move-to-group submenu; 5. pinned agent renders in Pinned **and** its home group (multi-presence); 6. pointer drag moved an ungrouped agent into a group; 7. keyboard drag picks up via Space on the focused row; 8. groups persist across reload (server config); 9. collapse state persists across reload; 10. non-empty group delete shows the AlertDialog with the exact spec copy.

## Deviations from the frozen spec (all reviewed)

- Void/null drop is a no-op; unpin fires only when a pinned row lands on a non-pinned container (spec table row 7 updated in-branch to match).
- `ui.sidebar` also surfaced on `ServerConfigSchema` + `GET /api/config` (required for the client hook; not in the spec's file list).
- Recent-sessions warnings deduped per runtime; the route always emits `warnings: []` (schema keeps it optional).
- dnd-kit's sortable `role="button"` on rows accepted as-is (standard dnd-kit; ADR-consistent).

## Follow-ups (not blocking)

- `dashboard-sidebar/ui/` is at 18 files (>15 advisory): a `ui/dnd/` subfolder would tidy it.
- A committed Playwright e2e for group create + drag (the one-off verification script lives outside the repo).
- Sidebar virtualization remains future work if fleets reach 100+ (unchanged stance from the prior sidebar spec).
