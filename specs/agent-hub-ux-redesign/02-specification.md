---
slug: agent-hub-ux-redesign
number: 240
created: 2026-04-12
status: specification
design-session: .dork/visual-companion/7057-1776029581
---

# Agent Hub UX Redesign — Personality Theater

## Overview

Redesign the Agent Hub right-panel from a cramped 6-tab left-nav layout into a three-zone architecture with an identity hero header, 3 horizontal tabs (Profile, Sessions, Config), and a "Personality Theater" — animated radar chart, named archetype presets, and a live response preview. The goal is a panel that is easy to use, fun, and visually delightful.

### Problem

The current Agent Hub has critical UX issues:

1. **Panel-within-a-panel**: A left-nav sidebar (6 tabs, ~105px wide) inside a ~350px right panel leaves only ~230px for content — violating NNGroup's explicit warning against vertical tabs in narrow panels
2. **Redundant content**: Overview tab renders identical content to Sessions tab
3. **Minimized identity**: 24px avatar + name with no status, description, runtime, or directory
4. **Overwhelming personality controls**: 5 sliders + 2 textareas + toggles + dropdown crammed into a narrow column
5. **Zero visual delight**: Flat utilitarian gray with no personality visualization or feedback

### Solution

Replace the left-nav + 6 tabs with:

- **Zone 1**: Identity hero header (52px avatar, status ring, runtime, sparkline) — never scrolls
- **Zone 2**: 3 horizontal tabs (Profile, Sessions, Config) — industry-standard top tabs
- **Zone 3**: Scrollable tab content with full panel width

The Config tab features a "Personality Theater" with animated radar chart, named archetypes (The Hotshot, The Sage, etc.), preset pills for instant personality selection, and a live response preview showing how the agent talks.

---

## Technical Design

### Architecture: Three-Zone Layout

```
AgentHub (flex flex-col h-full overflow-hidden)
├── AgentHubHero (sticky, non-scrolling)
│   ├── Avatar (52px) with StatusRing + PersonalityAura
│   ├── Agent name (15px bold)
│   ├── Meta row: status + runtime label
│   └── ActivitySparkline (7-day, 80px wide)
├── AgentHubTabBar (horizontal, 3 tabs)
│   ├── Profile tab
│   ├── Sessions tab
│   └── Config tab
└── AgentHubTabContent (flex-1 overflow-auto)
    └── Suspense → [ProfileTab | SessionsTab | ConfigTab]
```

**Key layout changes from current:**

- `AgentHubNav` (left sidebar) → **deleted**, replaced by `AgentHubTabBar` (horizontal)
- `AgentHubHeader` (minimal) → **replaced** by `AgentHubHero` (rich identity)
- `AgentHubContent` → renamed to `AgentHubTabContent`, same lazy-loading pattern
- 6 tab components → 3 tab components (Overview and Tasks deleted; Personality, Tools, Channels absorbed into Config)

### Store Changes

File: `apps/client/src/layers/features/agent-hub/model/agent-hub-store.ts`

```typescript
// BEFORE
type AgentHubTab = 'overview' | 'personality' | 'sessions' | 'channels' | 'tasks' | 'tools';

// AFTER
type AgentHubTab = 'profile' | 'sessions' | 'config';
```

The store shape stays the same (`activeTab`, `agentPath`, `setActiveTab`, `setAgentPath`, `openHub`). Only the tab type union changes.

### Deep-Link Changes

File: `apps/client/src/layers/features/agent-hub/model/use-agent-hub-deep-link.ts`

Update the URL param `hubTab` to accept the new tab names. Add migration mapping for old tab names:

```typescript
const TAB_MIGRATION: Record<string, AgentHubTab> = {
  overview: 'sessions', // overview was duplicate of sessions
  personality: 'config', // personality moved into config
  sessions: 'sessions', // unchanged
  channels: 'config', // channels moved into config
  tasks: 'sessions', // tasks absorbed into sessions
  tools: 'config', // tools moved into config
};
```

### Component: AgentHubHero

New file: `apps/client/src/layers/features/agent-hub/ui/AgentHubHero.tsx`

Replaces `AgentHubHeader`. Renders:

1. **Avatar** (52px) with:
   - Status ring: 3px ring outside avatar — green (online), gray (offline)
   - Personality aura: Subtle radial gradient glow behind avatar, color derived from active personality preset (P2 feature)
