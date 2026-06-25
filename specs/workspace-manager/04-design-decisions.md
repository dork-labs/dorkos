# Design Decisions — WorkspaceManager UI

Visual companion session: `.dork/visual-companion/14384-1781658628/`
Operator: Dorian · Date: 2026-06-16

Captured from a `/visual-companion` design pass (local browser preview, no
DesignSync/claude.ai). These decisions govern the Phase-3 UI build; an
implementing agent can build from this prose without opening the raw mockups.

## 1. Current-workspace indicator placement

**Screen:** `workspace-indicator.html`
**Options:** A) chip in the existing status strip · B) badge in the session header · C) pill above the input
**Chosen:** **A — status-strip chip.** It belongs with the other live session metadata (tokens, mode), stays subtle, and is contextual.

## 2. Fold the indicator into the existing Git Status item

**Screen:** `git-workspace-chip.html`
**Options:** A) workspace-led, minimal · B) workspace + full git detail inline
**Chosen:** **A — workspace-led, minimal.**

**Rationale:** The existing `GitStatusItem` (`features/status/ui/GitStatusItem.tsx`,
fed by `useGitStatus(status.cwd)`) is already keyed on the **same cwd** the
workspace resolves from, and a managed workspace **is** a git worktree on
`dork/<key>`. One unified "where am I" chip beats two redundant ones, and the
dirty count the chip shows is the same signal that gates workspace cleanup.

**Final design:**

- When the session cwd resolves to a managed workspace, the Git Status item
  leads with the **workspace identity**: `⎇ DOR-84 · core` (key + project, muted
  project), followed inline by just the **change count** (`· 3 changes`) when
  dirty. The branch (`dork/DOR-84`), provider (worktree/clone), ahead/behind,
  the port block (`:4292 / :4442 / :4592`), and `pinned` move to the **hover
  tooltip**. The key already implies the branch, so the branch is not shown inline.
- When the cwd is **not** a managed workspace, the item renders **exactly as it
  does today** (branch + ahead/behind + changes, "main checkout"). No regression.
- The "No repo" disabled state is unchanged.

**Implementation note:** `entities/workspace` exposes `useWorkspaceForSession(cwd)`
(→ `transport.resolveWorkspace(cwd)`); `features/status` consumes it in
`GitStatusItem` to switch to the workspace-led label when a workspace resolves.
FSD-legal (features → entities).

## 3. Workspaces view — layout

**Screen:** `workspaces-view.html`
**Options:** A) grouped cards per project · B) sortable table
**Chosen:** **A — grouped cards.**

**Final design:**

- Sections grouped by **project** (header = project name + workspace count).
- Each workspace is a **card** showing: the key (`⎇ DOR-84`), a status pill
  (`provisioning` amber / `ready` green / `failed` / `removing`), provider,
  the port block (`:4292`), a `📌` when pinned, and the dirty state
  (`● N changes` amber when dirty, `clean` muted).
- Inside each card, an **attached-sessions** list (separated by a dashed rule):
  `● active` (green dot) / `○ idle` (gray dot) session titles; clicking a session
  navigates to its view. "no sessions" when empty.
- Per-card actions (on hover): **pin/unpin**, **remove**. Remove refuses a dirty
  workspace and surfaces an explicit confirm-with-force dialog — never a silent
  destroy.
- Empty state (no workspaces) and `failed`-status (with the truncated hook error)
  are present.

## 4. Placement

**Chosen:** a **dedicated `/workspaces` route** in the main nav (peer to
`/agents` and `/session`), not a tab inside `/agents`. Keeps the fleet view
focused; workspaces are a first-class concept.

**Implementation:** `widgets/workspaces` (the page) + a route in `router.tsx`;
the page consumes `entities/workspace` (`useWorkspaces`) and
`features/workspace-management` (pin/remove actions).

## Final Design Summary

A minimal, interactive workspaces UI in two parts:

1. **Session-view indicator** — the existing status-strip Git Status item, upgraded
   to lead with the workspace identity (`⎇ <key> · <project>`, change count inline,
   everything else in the tooltip) whenever the session's cwd is a managed
   workspace; otherwise unchanged. This is the headline "what workspace am I in"
   element.
2. **`/workspaces` route** — project-grouped cards, each card a workspace with its
   provider/status/ports/dirty/pin and the sessions attached to it (active vs
   idle, click-through), plus pin and dirty-safe remove actions.
