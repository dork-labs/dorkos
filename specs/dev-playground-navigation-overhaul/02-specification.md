---
slug: dev-playground-navigation-overhaul
number: 143
created: 2026-03-16
status: draft
---

# Dev Playground Navigation Overhaul

**Status:** Draft
**Authors:** Claude Code, 2026-03-16
**Ideation:** `specs/dev-playground-navigation-overhaul/01-ideation.md`
**Research:** `research/20260316_dev_playground_navigation_overhaul.md`

---

## Overview

Add three navigation features to the Dev Playground (`/dev`): a right-side sticky scrollspy TOC, Cmd+K fuzzy search across all ~48 component sections, and a landing page at `/dev` with category cards. These features transform the playground from blind-scrolling mega-pages into a world-class component gallery with instant navigation.

---

## Background / Problem Statement

The Dev Playground currently has 3 sidebar items (Tokens, Components, Chat) that hide ~48 `PlaygroundSection` components across 2 long-scroll pages. There is no way to:

- **Find** a specific component (no search)
- **Jump to** a section (no TOC or section-level navigation)
- **See what exists** (no overview or inventory)
- **Deep link** to a component (anchor IDs exist but are undiscoverable)

Designers and developers reviewing components must scroll through the entire page to find what they need. The `/dev` root redirects to `/dev/tokens` — wasting a potential landing page.

---

## Goals

- Provide instant section-level navigation via a right-side scrollspy TOC
- Enable fuzzy search over all component sections via Cmd+K
- Show a useful landing page at `/dev` with component inventory
- Support deep linking via URL hash fragments (e.g., `/dev/components#button`)
- Zero new npm dependencies
- No impact on production bundle (dev-only code path)

---

## Non-Goals

- Storybook-style visual screenshots or thumbnails
- Per-component route pages (50+ routes is overengineered)
- Splitting mega-pages into sub-pages (TOC + search solves the navigation problem)
- View source / view props / API documentation
- Mobile-optimized right TOC (hide on <1280px is sufficient for a dev tool)
- Expanding the left sidebar with section-level sub-items (Phase 4/future)

---

## Technical Dependencies

| Dependency             | Version              | Purpose                                   |
| ---------------------- | -------------------- | ----------------------------------------- |
| `cmdk`                 | ^1.1.1               | Command palette (already installed)       |
| `motion/react`         | ^12.33.0             | Animations (already installed)            |
| `lucide-react`         | installed            | Icons (already installed)                 |
| shadcn `Command`       | `@/layers/shared/ui` | CommandDialog wrapper (already available) |
| shadcn `Sidebar`       | `@/layers/shared/ui` | Sidebar components (already used)         |
| `IntersectionObserver` | Web API              | Scrollspy detection (no library needed)   |

**No new packages to install.**

---

## Detailed Design

### Architecture

The design adds three features to the existing `DevPlayground` shell. All new code lives under `apps/client/src/dev/` — outside the FSD layer hierarchy (dev-only, tree-shaken from production).

```
apps/client/src/dev/
├── DevPlayground.tsx          ← Modified (add search, landing page, layout)
├── PlaygroundSection.tsx      ← Modified (add scroll-mt-14)
├── PlaygroundSearch.tsx       ← NEW (Cmd+K search dialog)
├── TocSidebar.tsx             ← NEW (right-side scrollspy TOC)
├── playground-registry.ts     ← NEW (static section registry)
├── lib/
│   └── use-toc-scrollspy.ts   ← NEW (IntersectionObserver hook)
├── pages/
│   ├── OverviewPage.tsx       ← NEW (landing page)
│   ├── TokensPage.tsx         ← Modified (flex layout wrapper)
│   ├── ComponentsPage.tsx     ← Modified (flex layout wrapper + TOC sections export)
│   └── ChatPage.tsx           ← Modified (flex layout wrapper + TOC sections export)
└── showcases/                 ← Unchanged
```

