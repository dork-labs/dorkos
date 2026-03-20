---
title: 'Dev Playground Navigation Overhaul — Scrollspy TOC, Cmd+K Search, Page Organization, Landing Page'
date: 2026-03-16
type: external-best-practices
status: active
tags:
  [
    dev-playground,
    scrollspy,
    IntersectionObserver,
    cmdk,
    command-palette,
    design-system,
    navigation,
    shadcn,
    react,
  ]
feature_slug: dev-playground-navigation-overhaul
searches_performed: 9
sources_count: 22
---

# Dev Playground Navigation Overhaul

## Research Summary

The DorkOS Dev Playground currently has 3 sidebar items (Tokens, Components, Chat) hiding ~45 `PlaygroundSection`s across two mega-pages. The research covers four areas: (1) scrollspy TOC sidebar using `IntersectionObserver`, (2) Cmd+K fuzzy search using the already-installed `cmdk`/shadcn `Command` component, (3) page organization strategy (mega-page vs. category pages vs. per-component), and (4) landing/overview page patterns. The recommended approach is: **keep the two mega-pages but add a sticky right-side TOC** (IntersectionObserver, no library needed), **add Cmd+K search** over a flat registry of all section titles + keywords, and **add a landing page** as the default `/dev` route with a category-card grid.

---

## Current State Audit

### Pages and Section Counts

| Page                           | Showcase Files                                                                           | Sections     |
| ------------------------------ | ---------------------------------------------------------------------------------------- | ------------ |
| Components (`/dev/components`) | ButtonShowcases, FormShowcases, FeedbackShowcases, NavigationShowcases, OverlayShowcases | 19 sections  |
| Chat (`/dev/chat`)             | MessageShowcases, ToolShowcases, InputShowcases, StatusShowcases, MiscShowcases          | 26 sections  |
| Tokens (`/dev/tokens`)         | Inline TokensPage                                                                        | 4–5 sections |

Total: ~48 `PlaygroundSection` sections across 2 long-scroll pages + 1 token page.

### Current Navigation Architecture

`DevPlayground.tsx` holds a `Page` union type (`'tokens' | 'components' | 'chat'`) and uses `history.pushState` for simple SPA routing. The `PlaygroundSection` component already generates `id={title.toLowerCase().replace(/\s+/g, '-')}` anchor IDs on every `<section>` element — this is the exact hook needed for scrollspy without any refactoring.

---

## Key Findings

### 1. Scrollspy TOC Sidebar

**The definitive pattern: IntersectionObserver with negative rootMargin.**

Best-in-class docs sites (Fumadocs, Tailwind CSS, shadcn/ui, Radix UI) all implement TOC scrollspy via `IntersectionObserver` — never scroll event listeners. The key reasons:

- Scroll listeners run on the main thread; `IntersectionObserver` runs asynchronously off-thread. No throttling needed, no jank.
- The `rootMargin` parameter provides fine control over "when" a section counts as active without any scroll position math.
- The pattern is ~40 lines of code with no library dependency.

**The critical rootMargin setting:**

```ts
const observer = new IntersectionObserver(
  (entries) => {
    /* ... */
  },
  {
    // Offset for the sticky playground header (36px) plus breathing room.
    // Bottom margin keeps sections at the very bottom of viewport from activating.
    rootMargin: '-48px 0px -60% 0px',
    threshold: 0,
  }
);
```

This means: a section becomes "active" only when its top edge is within 48px below the viewport top and the bottom 60% of the viewport doesn't count. This prevents rapid flickering as sections scroll through the viewport.

**Active section tracking (single-active variant):**

Fumadocs uses a `single: true` mode that only accepts one active item at a time. This is the right choice for a narrow TOC sidebar — showing multiple simultaneously-active items creates visual noise.

The correct algorithm: maintain a `Map<string, boolean>` (sectionId → isIntersecting). In the observer callback, update the map, then find the **first** entry in document order that is currently intersecting. This preserves "top wins" behavior.

```ts
function useActiveSection(sectionIds: string[]) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const intersectingRef = useRef(new Set<string>());

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            intersectingRef.current.add(entry.target.id);
          } else {
            intersectingRef.current.delete(entry.target.id);
          }
        });
        // First ID in document order that is currently intersecting
        const first = sectionIds.find((id) => intersectingRef.current.has(id));
        setActiveId(first ?? null);
      },
      { rootMargin: '-48px 0px -60% 0px', threshold: 0 }
    );

    sectionIds.forEach((id) => {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    });

    return () => observer.disconnect();
  }, [sectionIds]);

  return activeId;
}
```

