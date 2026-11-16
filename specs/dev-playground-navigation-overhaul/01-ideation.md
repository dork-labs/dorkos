---
slug: dev-playground-navigation-overhaul
number: 143
created: 2026-03-16
status: ideation
---

# Dev Playground Navigation Overhaul

**Slug:** dev-playground-navigation-overhaul
**Author:** Claude Code
**Date:** 2026-03-16
**Branch:** preflight/dev-playground-navigation-overhaul

---

## 1) Intent & Assumptions

- **Task brief:** Redesign the Dev Playground navigation to transform it from a 3-item sidebar with blind-scrolling mega-pages into a world-class component gallery with instant section navigation, fuzzy search, and a useful landing page. The current playground hides ~48 component sections behind 2 long-scroll pages with no way to find, jump to, or search for anything.

- **Assumptions:**
  - The dev playground is a dev-only tool (tree-shaken from production builds)
  - The existing `PlaygroundSection` anchor ID system is the foundation — no need to change showcase files
  - The existing shadcn `Command` component and `cmdk` library are available (already installed)
  - The design should follow the same patterns as best-in-class docs sites (Radix, shadcn/ui, Tailwind)
  - No new npm dependencies are needed

- **Out of scope:**
  - Storybook-style visual screenshots/thumbnails of components
  - Per-component route pages (50+ routes is overengineered for a dev tool)
  - Splitting mega-pages into sub-pages (TOC + search solves the navigation problem)
  - View source / view props / API documentation features
  - Responsive mobile layout for the right TOC (hide on <1280px is sufficient)

---

## 2) Pre-reading Log

- `apps/client/src/dev/DevPlayground.tsx`: Main shell — 175 lines, SidebarProvider with 3 nav items (tokens, components, chat), `history.pushState` routing, theme toggle in footer
- `apps/client/src/dev/PlaygroundSection.tsx`: Section wrapper — generates anchor IDs via `title.toLowerCase().replace(/\s+/g, '-')`, includes hover `#` link. **Key: already has anchor IDs — this is the scrollspy hook.**
- `apps/client/src/dev/ShowcaseDemo.tsx`: Inset demo container with dashed border
- `apps/client/src/dev/ShowcaseLabel.tsx`: Uppercase muted sub-label
- `apps/client/src/dev/pages/TokensPage.tsx`: 336 lines, 8 inline sections (colors, typography, spacing, radii, shadows, sizes)
- `apps/client/src/dev/pages/ComponentsPage.tsx`: 27 lines — imports 5 showcase files (Button, Form, Feedback, Navigation, Overlay)
- `apps/client/src/dev/pages/ChatPage.tsx`: 27 lines — imports 5 showcase files (Message, Tool, Input, Status, Misc)
- `apps/client/src/dev/showcases/`: 10 showcase files, 1528 total lines, ~48 PlaygroundSection sections
- `apps/client/src/layers/features/command-palette/`: Existing Cmd+K implementation using cmdk/Fuse.js — reference pattern for search
- `apps/client/src/layers/shared/ui/command.tsx`: shadcn Command component (wraps cmdk) — available for reuse
- `apps/client/src/layers/shared/ui/sidebar.tsx`: shadcn Sidebar with SidebarMenuSub for collapsible items
- `apps/client/src/main.tsx`: Dev playground loaded via `React.lazy` when path starts with `/dev`
- `contributing/design-system.md`: 8pt grid, radius tokens, motion specs (100-300ms ease-out), color palette
- `contributing/animations.md`: motion/react patterns for UI animations

---

## 3) Codebase Map

**Primary components/modules:**

- `apps/client/src/dev/DevPlayground.tsx` — Shell layout, sidebar, routing state, theme toggle
- `apps/client/src/dev/PlaygroundSection.tsx` — Section card with anchor ID generation
- `apps/client/src/dev/pages/TokensPage.tsx` — Design tokens page (8 sections, inline)
- `apps/client/src/dev/pages/ComponentsPage.tsx` — Component gallery (5 showcase imports, 19 sections)
- `apps/client/src/dev/pages/ChatPage.tsx` — Chat component gallery (5 showcase imports, 26 sections)
- `apps/client/src/dev/showcases/*.tsx` — 10 showcase files with ~48 total sections

