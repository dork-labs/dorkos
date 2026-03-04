---
title: "Command Palette 10x Elevation — Preview Panels, Fuzzy Highlighting, Sub-menus, Animations, Smart Suggestions"
date: 2026-03-03
type: external-best-practices
status: active
tags: [command-palette, cmdk, shadcn, motion-dev, fuzzy-search, ufuzzy, fuse-js, frecency, sub-menu, preview-panel, animation, stagger, micro-interactions]
feature_slug: command-palette-10x
searches_performed: 18
sources_count: 32
---

# Command Palette 10x Elevation — Best Practices and Technical Patterns

## Prerequisite: Existing Research

See `research/20260303_command_palette_agent_centric_ux.md` for the foundational patterns (cmdk API, Cmd+K binding, frecency basics, group structure, FSD placement). This report covers the *elevation* layer: the features that separate a good palette from a world-class one.

---

## Research Summary

The five areas covered are: (1) preview/detail panels, (2) contextual smart suggestions via frecency, (3) fuzzy search with character-level match highlighting, (4) sub-menu drill-down, and (5) micro-interactions and animation. The strongest industry references are Raycast (preview panels, frecency, stagger), Linear (speed-first keyboard UX), Superhuman (shortcut education, visual feedback), VS Code (prefix scoping, fuzzy scoring), and Slack (bucket-based frecency). cmdk provides the foundational hooks for all of these. uFuzzy is the recommended fuzzy library. motion.dev provides the animation layer. No new API endpoints are required for any of these features.

---

## Key Findings

### 1. Preview Panels: Raycast List+Detail Pattern

Raycast's most-copied pattern is the split-view: a command list on the left, a live detail/preview panel on the right. This is controlled by the `isShowingDetail` flag on the List component. In web implementations with cmdk, the equivalent is a flex-row container where `CommandList` takes ~40% width and a `PreviewPane` takes ~60%.

Key Raycast design rules for the detail panel:
- When the detail panel is visible, do not show accessories on list items — bring that info into the detail view only (avoids duplication).
- The detail view renders markdown and structured metadata (labels, links, tags).
- The panel appears/disappears via a toggle, not by navigating to a separate route.
- Use lazy/deferred data: the detail panel loads content only for the currently-selected item, debounced by ~100ms to avoid fetching on rapid arrow-key traversal.

For DorkOS agent items, the detail panel would show: agent name + color chip, CWD path, persona description, active session count, recent session titles, and mesh status.

### 2. Contextual Smart Suggestions: Slack's Bucket Frecency

Slack's Quick Switcher uses a bucket-based frecency system:

| Time Window | Points |
|---|---|
| Past 4 hours | 100 |
| Past day | 80 |
| Past 3 days | 60 |
| Past week | 40 |
| Past month | 20 |
| Past 90 days | 10 |
| Beyond 90 days | 0 |

**Scoring formula**: `Total Count * Bucket Score / min(visitCount, 10)`

The denominator caps at 10 timestamps. This elegantly handles "I visited this 100 times a year ago" — old activity decays because newer contacts accumulate points in higher-value buckets and can eventually outrank it.

Slack also stores both query-based entries ("typed 'Hu'") and ID-based entries (target object ID), awarding half-points for ID matches to avoid overriding direct query patterns.

For DorkOS, the zero-query state should show:
- Top 5 agents by frecency score
- Current agent pinned first (regardless of frecency)
- 3-4 recently-used feature commands (Pulse, Relay, Mesh, Discover)

### 3. Fuzzy Search with Character Highlighting

Three libraries compared:

**uFuzzy** (`@leeoniya/ufuzzy`, 4kb):
- Returns `info.ranges` — pairs of `[startIdx, endIdx]` character positions.
- `uFuzzy.highlight(haystack[i], ranges[i], markFn)` generates highlighted output with character granularity.
- Scoring bonuses for: consecutive matches, word boundary matches, prefix matches.
- Does NOT support typo-tolerance (no transpositions). It's "inter-word fuzzy, intra-word exact."
- Best for: developer tool palettes where input terms are precise (agent names, cwd paths, command names).