**Smooth scroll-to-section:**

The `PlaygroundSection` component already produces anchor IDs. Clicking a TOC item should use `el.scrollIntoView({ behavior: 'smooth', block: 'start' })` with an offset for the sticky header via `scroll-margin-top` CSS:

```css
/* Applied to all PlaygroundSection <section> elements */
section[id] {
  scroll-margin-top: 56px; /* height of playground header */
}
```

Or applied via Tailwind: add `scroll-mt-14` to the `<section>` in `PlaygroundSection.tsx`.

**Layout: right-side TOC vs. left-side sub-nav:**

Radix UI, Tailwind CSS, shadcn/ui, and Fumadocs all use a **right-side TOC** for on-page section navigation and a **left sidebar** for cross-page navigation. This is the correct pattern. The left sidebar stays at the page/category level; the right TOC handles in-page anchors. Width: 180–220px is the standard. On narrower viewports (<1280px), hide the right TOC and replace with an inline "On this page" collapse at the top of content.

### 2. Component Search (Cmd+K)

**Pre-existing research confirms:** The `cmdk` library is already installed as the shadcn `Command` component at `layers/shared/ui/command.tsx`. A `CommandDialog` with Cmd+K binding is the correct implementation — zero new dependencies needed.

**Data structure for the component registry:**

The search target is "playground sections," not pages. Each section should be a `SearchItem`:

```ts
interface PlaygroundSearchItem {
  id: string; // anchor ID, e.g. 'tool-call-card'
  title: string; // Display name, e.g. 'ToolCallCard'
  page: Page; // 'components' | 'chat' | 'tokens'
  category: string; // Showcase group, e.g. 'Tools', 'Form', 'Feedback'
  keywords: string[]; // Aliases: ['tool', 'call', 'approval', 'function']
}
```

This flat array is defined **statically** — not derived at runtime from DOM queries. Each showcase file exports its sections as a `const` alongside the component:

```ts
// ButtonShowcases.tsx
export const BUTTON_SEARCH_ITEMS: PlaygroundSearchItem[] = [
  {
    id: 'button',
    title: 'Button',
    page: 'components',
    category: 'Actions',
    keywords: ['btn', 'click', 'primary', 'secondary', 'destructive', 'ghost'],
  },
  {
    id: 'badge',
    title: 'Badge',
    page: 'components',
    category: 'Actions',
    keywords: ['label', 'tag', 'status', 'pill'],
  },
  // ...
];
```

A root `PLAYGROUND_REGISTRY` array merges all exported arrays. The `cmdk` filter function handles fuzzy matching internally — no uFuzzy or Fuse.js needed for ~50 items. The `keywords` prop on `CommandItem` provides alias matching.

**Grouping in the palette:**

```
[ Search... ]
─────────────
COMPONENTS
  Button
  Badge
  Input
  ...
CHAT
  ToolCallCard
  ChatInput
  ...
TOKENS
  Colors
  Typography
  ...
```

On item select: call `navigateTo(item.page)` then `setTimeout(() => document.getElementById(item.id)?.scrollIntoView({ behavior: 'smooth' }), 100)`. The timeout allows the page to render before scrolling.

**Where to mount the Cmd+K handler:** In `DevPlayground.tsx` at the shell level — same component that controls `page` state. This is the correct place since the palette needs access to `navigateTo`.

### 3. Page Organization Patterns

**Current vs. alternatives:**

| Approach                                      | Description                              | Pros                                                         | Cons                                                                                    |
| --------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| **A: Mega-page (current)**                    | All sections in one scroll               | Simple code, easy to add new sections                        | No way to jump to specific section; TOC sidebar becomes critical                        |
| **B: Category sub-pages**                     | Each showcase file becomes its own route | Shorter pages, focused context                               | 10+ routes to maintain; cross-category navigation harder; breaks current simple routing |
| **C: Per-component pages**                    | One page per `PlaygroundSection`         | Deep linking is trivial; matches Radix/shadcn docs structure | ~50 route entries; massive overhead for a dev-only tool                                 |
| **D: Mega-page + TOC + search (recommended)** | Keep mega-pages, add right TOC and Cmd+K | Best DX, minimal code change, leverages existing anchor IDs  | Right TOC needs ~180px width; requires 1280px+ for 3-column layout                      |

