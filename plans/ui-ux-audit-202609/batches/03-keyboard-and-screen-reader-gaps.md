[← Findings index](../01-findings.md) · [charter](../00-charter.md) — annotate a finding in place, right under it; see [where new material goes](../01-findings.md#where-new-material-goes).

## Batch 3 — Keyboard and screen-reader gaps

**Priority P1 · 5 findings · 4S · 1M**
**Scope:** controls that are reachable but unusable by keyboard, or that speak the wrong thing. Two shared primitives, one feature card, two sweeps.

### 3.1 — `FilterBarSort`'s direction toggle is keyboard-unreachable, nested inside another button

**P1 · S · lenses 2 + 9**
`apps/client/src/layers/shared/ui/filter-bar/FilterBarSort.tsx:37-61`

**Evidence.** Verified in source. Inside `DropdownMenuTrigger` — which Radix renders as a real `<button>` — sits a `<span role="button" tabIndex={-1}>` carrying `onClick`, a full Enter/Space `onKeyDown`, and an `aria-label`. Two defects compound: (a) a button nested in a button is invalid HTML that browsers unnest unpredictably; (b) `tabIndex={-1}` means focus can never land there, so the `onKeyDown` it carries can never fire, and the Enter/Space that does reach the trigger is consumed by Radix to open the menu. **Reversing a sort has no keyboard path at all**, on a shared control backing the toolbars of `/tasks`, `/team` and `/activity`.

**Recommendation.** Split the controls. Render the trigger with `asChild` over `<Button variant="outline" size="xs">` for "Sort: {label}", and put the direction toggle _beside_ it as its own `<Button variant="ghost" size="icon-xs" aria-label=…>` sibling. Both then get a real tab stop, the shared focus ring, and the responsive touch height.

### 3.2 — Schedule template cards speak the entire prompt as the button's accessible name

**P1 · S · lens 9**
`apps/client/src/layers/features/tasks/ui/TaskTemplateCard.tsx:58-97` (line 95 specifically)

**Evidence.** Playwright's accessibility snapshot on `/tasks` shows each preset button's accessible name is name + description + cron + the **entire** prompt, e.g. _"activity-summary Summarize recent agent activity across all sessions Every weekday at 6:00 PM Summarize today's agent activity: 1. List sessions that were active today 2. Note any errors or failures 3. Highlight completed tasks…"_. The prompt is rendered with `line-clamp-2`, which is visual-only — the full text stays in the DOM and joins the enclosing `<button>`'s name because nothing overrides it. A screen-reader user tabbing this list hears the whole paragraph, four times.

**Recommendation.** Give the button a concise `aria-label` (`` `${preset.name}: ${preset.description}` ``) and mark the cron line and prompt preview `aria-hidden`. Never let visually-truncated content still speak in full.

### 3.3 — `LinkSafetyModal` claims `aria-modal` without focus trap, focus restore, scroll lock or working Escape

**P1 · M · lens 2**
`apps/client/src/layers/shared/ui/link-safety-modal.tsx:52-125`; compare `apps/client/src/layers/shared/ui/dialog.tsx:27-48`

**Evidence.** Verified in source. The app's single link-confirmation surface — reached from every markdown link in every answer, from gen-UI `url` actions and from MCP App iframes — is a bare `createPortal` into `document.body`: a `<div className="fixed inset-0 …">`, an `aria-hidden` backdrop `<div onClick={onClose}>`, and a `<div role="dialog" aria-modal="true" tabIndex={-1} onKeyDown={…}>`. Nothing ever calls `.focus()` on the container and there is no `autoFocus`, so a keyboard user who activates a link keeps focus on the anchor **behind** the overlay: Escape never reaches the handler, Tab walks the page underneath, and there is no scroll lock or focus restore. `aria-modal="true"` is a claim the markup does not keep. The file's own docblock justifies only the _portalling_ ("to escape transform-based containing blocks"), which `DialogPortal` also provides; nothing in `decisions/` requires a hand-rolled dialog here.

**Recommendation.** Re-express as `<Dialog open onOpenChange>` + `<DialogContent>` with `DialogTitle`/`DialogDescription` carrying the `title`/`detail` strings it already computes, keeping the `LinkSafetyModalProps` signature unchanged so the three call sites do not move. The three hand-rolled buttons become `<Button>`s (see 14.5). No visual change intended — the same box, with the behaviour it already claims.

### 3.4 — Hand-rolled controls fall back to Chromium's native focus ring

**P2 · S · lens 9**
`apps/client/src/layers/features/right-panel/ui/RightPanelHeader.tsx:260-277`, `apps/client/src/layers/features/status/ui/RuntimeItem.tsx:180`, `ModelConfigPopover.tsx:225`, `PlanModeItem.tsx:42`, `PermissionModeItem.tsx:162`, `apps/client/src/layers/features/tasks/ui/TaskTemplateCard.tsx:64-72`, `apps/client/src/layers/features/mesh/ui/AdapterNode.tsx:154-168`

**Evidence.** Verified live by real `Tab` traversal, not static reading. Focusing the `/session` right-panel "Files" tab and reading `getComputedStyle(document.activeElement)` returns `outline: auto 1px rgb(0, 95, 204)` — Chromium's native blue, not the app's `focus-visible:ring-ring/50 ring-[3px]`. The adjacent "Close panel" icon button shows the custom ring correctly, so the contrast is visible in one screenshot. `RightPanelHeader` re-implements a tab strip from bare `<button role="tab">` instead of reusing `shared/ui/tabs.tsx:26-42`, which already gets this right (confirmed on the Marketplace Browse/Installed toggle). The four `status/ui/*` files each hand-copy the identical class string `'hover:text-foreground inline-flex min-w-0 … transition-colors duration-150'` with no focus treatment. `TaskTemplateCard`'s `cn()` (verified) has `hover:bg-accent/50` and no `focus-visible:` anywhere. `AdapterNode`'s "Add adapter" ghost node has `hover:opacity-70` and no focus twin despite being `role="button" tabIndex={0}` with an Enter/Space handler.

**Recommendation.** For the right-panel strip, adopt the shared `Tabs`/`TabsTrigger` primitive. For the four `status/ui/*` files, extract the duplicated string into one shared constant and add `focus-visible:ring-ring/50 focus-visible:ring-[3px]` once. For `TaskTemplateCard` and `AdapterNode`, add the `focus-ring` utility from `index.css`. Keyboard users currently lose the app's focus language on exactly the surfaces that gate real actions.

### 3.5 — Bare `focus:` rings in five shared primitives fire on mouse click

**P2 · S · lens 2**
`apps/client/src/layers/shared/ui/badge.tsx:6`, `dialog.tsx:41`, `sheet.tsx:76`, `responsive-dialog.tsx:223`, `select.tsx:23`

**Evidence.** Verified in source — `badge.tsx` carries `focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2`, `sheet.tsx`'s close button `focus:ring-2 focus:ring-offset-2 focus:outline-hidden`. `.claude/rules/components.md` §Required Patterns is explicit: "**Focus styles**: `focus-visible:` (keyboard only), never bare `focus:`." Everything else in the folder already complies. A bare `focus:` ring paints on every mouse click — chrome at rest, which `design-system.md` §Anti-Patterns rules out — and it is a path-rule violation, binding under Hard Rule 8.

**Recommendation.** Mechanical swap to `focus-visible:` in those five class strings. The dialog and sheet close buttons should become `<Button variant="ghost" size="icon-sm" asChild>` per 14.5, which fixes them for free.