**Fuse.js** (`fuse.js`, 24kb):
- Returns match indices via `includeMatches: true` option. Each match has a `key`, `value`, and `indices` array of `[start, end]` pairs.
- Supports typo-tolerance (Levenshtein distance, configurable threshold).
- Scoring factors: location in string, length of match, distance from start.
- Best for: content search where users may misspell queries.

**cmdk's built-in filter**:
- No match indices returned — cannot highlight matched characters.
- Uses a simple scoring function: returns 0 (hidden) or a score between 0-1.
- Very fast, zero dependencies.
- Best for: basic palettes where highlighting is not required.

**match-sorter** (`match-sorter`, 3kb):
- Ranking tiers: `CASE_SENSITIVE_EQUAL`, `EQUAL`, `STARTS_WITH`, `WORD_STARTS_WITH`, `CONTAINS`, `ACRONYM`, `MATCHES`, `NO_MATCH`.
- Does NOT return match indices. Pair with `highlight-matches-utils` for highlighting.
- Best for: ranking where hierarchy matters (exact matches beat word-start matches beat substring matches).

**Recommendation for DorkOS**: uFuzzy. Rationale:
1. Agent names and cwd paths are precise terms — typo-tolerance isn't valuable.
2. The `info.ranges` output gives character-level positions for React highlighting without innerHTML.
3. 4kb vs Fuse.js's 24kb.
4. Fastest of the three for list sizes < 5,000 items.

**React highlighting pattern with uFuzzy** (safe, no innerHTML):

```tsx
import uFuzzy from '@leeoniya/ufuzzy';

const uf = new uFuzzy({ intraMode: 0 });

function highlightMatches(text: string, ranges: number[]): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let lastIdx = 0;

  for (let i = 0; i < ranges.length; i += 2) {
    const start = ranges[i];
    const end = ranges[i + 1];

    if (lastIdx < start) {
      parts.push(<span key={`plain-${i}`}>{text.slice(lastIdx, start)}</span>);
    }
    parts.push(
      <mark
        key={`match-${i}`}
        className="bg-transparent text-foreground font-semibold"
      >
        {text.slice(start, end)}
      </mark>
    );
    lastIdx = end;
  }

  if (lastIdx < text.length) {
    parts.push(<span key="tail">{text.slice(lastIdx)}</span>);
  }

  return parts;
}

// Usage: render result items with highlights
function AgentResultItem({ agent, ranges }: { agent: Agent; ranges: number[] }) {
  return (
    <div className="flex items-center gap-2">
      <span className="font-medium">
        {highlightMatches(agent.name, ranges)}
      </span>
      <span className="text-muted-foreground text-sm">
        {agent.cwd}
      </span>
    </div>
  );
}
```

This approach builds React nodes directly from range pairs — no innerHTML involved. Safe against XSS by construction because all content goes through React's element creation, not raw DOM injection.

### 4. Sub-menu Drill-Down Pattern

cmdk's official "pages" pattern is a clean stack-based approach:

```tsx
const [pages, setPages] = useState<string[]>([]);
const page = pages[pages.length - 1]; // current page = last element
const [search, setSearch] = useState('');

function goBack() {
  setPages((prev) => prev.slice(0, -1));
  setSearch('');
}

return (
  <Command
    onKeyDown={(e) => {
      // Backspace when input is empty, or Escape = go back
      if ((e.key === 'Backspace' && !search) || e.key === 'Escape') {
        if (pages.length > 0) {
          e.preventDefault();
          e.stopPropagation(); // prevent dialog close on Escape
          goBack();
        }
      }
    }}
  >
    <CommandInput
      value={search}
      onValueChange={setSearch}
      placeholder={page ? `Search ${page}...` : 'Search...'}
    />

    {/* Breadcrumb indicator */}
    {pages.length > 0 && (
      <div className="px-3 py-1 text-xs text-muted-foreground border-b flex items-center gap-1">
        <span>All</span>
        {pages.map((p, i) => (
          <span key={i}> / {p}</span>
        ))}
      </div>
    )}

    <CommandList>
      {/* Root page */}
      {!page && (
        <>
          <CommandItem onSelect={() => { setPages(['agent-actions']); setSearch(''); }}>
            Agent Actions...
          </CommandItem>
          <CommandItem onSelect={() => { setPages(['settings']); setSearch(''); }}>
            Settings...
          </CommandItem>
        </>
      )}

      {/* Sub-page: agent-actions */}
      {page === 'agent-actions' && (
        <>
          <CommandItem>Start New Session</CommandItem>
          <CommandItem>View Session History</CommandItem>
          <CommandItem>Edit Agent Identity</CommandItem>
        </>
      )}
    </CommandList>
  </Command>
);
```