**The sweet spot: Approach D.** The reference case is the shadcn/ui docs "Components" page — all 50+ components on one page with a left sidebar for page selection and a right TOC for in-page navigation. This is the standard for design system galleries. Radix UI Primitives follows the same pattern.

The DorkOS playground has ~48 sections across 2 pages. This is well within the range where a single mega-page with TOC works perfectly. Category sub-pages would be justified only if sections grew to 100+ per page.

**Deep linking via URL hash:** The current `history.pushState` approach can be extended to support hash fragments: `/dev/components#tool-call-card`. This enables direct links to specific components. Implementation: parse `window.location.hash` on load, navigate to the right page, then scroll to the anchor after a brief delay.

**Proposed URL structure:**

- `/dev` — Landing/overview page (new)
- `/dev/tokens` — Token reference (existing)
- `/dev/components` — Component gallery (existing, + right TOC)
- `/dev/components#button` — Deep link to Button section
- `/dev/chat` — Chat component gallery (existing, + right TOC)
- `/dev/chat#tool-call-card` — Deep link to ToolCallCard section

### 4. Landing/Overview Page

**Pattern analysis from best-in-class:**

The Component Gallery (component.gallery) uses a **category-card grid** as its homepage: component names as cards with brief descriptions, grouped by type. Storybook uses a **visual thumbnail grid** showing rendered screenshots. shadcn/ui uses a flat alphabetical list with descriptions.

For a developer playground (internal tool, not marketing), the most useful landing page is a **category card grid** with counts:

```
┌─────────────────────────────────────────────────────┐
│  DorkOS Dev Playground                               │
│  Interactive component gallery and design system.    │
├──────────────────┬──────────────────┬───────────────┤
│  Design Tokens   │  Components      │  Chat UI      │
│  Colors, type,   │  Buttons, forms, │  Messages,    │
│  spacing, radius │  overlays, nav   │  tools, input │
│  5 sections →    │  19 sections →   │  26 sections →│
├──────────────────┴──────────────────┴───────────────┤
│  Quick Jump: [Button] [ToolCallCard] [ChatInput] ... │
└─────────────────────────────────────────────────────┘
```

Key elements:

1. **Category cards** — clickable, each card links to a page. Show section count and category description.
2. **Quick Jump chips** — the 6–8 most recently accessed or most important sections as direct deep-link chips below the grid. This is the "frecency" concept applied to a landing page.
3. **Recent changes indicator** — optional: a "Recently Updated" section showing the last 3 sections modified. Useful for design system maintenance. Keep it optional/v2.

**Visual vs. text:** At this scale (~50 sections), visual component thumbnails (like Storybook) are overengineered for a dev-only internal tool. Text cards with brief descriptions and section counts are sufficient and much faster to maintain.

---

## Detailed Analysis

### Scrollspy TOC Layout

The three-column layout for a page with right TOC:

```
┌──────────────┬──────────────────────────────┬──────────────┐
│  Left        │  Content Area                │  Right TOC   │
│  Sidebar     │  max-w-[680px]               │  180px       │
│  (shadcn     │                              │  sticky      │
│   Sidebar)   │  PlaygroundSections...       │  top-12      │
│              │                              │  On this page│
│              │                              │  • Button    │
│              │                              │  • Badge [•] │  ← active
│              │                              │  • Input     │
└──────────────┴──────────────────────────────┴──────────────┘
```

At 1280px viewport width:

- Left sidebar: 240px (shadcn Sidebar default)
- Content: ~860px (takes remaining space)
- Right TOC: 200px (sticky)

At <1280px: hide right TOC, show inline "On this page" collapse/accordion at top of page content.

The right TOC should live inside `SidebarInset` as an `<aside>` with `position: sticky; top: 48px` (below the header bar). A clean implementation is a flex row inside `SidebarInset`: `<div className="flex gap-6"><main className="min-w-0 flex-1">...</main><aside className="hidden w-48 shrink-0 xl:block">...</aside></div>`.

### Cmd+K Search Implementation

The palette should open from a search trigger in the playground header bar (a `<button>` with placeholder text "Search components... ⌘K") in addition to the keyboard shortcut. This is the Linear/Vercel pattern — the visible input hint teaches the shortcut.

```tsx
// In DevPlayground.tsx header area
<button
  onClick={() => setSearchOpen(true)}
  className="text-muted-foreground hover:bg-accent flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs"
>
  <Search className="size-3" />
  Search components...
  <Kbd className="ml-2">⌘K</Kbd>
</button>
```

