---
slug: command-palette-10x
number: 87
title: "10x Command Palette UX"
status: draft
created: 2026-03-03
authors: ["Claude Code"]
spec: command-palette-10x
---

# 10x Command Palette UX

## Status

Draft

## Overview

Elevate the existing Cmd+K global command palette from a functional launcher into a world-class, intelligent interface. This spec covers five enhancements: (1) an agent preview panel for informed switching, (2) Fuse.js fuzzy search with character-level highlighting, (3) Slack-style bucket frecency, (4) agent sub-menu drill-down via cmdk pages, and (5) premium micro-interactions using motion.dev.

The existing palette (ADR-0063, spec #85) is stable. This is a UX enhancement, not a rewrite. All data sources (mesh agents, sessions, Pulse/Relay status) are already accessible via entity hooks. No new server endpoints are required.

## Background / Problem Statement

The current command palette is functional but flat. It lists agents and features without visual hierarchy, has no match highlighting, uses a simple linear frecency formula that doesn't decay naturally, and lacks the polish that separates a "good enough" tool from one users enjoy using. Specifically:

1. **No preview context** — Users must switch to an agent to learn about it. No way to see session count, health, or persona before committing.
2. **No match highlighting** — cmdk's built-in filter returns a score but no match indices. Users can't see *why* a result matched their query.
3. **Linear frecency decay** — The current `useCount / (1 + hours * 0.1)` formula keeps old high-frequency items ranked too long.
4. **No drill-down** — Selecting an agent immediately switches CWD. No opportunity to choose "open here", "open in new tab", or view recent sessions.
5. **No micro-interactions** — Selection snaps between items rather than sliding. No entrance animation, no hover feedback, no keyboard hint footer.

## Goals

- Provide rich agent context (health, sessions, persona) without leaving the palette
- Highlight matched characters in fuzzy search results using Fuse.js
- Implement Slack's bucket frecency algorithm for natural ranking decay
- Enable agent sub-menu drill-down with "Open Here", "Open in New Tab", "New Session", and recent sessions
- Add premium micro-interactions: sliding selection indicator, stagger animations, directional page transitions
- Show contextual suggestions based on current state (recent sessions, active Pulse runs, previous agent)
- Display dynamic keyboard hints in a footer bar

## Non-Goals

- `#` session prefix search (deferred)
- "Ask Claude: '{query}'" natural language fallback on empty results (deferred)
- Inline slash command palette changes (separate system at `features/commands/`)
- Agent-registered custom palette actions (future extensibility)
- Server-side search endpoints (all search is client-side)
- Mobile preview panel (mobile keeps current Drawer layout)
- Virtualization (agent count < 50, command count < 100)

## Technical Dependencies

| Dependency | Version | Purpose |
|---|---|---|
| `fuse.js` | `^7.0.0` | Fuzzy search with `includeMatches` for character-level highlighting |
| `cmdk` | `^1.1.1` | Already installed — `shouldFilter={false}` mode, `pages` pattern |
| `motion` | `^12.x` | Already installed — `layoutId`, `AnimatePresence`, stagger variants |
| `@dorkos/shared` | workspace | Mesh schemas (`AgentPathEntry`), session types |

**New dependency**: `fuse.js` (24kb, MIT license, zero sub-dependencies). Install in `apps/client/`.

## Detailed Design

### Architecture Overview

All changes are client-side within the `features/command-palette/` FSD module. No server changes, no new API endpoints, no shared package changes.

```
features/command-palette/
├── ui/
│   ├── CommandPaletteDialog.tsx   # MODIFY — add preview panel, pages stack, animations
│   ├── AgentCommandItem.tsx       # MODIFY — add highlight support, selection indicator
│   ├── AgentPreviewPanel.tsx      # NEW — right-side agent context panel
│   ├── AgentSubMenu.tsx           # NEW — drill-down actions + recent sessions
│   ├── HighlightedText.tsx        # NEW — React nodes from Fuse.js match indices
│   └── PaletteFooter.tsx          # NEW — dynamic keyboard hint bar
├── model/
│   ├── use-palette-items.ts       # MODIFY — add contextual suggestions, session data
│   ├── use-agent-frecency.ts      # MODIFY — upgrade to Slack bucket system
│   ├── use-global-palette.ts      # MODIFY — add previous agent tracking
│   ├── use-palette-search.ts      # NEW — Fuse.js integration + category prefix detection
│   └── use-preview-data.ts        # NEW — debounced preview data aggregation
├── __tests__/
│   ├── CommandPaletteDialog.test.tsx  # MODIFY — update for new structure
│   ├── use-palette-search.test.ts    # NEW
│   ├── use-agent-frecency.test.ts    # MODIFY — test bucket algorithm
│   └── use-preview-data.test.ts      # NEW
└── index.ts                       # MODIFY — export new public API
```

### Feature 1: Agent Preview Panel

**Layout**: The dialog uses a flex-row container. `CommandList` takes ~40% width, `AgentPreviewPanel` takes ~60% width. The panel only appears when the selected item is an agent (guard: `selectedItem?.type === 'agent'`).

**Dialog width animation**: When the preview panel appears, the dialog container animates from `max-w-[480px]` to `max-w-[720px]` using a motion.div width spring. When no agent is selected, it collapses back.

```
+---------------------------------------------+
| [search icon] Search agents, features, ...  |
| [All > agent-actions]  (breadcrumb, if sub) |
+--------------------+------------------------+
| List (40%)         | Preview Panel (60%)    |
| > agent-1 my-api   | [dot] my-api-agent     |
|   agent-2 market   | ~/projects/my-api      |
|   Pulse Scheduler  | "Builds the REST API" |
|   Settings         |                       |
|                    | Sessions: 3 active     |
|                    | Health: healthy        |
+--------------------+------------------------+
| up/down Navigate  Enter Select  esc Close   |
+---------------------------------------------+
```

**Preview content** (for agent items):
- Agent name + color chip + emoji
- CWD path (shortened via `shortenHomePath`)
- Persona description (from `useCurrentAgent` or mesh data)
- Active session count (from `useSessions` filtered by agent CWD)
- Recent session titles (last 3 sessions for that agent)
- Mesh health status badge (from `useMeshAgentHealth`)

**Data debouncing**: Preview data fetching is debounced 100ms on `selectedItemId` changes using `useDeferredValue`. This prevents fetch thrashing during rapid arrow key navigation.

**Mobile**: On mobile (`useIsMobile()`), the preview panel is hidden. The palette uses the existing Drawer layout.

#### AgentPreviewPanel.tsx

```tsx
interface AgentPreviewPanelProps {
  agent: AgentPathEntry;
}

export function AgentPreviewPanel({ agent }: AgentPreviewPanelProps) {
  const { sessionCount, health, recentSessions } = usePreviewData(agent.id, agent.projectPath);

  return (
    <motion.div
      initial={{ opacity: 0, width: 0 }}
      animate={{ opacity: 1, width: '60%' }}
      exit={{ opacity: 0, width: 0 }}
      transition={{ type: 'spring', stiffness: 400, damping: 35 }}
      className="border-l overflow-hidden"
    >
      {/* Agent identity header */}
      {/* Persona description */}
      {/* Session count + recent sessions */}
      {/* Health status */}
    </motion.div>
  );
}
```

#### use-preview-data.ts

```tsx
export function usePreviewData(agentId: string, agentCwd: string) {
  const deferredAgentId = useDeferredValue(agentId);
  const { data: sessions } = useSessions();
  const { data: health } = useMeshAgentHealth(deferredAgentId);

  const agentSessions = useMemo(() =>
    sessions?.filter(s => s.cwd === agentCwd) ?? [],
    [sessions, agentCwd]
  );

  const recentSessions = useMemo(() =>
    agentSessions.slice(0, 3),
    [agentSessions]
  );

  return {
    sessionCount: agentSessions.length,
    recentSessions,
    health: health ?? null,
  };
}
```

### Feature 2: Fuzzy Search with Highlighting

**Library**: Fuse.js with `includeMatches: true` returns match indices per result. These indices are `[start, end]` pairs indicating which characters in the haystack matched.

**Integration**: Set `shouldFilter={false}` on cmdk's `<Command>` to disable built-in filtering. All filtering, scoring, and sorting is managed externally by `use-palette-search.ts`.

**Category prefixes**:
- `@` — filters agents only (existing behavior, enhanced)
- `>` — filters commands only (new)
- No prefix — searches all categories

#### use-palette-search.ts

```tsx
import Fuse from 'fuse.js';

interface SearchableItem {
  id: string;
  name: string;
  type: 'agent' | 'feature' | 'command' | 'quick-action' | 'suggestion';
  keywords?: string[];
  // Original data reference
  data: AgentPathEntry | FeatureItem | CommandItemData | QuickActionItem;
}

interface SearchResult {
  item: SearchableItem;
  matches: Fuse.FuseResultMatch[] | undefined;
}

const FUSE_OPTIONS: Fuse.IFuseOptions<SearchableItem> = {
  keys: ['name', 'keywords'],
  includeMatches: true,
  threshold: 0.3,       // Tight matching — agent names/paths are precise terms
  distance: 100,
  minMatchCharLength: 1,
};

export function usePaletteSearch(items: SearchableItem[], search: string) {
  const { prefix, term } = useMemo(() => parsePrefix(search), [search]);

  const filteredByPrefix = useMemo(() => {
    if (prefix === '@') return items.filter(i => i.type === 'agent');
    if (prefix === '>') return items.filter(i => i.type === 'command');
    return items;
  }, [items, prefix]);

  const fuse = useMemo(
    () => new Fuse(filteredByPrefix, FUSE_OPTIONS),
    [filteredByPrefix]
  );

  const results: SearchResult[] = useMemo(() => {
    if (!term) {
      return filteredByPrefix.map(item => ({ item, matches: undefined }));
    }
    return fuse.search(term);
  }, [fuse, term, filteredByPrefix]);

  return { results, prefix, term };
}

function parsePrefix(search: string): { prefix: string | null; term: string } {
  if (search.startsWith('@')) return { prefix: '@', term: search.slice(1) };
  if (search.startsWith('>')) return { prefix: '>', term: search.slice(1) };
  return { prefix: null, term: search };
}
```

#### HighlightedText.tsx

Builds React nodes from Fuse.js match indices. Safe by construction — all content goes through React's createElement pipeline, never raw HTML injection.

```tsx
interface HighlightedTextProps {
  text: string;
  indices?: readonly [number, number][];
  className?: string;
}

export function HighlightedText({ text, indices, className }: HighlightedTextProps) {
  if (!indices || indices.length === 0) {
    return <span className={className}>{text}</span>;
  }

  const parts: React.ReactNode[] = [];
  let lastIdx = 0;

  for (let i = 0; i < indices.length; i++) {
    const [start, end] = indices[i];
    // end is inclusive in Fuse.js
    const matchEnd = end + 1;

    if (lastIdx < start) {
      parts.push(<span key={`p-${i}`}>{text.slice(lastIdx, start)}</span>);
    }
    parts.push(
      <mark key={`m-${i}`} className="bg-transparent text-foreground font-semibold">
        {text.slice(start, matchEnd)}
      </mark>
    );
    lastIdx = matchEnd;
  }

  if (lastIdx < text.length) {
    parts.push(<span key="tail">{text.slice(lastIdx)}</span>);
  }

  return <span className={className}>{parts}</span>;
}
```

### Feature 3: Frecency (Slack Bucket System)

Upgrade `use-agent-frecency.ts` from the current linear formula to Slack's battle-tested bucket system.

**Storage key migration**: Use a new storage key (`dorkos:agent-frecency-v2`) to avoid conflicts with existing data. The old key (`dorkos-agent-frecency`) is left in place — old data is simply ignored.

**Bucket scoring**:

| Time Window | Points |
|---|---|
| Past 4 hours | 100 |
| Past 24 hours | 80 |
| Past 3 days | 60 |
| Past week | 40 |
| Past month | 20 |
| Past 90 days | 10 |
| Beyond 90 days | 0 |

**Formula**: `totalCount * bucketSum / min(timestamps.length, MAX_TIMESTAMPS)`

Where `bucketSum` is the sum of bucket scores for each stored timestamp (max 10 timestamps per agent). The denominator caps at 10 to prevent old high-frequency items from dominating.

**Interface change**:

```tsx
// Old
interface FrecencyEntry {
  agentId: string;
  lastUsed: string;
  useCount: number;
}

// New
interface FrecencyRecord {
  agentId: string;
  timestamps: number[];  // epoch ms, most recent first, max 10
  totalCount: number;
}
```

The `useSyncExternalStore` pattern and `subscribe`/`emitChange` mechanism remain identical. Only the scoring algorithm and storage format change.

### Feature 4: Sub-menu Drill-down

Uses cmdk's native `pages` pattern — an array stack where the last element is the current page.

**State management**: Pages state is local to `CommandPaletteDialog` (not in Zustand — it resets when the palette closes).

```tsx
const [pages, setPages] = useState<string[]>([]);
const [selectedAgent, setSelectedAgent] = useState<AgentPathEntry | null>(null);
const page = pages[pages.length - 1];
```

**Navigation**:
- **Enter** on an agent item — pushes `'agent-actions'` page, stores selected agent
- **Cmd+Enter** on an agent item — fast path: opens agent in new tab directly (skips sub-menu)
- **Backspace** when input is empty — pops last page (`goBack()`)
- **Escape** when `pages.length > 0` — pops last page with `e.stopPropagation()` (prevents dialog close)
- **Escape** when `pages.length === 0` — closes dialog (default behavior)

**Breadcrumb**: When `pages.length > 0`, a compact breadcrumb displays below the input:
```
All / Agent: my-api-agent
```

**Height animation**: The `--cmdk-list-height` CSS variable (provided by cmdk) drives a CSS transition on the list container:
```css
[cmdk-list] {
  height: var(--cmdk-list-height);
  transition: height 150ms cubic-bezier(0.4, 0, 0.2, 1);
  overflow: hidden;
}
```

#### AgentSubMenu.tsx

```tsx
interface AgentSubMenuProps {
  agent: AgentPathEntry;
  onOpenHere: () => void;
  onOpenNewTab: () => void;
  onNewSession: () => void;
  recentSessions: SessionMetadata[];
}

export function AgentSubMenu({
  agent, onOpenHere, onOpenNewTab, onNewSession, recentSessions,
}: AgentSubMenuProps) {
  return (
    <>
      <CommandGroup heading={`${agent.name} Actions`}>
        <CommandItem onSelect={onOpenHere}>
          <FolderOpen className="size-4" />
          <span>Open Here</span>
          <CommandShortcut>Enter</CommandShortcut>
        </CommandItem>
        <CommandItem onSelect={onOpenNewTab}>
          <ExternalLink className="size-4" />
          <span>Open in New Tab</span>
          <CommandShortcut>Cmd+Enter</CommandShortcut>
        </CommandItem>
        <CommandItem onSelect={onNewSession}>
          <Plus className="size-4" />
          <span>New Session</span>
        </CommandItem>
      </CommandGroup>
      {recentSessions.length > 0 && (
        <CommandGroup heading="Recent Sessions">
          {recentSessions.map(session => (
            <CommandItem key={session.id} onSelect={() => navigateToSession(session.id)}>
              <MessageSquare className="size-4" />
              <span className="truncate">{session.title ?? 'Untitled'}</span>
              <span className="text-muted-foreground ml-auto text-xs">
                {formatRelativeTime(session.lastActive)}
              </span>
            </CommandItem>
          ))}
        </CommandGroup>
      )}
    </>
  );
}
```

### Feature 5: Micro-interactions

All animations use motion.dev and respect `prefers-reduced-motion` via the existing `<MotionConfig reducedMotion="user">` wrapper in `App.tsx`.

#### 5a. Sliding Selection Indicator

The highest-impact single animation. A `motion.div` with `layoutId="cmd-palette-selection"` creates a sliding pill effect as keyboard focus moves between items.

**Implementation**: Inside each `CommandItem`, render a `motion.div` with `position: absolute` when `data-selected="true"`. The `layoutId` causes motion.dev to animate the position between items.

```tsx
// Inside AgentCommandItem (and other CommandItem wrappers)
<CommandItem className="relative" {...props}>
  {isSelected && (
    <motion.div
      layoutId="cmd-palette-selection"
      className="bg-accent absolute inset-0 rounded-sm"
      transition={{ type: 'spring', stiffness: 500, damping: 40 }}
    />
  )}
  <div className="relative z-10">{/* item content */}</div>
</CommandItem>
```

**cmdk compatibility note**: The `data-selected` attribute is managed by cmdk internally. To detect selection, observe the `[data-selected=true]` attribute via a wrapper or use cmdk's value tracking. The selection indicator wraps the *content* inside `CommandItem`, not the `CommandItem` itself, to avoid interfering with cmdk's keyboard navigation.

#### 5b. Dialog Entrance

Spring scale + fade on open. Applied to the dialog's inner content container.

```tsx
const dialogVariants = {
  hidden: { opacity: 0, scale: 0.96, y: -8 },
  visible: {
    opacity: 1, scale: 1, y: 0,
    transition: { type: 'spring', stiffness: 500, damping: 35 },
  },
  exit: {
    opacity: 0, scale: 0.96, y: -8,
    transition: { duration: 0.12 },
  },
};
```

#### 5c. Stagger Entrance

Items stagger in on initial open and page transitions only (not on every keystroke).

```tsx
const listVariants = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.04, delayChildren: 0.05 },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: -4 },
  visible: {
    opacity: 1, y: 0,
    transition: { type: 'spring', stiffness: 400, damping: 30 },
  },
};
```

Limit stagger to the first 8 visible items. Items beyond the fold render immediately without animation.

#### 5d. Page Transition

Directional x-axis slide when navigating between pages.

```tsx
<AnimatePresence mode="wait" initial={false}>
  <motion.div
    key={page ?? 'root'}
    initial={{ opacity: 0, x: page ? 16 : -16 }}
    animate={{ opacity: 1, x: 0 }}
    exit={{ opacity: 0, x: page ? -16 : 16 }}
    transition={{ duration: 0.15, ease: 'easeOut' }}
  >
    {/* Current page content */}
  </motion.div>
</AnimatePresence>
```

#### 5e. Item Hover

Subtle 2px rightward nudge on hover (Linear pattern).

```tsx
<motion.div
  whileHover={{ x: 2 }}
  transition={{ type: 'spring', stiffness: 600, damping: 40 }}
>
  {/* CommandItem content */}
</motion.div>
```

#### 5f. PaletteFooter

Dynamic keyboard hint bar at the bottom of the palette. Shows context-appropriate shortcuts.

```tsx
export function PaletteFooter({ page, hasSelection }: PaletteFooterProps) {
  return (
    <div className="border-t px-3 py-1.5 flex items-center gap-4 text-xs text-muted-foreground">
      <span><kbd>up/down</kbd> Navigate</span>
      {!page && hasSelection && <span><kbd>Enter</kbd> Open</span>}
      {!page && <span><kbd>Cmd+Enter</kbd> New Tab</span>}
      {page && <span><kbd>Backspace</kbd> Back</span>}
      <span className="ml-auto"><kbd>esc</kbd> Close</span>
    </div>
  );
}
```

### Contextual Suggestions

A client-side rules engine produces up to 3 contextual suggestion items shown in a "Suggestions" group at the top of the zero-query palette.

**Rules** (computed from existing hooks, no new endpoints):

1. **"Continue session"** — If the most recent session in the current CWD was active less than 1 hour ago
2. **"N active Pulse runs"** — If `useActiveRunCount()` returns > 0, suggest opening Pulse
3. **"Switch back to {previousAgent}"** — If the user recently switched agents, offer to switch back

**Previous agent tracking**: Add `previousCwd: string | null` to Zustand app-store. Set when an agent switch occurs (before updating `selectedCwd`). Cleared when the palette closes or the user explicitly dismisses.

### Zustand State Changes

Add to `app-store.ts`:

```tsx
// New fields
previousCwd: string | null;
setPreviousCwd: (cwd: string | null) => void;
```

These are minimal additions — no structural changes to the store.

### Data Flow

```
User presses Cmd+K
  -> useGlobalPalette() sets globalPaletteOpen: true
  -> CommandPaletteDialog opens (spring scale+fade animation)
  -> usePaletteItems() assembles groups:
      -> Contextual suggestions (from Pulse/session/previousAgent state)
      -> Recent agents (frecency-sorted, Slack bucket algorithm)
      -> Features (static)
      -> Quick actions (static)
  -> User types search:
      -> usePaletteSearch() detects prefix (@, >, or none)
      -> Fuse.js filters + scores items, returns match indices
      -> Results render with HighlightedText (bold matched chars)
      -> Items stagger-animate into position (open only, not every keystroke)
  -> User arrows to agent:
      -> Selection indicator slides via layoutId
      -> Preview panel slides in (right side, 200ms spring)
      -> usePreviewData() aggregates: health, sessions (100ms debounce via useDeferredValue)
  -> User presses Enter on agent:
      -> Pages stack pushes 'agent-actions'
      -> AgentSubMenu renders: Open Here, Open in New Tab, New Session, Recent Sessions
      -> Directional slide animation (left to right)
  -> User presses Cmd+Enter on agent (fast path):
      -> Opens agent CWD in new browser tab
      -> Records frecency
      -> Closes palette
  -> User selects action in sub-menu:
      -> Execute action (switch cwd, window.open, etc.)
      -> Record frecency
      -> Close palette
```

## User Experience

### Zero-query State (palette just opened)

1. **Suggestions** (0-3 items) — contextual, computed from current state
2. **Recent Agents** (up to 5) — frecency-sorted, current agent pinned first with checkmark
3. **Features** — Pulse, Relay, Mesh, Settings (with keyboard shortcuts)
4. **Quick Actions** — New Session, Discover Agents, Browse Filesystem, Toggle Theme

### Searching

- Type freely — Fuse.js searches all categories with typo tolerance
- Type `@` — agent-only mode, Fuse.js searches agent names/paths
- Type `>` — command-only mode, Fuse.js searches command names/descriptions
- Matched characters are **bolded** in results via `HighlightedText`

### Agent Selection Flow

1. Arrow to an agent — preview panel slides in from right showing agent details
2. Press **Enter** — sub-menu opens with "Open Here", "Open in New Tab", "New Session", recent sessions
3. Press **Cmd+Enter** — fast path: opens in new tab directly, skipping sub-menu
4. In sub-menu, press **Backspace** (empty input) or **Escape** — goes back to main list
5. After action completes — frecency is recorded, palette closes

### Keyboard Shortcuts (shown in PaletteFooter)

| Key | Context | Action |
|---|---|---|
| Up / Down | Always | Navigate items |
| Enter | Agent selected | Open sub-menu |
| Enter | Sub-menu action | Execute action |
| Cmd+Enter | Agent selected | Open in new tab (fast path) |
| Backspace | Empty input, in sub-menu | Go back one level |
| Escape | In sub-menu | Go back one level |
| Escape | Root level | Close palette |

## Testing Strategy

### Unit Tests

**use-palette-search.test.ts** — Tests Fuse.js integration:
- Returns all items when search is empty
- Filters by `@` prefix (agents only)
- Filters by `>` prefix (commands only)
- Returns match indices for highlighting
- Handles typo-tolerant matching (e.g., "autth" matches "Auth Service")
- Empty results when no match
- Scores exact matches higher than partial matches

**use-agent-frecency.test.ts** — Tests bucket algorithm:
- Bucket score calculation for each time window (4h, 24h, 72h, 1w, 1mo, 3mo)
- Score formula: `totalCount * bucketSum / min(timestamps.length, 10)`
- Recording a visit adds timestamp and increments totalCount
- Timestamps array capped at 10 entries (most recent first)
- getSortedAgentIds returns agents ordered by frecency score
- Migration: new storage key doesn't conflict with old data
- Graceful degradation when localStorage unavailable

**use-preview-data.test.ts** — Tests data aggregation:
- Returns session count and recent sessions for agent CWD
- Returns health data when available
- Returns null health when agent has no health data
- Filters sessions by agent CWD correctly

**HighlightedText** — Tests rendering:
- Renders plain text when no indices
- Renders `<mark>` elements for matched ranges
- Handles adjacent/overlapping ranges
- Handles matches at string boundaries (start, end)
- All content rendered via React createElement (no raw HTML injection)

### Integration Tests

**CommandPaletteDialog.test.tsx** — Update existing tests + add:
- Preview panel appears when agent is selected (via arrow key simulation)
- Preview panel hidden on mobile
- Sub-menu opens on Enter for agent items
- Backspace in sub-menu goes back to root
- Escape in sub-menu goes back (not closes dialog)
- `@` prefix shows only agents
- `>` prefix shows only commands
- Fuse.js match highlighting renders `<mark>` elements
- PaletteFooter shows correct hints for root vs. sub-menu context
- Contextual suggestions appear based on state

### Mocking Strategies

- **Fuse.js**: No need to mock — it's a pure function library. Test with real Fuse instances against mock data.
- **motion.dev**: Mock `motion/react` to render plain `div`/`span` elements (existing pattern in project tests).
- **Entity hooks**: Mock `useSessions`, `useMeshAgentHealth`, `useActiveRunCount` via `vi.mock()` to control preview panel content.
- **localStorage**: Use `vi.spyOn(Storage.prototype, 'getItem')` / `setItem` for frecency tests.
- **ResizeObserver/scrollIntoView**: Already mocked in existing test setup (required by cmdk).

## Performance Considerations

- **Pre-load all data**: Agent list, command list, and feature items are loaded before the palette opens via TanStack Query with `staleTime: 30000`.
- **Fuse.js instance memoization**: Create the Fuse instance once per item list change (via `useMemo`), not on every search.
- **Debounce preview data**: `useDeferredValue(selectedItemId)` prevents unnecessary preview fetches during rapid arrow key navigation.
- **Stagger budget**: Limit stagger animation to first 8 visible items. Items below the fold render immediately.
- **Animation budget**: All palette animations complete in under 200ms total. Dialog open: 150ms. Stagger per item: 40ms. Page transition: 150ms.
- **Fuse.js bundle size**: 24kb gzipped — acceptable for a client app. Only imported in the palette feature module.

## Security Considerations

- **Character highlighting**: `HighlightedText` builds React nodes from index pairs using `React.createElement`. All content passes through React's escaping pipeline. No raw HTML APIs are used.
- **localStorage frecency**: Only stores agent IDs (opaque identifiers) and timestamps. No paths, names, or sensitive data in the frecency store.
- **Preview panel data**: All data comes from existing entity hooks that already enforce server-side access controls.

## Documentation

- Update `contributing/keyboard-shortcuts.md` with new palette shortcuts (Cmd+Enter, `>` prefix)
- Update `contributing/animations.md` with `layoutId` selection indicator pattern and stagger-on-open pattern
- ADR-0063 status: update from "proposed" to "accepted" (palette is now implemented and being enhanced)

## Implementation Phases

### Phase 1: Search + Frecency Foundation

- Install `fuse.js` in `apps/client/`
- Create `use-palette-search.ts` with Fuse.js integration, prefix detection
- Create `HighlightedText.tsx` component
- Upgrade `use-agent-frecency.ts` to Slack bucket system (new storage key)
- Update `CommandPaletteDialog.tsx` to use `shouldFilter={false}` and render highlights
- Add `>` command prefix support
- Update and add unit tests

### Phase 2: Sub-menu + Preview Panel

- Add pages stack to `CommandPaletteDialog.tsx`
- Create `AgentSubMenu.tsx` with actions + recent sessions
- Implement Escape/Backspace navigation with `e.stopPropagation()`
- Add breadcrumb indicator
- Create `AgentPreviewPanel.tsx` with agent context
- Create `use-preview-data.ts` hook
- Add `previousCwd` to Zustand store
- Add CSS height transition on `[cmdk-list]`
- Update and add tests

### Phase 3: Micro-interactions + Polish

- Add sliding selection indicator (`layoutId="cmd-palette-selection"`)
- Add dialog entrance animation (spring scale + fade)
- Add stagger entrance (on open + page transitions only)
- Add page transition animation (directional x-axis slide)
- Add item hover nudge (2px x offset)
- Create `PaletteFooter.tsx` with dynamic keyboard hints
- Add contextual suggestions group to `usePaletteItems`
- Final integration testing and animation tuning

## Open Questions

1. ~~**Fuse.js threshold tuning**~~ (RESOLVED)
   **Answer:** Use `threshold: 0.3` (tight matching)
   **Rationale:** Agent names and paths are precise terms. Tighter matching reduces noise. Can always loosen later.

2. ~~**Preview panel width breakpoint**~~ (RESOLVED)
   **Answer:** Hide preview panel below 900px viewport width
   **Rationale:** The 720px dialog needs comfortable margins. Below 900px the preview would feel cramped.

3. ~~**Frecency migration**~~ (RESOLVED)
   **Answer:** Start fresh with new storage key (`dorkos:agent-frecency-v2`)
   **Rationale:** Zero migration code. Old data ages out naturally. Clean slate for the new bucket algorithm.

4. ~~**Cmd+Enter on non-agent items**~~ (RESOLVED)
   **Answer:** Agents only
   **Rationale:** "Open in new tab" only makes sense for agents. No meaningful new-tab action for features or commands.

## Related ADRs

- **ADR-0063**: Use Shadcn CommandDialog for Global Agent Command Palette — establishes the palette architecture
- **ADR-0062**: Remove Mesh Feature Flag, Always-On — ensures mesh data is always available for the palette

## References

- [Fuse.js documentation — includeMatches, scoring](https://www.fusejs.io/)
- [cmdk — pages pattern, shouldFilter](https://github.com/pacocoursey/cmdk)
- [Slack Engineering — A Faster, Smarter Quick Switcher (frecency)](https://slack.engineering/a-faster-smarter-quick-switcher/)
- [motion.dev — layoutId, AnimatePresence, stagger](https://motion.dev/docs)
- [Raycast List API — isShowingDetail](https://developers.raycast.com/api-reference/user-interface/list)
- Research: `research/20260303_command_palette_10x_elevation.md`
- Ideation: `specs/command-palette-10x/01-ideation.md`
- Parent spec: `specs/agent-centric-ux/02-specification.md` (spec #85)