**Shared dependencies:**

- `@/layers/shared/ui` — Sidebar*, ScrollArea, Command*, Button, Badge, Kbd (\* = key for this feature)
- `@/layers/shared/lib` — cn() utility
- `@/layers/shared/model` — useTheme hook
- `lucide-react` — Icons
- `motion/react` — Animations
- `cmdk` — Command palette (via shadcn Command)

**Data flow:**
Static showcase components → PlaygroundSection (anchor IDs) → DevPlayground (page routing) → Browser URL

**Feature flags/config:**

- Dev playground is gated by `import.meta.env.DEV` — only loaded in development
- No feature flags needed

**Potential blast radius:**

- Direct: `DevPlayground.tsx` (restructure), `PlaygroundSection.tsx` (add scroll-mt)
- New files: ~5 new files (TOC, search, landing page, scrollspy hook, registry)
- Showcase files: Minor additions (export TOC/search metadata constants)
- No impact on production app code

---

## 4) Root Cause Analysis

N/A — this is a feature enhancement, not a bug fix.

---

## 5) Research

Research file: `research/20260316_dev_playground_navigation_overhaul.md`

### Potential Solutions

**1. Right-side Scrollspy TOC (IntersectionObserver)**

- Description: Sticky right-side TOC that highlights the current section as you scroll, using IntersectionObserver with negative rootMargin
- Pros:
  - Best-in-class pattern (used by Radix, Tailwind, shadcn docs)
  - ~40 lines of hook code, no library dependency
  - IntersectionObserver runs off main thread — no jank
  - PlaygroundSection already generates anchor IDs
- Cons:
  - Needs ~1280px+ viewport for 3-column layout
  - Hidden on smaller screens (acceptable for dev tool)
- Complexity: Low (~150 lines new code)
- Maintenance: Low (static section list, no runtime DOM queries)

**2. Cmd+K Search (cmdk CommandDialog)**

- Description: Fuzzy search over all ~48 component sections with keyboard shortcut and visible trigger button
- Pros:
  - cmdk already installed (shadcn Command component)
  - ~50 items is well within cmdk's built-in filter performance
  - Keywords prop enables alias matching (e.g., "btn" → Button)
  - Proven pattern in the existing command palette feature
- Cons:
  - Requires static registry of all sections (maintenance when adding new showcases)
- Complexity: Low-Medium (~200 lines new code)
- Maintenance: Low (add entries when adding new showcases)

**3. Landing Page (Category Card Grid)**

- Description: Default `/dev` page with category cards showing page name, description, and section count
- Pros:
  - Provides visual inventory of everything available
  - Low maintenance (section counts can be derived from registry)
  - Clean, informative landing
- Cons:
  - Minimal — but "less, but better" is the right philosophy for a dev tool
- Complexity: Low (~100 lines new code)
- Maintenance: Very low

**Recommendation:** All three features, implemented in order: TOC → Search → Landing Page. Each is independently valuable and builds on the previous. Total: ~450 lines of new code, zero new dependencies.

---

## 6) Decisions

| #   | Decision             | Choice                             | Rationale                                                                                                                                                                                                     |
| --- | -------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | TOC placement        | Right-side sticky TOC              | Best-in-class pattern used by Radix, Tailwind, shadcn docs. Left sidebar stays at page level; right TOC handles section-level navigation. Research confirms this as the standard for design system galleries. |
| 2   | Page structure       | Keep mega-pages + TOC + search     | ~48 sections across 2 pages is well within the range where mega-page + TOC works (shadcn has 50+ on one page). Avoids routing complexity. Existing anchor IDs make this trivial.                              |
| 3   | Landing page content | Category cards with section counts | Clean, informative, low maintenance. Quick-jump chips would need manual curation. "Less, but better."                                                                                                         |