2. **Agent name**: 15px, font-weight 600, white
3. **Meta row**: `{status} · {runtime}` in 10px muted text
   - Status: "Online" (green) or "Offline" (gray)
   - Runtime: The agent's runtime identifier (e.g., "claude-code")
4. **Activity sparkline** (P2 feature): 80px wide SVG polyline showing session count over 7 days
5. **Close button**: X icon, top-right, closes the right panel

```tsx
// Styling
<div data-slot="agent-hub-hero" className="flex flex-col items-center gap-1 border-b px-4 py-3">
  {/* Avatar with status ring */}
  <div className="relative">
    <AgentIdentity agent={agent} size="lg" />
    <StatusRing status={agentStatus} />
  </div>
  {/* Name + meta */}
  <span className="text-[15px] font-semibold">{agent.displayName || agent.name}</span>
  <span className="text-muted-foreground text-[10px]">
    <StatusDot status={agentStatus} /> {agentStatus} · {agent.runtime}
  </span>
  {/* Close button absolute top-right */}
</div>
```

### Component: AgentHubTabBar

New file: `apps/client/src/layers/features/agent-hub/ui/AgentHubTabBar.tsx`

Horizontal tab bar with 3 tabs. Replaces `AgentHubNav` (left sidebar).

```tsx
const TABS: { id: AgentHubTab; label: string }[] = [
  { id: 'profile', label: 'Profile' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'config', label: 'Config' },
];

// Render as flex row with border-bottom
<div data-slot="agent-hub-tab-bar" className="flex border-b">
  {TABS.map((tab) => (
    <button
      key={tab.id}
      onClick={() => setActiveTab(tab.id)}
      className={cn(
        'flex-1 border-b-2 py-2 text-xs font-medium transition-colors',
        activeTab === tab.id
          ? 'text-foreground border-primary font-semibold'
          : 'text-muted-foreground hover:text-foreground border-transparent'
      )}
    >
      {tab.label}
    </button>
  ))}
</div>;
```

### Tab: ProfileTab

New file: `apps/client/src/layers/features/agent-hub/ui/tabs/ProfileTab.tsx`

Replaces `OverviewTab`. Renders editable agent identity fields:

1. **Display Name** — Inline-editable text field. Click to edit, blur to save. Calls `onUpdate({ displayName })`.
2. **Description** — Inline-editable textarea. Click to edit, blur to save. Calls `onUpdate({ description })`.
3. **Agent Runtime** — Dropdown `<Select>` showing available runtimes. Calls `onUpdate({ runtime })`. Shows runtime icon + label.
4. **Directory** — Read-only monospace field showing the agent's CWD. Folder icon prefix. Path tilde-shortened (replace `$HOME` prefix with `~`). Use `font-mono text-xs text-muted-foreground`.
5. **Tags** — Array of pill chips. Each chip is removable (x button). "+" add button opens an inline input. Calls `onUpdate({ tags })`.
6. **Stats row** — 3 cards in a flex row:
   - Sessions count (from `useSessions()` filtered to projectPath)
   - Channels count (from `useBindings()`)
   - Tasks run count (from `useTaskRuns()`)

### Tab: SessionsTab

File: `apps/client/src/layers/features/agent-hub/ui/tabs/SessionsTab.tsx` (modified)

Absorbs the old TasksTab content. Renders a unified view:

1. **Scheduled section** (from TasksView) — Upcoming cron-scheduled tasks with time badges. Only shown when agent has scheduled tasks.
2. **Active sessions** — Sessions with `status === 'active'`, showing green dot + "LIVE" badge.
3. **Past sessions** — Grouped by time period (Today, Previous 7 days, Previous 30 days). Each row shows: session title (or first message preview), timestamp, duration.

Implementation: Compose existing `SessionsView` and `TasksView` components vertically. TasksView shows at top when tasks exist, SessionsView below.

### Tab: ConfigTab (Personality Theater)

New file: `apps/client/src/layers/features/agent-hub/ui/tabs/ConfigTab.tsx`

The star of the redesign. Renders:

#### Section 1: Personality Theater (always visible at top)