### 1. Playground Registry (`playground-registry.ts`)

The foundation for both search and TOC. A static, typed array of all sections:

```typescript
import type { LucideIcon } from 'lucide-react';

/** Page identifiers for the dev playground. */
export type Page = 'overview' | 'tokens' | 'components' | 'chat';

/** A single searchable/navigable section in the playground. */
export interface PlaygroundSection {
  /** Anchor ID matching the section element's id attribute. */
  id: string;
  /** Display name shown in TOC and search. */
  title: string;
  /** Which page this section lives on. */
  page: Page;
  /** Showcase group for search grouping (e.g., 'Actions', 'Tools'). */
  category: string;
  /** Alias keywords for fuzzy search matching. */
  keywords: string[];
}

/** Section definitions for the Components page. */
export const COMPONENTS_SECTIONS: PlaygroundSection[] = [
  {
    id: 'button',
    title: 'Button',
    page: 'components',
    category: 'Actions',
    keywords: ['btn', 'click', 'primary', 'secondary', 'destructive', 'ghost', 'brand'],
  },
  {
    id: 'badge',
    title: 'Badge',
    page: 'components',
    category: 'Actions',
    keywords: ['label', 'tag', 'status', 'pill'],
  },
  {
    id: 'hoverbordergradient',
    title: 'HoverBorderGradient',
    page: 'components',
    category: 'Actions',
    keywords: ['gradient', 'animated', 'aceternity'],
  },
  {
    id: 'kbd',
    title: 'Kbd',
    page: 'components',
    category: 'Actions',
    keywords: ['keyboard', 'shortcut', 'key', 'hint'],
  },
  {
    id: 'input',
    title: 'Input',
    page: 'components',
    category: 'Forms',
    keywords: ['text', 'field', 'form'],
  },
  {
    id: 'textarea',
    title: 'Textarea',
    page: 'components',
    category: 'Forms',
    keywords: ['multiline', 'text', 'form'],
  },
  {
    id: 'switch',
    title: 'Switch',
    page: 'components',
    category: 'Forms',
    keywords: ['toggle', 'boolean', 'form'],
  },
  {
    id: 'select',
    title: 'Select',
    page: 'components',
    category: 'Forms',
    keywords: ['dropdown', 'picker', 'form'],
  },
  {
    id: 'tabs',
    title: 'Tabs',
    page: 'components',
    category: 'Forms',
    keywords: ['tab', 'panel', 'tabbed'],
  },
  {
    id: 'skeleton',
    title: 'Skeleton',
    page: 'components',
    category: 'Feedback',
    keywords: ['loading', 'placeholder', 'shimmer'],
  },
  {
    id: 'separator',
    title: 'Separator',
    page: 'components',
    category: 'Feedback',
    keywords: ['divider', 'line', 'hr'],
  },
  {
    id: 'tooltip',
    title: 'Tooltip',
    page: 'components',
    category: 'Feedback',
    keywords: ['hover', 'hint', 'popover'],
  },
  {
    id: 'navigationlayout',
    title: 'NavigationLayout',
    page: 'components',
    category: 'Navigation',
    keywords: ['nav', 'sidebar', 'vertical', 'settings'],
  },
  {
    id: 'dialog',
    title: 'Dialog',
    page: 'components',
    category: 'Overlays',
    keywords: ['modal', 'popup', 'window'],
  },
  {
    id: 'alertdialog',
    title: 'AlertDialog',
    page: 'components',
    category: 'Overlays',
    keywords: ['confirm', 'destructive', 'warning'],
  },
  {
    id: 'popover',
    title: 'Popover',
    page: 'components',
    category: 'Overlays',
    keywords: ['floating', 'panel', 'dropdown'],
  },
  {
    id: 'dropdownmenu',
    title: 'DropdownMenu',
    page: 'components',
    category: 'Overlays',
    keywords: ['context', 'menu', 'actions'],
  },
];

/** Section definitions for the Chat page. */
export const CHAT_SECTIONS: PlaygroundSection[] = [
  {
    id: 'usermessagecontent',
    title: 'UserMessageContent',
    page: 'chat',
    category: 'Messages',
    keywords: ['user', 'message', 'bubble', 'input'],
  },
  {
    id: 'assistantmessagecontent',
    title: 'AssistantMessageContent',
    page: 'chat',
    category: 'Messages',
    keywords: ['assistant', 'ai', 'response', 'markdown'],
  },
  {
    id: 'messageitem',
    title: 'MessageItem',
    page: 'chat',
    category: 'Messages',
    keywords: ['message', 'grouping', 'position'],
  },
  {
    id: 'toolcallcard',
    title: 'ToolCallCard',
    page: 'chat',
    category: 'Tools',
    keywords: ['tool', 'call', 'function', 'pending', 'running', 'complete', 'error'],
  },
  {
    id: 'toolcallcard-—-extended-labels',
    title: 'ToolCallCard — Extended Labels',
    page: 'chat',
    category: 'Tools',
    keywords: ['tool', 'label', 'taskget', 'notebookedit'],
  },
  {
    id: 'toolcallcard-—-hook-lifecycle',
    title: 'ToolCallCard — Hook Lifecycle',
    page: 'chat',
    category: 'Tools',
    keywords: ['hook', 'lifecycle', 'pre', 'post'],
  },
  {
    id: 'subagentblock',
    title: 'SubagentBlock',
    page: 'chat',
    category: 'Tools',
    keywords: ['subagent', 'task', 'agent', 'running'],
  },
  {
    id: 'errormessageblock',
    title: 'ErrorMessageBlock',
    page: 'chat',
    category: 'Tools',
    keywords: ['error', 'max_turns', 'budget', 'retry'],
  },
  {
    id: 'thinkingblock',
    title: 'ThinkingBlock',
    page: 'chat',
    category: 'Tools',
    keywords: ['thinking', 'extended', 'reasoning'],
  },
  {
    id: 'toolapproval',
    title: 'ToolApproval',
    page: 'chat',
    category: 'Tools',
    keywords: ['approval', 'permission', 'approve', 'deny', 'countdown'],
  },
  {
    id: 'chatinput',
    title: 'ChatInput',
    page: 'chat',
    category: 'Input',
    keywords: ['input', 'message', 'compose', 'send'],
  },
  {
    id: 'filechipbar',
    title: 'FileChipBar',
    page: 'chat',
    category: 'Input',
    keywords: ['file', 'upload', 'attachment', 'chip'],
  },
  {
    id: 'queuepanel',
    title: 'QueuePanel',
    page: 'chat',
    category: 'Input',
    keywords: ['queue', 'pending', 'messages'],
  },
  {
    id: 'shortcutchips',
    title: 'ShortcutChips',
    page: 'chat',
    category: 'Input',
    keywords: ['shortcut', 'slash', 'command', 'chip'],
  },
  {
    id: 'promptsuggestionchips',
    title: 'PromptSuggestionChips',
    page: 'chat',
    category: 'Input',
    keywords: ['prompt', 'suggestion', 'chip', 'hint'],
  },
  {
    id: 'streamingtext',
    title: 'StreamingText',
    page: 'chat',
    category: 'Status',
    keywords: ['streaming', 'text', 'markdown', 'cursor'],
  },
  {
    id: 'inferenceindicator',
    title: 'InferenceIndicator',
    page: 'chat',
    category: 'Status',
    keywords: ['inference', 'streaming', 'timer', 'rate', 'limit'],
  },
  {
    id: 'systemstatuszone',
    title: 'SystemStatusZone',
    page: 'chat',
    category: 'Status',
    keywords: ['system', 'status', 'permission', 'truncated'],
  },
  {
    id: 'transporterrorbanner',
    title: 'TransportErrorBanner',
    page: 'chat',
    category: 'Status',
    keywords: ['transport', 'error', 'connection', 'retry'],
  },
  {
    id: 'tasklistpanel',
    title: 'TaskListPanel',
    page: 'chat',
    category: 'Status',
    keywords: ['task', 'list', 'todo', 'progress'],
  },
  {
    id: 'clientsitem',
    title: 'ClientsItem',
    page: 'chat',
    category: 'Status',
    keywords: ['clients', 'multi', 'session', 'indicator'],
  },
  {
    id: 'celebrationoverlay',
    title: 'CelebrationOverlay',
    page: 'chat',
    category: 'Misc',
    keywords: ['celebration', 'confetti', 'success'],
  },
  {
    id: 'draghandle',
    title: 'DragHandle',
    page: 'chat',
    category: 'Misc',
    keywords: ['drag', 'handle', 'pill', 'collapse'],
  },
];

/** Section definitions for the Tokens page. */
export const TOKENS_SECTIONS: PlaygroundSection[] = [
  {
    id: 'semantic-colors',
    title: 'Semantic Colors',
    page: 'tokens',
    category: 'Colors',
    keywords: ['color', 'palette', 'background', 'foreground', 'primary'],
  },
  {
    id: 'status-colors',
    title: 'Status Colors',
    page: 'tokens',
    category: 'Colors',
    keywords: ['status', 'success', 'error', 'warning', 'info'],
  },
  {
    id: 'sidebar-colors',
    title: 'Sidebar Colors',
    page: 'tokens',
    category: 'Colors',
    keywords: ['sidebar', 'nav', 'color'],
  },
  {
    id: 'typography',
    title: 'Typography',
    page: 'tokens',
    category: 'Type',
    keywords: ['font', 'text', 'size', 'weight', 'family'],
  },
  {
    id: 'spacing',
    title: 'Spacing',
    page: 'tokens',
    category: 'Layout',
    keywords: ['space', 'gap', 'padding', 'margin', 'grid'],
  },
  {
    id: 'border-radius',
    title: 'Border Radius',
    page: 'tokens',
    category: 'Shape',
    keywords: ['radius', 'rounded', 'corner'],
  },
  {
    id: 'shadows',
    title: 'Shadows',
    page: 'tokens',
    category: 'Shape',
    keywords: ['shadow', 'elevation', 'depth'],
  },
  {
    id: 'icon-&-button-sizes',
    title: 'Icon & Button Sizes',
    page: 'tokens',
    category: 'Sizing',
    keywords: ['icon', 'button', 'size', 'height'],
  },
];

/** Complete registry of all playground sections for search. */
export const PLAYGROUND_REGISTRY: PlaygroundSection[] = [
  ...TOKENS_SECTIONS,
  ...COMPONENTS_SECTIONS,
  ...CHAT_SECTIONS,
];
```