**Height animation**: cmdk provides `--cmdk-list-height` CSS variable. Apply a transition on the list to animate height changes between pages:

```css
[cmdk-list] {
  height: var(--cmdk-list-height);
  transition: height 150ms cubic-bezier(0.4, 0, 0.2, 1);
  overflow: hidden;
}
```

**Escape handling**: The critical detail is `e.stopPropagation()` when pages exist — otherwise Escape closes the entire dialog instead of going back one level. Only let Escape propagate (to close the dialog) when `pages.length === 0`.

**Breadcrumb display**: Show a compact breadcrumb path below the input to orient the user in the hierarchy. This is the pattern VS Code uses in multi-step quick picks.

### 5. Micro-interactions and Animation Patterns

**Stagger entrance for search results:**

```tsx
import { motion, AnimatePresence } from 'motion/react';

const listVariants = {
  hidden: {},
  visible: {
    transition: {
      staggerChildren: 0.04,   // 40ms between each item
      delayChildren: 0.05,     // 50ms before first item starts
    },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: -4 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { type: 'spring', stiffness: 400, damping: 30 },
  },
};

// Wrap CommandList children
<motion.div
  key={search} // re-trigger stagger on query change
  variants={listVariants}
  initial="hidden"
  animate="visible"
>
  {results.map((item) => (
    <motion.div key={item.id} variants={itemVariants}>
      <CommandItem>...</CommandItem>
    </motion.div>
  ))}
</motion.div>
```

**Important caveats for cmdk + motion stagger**:
- Do NOT stagger on every keystroke — only stagger on initial open + large result set changes (debounce by 150ms).
- Keep stagger delay short: 30-50ms per item max. More than 60ms feels sluggish.
- Limit animated items to the first 8-10 visible results. Items beyond the fold render instantly.
- The `key={search}` on the container re-mounts and re-triggers the stagger animation when the query changes significantly.

**Dialog entrance:**

```tsx
const dialogVariants = {
  hidden: { opacity: 0, scale: 0.96, y: -8 },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: { type: 'spring', stiffness: 500, damping: 35 }
  },
  exit: {
    opacity: 0,
    scale: 0.96,
    y: -8,
    transition: { duration: 0.12 }
  },
};
```

**Item hover micro-interaction:**

```tsx
<motion.div
  whileHover={{ x: 2 }}
  transition={{ type: 'spring', stiffness: 600, damping: 40 }}
>
  <CommandItem>...</CommandItem>
</motion.div>
```

Subtle rightward nudge on hover (2px) signals interactivity without distraction. Used by Linear for their command items.

**Page transition animation** (between sub-menu levels):

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

Directional slide: entering a sub-menu slides in from the right; going back slides in from the left. Uses `mode="wait"` so exit completes before enter starts.

**Preview panel slide-in:**

```tsx
<AnimatePresence>
  {selectedItem && (
    <motion.div
      initial={{ opacity: 0, width: 0 }}
      animate={{ opacity: 1, width: '60%' }}
      exit={{ opacity: 0, width: 0 }}
      transition={{ type: 'spring', stiffness: 400, damping: 35 }}
      className="border-l overflow-hidden"
    >
      <PreviewContent item={selectedItem} />
    </motion.div>
  )}
</AnimatePresence>
```

**Selection indicator animation**: When keyboard focus moves between items, the selection background should slide rather than snap. Use `layout` animation on the selection indicator:

```tsx
{isSelected && (
  <motion.div
    layoutId="command-palette-selection"
    className="absolute inset-0 bg-accent rounded-md"
    transition={{ type: 'spring', stiffness: 500, damping: 40 }}
  />
)}
```