The `CommandDialog` itself:

```tsx
<CommandDialog open={searchOpen} onOpenChange={setSearchOpen}>
  <CommandInput placeholder="Search components and sections..." />
  <CommandList>
    <CommandEmpty>No results.</CommandEmpty>
    {Object.entries(groupedRegistry).map(([category, items]) => (
      <CommandGroup key={category} heading={category}>
        {items.map((item) => (
          <CommandItem
            key={item.id}
            value={item.title}
            keywords={item.keywords}
            onSelect={() => {
              setSearchOpen(false);
              navigateTo(item.page);
              // Small delay to let page render, then scroll to section
              setTimeout(() => {
                document.getElementById(item.id)?.scrollIntoView({
                  behavior: 'smooth',
                  block: 'start',
                });
              }, 100);
            }}
          >
            <item.icon className="size-4" />
            {item.title}
            <CommandShortcut>{item.category}</CommandShortcut>
          </CommandItem>
        ))}
      </CommandGroup>
    ))}
  </CommandList>
</CommandDialog>
```

### Page Organization: Recommended Sub-nav Structure

Rather than the current flat 3-item sidebar, expand the left sidebar to show section-level nav items within each page as a collapsible sub-menu. This is the Radix UI / shadcn docs sidebar pattern:

```
Design System
  Tokens
  Components
    ├── Buttons & Actions
    ├── Form Controls
    ├── Feedback
    ├── Navigation
    └── Overlays
Features
  Chat
    ├── Messages
    ├── Tools
    ├── Input
    ├── Status
    └── Misc
```

This is the correct balance: the sidebar provides category navigation, the right TOC provides in-section navigation. Clicking a sub-item in the sidebar navigates to the page AND scrolls to the section group.

The sidebar items become `SidebarMenuSub` items using the shadcn Sidebar's built-in collapsible support — no new components needed.

---

## Recommended Implementation Plan

### Phase 1: Right TOC Sidebar (Highest Impact, Low Complexity)

1. Add `scroll-mt-14` to `PlaygroundSection.tsx`'s `<section>` element (1 line change).
2. Create `useTocScrollspy(sectionIds: string[])` hook in `apps/client/src/dev/lib/use-toc-scrollspy.ts`.
3. Create `TocSidebar` component in `apps/client/src/dev/TocSidebar.tsx`.
4. Wrap page content in `ComponentsPage` and `ChatPage` with the 2-column flex layout.
5. The TOC items come from a `const TOC_SECTIONS` export in each showcase file listing `{ id, title }` pairs.

**Complexity:** Low. ~150 lines of new code. No new dependencies.

### Phase 2: Cmd+K Search (Medium Complexity)

1. Add `SEARCH_ITEMS` constant exports to each showcase file (statically defined).
2. Create `PLAYGROUND_REGISTRY` in `apps/client/src/dev/playground-registry.ts` that merges all exports.
3. Add `PlaygroundSearch` component (`CommandDialog`) in `apps/client/src/dev/PlaygroundSearch.tsx`.
4. Mount in `DevPlayground.tsx` with Cmd+K keyboard handler.
5. Add search trigger button to the header bar.

**Complexity:** Low-Medium. ~200 lines of new code. No new dependencies (cmdk already installed).

### Phase 3: Landing Page (Medium Complexity)

1. Add `'overview'` to the `Page` union type.
2. Create `OverviewPage.tsx` with category cards and quick-jump chips.
3. Make `/dev` (no path suffix) show `OverviewPage` by default.
4. Update `getPageFromPath()` to return `'overview'` for the root `/dev` path.

**Complexity:** Low. ~100 lines of new code.

### Phase 4: Sub-nav Sidebar Expansion (Optional, Later)

1. Expand sidebar to show collapsible sub-items for each showcase group.
2. Clicking a sub-item navigates to page + scrolls to section group.
3. Active sub-item tracks via the same scrollspy hook.

**Complexity:** Medium. Requires restructuring the sidebar nav data model. Worth doing after phases 1–3 validate the TOC approach.

---

## Approach Comparison Table

