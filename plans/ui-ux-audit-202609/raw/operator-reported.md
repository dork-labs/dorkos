# Operator-reported findings (confirmed live, 2026-09-03)

## Coverage

Bugs the operator saw with their own eyes while the browser audit ran. Screenshot evidence on the operator's machine (`CleanShot 2026-09-03 at 08.37.04@2x.png`). Treated as confirmed — no re-verification needed.

### [P1/S] Long path overflows the Workspaces empty state and the page (mobile)

- **Files:** `apps/client/src/layers/widgets/workspaces/ui/WorkspacesPage.tsx:200-204`
- **Evidence:** On a phone-width viewport, the "No worktrees yet" empty state interpolates the workspace root path (`` ` in ${shortenHomePath(root)}` ``) into body copy. A long root (`~/Keep/dork-os/dorkos/apps/desktop/.temp/.dork/wo…`) renders as one unbroken string that escapes the card _and_ the page, causing horizontal scroll. Screenshot confirms.
- **Recommendation:** Two fixes in one: (1) contain the path — render it as its own line in a truncating element (`truncate` + `min-w-0`, full path on tap/hover; or drop the path from the copy entirely — the folder is discoverable elsewhere; simplest wins). (2) Shrink the copy per the no-wall-of-text rule: this empty state is two sentences of explainer prose. Gist it ("No worktrees yet" + one short line, e.g. "Agents create these when they start work"), with an info affordance only if truly needed.

### [P1/M] Pattern: unbroken strings (paths, URLs, IDs) rendered without overflow containment

- **Files:** pattern — audit-wide; known instance above; auditors' responsive/states reports carry more.
- **Evidence:** The codebase renders many paths/URLs/session IDs inline. Any of them can blow out a container on narrow screens.
- **Recommendation:** Sweep every render of a path/URL/ID; contain each via `path-breadcrumb`/`truncated-output` primitives or `truncate`+`min-w-0`; page body must never scroll horizontally. Charter lens 8 now carries the binding rule (auto-P1).
