---
slug: workspace-manager
number: 259
created: 2026-06-16
status: implemented
linearIssue: DOR-84
---

# WorkspaceManager — Implementation Record

**Author:** /flow auto (autonomous; operator: Dorian) · **Date:** 2026-06-16
**Worktree:** `spec-workspace-manager` · **Spec:** `02-specification.md` · **Design:** `04-design-decisions.md`

## What shipped

A complete, browser-verified WorkspaceManager subsystem, wired into the live
session path, with a console UI — built end-to-end under `/flow auto` (the
operator confirmed scope, then slept; the rest ran autonomously, logging every
assumption here for the review gate).

| Phase        | Delivered                                                                                                                                                                                         | Tests                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Contract     | `Workspace` entity + `WorkspaceProvider` + `WorkspaceManager` + DTOs (`@dorkos/shared/workspace`)                                                                                                 | typecheck                                           |
| DB           | `workspaces` table + migration `0017_petite_slapstick`                                                                                                                                            | —                                                   |
| Backend      | file-first store · contiguous port-allocator · worktree + clone providers · Symphony 4-hook executor · port-env writer · the service · 5-min reconciler · `workspace` config + `0.45.0` migration | **VC#1/2/3 acceptance** + allocator unit (11 tests) |
| API + wiring | `/api/workspaces` routes · Transport verbs (HTTP + embedded adapters + mock) · **opt-in `workspaceKey` session binding** · bootstrap + reconciler                                                 | route tests (5)                                     |
| UI           | session-view indicator folded into the Git Status chip · dedicated `/workspaces` route (project-grouped cards + attached sessions) · pin + dirty-safe remove                                      | indicator + page tests (6)                          |
| Docs         | ADR-0283, ADR-0284, `contributing/workspace-manager.md`                                                                                                                                           | —                                                   |

**Validation criteria (DOR-84) — all pass end-to-end against a real git repo:**
VC#1 distinct keys → isolated paths + **disjoint** port blocks · VC#2 same key →
reuse · VC#3 cleanup **refuses a dirty workspace** unless forced.

## Browser test (evidence)

Ran the dev server (worktree ports 4292/4442), provisioned two real workspaces via
`POST /api/workspaces` (DOR-84 → port 4250, DOR-91 → 4260 — disjoint blocks,
both `ready` via the real worktree provider), made DOR-84 dirty and pinned DOR-91,
then drove Chrome through the `/workspaces` view and the dirty-safe remove.
Recording: `evidence/dor84-workspaces-ui.gif`.

**A real bug was caught and fixed by the browser test:** the DELETE route
returned `409` on a dirty refusal, but the client's `fetchJSON` throws on non-2xx
and drops the body, so the UI showed a generic "Action failed" toast instead of
the force-confirm. Fixed: the route now returns `200` with the `RemoveResult`
(`blocked:'dirty'`) and reserves `404` for genuinely-missing workspaces; a route
test locks the contract.

## Assumption trail (calibration-ladder log for review)

1. **Scope = wire into the live session/flow path** (operator-confirmed). Built
   **additive/opt-in**: no `workspaceKey` → the session path is byte-for-byte
   unchanged; a disabled/failing manager degrades to the supplied cwd.
2. **UI = minimal-interactive, operator-designed** via `/visual-companion`
   (indicator in the Git Status chip; dedicated `/workspaces` route). Captured in
   `04-design-decisions.md`.
3. **`projectKey` = sanitized repo dir name** for v1 (`<name>-<shortSha>` is a
   non-breaking upgrade; the key is opaque to consumers). _Not separately confirmed._
4. **`worktree-setup.sh` left unchanged** as the offline hash fallback: the server
   owns allocation for managed workspaces (`ensure → writePortEnv`); adding a
   server-consult to the shell hook would be fragile (server-URL discovery) for
   near-zero gain. _Deviation from task 2.4 as written — logged._
5. **Dirty detection** treats `.env` correctly only because repos gitignore it
   (standard; it's why `.gtrconfig` _copies_ `.env`). A repo that tracks `.env`
   would read every workspace as dirty — pin or force to remove. _Edge case noted._
6. **`EnterWorktree` (runtime-native worktree movement) is a non-goal** — the
   manager composes with but never integrates it; a workspace-bound orchestrated
   session must not use it (hardening via disallowed-tools is a follow-up).

## Follow-ups (not in this PR)

- Wire the `/flow` EXECUTE stage to provision via `WorkspaceManager.ensure` instead
  of a bare `gtr` call (the in-code seam — the session path — is ready).
- v2 naming layer (DOR-91): populate the reserved `hostname`/`url`.
- Disable `EnterWorktree` via disallowed-tools for orchestrated workspace-bound sessions.
- Retire the `worktree-setup.sh` hash path once non-managed gtr worktrees are gone.
- Pulse-seat concurrency hardening (heartbeat / fencing) — DOR-89.

This unblocks **DOR-91** and **DOR-88**, and folds in **DOR-85**.
