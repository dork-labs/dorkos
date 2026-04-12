# Agent Hub UX Redesign — Task Breakdown

> Generated: 2026-04-12 | Spec: `specs/agent-hub-ux-redesign/02-specification.md`

## Summary

| Metric       | Value |
| ------------ | ----- |
| Total tasks  | 15    |
| Phases       | 4     |
| Small tasks  | 4     |
| Medium tasks | 8     |
| Large tasks  | 3     |

## Dependency Graph

```
Phase 1: Foundation
  1.1 Store type update ──┬──> 1.2 AgentHubHero ──────┐
                          ├──> 1.3 AgentHubTabBar ─────┼──> 1.4 Shell restructure ──> 1.6 Barrel exports
                          └──> 1.5 Deep-link migration  │
                                                         │
Phase 2: Tab Content                                     │
  (all depend on 1.4) ──────────────────────────────────┘
  2.1 ProfileTab          ─┐
  2.2 SessionsTab (modify) ├── parallel
  2.3 ConfigTab            ─┘

Phase 3: Personality Theater
  3.1 PersonalityRadar ──┐
  3.2 Presets data model ─┤── parallel
                          └──> 3.3 Preset selector + radar integration ──> 3.4 Response preview

Phase 4: Cleanup
  4.1 Delete old files ──┐
                         └──> 4.2 Integration tests + deep-link verification
```

## Parallel Opportunities

- **Batch 1:** Tasks 1.2, 1.3, 1.5 can run in parallel (all depend only on 1.1)
- **Batch 2:** Tasks 2.1, 2.2, 2.3 can run in parallel (all depend only on 1.4)
- **Batch 3:** Tasks 3.1, 3.2 can run in parallel (3.1 depends on 1.4, 3.2 has no dependencies)
- **Batch 4:** Tasks 4.1, 4.2 are partially parallel (4.2 depends on 4.1 completion)

---

## Phase 1: Foundation

### 1.1 Update AgentHubTab type and store defaults (6 to 3 tabs)

- **Size:** Small | **Priority:** High | **Dependencies:** None
- **Files:** `agent-hub-store.ts`, `agent-hub-store.test.ts`
- Change `AgentHubTab` from `'overview' | 'personality' | 'sessions' | 'channels' | 'tasks' | 'tools'` to `'profile' | 'sessions' | 'config'`
- Update default tab from `'overview'` to `'profile'`
- Update all test expectations to use new tab names

### 1.2 Create AgentHubHero component

- **Size:** Medium | **Priority:** High | **Dependencies:** 1.1 | **Parallel with:** 1.3
- **New file:** `AgentHubHero.tsx`
- Replaces `AgentHubHeader` with richer identity display: 52px avatar with status ring, agent name (15px semibold), meta row (status + runtime), close button (absolute top-right)
- Vertical centered layout, non-scrolling, border-b separator

### 1.3 Create AgentHubTabBar horizontal tab component

- **Size:** Medium | **Priority:** High | **Dependencies:** 1.1 | **Parallel with:** 1.2
- **New files:** `AgentHubTabBar.tsx`, `AgentHubTabBar.test.tsx`
- 3 horizontal tabs: Profile, Sessions, Config
- Underline-style active indicator with `border-b-2 border-primary`
- Uses `role="tablist"` + `role="tab"` + `aria-selected` for accessibility
- Tests cover rendering, active state, click behavior

### 1.4 Restructure AgentHub shell and rename AgentHubContent

- **Size:** Medium | **Priority:** High | **Dependencies:** 1.1, 1.2, 1.3
- **Files:** `AgentHub.tsx`, `AgentHubContent.tsx` (renamed to `AgentHubTabContent.tsx`)
- Remove sidebar layout (`AgentHubNav` + `AgentHubContent` side-by-side)
- Replace with vertical three-zone: `AgentHubHero` -> `AgentHubTabBar` -> `AgentHubTabContent`
- Update lazy imports in TabContent to 3 tabs: ProfileTab, SessionsTab, ConfigTab
- Update `AgentHub.test.tsx` selectors

### 1.5 Update deep-link migration mapping

- **Size:** Medium | **Priority:** High | **Dependencies:** 1.1 | **Parallel with:** 1.2, 1.3
- **Files:** `use-agent-hub-deep-link.ts`, `deep-link-migration.test.tsx`
- Add `TAB_MIGRATION` mapping: overview->sessions, personality->config, sessions->sessions, channels->config, tasks->sessions, tools->config
- Update `VALID_HUB_TABS` to new 3-tab set
- Update `LEGACY_TAB_MAP` to map to new tab names
- Update all deep-link test expectations

### 1.6 Update barrel exports

- **Size:** Small | **Priority:** High | **Dependencies:** 1.2, 1.3, 1.4
- **File:** `index.ts`
- Remove: `AgentHubHeader`, `AgentHubNav`, `AgentHubContent` exports
- Add: `AgentHubHero`, `AgentHubTabBar`, `AgentHubTabContent` exports

---

## Phase 2: Tab Content

### 2.1 Create ProfileTab with editable agent identity fields