1. **Radar chart** (`PersonalityRadar` component):
   - 5 axes: Tone, Autonomy, Caution, Communication, Creativity
   - SVG pentagon with filled shape showing current trait values
   - CSS `animation: pulse-glow 3s ease-in-out infinite` on the background radial gradient
   - SVG `<animate>` on polygon points for subtle breathing effect
   - Data points as small circles at vertices
   - Axis labels in 8px muted text

2. **Archetype name + tagline**:
   - Preset name rendered with `bg-gradient-to-r from-primary to-pink-500 bg-clip-text text-transparent` (gradient text)
   - Tagline in 11px muted text below

3. **Preset pill selector**:
   - Horizontal scrollable row of pill buttons
   - Active preset has primary color background + border
   - Inactive presets have muted background
   - Each pill shows emoji + name
   - Clicking a preset sets all 5 trait values at once
   - "Custom" pill activates when any trait is manually adjusted away from a preset

4. **Response preview bubble** (P1):
   - Section label: "How this agent talks" in 9px uppercase
   - Preview card with italic sample text
   - Static sample responses per preset (client-side, no backend needed for P1)
   - Meta text: "sample response · updates with personality"

#### Section 2-4: Accordion sections (collapsed by default)

Use `CollapsibleFieldCard` or a custom accordion component. Each section has:

- Chevron icon (right = collapsed, down = expanded)
- Section title (11px semibold)
- Meta badge (right-aligned, 9px muted — e.g., "4 groups · 3 servers")

**Section 2: Tools & MCP**

- Wraps existing `ToolsTab` content from `agent-settings`
- Shows tool group toggles + MCP server status

**Section 3: Channels**

- Wraps existing `ChannelsTab` content from `agent-settings`
- Shows channel bindings or empty state

**Section 4: Advanced**

- SOUL.md textarea with toggle (from personality)
- NOPE.md textarea with toggle (from personality)
- Response mode selector
- Safety limits (hops, calls/hr)
- DorkOS Knowledge Base toggle

### Personality Presets Data Model

New file: `apps/client/src/layers/features/agent-hub/model/personality-presets.ts`

```typescript
interface PersonalityPreset {
  id: string;
  name: string;
  emoji: string;
  tagline: string;
  traits: {
    tone: number; // 1-5
    autonomy: number; // 1-5
    caution: number; // 1-5
    communication: number; // 1-5
    creativity: number; // 1-5
  };
  sampleResponse: string;
}

const PERSONALITY_PRESETS: PersonalityPreset[] = [
  {
    id: 'balanced',
    name: 'Balanced',
    emoji: '\u{1F916}',
    tagline: 'The default. Steady, reliable, explains when it matters.',
    traits: { tone: 3, autonomy: 3, caution: 3, communication: 3, creativity: 3 },
    sampleResponse:
      "I'll handle this step by step. Let me explain my approach, then implement it. I'll check with you before making any irreversible changes.",
  },
  {
    id: 'hotshot',
    name: 'The Hotshot',
    emoji: '\u{1F525}',
    tagline: 'Ship fast, explain later. Turns caffeine into commits.',
    traits: { tone: 4, autonomy: 5, caution: 2, communication: 2, creativity: 5 },
    sampleResponse:
      'Done. Pushed the fix to feature/auth-refactor. Tests pass, types check, no regressions. Already moved on to the next item.',
  },
  {
    id: 'sage',
    name: 'The Sage',
    emoji: '\u{1F9D0}',
    tagline: 'Teaches as it works. Every answer is a lesson.',
    traits: { tone: 5, autonomy: 2, caution: 4, communication: 5, creativity: 3 },
    sampleResponse:
      'This is a great learning opportunity. The issue stems from a race condition in the useEffect cleanup. Let me walk you through why this happens and three ways to fix it...',
  },
  {
    id: 'sentinel',
    name: 'The Sentinel',
    emoji: '\u{1F6E1}',
    tagline: 'Measure twice, cut once. Asks before every action.',
    traits: { tone: 3, autonomy: 1, caution: 5, communication: 4, creativity: 2 },
    sampleResponse:
      "Before I make any changes, I want to confirm: should I modify the auth middleware directly, or create a new wrapper? Both approaches have trade-offs I'd like to discuss.",
  },
  {
    id: 'phantom',
    name: 'The Phantom',
    emoji: '\u{1F47B}',
    tagline: "You'll barely know it's there. Pure silent execution.",
    traits: { tone: 1, autonomy: 5, caution: 3, communication: 1, creativity: 3 },
    sampleResponse: 'Fixed.',
  },
  {
    id: 'mad-scientist',
    name: 'Mad Scientist',
    emoji: '\u{1F3A8}',
    tagline: 'Wild ideas, unexpected solutions. Thrives on chaos.',
    traits: { tone: 4, autonomy: 4, caution: 1, communication: 4, creativity: 5 },
    sampleResponse:
      "Okay hear me out — what if instead of fixing the N+1 query, we restructure the entire data layer to use a materialized view? It's unconventional but it would solve three other problems too...",
  },
];
```