The `id` values must match what `PlaygroundSection.tsx` generates from the title: `title.toLowerCase().replace(/\s+/g, '-')`. This is validated at dev-time — if a section title changes, the registry entry must be updated.

### 2. Scrollspy TOC Hook (`lib/use-toc-scrollspy.ts`)

An `IntersectionObserver`-based hook that tracks which section is currently in view:

```typescript
import { useState, useEffect, useRef } from 'react';

/**
 * Track which section is currently visible using IntersectionObserver.
 *
 * @param sectionIds - Array of section element IDs to observe
 * @returns The ID of the currently active (topmost visible) section, or null
 */
export function useTocScrollspy(sectionIds: string[]): string | null {
  const [activeId, setActiveId] = useState<string | null>(null);
  const intersectingRef = useRef(new Set<string>());

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            intersectingRef.current.add(entry.target.id);
          } else {
            intersectingRef.current.delete(entry.target.id);
          }
        }
        // First ID in document order that is currently intersecting
        const first = sectionIds.find((id) => intersectingRef.current.has(id));
        setActiveId(first ?? null);
      },
      {
        // Top offset accounts for sticky header (36px) + breathing room.
        // Bottom 60% exclusion prevents rapid flickering as sections scroll through.
        rootMargin: '-48px 0px -60% 0px',
        threshold: 0,
      }
    );

    for (const id of sectionIds) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }

    return () => observer.disconnect();
  }, [sectionIds]);

  return activeId;
}
```

