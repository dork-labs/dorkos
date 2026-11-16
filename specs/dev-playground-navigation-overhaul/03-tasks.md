# Dev Playground Navigation Overhaul — Task Breakdown

**Spec:** `specs/dev-playground-navigation-overhaul/02-specification.md`
**Generated:** 2026-03-16
**Mode:** Full

---

## Phase 1: Registry + Scrollspy TOC

### Task 1.1 — Create playground section registry

**Size:** Medium | **Priority:** High | **Dependencies:** None | **Parallel with:** 1.2

Create the static typed registry of all playground sections at `apps/client/src/dev/playground-registry.ts`. This is the foundation data structure for both the TOC sidebar and the Cmd+K search. Exports `Page` type, `PlaygroundSection` interface, and per-page section arrays (`TOKENS_SECTIONS`, `COMPONENTS_SECTIONS`, `CHAT_SECTIONS`) plus `PLAYGROUND_REGISTRY` (the union of all). Includes unit tests validating uniqueness of IDs, anchor pattern conformance, and registry completeness.

### Task 1.2 — Create scrollspy TOC hook and add scroll-mt-14 to PlaygroundSection

**Size:** Medium | **Priority:** High | **Dependencies:** None | **Parallel with:** 1.1

Create the `useTocScrollspy` IntersectionObserver hook at `apps/client/src/dev/lib/use-toc-scrollspy.ts`. The hook tracks which section is currently visible using `rootMargin: '-48px 0px -60% 0px'` and returns the topmost intersecting section ID. Also add `scroll-mt-14` to `PlaygroundSection.tsx` to account for the sticky header height. Includes unit tests with mocked IntersectionObserver.

### Task 1.3 — Create TocSidebar component and integrate into pages

**Size:** Large | **Priority:** High | **Dependencies:** 1.1, 1.2

Create the `TocSidebar` component at `apps/client/src/dev/TocSidebar.tsx` — a sticky right-side aside showing all sections for the current page with active highlighting. Integrate it into all three page components (`ComponentsPage`, `ChatPage`, `TokensPage`) by wrapping existing content in a flex layout (`flex gap-6`) with the TOC on the right. Each page calls `useTocScrollspy` with its section IDs. TOC is hidden below `xl` (1280px) breakpoint. Includes component tests for rendering, active styling, and empty state.

---

## Phase 2: Cmd+K Search

### Task 2.1 — Create PlaygroundSearch command palette dialog

**Size:** Medium | **Priority:** High | **Dependencies:** 1.1

Create the `PlaygroundSearch` component at `apps/client/src/dev/PlaygroundSearch.tsx` using shadcn `Command` + `ResponsiveDialog`. Displays all sections grouped by page (Design Tokens, Components, Chat UI) with fuzzy search via `cmdk`'s built-in filter. Each item shows the section title and category. Selecting an item fires `onNavigate(page, sectionId)` and closes the dialog. Includes component tests for rendering, grouping, and selection behavior.

### Task 2.2 — Integrate Cmd+K search into DevPlayground shell

**Size:** Medium | **Priority:** High | **Dependencies:** 2.1

Add Cmd+K (Mac) / Ctrl+K keyboard shortcut handler to `DevPlayground.tsx`, a search trigger button in the header bar (right-aligned with magnifying glass icon and `⌘K` hint), and the navigate-and-scroll behavior. The `handleNavigate` callback sets the page, updates the URL with hash fragment, and uses `requestAnimationFrame` + `setTimeout(50)` to scroll to the target section after React renders. Also updates the `Page` type to use the registry's type (which includes `'overview'`).

---

## Phase 3: Landing Page + Deep Linking

### Task 3.1 — Create OverviewPage landing page

**Size:** Medium | **Priority:** Medium | **Dependencies:** 1.1 | **Parallel with:** 3.2

Create the `OverviewPage` component at `apps/client/src/dev/pages/OverviewPage.tsx`. Displays 3 category cards (Design Tokens, Components, Chat UI) in a responsive grid. Each card shows an icon, label, description, and section count derived from the registry arrays. Clicking a card calls `onNavigate` with the page identifier. Includes component tests for rendering, section counts, and click behavior.

### Task 3.2 — Add overview page routing and URL hash deep linking to DevPlayground

**Size:** Medium | **Priority:** Medium | **Dependencies:** 2.2, 3.1

Update `DevPlayground.tsx` to support the overview page at `/dev` (replacing the tokens-page default), add hash-based deep linking on initial load, and update routing logic. Replace `getPageFromPath()` with `getRouteFromPath()` that parses both pathname and hash fragment. Add a `useEffect` that scrolls to the anchor after page render. Render `OverviewPage` for the overview route. Browser back/forward continues to work correctly.

---

## Dependency Graph

```
1.1 ──┬──> 1.3 ──> (Phase 1 complete)
1.2 ──┘
1.1 ──> 2.1 ──> 2.2 ──> (Phase 2 complete)
1.1 ──> 3.1 ──┬──> 3.2 ──> (Phase 3 complete)
2.2 ──────────┘
```

## Summary

| Phase                           | Tasks | New Files                                                                             | Modified Files                                                                  |
| ------------------------------- | ----- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 1 — Registry + Scrollspy TOC    | 3     | `playground-registry.ts`, `lib/use-toc-scrollspy.ts`, `TocSidebar.tsx` + 3 test files | `PlaygroundSection.tsx`, `ComponentsPage.tsx`, `ChatPage.tsx`, `TokensPage.tsx` |
| 2 — Cmd+K Search                | 2     | `PlaygroundSearch.tsx` + 1 test file                                                  | `DevPlayground.tsx`                                                             |
| 3 — Landing Page + Deep Linking | 2     | `pages/OverviewPage.tsx` + 1 test file                                                | `DevPlayground.tsx`                                                             |
| **Total**                       | **7** | **7 source + 5 test files**                                                           | **6 files**                                                                     |