### Component: PersonalityRadar

New file: `apps/client/src/layers/features/agent-hub/ui/PersonalityRadar.tsx`

Pure SVG radar/spider chart component.

**Props:**

```typescript
interface PersonalityRadarProps {
  traits: {
    tone: number;
    autonomy: number;
    caution: number;
    communication: number;
    creativity: number;
  };
  size?: number; // Default 130
  animated?: boolean; // Default true — enables breathing animation
  className?: string;
}
```

**Implementation:**

- SVG viewBox matching size
- 3 concentric pentagon grid rings (opacity 0.06, 0.08, 0.1)
- Filled polygon for data shape, with `fill` at 20% opacity and `stroke` at 70% opacity
- Color: primary theme color (purple/violet)
- If `animated`: SVG `<animate>` on polygon points (subtle 3s breathing) and circle radii
- Axis labels as SVG `<text>` elements positioned outside the pentagon
- Data point circles at each vertex (r=3)

**Coordinate calculation:**

```typescript
function traitToPoint(index: number, value: number, center: number, maxRadius: number) {
  const angle = (Math.PI * 2 * index) / 5 - Math.PI / 2; // Start from top
  const radius = (value / 5) * maxRadius;
  return { x: center + radius * Math.cos(angle), y: center + radius * Math.sin(angle) };
}
```

### Deleted Files

The following files are removed (their content is absorbed into the new tab structure):

- `apps/client/src/layers/features/agent-hub/ui/AgentHubNav.tsx` — replaced by AgentHubTabBar
- `apps/client/src/layers/features/agent-hub/ui/AgentHubHeader.tsx` — replaced by AgentHubHero
- `apps/client/src/layers/features/agent-hub/ui/tabs/OverviewTab.tsx` — content identical to Sessions, eliminated
- `apps/client/src/layers/features/agent-hub/ui/tabs/TasksTab.tsx` — absorbed into SessionsTab
- `apps/client/src/layers/features/agent-hub/ui/tabs/PersonalityTab.tsx` — absorbed into ConfigTab
- `apps/client/src/layers/features/agent-hub/ui/tabs/ChannelsTab.tsx` — absorbed into ConfigTab accordion
- `apps/client/src/layers/features/agent-hub/ui/tabs/ToolsTab.tsx` — absorbed into ConfigTab accordion

### Modified Files

- `apps/client/src/layers/features/agent-hub/ui/AgentHub.tsx` — Remove nav/header, use Hero + TabBar + TabContent
- `apps/client/src/layers/features/agent-hub/ui/AgentHubContent.tsx` — Rename to `AgentHubTabContent`, update lazy imports to 3 tabs
- `apps/client/src/layers/features/agent-hub/model/agent-hub-store.ts` — Update `AgentHubTab` type
- `apps/client/src/layers/features/agent-hub/model/use-agent-hub-deep-link.ts` — Add tab migration mapping
- `apps/client/src/layers/features/agent-hub/index.ts` — Update barrel exports
- `apps/client/src/layers/entities/agent/ui/AgentIdentity.tsx` — Add `lg` size variant (52px avatar)

### New Files

- `apps/client/src/layers/features/agent-hub/ui/AgentHubHero.tsx`
- `apps/client/src/layers/features/agent-hub/ui/AgentHubTabBar.tsx`
- `apps/client/src/layers/features/agent-hub/ui/tabs/ProfileTab.tsx`
- `apps/client/src/layers/features/agent-hub/ui/tabs/ConfigTab.tsx`
- `apps/client/src/layers/features/agent-hub/ui/PersonalityRadar.tsx`
- `apps/client/src/layers/features/agent-hub/model/personality-presets.ts`

---

## Implementation Phases

### Phase 1: Foundation (layout restructuring)