**Key design decisions:**

- `rootMargin: '-48px 0px -60% 0px'` — top offset for the sticky header bar; bottom 60% exclusion prevents multiple sections from being "active" simultaneously and avoids flickering
- "First in document order wins" — when multiple sections are visible, the topmost one is active
- `threshold: 0` — triggers as soon as any part of the section enters the observation area
- The hook takes section IDs as input, making it reusable across pages with different section sets

### 3. TOC Sidebar Component (`TocSidebar.tsx`)

A sticky right-side aside showing all sections for the current page:

```typescript
import { cn } from '@/layers/shared/lib';
import { ScrollArea } from '@/layers/shared/ui';
import type { PlaygroundSection } from './playground-registry';

interface TocSidebarProps {
  sections: PlaygroundSection[];
  activeId: string | null;
}

/** Sticky right-side table of contents with scrollspy active highlighting. */
export function TocSidebar({ sections, activeId }: TocSidebarProps) {
  return (
    <aside className="hidden w-48 shrink-0 xl:block">
      <nav className="sticky top-12">
        <p className="mb-2 text-xs font-medium text-muted-foreground">
          On this page
        </p>
        <ScrollArea className="max-h-[calc(100dvh-8rem)]">
          <ul className="space-y-0.5">
            {sections.map((section) => (
              <li key={section.id}>
                <a
                  href={`#${section.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    document.getElementById(section.id)?.scrollIntoView({
                      behavior: 'smooth',
                      block: 'start',
                    });
                    // Update URL hash without scroll jump
                    history.replaceState(null, '', `#${section.id}`);
                  }}
                  className={cn(
                    'block truncate rounded-md px-2 py-1 text-xs transition-colors',
                    activeId === section.id
                      ? 'bg-accent font-medium text-accent-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {section.title}
                </a>
              </li>
            ))}
          </ul>
        </ScrollArea>
      </nav>
    </aside>
  );
}
```

**Layout integration:** Each page wraps its content in a flex container:

```tsx
<div className="flex gap-6">
  <main className="min-w-0 flex-1">{/* existing page content */}</main>
  <TocSidebar sections={PAGE_SECTIONS} activeId={activeId} />
