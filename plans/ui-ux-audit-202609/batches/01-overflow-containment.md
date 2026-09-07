[← Findings index](../01-findings.md) · [charter](../00-charter.md) — annotate a finding in place, right under it; see [where new material goes](../01-findings.md#where-new-material-goes).

## Batch 1 — Overflow containment

**Priority P1 · 7 findings · 6S · 1M**
**Scope:** every surface that renders a path, URL, id or long label without deliberate containment. One PR; the sweep item may split out.

The charter makes this automatic-P1: no content may escape its container or cause page-level horizontal scroll. All six concrete instances share one root cause — a long unbroken string in a flex row whose ancestors never got `min-w-0`, or a `truncate` applied to two siblings competing for the same space.

### 1.1 — Workspaces empty state: the workspace path escapes the card and the page

**P1 · S · lenses 8 + 11 (operator-confirmed)**
`apps/client/src/layers/widgets/workspaces/ui/WorkspacesPage.tsx:197-205`

**Evidence.** The "No worktrees yet" card interpolates the root path inline into body prose: ``{root ? ` in ${shortenHomePath(root)}` : ''}`` inside a plain `<p className="text-muted-foreground mt-1 text-sm">`. A filesystem path has no spaces, so the browser has no wrap opportunity. At 390×844 the string `~/Keep/dork-os/dorkos/apps/desktop/.temp/.dork/wo…` runs past the card's right edge and off the viewport, causing page-level horizontal scroll. Confirmed live by the operator with a screenshot, and independently reproduced by the mobile browser pass (`workspaces-phone.png`).

**Recommendation.** Simplest wins: drop the path from the sentence entirely — the folder is discoverable elsewhere on this page. If it stays, render it on its own line in a truncating element (`truncate` + `min-w-0` on every flex ancestor, full value on hover/tap) or use the shared `path-breadcrumb` primitive. Do not rely on `break-all` in running prose; it reads badly mid-sentence.

### 1.2 — Marketplace cards: author and source both crush to single characters, on all 303 cards

**P1 · S · lens 8**
`apps/client/src/layers/features/marketplace/ui/PackageCard.tsx:153-179`

**Evidence.** The metadata row renders `authorLabel` and `pkg.marketplace` as two siblings, each `min-w-0 truncate`, with only the separator and icons `shrink-0`. Flex distributes negative space in proportion to each item's _natural_ width, so both get crushed together. At 1440×900 with the right rail open, the featured rail reads `D... · dork...` and the 4-column grid reads `C... · d`. This is the default rendering for the whole catalogue, not an edge case. The component's own doc comment says this line exists so a reader "can tell a DorkOS package from a borrowed one"; today it cannot be read at all.

**Recommendation.** Reserve a floor for each side (`min-w-[3.5rem]`, or a fixed 60/40 basis split), or show one fact on narrow cards — author _or_ source — with the other in the detail sheet. Verify at the card width this grid actually produces at 1440px with the rail open, not at full bleed. Pairs with finding 2.2, which is the same grid measuring the wrong box.

### 1.3 — Command palette "Recent": the item's own name truncates harder than its path

**P2 · S · lens 8**
`apps/client/src/layers/entities/agent/ui/AgentOptionRow.tsx:49-70`

**Evidence.** ⌘K renders `Dork...  ~/Keep/dork-os/dorkos/apps/desktop/.temp/.dork/agents/dor...` — "DorkBot" (7 characters) cut to 4 while the secondary path shows ~55. `name` is `flex-auto` (grow 1, basis auto) and `secondary` is shrink-only. The inline comment at lines 51-59 explains the choice was to stop `name` vanishing against a 0-basis sibling, which it does — but proportional shrink means the short important label loses a large _fraction_ while the long path loses a large _absolute_ amount and still has room. The hierarchy inverts: the thing the user is scanning for is the thing that disappears.

**Recommendation.** Give `name` a floor it cannot cross before `secondary` yields more — `min-w-[8ch]` on the name span, or `shrink-0` on `name` plus a `max-w-*` cap on `secondary`. The path is provenance; it should yield first.

### 1.4 — Team card: "On this machine" truncates mid-word inside a card with room for it

**P2 · S · lens 8**
`apps/client/src/layers/features/team-roster/ui/TeamMemberCard.tsx:351`, `apps/client/src/layers/features/team-roster/ui/TeamRosterGrid.tsx:18`

**Evidence.** `/team` in Cards view at 1440×900 with a two-person roster renders the "You" card's secondary line as `On this ma...` — 16 characters cut well before the card's visible right edge. The class is `text-muted-foreground mt-1.5 truncate text-xs` at `md:grid-cols-2`; something upstream is starving the text column of width rather than the string being genuinely too long.

**Recommendation.** Measure the text column's computed width at `md` and find the fixed-width ancestor blocking it (a missing `min-w-0` is the usual culprit). This is a diagnosis-then-one-class fix, not a restyle.

> **Not reproducible — no fix owed (DOR-1817, re-checked 2026-09-06).** Batch 01 (DOR-1747, PR #1524) shipped every other finding in this batch and left this one alone because it could not reproduce it; the annotation never landed, which is what this note repairs. Re-measured live on `/team` in Cards view at 1440×900: the "On this machine" line renders whole — `clientWidth` 268px, `scrollWidth` 268px, no truncation — inside a 348px card, and the page causes no horizontal scroll (`documentElement.scrollWidth` 1440 = `clientWidth` 1440). The text column already carries `min-w-0 flex-1` (`TeamMemberCard.tsx:327`), so there is no fixed-width ancestor to find. Measured with a 25-member roster rather than the audit's two-person one; the grid template is `xl:grid-cols-3` (`TeamRosterGrid.tsx:25`), whose column width does not depend on how many cards fill it, so the sparse case is the same 348px. Left on the record as observed once and not since.

### 1.5 — Settings → Appearance: the font description hard-clips mid-word with no ellipsis

**P3 · S · lens 8**
`apps/client/src/layers/features/settings/ui/tabs/AppearanceTab.tsx:63-71`

**Evidence.** The Font Family trigger shows "Inter + JetBrains Mor" — the intended string (`font-config.ts:39`) is "Inter + JetBrains Mono". `SelectTrigger className="w-40"` (160px) is too narrow for the stacked value plus description, and the description span carries no `truncate`/`overflow-hidden`, so the browser clips at the container edge mid-character with no ellipsis.

**Recommendation.** Add `truncate` to the description span so it degrades to `…`, or widen the trigger. Clipping without an ellipsis reads as a rendering bug, not as a design decision.

### 1.6 — Marketplace search placeholder clips on phone; the `/` hint it makes room for is meaningless on touch

**P2 · S · lens 8**
`apps/client/src/layers/features/marketplace/ui/MarketplaceToolbar.tsx:165-177`

**Evidence.** At 390×844 the placeholder renders as "Search packag" with no ellipsis. The input reserves `pl-9` for the icon and `pr-10` for a `<kbd>/</kbd>` shortcut badge, inside a field already sharing the row with a `w-32 shrink-0` sort `Select`. A touchscreen has no keyboard-shortcut context, so the badge eats width from the one string every visitor needs to read.

**Recommendation.** Charter adaptive strategy (c) — hide the `<kbd>` below the `isMobile` breakpoint. That alone reclaims enough width for the full placeholder at 390px without touching the `Select`.

### 1.7 — Sweep: every path, URL and id render needs deliberate containment

**P1 · M · lens 8 (operator-directed)**
Pattern, app-wide. Known instances: 1.1 above; `AgentOptionRow.tsx` (1.3); session ids and branch names throughout `entities/session`, `features/workspaces`, `features/relay`.

**Evidence.** The codebase renders many unbroken strings inline. Any of them can blow out a container on a narrow screen; two already do. The shared primitives that solve this (`shared/ui/path-breadcrumb.tsx`, `shared/ui/truncated-output.tsx`) exist and are under-used.

**Recommendation.** Sweep every render of a path, URL, session id or branch name. Contain each with `path-breadcrumb`/`truncated-output` where they fit, or `truncate` + `min-w-0` on the flex ancestors. Add a browser assertion that the page body never scrolls horizontally at 390px on each main route, so the class of defect cannot regrow.