This creates a "sliding pill" effect as the user arrows through results — the same pattern used by Raycast and Vercel's command menu. Requires the indicator to be a separate element with `layoutId` and `position: absolute`.

**Keyboard shortcut badge entrance:**

```tsx
<motion.kbd
  initial={{ opacity: 0, scale: 0.8 }}
  animate={{ opacity: 1, scale: 1 }}
  transition={{ delay: 0.3 }}
  className="..."
>
  K
</motion.kbd>
```

Keyboard badges fade in slightly after the item to draw the eye to them without competing with the primary label.

**Post-action feedback**: After a command executes successfully, Superhuman's pattern is a brief highlight/flash on the affected element. For DorkOS, this could be a toast or a brief green flash on the sidebar's agent indicator after "Switch to agent" executes.

---

## Detailed Analysis

### Preview Panel Layout Approaches

**Approach A: Side-by-side (Raycast-style)**

```
+---------------------------------------------+
| Search Input                                |
+--------------------+------------------------+
| List (40%)         | Preview Pane (60%)     |
| > Agent: my-api    | [*] my-api-agent       |
|   Agent: marketing | ~/projects/my-api      |
|   New Session      | "Builds the REST API"  |
|   Pulse Scheduler  | -----------------------|
|                    | 3 active sessions      |
|                    | Status: healthy        |
+--------------------+------------------------+
```

Layout: `<div className="flex">` containing `<CommandList className="w-2/5">` and `<PreviewPane className="w-3/5 border-l">`.

Pros: Rich contextual info, premium feel, matches Raycast exactly.
Cons: Requires wider dialog (700-900px), content needed per item type.

**Approach B: Expanding detail below (Notion-style)**

The selected item expands vertically to show detail inline. Collapsed items show one line; selected item shows 3-4 lines.

Pros: Works at any dialog width.
Cons: Causes list height jitter; `--cmdk-list-height` transition can feel laggy with many items.

**Approach C: Tooltip/popover on the right edge**

A small popover appears to the right of the dialog when an item is selected.

Pros: Does not change dialog width.
Cons: Can be clipped by viewport edges; feels disconnected.

**Recommendation**: Approach A for agent items specifically. Not all item types need a preview — only items with rich data (agents, sessions). Use `shouldShowPreview` flag that's true only when the selected item is an agent or session.

**Debouncing preview data loading**: Debounce 100-150ms on arrow key navigation before loading preview content. Prevents unnecessary fetches when quickly scrolling through results. Use `useDeferredValue` or `useDebounce` hook on the `selectedItemId`.

### Fuzzy Search Comparison Table

| Feature | uFuzzy | Fuse.js | cmdk built-in | match-sorter |
|---|---|---|---|---|
| Character highlighting | Yes (ranges) | Yes (indices) | No | No (needs helper lib) |
| Typo-tolerance | No | Yes | No | No |
| Bundle size | 4kb | 24kb | 0 (included) | 3kb |
| Speed (10k items) | ~5ms | ~40ms | ~2ms | ~10ms |
| Word boundary bonus | Yes | Configurable | N/A | Yes (ranking tiers) |
| Consecutive bonus | Yes | N/A | N/A | No |
| TypeScript | Yes | Yes | Yes | Yes |
| React highlighting | Ranges to nodes | Indices to nodes | None | With helper lib |