</div>
```

The TOC is hidden below `xl` (1280px) breakpoint via `hidden xl:block`.

### 4. Cmd+K Search (`PlaygroundSearch.tsx`)

A `CommandDialog` that searches across all sections:

```typescript
import { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  Kbd,
} from '@/layers/shared/ui';
import { ResponsiveDialog, ResponsiveDialogContent } from '@/layers/shared/ui';
import { PLAYGROUND_REGISTRY, type Page, type PlaygroundSection } from './playground-registry';

interface PlaygroundSearchProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate: (page: Page, sectionId: string) => void;
}

/** Cmd+K search dialog for navigating to any playground section. */
export function PlaygroundSearch({ open, onOpenChange, onNavigate }: PlaygroundSearchProps) {
  // Group sections by page for display
  const grouped = groupByPage(PLAYGROUND_REGISTRY);

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="p-0" hideClose>
        <Command className="rounded-lg">
          <CommandInput placeholder="Search components and tokens..." />
          <CommandList>
            <CommandEmpty>No results found.</CommandEmpty>
            {Object.entries(grouped).map(([page, sections]) => (
              <CommandGroup key={page} heading={pageLabel(page)}>
                {sections.map((section) => (
                  <CommandItem
                    key={section.id}
                    value={section.title}
                    keywords={section.keywords}
                    onSelect={() => {
                      onOpenChange(false);
                      onNavigate(section.page, section.id);
                    }}
                  >
                    {section.title}
                    <CommandShortcut>{section.category}</CommandShortcut>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
```

**Keyboard shortcut handler** lives in `DevPlayground.tsx`:

```typescript
useEffect(() => {
  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      setSearchOpen((prev) => !prev);
    }
  };
  document.addEventListener('keydown', onKeyDown);
  return () => document.removeEventListener('keydown', onKeyDown);
}, []);
```

**Search trigger button** in the header bar:

```tsx
<button
  onClick={() => setSearchOpen(true)}
  className="text-muted-foreground hover:bg-accent flex items-center gap-2 rounded-md border px-3 py-1 text-xs"
>
  <Search className="size-3" />
  Search components...
  <Kbd className="ml-2">⌘K</Kbd>
</button>
```

**Navigate + scroll behavior:**

```typescript
const handleNavigate = useCallback((page: Page, sectionId: string) => {
  // Navigate to the page first
  setPage(page);
  history.pushState(null, '', `/dev/${page}#${sectionId}`);
  // Wait for React render, then scroll to section
  requestAnimationFrame(() => {
    setTimeout(() => {
      document.getElementById(sectionId)?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    }, 50);
  });
}, []);
```

### 5. Landing Page (`pages/OverviewPage.tsx`)

A simple category card grid at `/dev`:

```typescript
import { Palette, Component, MessageSquare } from 'lucide-react';
import {
  TOKENS_SECTIONS,
  COMPONENTS_SECTIONS,
  CHAT_SECTIONS,
  type Page,
} from '../playground-registry';

interface OverviewPageProps {
  onNavigate: (page: Page) => void;
}

const CATEGORIES = [
  {
    page: 'tokens' as Page,
    label: 'Design Tokens',
    description: 'Color palette, typography, spacing, and shape tokens.',
    icon: Palette,
    sections: TOKENS_SECTIONS,
  },
  {
    page: 'components' as Page,
    label: 'Components',
    description: 'Buttons, forms, overlays, navigation, and feedback.',
    icon: Component,
    sections: COMPONENTS_SECTIONS,
  },
  {
    page: 'chat' as Page,
    label: 'Chat UI',
    description: 'Messages, tools, input controls, and status indicators.',
    icon: MessageSquare,
    sections: CHAT_SECTIONS,
  },
];
```

Each card displays the page name, description, section count, and a link. The section count is derived from the registry arrays — no manual maintenance.

### 6. Page Layout Changes

Each page (Components, Chat, Tokens) receives a flex wrapper for the right TOC:

**Before (`ComponentsPage.tsx`):**

```tsx
<main className="mx-auto max-w-4xl space-y-8 p-6">
  <ButtonShowcases />
  ...
</main>
```

**After:**

```tsx
<div className="flex gap-6 p-6">
  <main className="mx-auto max-w-4xl min-w-0 flex-1 space-y-8">
    <ButtonShowcases />
    ...
  </main>
  <TocSidebar sections={COMPONENTS_SECTIONS} activeId={activeId} />
</div>
```

The scrollspy hook is called at the page level:

```tsx
const activeId = useTocScrollspy(COMPONENTS_SECTIONS.map((s) => s.id));
```

### 7. PlaygroundSection Change

One-line addition for scroll offset:

**Before:**

```tsx
<section id={anchorId} className="rounded-xl border border-border bg-card p-6">
```

**After:**

```tsx
<section id={anchorId} className="scroll-mt-14 rounded-xl border border-border bg-card p-6">
```

The `scroll-mt-14` (56px) accounts for the sticky header bar height, ensuring `scrollIntoView` doesn't land with the section hidden behind the header.

### 8. URL Hash Deep Linking

Extend `getPageFromPath()` to parse hash fragments:

```typescript
interface PlaygroundRoute {
  page: Page;
  anchor: string | null;
}

function getRouteFromPath(): PlaygroundRoute {
  const path = window.location.pathname;
  const anchor = window.location.hash.slice(1) || null;

  if (path === '/dev' || path === '/dev/') return { page: 'overview', anchor };
  if (path.startsWith('/dev/components')) return { page: 'components', anchor };
  if (path.startsWith('/dev/chat')) return { page: 'chat', anchor };
  if (path.startsWith('/dev/tokens')) return { page: 'tokens', anchor };
  return { page: 'overview', anchor };
}
```

On initial load, if an anchor is present, scroll to it after the page renders:

```typescript
useEffect(() => {
  const { anchor } = getRouteFromPath();
  if (anchor) {
    requestAnimationFrame(() => {
      document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
}, [page]);
```

### 9. DevPlayground Shell Changes

The shell component grows to accommodate the new features. Key changes:

1. **Page type** expands from `'tokens' | 'components' | 'chat'` to include `'overview'`
2. **Search state** (`searchOpen`) and Cmd+K handler added
3. **Header bar** gains the search trigger button
4. **Default page** changes from `'tokens'` to `'overview'`
5. **`navigateTo`** updated to handle hash fragments for search navigation

---

## User Experience

### Navigation Flow

1. **Landing**: User visits `/dev` → sees 3 category cards with descriptions and section counts
2. **Browse**: Clicks "Components" card → navigates to `/dev/components` → sees full component gallery with right-side TOC
3. **Scroll**: Scrolls through components → TOC highlights current section in real-time
4. **Jump**: Clicks "Dialog" in the right TOC → smooth-scrolls to the Dialog section
5. **Search**: Presses Cmd+K → types "tool" → sees ToolCallCard, ToolApproval, etc. → selects one → navigates to Chat page and scrolls to that section
6. **Share**: Copies URL from address bar (`/dev/chat#toolcallcard`) → shares with teammate → teammate lands directly on that section

### Visual Layout

```
┌──────────────┬──────────────────────────────┬──────────────┐
│  Left        │  Content Area                │  Right TOC   │
│  Sidebar     │                              │  (xl+ only)  │
│              │  ┌──────────────────────────┐ │              │
│  DorkOS Dev  │  │ [🔍 Search...     ⌘K]  │ │  On this page│
│              │  └──────────────────────────┘ │              │
│  Design Sys  │                              │  Button      │
│  • Tokens    │  ┌──────────────────────┐    │  Badge       │
│  • Components│  │  Button              │    │ [Input]  ←── │
│              │  │  variants, sizes...  │    │  Textarea    │
│  Features    │  └──────────────────────┘    │  Switch      │
│  • Chat      │                              │  ...         │
│              │  ┌──────────────────────┐    │              │
│  Theme       │  │  Badge               │    │              │
│  ☀ 🖥 🌙     │  │  default, secondary  │    │              │
│              │  └──────────────────────┘    │              │
└──────────────┴──────────────────────────────┴──────────────┘
```

At viewports below 1280px, the right TOC is hidden. The search (Cmd+K) remains available at all sizes.

---

## Testing Strategy

### Unit Tests

1. **`use-toc-scrollspy` hook test** (`lib/__tests__/use-toc-scrollspy.test.ts`):
   - Mock `IntersectionObserver` to simulate section visibility changes
   - Verify that the hook returns the correct active section ID
   - Verify cleanup on unmount (observer.disconnect called)
   - Verify behavior when no sections are intersecting (returns null)

2. **`playground-registry` test** (`__tests__/playground-registry.test.ts`):
   - Verify all section IDs are unique across the full registry
   - Verify all IDs match the expected anchor generation pattern (lowercase, dashes)
   - Verify all sections have a valid page assignment
   - Verify PLAYGROUND_REGISTRY equals the union of all page-level arrays

### Component Tests

3. **`TocSidebar` test** (`__tests__/TocSidebar.test.tsx`):
   - Renders all section titles as links
   - Applies active styling to the section matching `activeId`
   - Does not render when sections array is empty

4. **`PlaygroundSearch` test** (`__tests__/PlaygroundSearch.test.tsx`):
   - Renders search input when open
   - Displays grouped sections
   - Calls `onNavigate` with correct page and section ID when item is selected
   - Closes dialog after selection

5. **`OverviewPage` test** (`__tests__/OverviewPage.test.tsx`):
   - Renders 3 category cards
   - Each card shows correct section count
   - Clicking a card calls `onNavigate`

---

## Performance Considerations

- **IntersectionObserver is off-thread** — no scroll event listener overhead, no need for throttling
- **Static registry** — no runtime DOM queries to build the section list
- **cmdk built-in filter** — sufficient for ~50 items, no need for Fuse.js
- **Tree-shaken from production** — entire dev playground is gated by `import.meta.env.DEV`
- **Lazy-loaded** — `DevPlayground` is loaded via `React.lazy()` in `main.tsx`

---

## Security Considerations

No security implications — this is a dev-only tool that:

- Is tree-shaken from production builds
- Has no user data, no authentication, no external API calls
- Uses only browser APIs (IntersectionObserver, history.pushState)

---

## Documentation

No external documentation changes needed. The dev playground is an internal tool for developers working on the DorkOS codebase.

Update `contributing/design-system.md` to mention the dev playground URL (`http://localhost:4241/dev`) and the Cmd+K search shortcut.

---

## Implementation Phases

### Phase 1: Registry + Scrollspy TOC

**Files changed:** `PlaygroundSection.tsx`, new `playground-registry.ts`, new `lib/use-toc-scrollspy.ts`, new `TocSidebar.tsx`, modified `ComponentsPage.tsx`, `ChatPage.tsx`, `TokensPage.tsx`

1. Create `playground-registry.ts` with all section definitions
2. Add `scroll-mt-14` to `PlaygroundSection.tsx`
3. Create `useTocScrollspy` hook
4. Create `TocSidebar` component
5. Add flex layout wrapper and TOC to each page
6. Write tests for hook and registry

### Phase 2: Cmd+K Search

**Files changed:** new `PlaygroundSearch.tsx`, modified `DevPlayground.tsx`

1. Create `PlaygroundSearch` dialog component
2. Add Cmd+K keyboard handler to `DevPlayground.tsx`
3. Add search trigger button to header bar
4. Implement navigate + scroll-to-section behavior
5. Write tests for search component

### Phase 3: Landing Page + Deep Linking

**Files changed:** new `pages/OverviewPage.tsx`, modified `DevPlayground.tsx`

1. Add `'overview'` to Page type
2. Create `OverviewPage` with category cards
3. Update `getPageFromPath` to handle `/dev` root and hash fragments
4. Make `/dev` default to overview page
5. Add hash-based scroll on initial load
6. Write tests for overview page

---

## Open Questions

None — all decisions were resolved during ideation.

---

## Related ADRs

No directly related ADRs. This feature is contained within the dev-only playground and does not affect production architecture.

---

## References

- [Ideation document](../dev-playground-navigation-overhaul/01-ideation.md)
- [Research: Dev Playground Navigation Overhaul](../../research/20260316_dev_playground_navigation_overhaul.md)
- [Scrollspy via IntersectionObserver (Maxime Heckel)](https://blog.maximeheckel.com/posts/scrollspy-demystified/)
- [CSS-Tricks: TOC with IntersectionObserver](https://css-tricks.com/table-of-contents-with-intersectionobserver/)
- [cmdk npm package](https://www.npmjs.com/package/cmdk)
- [shadcn/ui Command component](https://ui.shadcn.com/docs/components/command)