- **Size:** Large | **Priority:** High | **Dependencies:** 1.4 | **Parallel with:** 2.2, 2.3
- **New files:** `ProfileTab.tsx`, `ProfileTab.test.tsx`
- 6 sections: Display Name (inline-editable), Description (inline-editable textarea), Runtime (Select dropdown), Directory (read-only monospace with tilde-shortening), Tags (removable pills + add button), Stats row (3-column grid: sessions/channels/tasks)
- Click-to-edit pattern: click field -> shows input, blur -> saves via `onUpdate`

### 2.2 Modify SessionsTab to compose SessionsView + TasksView

- **Size:** Medium | **Priority:** High | **Dependencies:** 1.4 | **Parallel with:** 2.1, 2.3
- **File:** `SessionsTab.tsx` (modified)
- Compose TasksView above SessionsView with border separator
- TasksView only shown when `toolStatus.tasks === 'enabled'`
- Update tests: add unified rendering tests, remove standalone TasksTab tests

### 2.3 Create ConfigTab with accordion sections

- **Size:** Large | **Priority:** High | **Dependencies:** 1.4 | **Parallel with:** 2.1, 2.2
- **New files:** `ConfigTab.tsx`, `ConfigTab.test.tsx`
- Personality Theater placeholder at top (replaced in Phase 3)
- 3 accordion sections (collapsed by default): Tools & MCP (wraps `AgentToolsTab`), Channels (wraps `AgentChannelsTab`), Advanced (wraps `PersonalityTab` from agent-settings)
- Custom `AccordionSection` component with chevron icon, title, meta badge, expand/collapse
- Tests verify all sections render, collapse/expand works

---

## Phase 3: Personality Theater

### 3.1 Create PersonalityRadar SVG component with animation

- **Size:** Large | **Priority:** Medium | **Dependencies:** 1.4 | **Parallel with:** 3.2
- **New files:** `PersonalityRadar.tsx`, `PersonalityRadar.test.tsx`
- Pure SVG component: 5-axis pentagon, 3 concentric guide rings, filled data polygon, 5 data-point circles, 5 axis labels
- Coordinate calculation: `traitToPoint(index, value, center, maxRadius)` using polar-to-cartesian
- Breathing animation via SVG `<animate>` on polygon points and circle radii (3s cycle)
- `animated` prop (default true) controls animation presence
- Uses `hsl(var(--primary))` for theme integration
- Tests verify SVG structure, animation presence/absence, custom size

### 3.2 Create personality presets data model

- **Size:** Small | **Priority:** Medium | **Dependencies:** None | **Parallel with:** 3.1
- **New files:** `personality-presets.ts`, `personality-presets.test.ts`
- `PersonalityPreset` interface: id, name, emoji, tagline, traits (5 axes), sampleResponse
- 6 presets: Balanced, The Hotshot, The Sage, The Sentinel, The Phantom, Mad Scientist
- `findMatchingPreset()` helper: returns matching preset or undefined for custom traits
- Tests verify count, field completeness, value ranges, uniqueness, matching logic

### 3.3 Build preset pill selector with radar chart integration

- **Size:** Medium | **Priority:** Medium | **Dependencies:** 2.3, 3.1, 3.2
- **File:** `ConfigTab.tsx` (modified)
- Replace Personality Theater placeholder with: centered PersonalityRadar, gradient text archetype name + tagline, horizontally scrollable preset pill row
- Active preset pill: `bg-primary text-primary-foreground border-primary`
- Clicking a preset calls `onPersonalityUpdate({ traits })` to update all 5 traits at once
- "Custom" label when traits don't match any preset
- Additional ConfigTab tests for radar and preset presence

### 3.4 Add response preview bubble

- **Size:** Small | **Priority:** Medium | **Dependencies:** 3.3
- **File:** `ConfigTab.tsx` (modified)
- "How this agent talks" label (9px uppercase muted)
- Preview card with italic sample text from active preset's `sampleResponse`
- Fallback text for custom traits
- Meta text: "sample response · updates with personality"
- Tests verify label, content, and meta text

---

## Phase 4: Cleanup and Testing

### 4.1 Delete removed files and clean up stale references

- **Size:** Medium | **Priority:** High | **Dependencies:** 1.4, 1.6, 2.1, 2.2, 2.3 | **Parallel with:** 4.2
- **Delete 7 component files:** AgentHubNav.tsx, AgentHubHeader.tsx, OverviewTab.tsx, TasksTab.tsx, PersonalityTab.tsx (hub wrapper), ChannelsTab.tsx (hub wrapper), ToolsTab.tsx (hub wrapper)
- **Delete 1 test file:** AgentHubNav.test.tsx
- **Update:** tab-migration-parity.test.tsx (remove tests for deleted tabs)
- Verify: grep for stale references, TypeScript compilation, full test suite

### 4.2 Update integration tests and verify deep-link backward compatibility

- **Size:** Medium | **Priority:** High | **Dependencies:** 1.5, 4.1
- **Files:** `AgentHub.test.tsx`, `deep-link-migration.test.tsx`
- Verify three-zone layout in integration test (hero + tab bar + content data-slots)
- Verify no sidebar nav or old header elements
- Add `it.each` test for all 6 old tab name migrations
- Run full agent-hub test suite with zero failures