For a command palette with fewer than 200 items (DorkOS's typical agent + command count), performance differences are negligible. The deciding factor is highlighting capability and typo-tolerance need.

### Frecency Algorithm Implementation

Slack's bucket system, adapted for DorkOS:

```typescript
// entities/agent/model/use-agent-frecency.ts

const STORAGE_KEY = 'dorkos:agent-frecency-v2';
const MAX_TIMESTAMPS = 10;

interface FrecencyRecord {
  agentId: string;
  timestamps: number[];   // most recent first, capped at MAX_TIMESTAMPS
  totalCount: number;
}

function getBucketScore(timestamp: number): number {
  const ageMs = Date.now() - timestamp;
  const ageHours = ageMs / (1000 * 60 * 60);

  if (ageHours < 4)    return 100;
  if (ageHours < 24)   return 80;
  if (ageHours < 72)   return 60;
  if (ageHours < 168)  return 40;
  if (ageHours < 720)  return 20;
  if (ageHours < 2160) return 10;
  return 0;
}

export function computeFrecencyScore(record: FrecencyRecord): number {
  const bucketSum = record.timestamps.reduce(
    (sum, ts) => sum + getBucketScore(ts),
    0
  );
  // Slack formula: totalCount * bucketSum / min(timestamps.length, MAX_TIMESTAMPS)
  return (record.totalCount * bucketSum) / Math.min(record.timestamps.length, MAX_TIMESTAMPS);
}

export function recordAgentVisit(agentId: string): void {
  const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
  const existing: FrecencyRecord = stored[agentId] ?? { agentId, timestamps: [], totalCount: 0 };

  existing.timestamps = [Date.now(), ...existing.timestamps].slice(0, MAX_TIMESTAMPS);
  existing.totalCount += 1;

  stored[agentId] = existing;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
}

export function getSortedAgentIds(agentIds: string[]): string[] {
  const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
  return [...agentIds].sort((a, b) => {
    const scoreA = stored[a] ? computeFrecencyScore(stored[a]) : 0;
    const scoreB = stored[b] ? computeFrecencyScore(stored[b]) : 0;
    return scoreB - scoreA;
  });
}
```

### cmdk Integration with External Fuzzy Search

When using uFuzzy instead of cmdk's built-in filter:

```tsx
<Command shouldFilter={false}>
  <CommandInput
    value={search}
    onValueChange={(val) => {
      setSearch(val);
      if (val) {
        const idxs = uf.filter(haystack, val);
        const info = uf.info(idxs, haystack, val);
        const order = uf.sort(info, haystack, val);
        setFilteredResults(order.map(i => ({
          item: allItems[info.idx[i]],
          ranges: info.ranges[i],
        })));
      } else {
        setFilteredResults(frecencyOrderedItems.map(item => ({ item, ranges: [] })));
      }
    }}
  />
  <CommandList>
    {filteredResults.map(({ item, ranges }) => (
      <CommandItem key={item.id} value={item.id}>
        <HighlightedText text={item.name} ranges={ranges} />
      </CommandItem>
    ))}
  </CommandList>
</Command>
```

Key: `shouldFilter={false}` disables cmdk's internal filter. You manage filtering, sorting, and result construction externally. cmdk still handles keyboard navigation, selection, and accessibility.

### Best-in-Class Pattern Summary

| Tool | Signature Pattern | What Makes It Great |
|---|---|---|
| Raycast | Split-view list+detail | Rich context without navigation; preview debounced on selection |
| Linear | Speed-first, zero-latency | Palette opens in under 50ms; all data pre-loaded; no network on search |
| VS Code | Prefix scoping (>, @, :) | Mental model clarity; one palette handles files, commands, symbols |
| Superhuman | Shortcut education via palette | Keyboard shortcuts displayed, muscle memory transfer |
| Slack | Bucket frecency | Smart ranking without ML; pure client-side; decays naturally |
| Vercel | Sliding selection indicator | Animated layoutId pill feels native, not "webby" |

---

## Security Considerations

- **localStorage for frecency**: Only store agent IDs (opaque identifiers), never full paths, names, or descriptions. The frecency store is not sensitive data, but cwd paths could expose directory structure to cross-origin scripts in a browser extension context.
- **Character highlighting**: Build React nodes from range pairs rather than injecting HTML strings into the DOM. The `highlightMatches` function above returns `React.ReactNode[]` — React's createElement pipeline handles escaping automatically. This is safe against XSS by construction. Never pass highlight output to any property that accepts raw HTML.
- **uFuzzy highlight function**: Use the marker function form that returns DOM nodes/React elements, not the HTML string form. The library supports both; choose the node-based form for React usage.

---

## Performance Considerations

- **Pre-load all palette data**: The palette should have agent list, command list, and feature items loaded before the user opens it. Use TanStack Query with `staleTime: 30000` — data is fresh enough, fetched in the background.
- **Virtual list for large result sets**: If agent count ever exceeds 50-100 items, consider `@tanstack/react-virtual` for the CommandList. For typical DorkOS deployments (fewer than 50 agents), not needed.
- **Debounce uFuzzy execution**: 50ms debounce on the search input value change before running uFuzzy. At 4kb and fewer than 200 items this is imperceptible, but prevents unnecessary work during fast typing.
- **Limit animated items**: Only apply stagger/entrance animations to the first 8 visible results. Items below the fold render immediately without animation.
- **Preview pane lazy loading**: Use `useDeferredValue(selectedItemId)` to defer preview panel data fetching. This keeps arrow key navigation instantaneous even if preview data requires a network request.
- **Animation budget**: Keep all command palette animations under 200ms total duration. Any longer and the palette feels like it's in the way rather than helping. The dialog enter/exit is 120-150ms; stagger per item is 30-40ms max.

---

## Potential Solutions

### Feature 1: Preview Panel

**Option A: Always-visible side panel (Raycast style)**
- Layout: flex-row dialog, min width 700px, list on left (40%), preview on right (60%)
- Shows only for item types that have rich data (agents, sessions)
- Empty state for items without previews: subtle "No preview available" text
- Pros: Premium feel, matches the gold standard; Cons: Requires wider dialog, content modeling per type

**Option B: On-demand expandable detail (below selection)**
- Use `--cmdk-list-height` CSS var + transition to expand selected item in place
- No additional dialog width needed
- Pros: Works at any screen size; Cons: Causes reflow jitter, more jarring

**Option C: Hover/selection tooltip**
- Floating panel appears to the right of the dialog on item focus
- Pros: Zero layout impact; Cons: Clipping on narrow screens, feels disconnected

**Recommendation**: Option A with `selectedItemId` debounced 100ms. Only show preview pane when an agent or session item is selected (guard with `itemType === 'agent' || itemType === 'session'`). Dialog expands from 560px to 900px using `motion.div` width animation when preview is first triggered.

### Feature 2: Smart Suggestions (Frecency)

**Option A: Slack bucket system** (recommended)
- 6 time buckets, `totalCount * bucketSum / min(visits, 10)`
- Pure client-side, localStorage
- Pros: Battle-tested, decays naturally, no ML needed

**Option B: Simple recency-weighted scoring**
- `score = useCount * 0.3 + (Date.now() - lastUsed) * -0.0001`
- From the existing research in `20260303_command_palette_agent_centric_ux.md`
- Pros: Simpler; Cons: Does not decay as naturally, old high-frequency items stay ranked too long

**Option C: Server-side personalization**
- Persist frecency to server, sync across devices
- Pros: Works on fresh machines; Cons: Requires new API, latency, complexity

**Recommendation**: Option A (Slack buckets). More robust decay than Option B. Option C is out of scope.

### Feature 3: Fuzzy Search with Highlighting

**Option A: uFuzzy** (recommended)
- 4kb, range-based highlighting, word boundary bonuses
- React-safe node construction from ranges
- Integrate with `shouldFilter={false}` on cmdk

**Option B: Fuse.js**
- 24kb, typo-tolerant, index-based highlighting
- More appropriate if users search content (not names)

**Option C: cmdk built-in + no highlighting**
- Zero added dependency, but no character highlighting
- Acceptable for v1; upgrade path to uFuzzy later

**Recommendation**: Option A (uFuzzy). The 4kb cost is worth the highlighting capability. Developer tools have precise queries — typo-tolerance adds noise.

### Feature 4: Sub-menu Drill-down

**Option A: cmdk pages stack** (recommended)
- `const [pages, setPages] = useState<string[]>([])`
- Backspace-when-empty goes back; Escape goes back (stops propagation) or closes
- CSS height transition on `--cmdk-list-height`
- `AnimatePresence mode="wait"` with directional slide

**Option B: Separate dialogs per level**
- Each sub-menu opens a new `CommandDialog`
- Pros: Clean isolation; Cons: Heavy, loses search context, worse keyboard UX

**Option C: Tab-based scoping (VS Code style)**
- Clicking an item changes the CommandInput prefix (`> `, `@ `, etc.)
- Pros: Visible context; Cons: Less intuitive for non-power-users

**Recommendation**: Option A. It's the cmdk-native pattern with the least friction.

### Feature 5: Micro-interactions and Animations

**Option A: Full motion.dev suite** (recommended)
- Dialog: spring scale+fade on open/close
- Selection indicator: `layoutId` sliding pill
- Page transitions: directional x-axis slide with `AnimatePresence mode="wait"`
- List stagger: variants with `staggerChildren: 0.04` on query change
- Hover: subtle x: 2 nudge on items
- Preview panel: width spring animation

**Option B: CSS-only transitions**
- Use Tailwind `transition-all`, `duration-150`, keyframes
- No motion.dev dependency additions
- Pros: Lighter; Cons: Cannot do layout animations (sliding pill requires FLIP), no stagger

**Option C: Minimal — only open/close animation**
- Just the dialog entrance/exit
- Pros: Safest performance; Cons: Feels flat compared to Raycast/Linear

**Recommendation**: Option A, but with `MotionConfig reducedMotion="user"` already wired in `App.tsx` to respect system preferences. The sliding pill (`layoutId`) alone makes the biggest perceptual quality jump.

---

## Implementation Priority Order

For DorkOS command-palette-10x, implement in this priority order:

1. **Sliding selection indicator** (layoutId pill) — highest impact, minimal effort. One `motion.div` with `layoutId="cmd-selection"` inside each `CommandItem`. The entire palette feels instantly more premium.

2. **uFuzzy with character highlighting** — replace cmdk's built-in filter with uFuzzy plus `shouldFilter={false}`. Add `HighlightText` component rendering React nodes from `info.ranges`. Zero new network requests.

3. **Slack bucket frecency** — implement `use-agent-frecency.ts` with the 6-bucket system. Record visits on agent switch. Sort zero-query results by frecency score. Current agent always pinned first.

4. **Sub-menu drill-down** — add pages stack for agent-specific actions (new session, edit identity, view sessions). Add CSS height transition. Add directional page slide with `AnimatePresence`.

5. **Dialog entrance animation** — spring scale+fade. Already partially supported by the existing `CommandDialog` wrapper; just add `motion.div` around inner content.

6. **Preview panel** — widest layout change, most content modeling work. Save for a dedicated spec. Use Option A (side panel) with 100ms debounce on selection.

---

## Sources & Evidence

- [uFuzzy GitHub — highlight API and ranges format](https://github.com/leeoniya/uFuzzy)
- [uFuzzy npm package](https://www.npmjs.com/package/@leeoniya/ufuzzy)
- [Extremely lightweight fuzzy + highlighted search with uFuzzy — swyx](https://swyxkit.netlify.app/ufuzzy-search)
- [Fuse.js — fuzzy search library](https://www.fusejs.io/)
- [match-sorter — deterministic best-match sorting](https://github.com/kentcdodds/match-sorter)
- [highlight-matches-utils — complement to match-sorter for highlighting](https://github.com/reyronald/highlight-matches-utils)
- [Slack Engineering — A Faster, Smarter Quick Switcher](https://slack.engineering/a-faster-smarter-quick-switcher/)
- [Firefox Frecency Ranking — source docs](https://firefox-source-docs.mozilla.org/browser/urlbar/ranking.html)
- [frecent — JavaScript frecency tracking library](https://github.com/johnsylvain/frecent)
- [Raycast List API with isShowingDetail](https://developers.raycast.com/api-reference/user-interface/list)
- [Raycast Detail component API](https://developers.raycast.com/api-reference/user-interface/detail)
- [cmdk GitHub — pages pattern, shouldFilter, CSS variables](https://github.com/dip/cmdk)
- [cmdk npm](https://www.npmjs.com/package/cmdk)
- [Command-K Mastery: CMDK Pages Pattern](https://reactlibs.dev/articles/command-k-mastery-cmdk-react/)
- [Motion.dev — stagger documentation](https://motion.dev/docs/stagger)
- [Motion.dev — AnimatePresence](https://motion.dev/docs/react-animate-presence)
- [Motion.dev — layout animations](https://motion.dev/docs/react-layout-animations)
- [Framer Motion stagger example — CodeSandbox](https://codesandbox.io/s/framer-motion-animate-presence-with-child-stagger-3lbs3)
- [Creating staggered animations with Framer Motion — Medium](https://medium.com/@onifkay/creating-staggered-animations-with-framer-motion-0e7dc90eae33)
- [Micro-animations in React with Framer Motion — Jacob Cofman](https://jcofman.de/blog/micro-animations)
- [How to build a remarkable command palette — Superhuman](https://blog.superhuman.com/how-to-build-a-remarkable-command-palette/)
- [Designing a Command Palette — Destiner](https://destiner.io/blog/post/designing-a-command-palette/)
- [Command Palette UX Patterns — Mobbin](https://mobbin.com/glossary/command-palette)
- [Command Palette UX Patterns #1 — Bootcamp/Medium](https://medium.com/design-bootcamp/command-palette-ux-patterns-1-d6b6e68f30c1)
- [Linear design — LogRocket](https://blog.logrocket.com/ux-design/linear-design/)
- [Awesome Command Palette — Stefan Judis GitHub](https://github.com/stefanjudis/awesome-command-palette)
- [Using Fuse.js with React for advanced search with highlighting — DEV](https://dev.to/noclat/using-fuse-js-with-react-to-build-an-advanced-search-with-highlighting-4b93)
- [shadcn/ui Command component](https://ui.shadcn.com/docs/components/command)
- [Vercel Command Menu changelog](https://vercel.com/changelog/command-menu-now-available-in-deployments)
- [PowerToys Command Palette overview](https://learn.microsoft.com/en-us/windows/powertoys/command-palette/overview)

---

## Research Gaps & Limitations

- **Linear's internal fuzzy algorithm** is not publicly documented. Based on visual inspection of the product, it appears to use word-boundary scoring similar to VS Code's but no source code is available.
- **Vercel's command menu animations** were not directly inspectable — the changelog only describes features, not the implementation. Reverse-engineering from their production app would require DevTools inspection.
- **Arc Browser command bar** patterns were not deeply documented in accessible sources. The pattern is similar to VS Code prefix scoping.
- **cmdk + motion.dev compatibility**: Known issue tracked in cmdk's GitHub — `AnimatePresence` wrapping `CommandItem` components can interfere with cmdk's keyboard navigation if the motion component intercepts synthetic events. Workaround: wrap the *content* inside `CommandItem`, not `CommandItem` itself.
- **Performance benchmarks for DorkOS item counts** are estimated from general library benchmarks. Actual perf testing on DorkOS's specific haystack sizes should be done during implementation.

---

## Contradictions & Disputes

- **Stagger on every keystroke vs. only on open**: Some implementations re-trigger stagger on every search query change. This can feel distracting. Preferred pattern: stagger only on open and on large categorical changes (e.g., switching from root to sub-menu page). Use `key` prop on the container to control re-mount.
- **uFuzzy vs. Fuse.js for typo-tolerance**: uFuzzy's author explicitly argues typo-tolerance is "noise" for developer tools where terms are precise. Fuse.js's author argues tolerance improves discoverability. For DorkOS's use case (agent names, cwd paths, command names), uFuzzy is correct.
- **Preview panel timing**: Raycast debounces preview at selection; some implementations load eagerly on hover. Eager loading causes more network requests and can cause visible "flash of preview" on rapid navigation. 100ms debounce on `selectedItemId` is the safe choice.

---

## Search Methodology

- Searches performed: 18
- Most productive terms: "uFuzzy highlight match ranges React", "Slack frecency algorithm Quick Switcher", "cmdk pages pattern typescript sub-menu", "Raycast List isShowingDetail side panel", "motion.dev stagger AnimatePresence command palette"
- Primary information sources: GitHub (uFuzzy, cmdk, match-sorter), Slack Engineering blog, Raycast developer docs, motion.dev docs, swyx's uFuzzy article, Superhuman engineering blog