| Feature            | Approach                         | Complexity | Recommendation     |
| ------------------ | -------------------------------- | ---------- | ------------------ |
| In-page navigation | Right TOC (IntersectionObserver) | Low        | **Recommended**    |
| In-page navigation | Left sub-nav expansion           | Medium     | Phase 4            |
| In-page navigation | Hash URL segments only           | Low        | Insufficient alone |
| Search             | Cmd+K with cmdk CommandDialog    | Low        | **Recommended**    |
| Search             | Inline filter input per page     | Low        | Fallback only      |
| Search             | URL query param ?q=              | Medium     | Not needed         |
| Page structure     | Keep mega-pages + TOC + search   | Low        | **Recommended**    |
| Page structure     | Split into category sub-pages    | Medium     | Not recommended    |
| Page structure     | Per-component routes             | High       | Not recommended    |
| Landing page       | Category card grid               | Low        | **Recommended**    |
| Landing page       | Visual screenshot thumbnails     | High       | Overengineered     |
| Landing page       | Plain list of links              | Very Low   | Too minimal        |

---

## Implementation Notes for DorkOS Codebase

### PlaygroundSection already has anchors — no refactoring needed

The anchor ID generation in `PlaygroundSection.tsx` is the exact hook needed:

```ts
const anchorId = title.toLowerCase().replace(/\s+/g, '-');
```

This produces IDs like `tool-call-card`, `chat-input`, `button`. The scrollspy hook can target these directly.

**One important addition:** add `scroll-mt-14` to the `<section>` element to account for the 36px playground header bar. Without this, scrollIntoView lands with the section title hidden behind the header.

### The REGISTRY pattern avoids runtime DOM queries

Never derive TOC items by querying the DOM for `h2` tags (the Fumadocs/MDX approach). In a React app with known static structure, define the registry statically alongside the components. This is faster, type-safe, and avoids `useEffect` timing issues.

### URL hash + page navigation

Extend `getPageFromPath()` to also read `window.location.hash` and store it separately. After page navigation, use a `useEffect` to scroll to the anchor once the page renders:

```ts
function getRouteFromPath(): { page: Page; anchor: string | null } {
  const path = window.location.pathname;
  const anchor = window.location.hash.slice(1) || null;
  // ...
}
```

### FSD placement

The dev playground is not part of the FSD layer hierarchy — it's entirely within `apps/client/src/dev/`. The `use-toc-scrollspy` hook, `TocSidebar`, `PlaygroundSearch`, and `OverviewPage` all live under `src/dev/` as dev-only utilities. No FSD imports restriction applies here.

---

## Research Gaps & Limitations

- Did not analyze the Tokens page in detail — it may benefit from the same TOC treatment (colors, typography, spacing, radius sections).
- Did not research animated TOC transitions (active item slide/highlight animation with motion). Likely warranted given the DorkOS design standard — worth adding smooth `animate` on active indicator.
- Deep-link URL sharing (`/dev/chat#tool-call-card`) is straightforward but the hash-scroll-after-navigation timing edge case needs testing (need to wait for React render before scrolling).

---

## Sources & Evidence

- "Scroll event listeners run on the main thread whereas Intersection Observers do not" — [Scrollspy Demystified by Maxime Heckel](https://blog.maximeheckel.com/posts/scrollspy-demystified/)
- rootMargin negative value technique for accounting for sticky headers — [CSS-Tricks: Table of Contents with IntersectionObserver](https://css-tricks.com/table-of-contents-with-intersectionobserver/)
- Fumadocs TOC API: `AnchorProvider`, `ScrollProvider`, `TOCItem` with `single` prop for single-active mode — [Fumadocs TOC docs](https://www.fumadocs.dev/docs/headless/components/toc)
- cmdk `keywords` prop for alias matching, `forceMount` for pinned items, `shouldFilter={false}` for external filtering — [existing research: research/20260303_command_palette_agent_centric_ux.md]
- shadcn/ui components page organizes 50+ components in a left sidebar with search — [shadcn/ui components](https://ui.shadcn.com/docs/components)
- Component Gallery uses ⌘K search (Pagefind), category organization, one page per component — [The Component Gallery](https://component.gallery/)
- CSS-Tricks sticky TOC with scrolling active states — [CSS-Tricks sticky TOC](https://css-tricks.com/sticky-table-of-contents-with-scrolling-active-states/)
- react-scrollspy patterns — [GitHub: react-scrollspy](https://github.com/toviszsolt/react-scrollspy)

## Search Methodology

- Searches performed: 9
- Most productive terms: "IntersectionObserver scrollspy sidebar TOC React rootMargin", "Fumadocs TOC scrollspy implementation", "cmdk command palette component search registry keywords"
- Primary sources: CSS-Tricks, Maxime Heckel's blog, Fumadocs docs, shadcn/ui docs, Component Gallery, prior DorkOS research