1. Update `AgentHubTab` type in store (6 → 3 values)
2. Create `AgentHubHero` component (replacing AgentHubHeader)
3. Create `AgentHubTabBar` component (replacing AgentHubNav)
4. Restructure `AgentHub.tsx` to use Hero + TabBar + TabContent
5. Update deep-link migration mapping
6. Update barrel exports

### Phase 2: Tab content

7. Create `ProfileTab` with editable fields (name, description, runtime, directory, tags, stats)
8. Modify `SessionsTab` to compose SessionsView + TasksView
9. Create `ConfigTab` with accordion sections wrapping existing agent-settings components

### Phase 3: Personality Theater

10. Create `PersonalityRadar` SVG component with animation
11. Create personality presets data model
12. Build preset pill selector with radar chart integration
13. Add response preview bubble with per-preset sample responses

### Phase 4: Cleanup and testing

14. Delete removed files (AgentHubNav, AgentHubHeader, OverviewTab, TasksTab, PersonalityTab wrapper, ChannelsTab wrapper, ToolsTab wrapper)
15. Update all tests for new tab structure
16. Verify deep-link backward compatibility

---

## Acceptance Criteria

### Functional

- [ ] Agent Hub opens with identity hero header showing avatar, name, status, runtime, and close button
- [ ] Three horizontal tabs (Profile, Sessions, Config) render correctly
- [ ] Profile tab shows editable name, description, runtime selector, directory path, tags, and stats
- [ ] Sessions tab shows scheduled tasks + active sessions + past sessions (unified view)
- [ ] Config tab shows personality radar chart with animated breathing effect
- [ ] 6 personality presets are selectable via pill buttons
- [ ] Selecting a preset updates all 5 trait values and the radar chart
- [ ] Response preview bubble shows a sample response matching the active preset
- [ ] Tools & MCP accordion section renders existing tool group toggles
- [ ] Channels accordion section renders existing channel bindings
- [ ] Advanced accordion section contains SOUL.md, NOPE.md, response mode, limits
- [ ] Old deep-link URLs (`?hubTab=personality`) redirect to new tab names (`?hubTab=config`)

### Visual

- [ ] No left-nav sidebar — content uses full panel width
- [ ] Radar chart has subtle breathing animation (3s cycle)
- [ ] Preset archetype name renders with gradient text
- [ ] Active preset pill has primary color highlight
- [ ] Identity hero header does not scroll with tab content
- [ ] Directory path uses monospace font with tilde-shortened path

### Non-regression

- [ ] Right-click → "Agent profile" in sidebar still opens Agent Hub
- [ ] Cmd+Shift+A keyboard shortcut still toggles Agent Hub
- [ ] Canvas panel still works and is switchable via tab bar icons
- [ ] Command palette "Agent profile" action still works
- [ ] Panel close button dismisses the right panel
- [ ] Agent identity click in session header opens Agent Hub (if wired)

---

## Testing Strategy

### Unit tests

- `PersonalityRadar` renders SVG with correct number of vertices and labels
- `PersonalityRadar` applies animation classes when `animated` prop is true
- Preset selection updates all trait values in the hub store
- Tab migration mapping correctly translates old tab names to new ones
- ProfileTab renders all expected fields
- ConfigTab renders all accordion sections

### Integration tests

- AgentHub renders hero + tab bar + content in correct layout
- Tab switching updates content and URL params
- Deep-link with old tab name redirects to correct new tab
- Preset selection updates radar chart and response preview
- Accordion expand/collapse works for each Config section

---

## Migration & Backward Compatibility

### URL deep-links

Old URLs with `?hubTab=overview|personality|sessions|channels|tasks|tools` are automatically mapped to the new tab names via `TAB_MIGRATION`. The mapping uses `replace: true` navigation so the old URL doesn't stay in browser history.

### Store persistence

The `activeTab` value in the Zustand store changes type. Since the store is not persisted to localStorage (it resets on page load), no migration is needed.

### Feature flags

No feature flag. This is a direct replacement — the old layout is removed entirely.

---

## Changelog

### 2026-04-12 — Initial specification

- Created from ideation document `specs/agent-hub-ux-redesign/01-ideation.md`
- All 8 design decisions resolved during interactive visual companion session
- Design mockups preserved in `.dork/visual-companion/7057-1776029581/`
