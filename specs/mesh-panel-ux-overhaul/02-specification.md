---
slug: mesh-panel-ux-overhaul
number: 62
created: 2026-02-25
status: specified
---

# Specification: Mesh Panel UI/UX Overhaul

**Status:** Draft
**Authors:** Claude Code, 2026-02-25
**Ideation:** [01-ideation.md](./01-ideation.md)
**Research:** [research/20260225_mesh_panel_ux_overhaul.md](../../research/20260225_mesh_panel_ux_overhaul.md)

---

## Overview

Transform the Mesh Panel from a passive, tab-heavy interface into a progressive disclosure system with two visual modes. First-time users see a clean, full-bleed Discovery view with the server boundary pre-filled as the default scan root. Once agents are registered, the full tabbed interface (Topology, Discovery, Agents, Denied, Access) appears with contextual empty states per tab. Custom scan roots persist to `~/.dork/config.json`.

## Background / Problem Statement

The current Mesh Panel has five tabs but drops users onto an empty Topology graph that says "No agents discovered yet" with no guidance. Every tab shows passive empty states (bare muted text, no icons, no CTAs). The Discovery tab — the keystone action that unlocks all downstream tabs — requires manual comma-separated path entry with no defaults, no persistence, and ephemeral results.

Research (Linear's "anti-onboarding" philosophy, GitHub's "Default Setup" pattern) confirms that developer tools should eliminate blank-slate friction through smart defaults and contextual guidance, not wizards or tooltips.

## Goals

- First-time user can scan immediately with zero typing (boundary pre-filled)
- Progressive disclosure: hide tabs when they'd all be empty; show full UI when populated
- Custom scan roots persist across sessions via server config
- Every empty state has contextual copy and a forward-moving CTA
- Smooth animated transition from Discovery-only (Mode A) to full tabbed UI (Mode B)
- Reuse existing components: DirectoryPicker, Badge, motion.dev

## Non-Goals

- Backend mesh-core library changes (discovery engine, registry, strategies)
- Topology edge rendering (Spec 58: mesh-network-topology)
- New discovery strategies or scanning algorithms
- Relay/Pulse integration changes
- Auto-scanning on panel load (explicit user consent required)
- Setup wizard or product tour

## Technical Dependencies

- `motion` (motion.dev) — already installed, used for layout transitions
- `@xyflow/react` + `dagre` — already installed, topology graph (no changes needed)
- `@/layers/shared/ui/DirectoryPicker` — reused for browsable root selection
- `@/layers/shared/ui/Badge` — reused for chip rendering
- `@dorkos/shared/config-schema` — extended with `mesh.scanRoots`
- `apps/server/src/routes/config.ts` — GET response extended with `boundary` field

## Detailed Design

### 1. Two Visual Modes in MeshPanel

The `MeshPanel` component switches between two modes based on `agents.length`:

**Mode A — Zero registered agents:**

```
┌──────────────────────────────────────────┐
│  (No MeshStatsHeader)                    │
│  (No TabsList)                           │
│                                          │
│        [Radar icon]                      │
│   Discover agents on this machine        │
│   Scan your filesystem to find           │
│   compatible AI agents.                  │
│                                          │
│   [ /Users/you  ×  ]            [ 📁 ]   │
│                                          │
│   [ Scan → ]                             │
│                                          │
│   ▸ Advanced options                     │
│                                          │
│   (Candidate results appear here)        │
└──────────────────────────────────────────┘
```

**Mode B — One or more registered agents:**

```
┌──────────────────────────────────────────┐
│  3 agents · 2 active · 1 stale          │
│  [Topology] [Discovery] [Agents] [...]   │
│                                          │
│  (Active tab content with per-tab        │
│   contextual empty states)               │
└──────────────────────────────────────────┘
```

**Transition logic:**

```tsx
// In MeshPanel
const agents = agentsResult?.agents ?? [];
const hasAgents = agents.length > 0;

if (!meshEnabled) return <DisabledState />;

return hasAgents ? <FullTabbedMode /> : <DiscoveryOnlyMode />;
```

When `hasAgents` transitions from `false` → `true` (first agent registered), animate the tab bar and stats header in using `motion.div` with `AnimatePresence`. When `hasAgents` transitions from `true` → `false` (all agents unregistered), animate back to Discovery-only mode.

### 2. DiscoveryView Component

Extract the current inline `DiscoveryTab` from `MeshPanel.tsx` into a standalone `DiscoveryView.tsx` that serves both modes:

- **Mode A:** Full-bleed with hero-style headline, centered layout
- **Mode B:** Compact tab content (no headline, just the scan input and results)

```tsx
interface DiscoveryViewProps {
  /** When true, renders full-bleed hero layout (Mode A). Otherwise compact tab layout. */
  fullBleed?: boolean;
}
```

### 3. ScanRootInput Component

A chip/tag input component for managing scan root paths:

```tsx
interface ScanRootInputProps {
  /** Current list of root paths */
  roots: string[];
  /** Called when roots change (add/remove) */
  onRootsChange: (roots: string[]) => void;
  /** Whether scanning is in progress */
  disabled?: boolean;
}
```

**Behavior:**

- Renders each root as a `Badge variant="secondary"` with an X (remove) button
- Text input at the end of the chip row: type a path + Enter or comma to add
- Folder icon button at the end opens `DirectoryPicker` dialog
- When a path is selected from DirectoryPicker, it's added as a new chip
- Duplicate paths are silently deduplicated
- Paths are normalized: trim whitespace, resolve `~` to home dir on display

**Layout:**

```
┌──────────────────────────────────────────────┐
│ [ ~/projects × ] [ /opt/agents × ]  ____  📁 │
└──────────────────────────────────────────────┘
```

The input wraps to multiple lines if chips overflow. Uses `flex flex-wrap` layout.

### 4. Config Schema Extension

In `packages/shared/src/config-schema.ts`, extend the `mesh` config object:

```typescript
mesh: z.object({
  enabled: z.boolean().default(false),
  scanRoots: z.array(z.string()).default(() => []),
}).default(() => ({ enabled: false, scanRoots: [] })),
```

When `scanRoots` is empty (default), the UI falls back to the server boundary as the initial root.

### 5. Boundary Exposure in Config API

The GET `/api/config` response currently returns feature flags but not the server boundary. Add `boundary` to the response:

```typescript
// In routes/config.ts GET handler
res.json({
  // ... existing fields ...
  boundary: getBoundary(), // from lib/boundary.ts
});
```

This gives the client the resolved boundary path for pre-filling the Discovery input. The `getBoundary()` function is already exported from `lib/boundary.ts`.

### 6. Client-Side Config Hook

Add a new entity hook or extend existing config fetching to read `mesh.scanRoots` from config:

```typescript
// In entities/mesh/model/use-mesh-scan-roots.ts
export function useMeshScanRoots() {
  const transport = useTransport();

  // Query: fetch config to get scanRoots and boundary
  const { data: config } = useQuery({
    queryKey: ['config'],
    queryFn: () => transport.getConfig(),
  });

  const boundary = config?.boundary ?? '~';
  const savedRoots = config?.mesh?.scanRoots ?? [];
  const defaultRoots = savedRoots.length > 0 ? savedRoots : [boundary];

  // Mutation: save custom roots to config
  const { mutate: saveScanRoots } = useMutation({
    mutationFn: (roots: string[]) => transport.updateConfig({ mesh: { scanRoots: roots } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['config'] }),
  });

  return { defaultRoots, boundary, saveScanRoots };
}
```

**Note:** The existing `transport.getConfig()` and `transport.updateConfig()` methods already exist in the Transport interface (mapped to GET/PATCH `/api/config`). The hook reads the boundary for fallback and `mesh.scanRoots` for persisted custom roots.

### 7. Advanced Options (Progressive Disclosure)

A collapsible "Advanced" section below the scan input:

```
▸ Advanced options
```

Expands to show:

- **Scan depth** slider: Range 1-5, default 3. Maps to `maxDepth` parameter in `useDiscoverAgents`
- Shows current depth as number label beside slider

Uses `details/summary` HTML or a controlled disclosure with `ChevronRight`/`ChevronDown` toggle.

### 8. Tab-by-Tab Empty States (Mode B)

Create a reusable `MeshEmptyState` component:

```tsx
interface MeshEmptyStateProps {
  icon: React.ReactNode;
  headline: string;
  description: string;
  action?: {
    label: string;
    onClick: () => void;
  };
}
```

**Per-tab empty states:**

| Tab    | Icon          | Headline                                            | Description                                                                                        | CTA                              |
| ------ | ------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------- |
| Agents | `Network`     | "No agents registered yet"                          | "Run a discovery scan to find compatible agents, then register them to join the mesh."             | "Go to Discovery" (switches tab) |
| Denied | `ShieldCheck` | "No blocked paths"                                  | "Paths you deny during discovery will appear here, preventing those agents from joining the mesh." | None (healthy state)             |
| Access | `Shield`      | "Cross-project access requires multiple namespaces" | "Register agents from different projects to configure which namespaces can communicate."           | "Go to Discovery" (switches tab) |

Empty states use the Calm Tech design system: `rounded-xl` card feel, `text-muted-foreground`, icon at `size-8 text-muted-foreground/50`, adequate `p-8` padding.

### 9. Tab Switching from Empty State CTAs

Empty state CTA buttons need to switch the active tab to "discovery". This requires lifting tab state to a controlled `Tabs` component:

```tsx
// In MeshPanel (Mode B)
const [activeTab, setActiveTab] = useState('topology');

<Tabs value={activeTab} onValueChange={setActiveTab}>
  ...
  <TabsContent value="agents">
    <AgentsTab
      agents={agents}
      isLoading={agentsLoading}
      onGoToDiscovery={() => setActiveTab('discovery')}
    />
  </TabsContent>
  ...
</Tabs>;
```

### 10. Transition Animations

Use `motion.div` from `motion/react` for the Mode A → Mode B transition:

```tsx
import { AnimatePresence, motion } from 'motion/react';

// Stats header + tab bar animate in/out
<AnimatePresence>
  {hasAgents && (
    <motion.div
      initial={{ opacity: 0, y: -20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      transition={{ duration: 0.2 }}
    >
      <MeshStatsHeader />
      <TabsList>...</TabsList>
    </motion.div>
  )}
</AnimatePresence>;
```

Wrap in `<MotionConfig reducedMotion="user">` (already present at app level in `App.tsx`).

### File Organization

**Modified files:**
| File | Change |
|------|--------|
| `apps/client/src/layers/features/mesh/ui/MeshPanel.tsx` | Major rewrite: Mode A/B conditional, controlled tabs, extract inline components |
| `packages/shared/src/config-schema.ts` | Add `scanRoots` to `mesh` config object |
| `apps/server/src/routes/config.ts` | Add `boundary` to GET response |
| `apps/client/src/layers/features/mesh/index.ts` | Export new components |
| `apps/client/src/layers/features/mesh/__tests__/MeshPanel.test.tsx` | Update for Mode A/B, new components |

**New files:**
| File | Purpose |
|------|---------|
| `apps/client/src/layers/features/mesh/ui/DiscoveryView.tsx` | Discovery content for both modes |
| `apps/client/src/layers/features/mesh/ui/ScanRootInput.tsx` | Chip/tag input for scan roots |
| `apps/client/src/layers/features/mesh/ui/MeshEmptyState.tsx` | Reusable empty state component |
| `apps/client/src/layers/entities/mesh/model/use-mesh-scan-roots.ts` | Config hook for scan roots + boundary |

## User Experience

### First-Time User Journey

1. User enables Mesh (`DORKOS_MESH_ENABLED=true`) and opens the Mesh panel
2. They see a clean Discovery view with their home directory pre-filled as a chip
3. They click "Scan" — candidates appear as cards below
4. They click "Register" on a candidate — the full tabbed interface animates in
5. They're now on the Topology tab with their first agent visible in the graph

### Returning User Journey

1. User opens Mesh panel — if they have registered agents, they see the full tabbed UI
2. They switch to Discovery tab, which still has their custom scan roots from last session
3. They run another scan, register more agents
4. Access tab shows namespace groups once agents span multiple projects

### Error States

- **Scan returns no candidates:** "No agents found in these directories. Try scanning with greater depth or different directories."
- **Path outside boundary:** Show the boundary path in the error: "This path is outside your configured boundary (/Users/you). Update your boundary in config to scan here."
- **Scan fails (network/permission):** Standard error toast via existing error handling

## Testing Strategy

### Unit Tests

**MeshPanel Mode A/B switching:**

```typescript
it('renders Discovery-only view when no agents registered', () => {
  enableMesh();
  mockUseRegisteredAgents.mockReturnValue({ data: { agents: [] }, isLoading: false });
  render(<MeshPanel />, { wrapper: createWrapper() });

  // Should show Discovery headline, NOT tab bar
  expect(screen.getByText(/discover agents/i)).toBeInTheDocument();
  expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
});

it('renders full tabbed interface when agents exist', () => {
  enableMesh();
  mockUseRegisteredAgents.mockReturnValue({
    data: { agents: [mockAgent] },
    isLoading: false,
  });
  render(<MeshPanel />, { wrapper: createWrapper() });

  expect(screen.getByRole('tablist')).toBeInTheDocument();
  expect(screen.getByText('Topology')).toBeInTheDocument();
});
```

**ScanRootInput chip management:**

```typescript
it('renders initial roots as chips', () => {
  render(<ScanRootInput roots={['/home/user']} onRootsChange={vi.fn()} />);
  expect(screen.getByText('/home/user')).toBeInTheDocument();
});

it('adds new root on Enter key', async () => {
  const onRootsChange = vi.fn();
  render(<ScanRootInput roots={[]} onRootsChange={onRootsChange} />);

  const input = screen.getByRole('textbox');
  await userEvent.type(input, '/opt/agents{Enter}');
  expect(onRootsChange).toHaveBeenCalledWith(['/opt/agents']);
});

it('removes root when chip X is clicked', async () => {
  const onRootsChange = vi.fn();
  render(<ScanRootInput roots={['/a', '/b']} onRootsChange={onRootsChange} />);

  await userEvent.click(screen.getAllByLabelText(/remove/i)[0]);
  expect(onRootsChange).toHaveBeenCalledWith(['/b']);
});

it('deduplicates paths', async () => {
  const onRootsChange = vi.fn();
  render(<ScanRootInput roots={['/a']} onRootsChange={onRootsChange} />);

  const input = screen.getByRole('textbox');
  await userEvent.type(input, '/a{Enter}');
  expect(onRootsChange).not.toHaveBeenCalled();
});
```

**Empty state CTAs:**

```typescript
it('switches to Discovery tab when "Go to Discovery" is clicked in Agents empty state', async () => {
  enableMesh();
  mockUseRegisteredAgents.mockReturnValue({
    data: { agents: [mockAgent] }, // Agents exist for Mode B
    isLoading: false,
  });
  // But agents tab itself is somehow empty (filtered view, etc.)
  render(<MeshPanel />, { wrapper: createWrapper() });

  // Navigate to agents tab, click CTA
  // Verify tab switches to 'discovery'
});
```

**Config persistence:**

```typescript
it('saves custom roots to config when modified', async () => {
  // Verify PATCH /api/config is called with mesh.scanRoots
});

it('loads saved roots from config on mount', () => {
  // Verify initial roots come from config, not boundary
});

it('falls back to boundary when no saved roots', () => {
  // Verify boundary is used as default
});
```

### Integration Tests

- Verify GET `/api/config` now includes `boundary` field
- Verify PATCH `/api/config` with `mesh.scanRoots` persists and validates
- Verify `UserConfigSchema` validates `mesh.scanRoots` as string array

### Mocking Strategy

- Mock `@/layers/entities/mesh` hooks (existing pattern in MeshPanel.test.tsx)
- Mock `motion/react` to render plain elements (existing pattern)
- Mock `DirectoryPicker` to avoid filesystem browser rendering
- Mock `useQuery` for config data (boundary + scan roots)
- Use `createWrapper()` with `QueryClientProvider` (existing pattern)

## Performance Considerations

- `ScanRootInput` uses controlled input — chip add/remove is O(1) array operation
- Config fetch (GET `/api/config`) is already cached by TanStack Query — no additional requests
- Config save (PATCH) is debounced implicitly by user action (only on explicit root modification)
- `AnimatePresence` transition is 200ms — no jank risk
- No new lazy-loaded chunks beyond what exists (TopologyGraph is already lazy)

## Security Considerations

- **Boundary enforcement unchanged:** Server-side `boundary.ts` still validates all scan paths via POST `/api/mesh/discover`. The UI pre-fills the boundary but doesn't bypass validation.
- **Path normalization:** `ScanRootInput` trims whitespace. Server-side validation handles traversal attacks (`../../`).
- **Config persistence:** `meshScanRoots` in `~/.dork/config.json` is user-writable (same security model as all other config). No sensitive data stored.
- **Boundary exposure:** GET `/api/config` already returns `workingDirectory`. Adding `boundary` is equivalent — it's the user's home directory by default.

## Documentation

- Update `contributing/architecture.md` if the Mesh feature section needs the Mode A/B pattern documented
- No external docs changes needed — this is a UI-internal refactor

## Implementation Phases

### Phase 1: Config + API Foundation

- Add `mesh.scanRoots` to `UserConfigSchema`
- Add `boundary` to GET `/api/config` response
- Create `useMeshScanRoots` entity hook
- Verify with unit tests

### Phase 2: Discovery Components

- Create `ScanRootInput` (chip/tag input with DirectoryPicker)
- Create `DiscoveryView` (extracted from MeshPanel, supports `fullBleed` prop)
- Create `MeshEmptyState` (reusable component)
- Unit test all three components

### Phase 3: MeshPanel Rewrite

- Refactor `MeshPanel` for Mode A/B conditional rendering
- Add controlled tab state for CTA-driven tab switching
- Add `AnimatePresence` transitions for mode switching
- Update all tab empty states to use `MeshEmptyState`
- Update barrel exports in `index.ts`

### Phase 4: Tests + Polish

- Update `MeshPanel.test.tsx` for new Mode A/B behavior
- Add tests for `ScanRootInput`, `DiscoveryView`, `MeshEmptyState`
- Verify animation respects `prefers-reduced-motion`
- Verify config persistence round-trip

## Open Questions

1. ~~**Config transport methods**~~ (RESOLVED)
   **Answer:** Extend existing config response type with `boundary?: string`. Minimal change, backward compatible.

2. ~~**Scan root save trigger**~~ (RESOLVED)
   **Answer:** Save immediately on chip add/remove. Config writes are cheap (atomic JSON file). User expectation: "I set these, they should stick." No risk of losing roots when navigating away.

## Related ADRs

- **ADR 35**: Use @xyflow/react for Mesh Topology — topology graph rendering approach
- **ADR 32**: Hybrid Filesystem + Manifest Namespace Derivation — namespace derivation from scan roots
- **ADR 23**: Custom Async BFS for Agent Discovery — scan depth and BFS algorithm
- **ADR 24**: DorkOS-Native Agent Manifest — `.dork/agent.json` format
- **ADR 25**: Simple JSON Columns for Agent Registry — SQLite storage pattern

## References

- [Ideation document](./01-ideation.md)
- [Research: Mesh Panel UX Overhaul](../../research/20260225_mesh_panel_ux_overhaul.md)
- [Design system](../../contributing/design-system.md)
- [Linear Onboarding Teardown](https://www.candu.ai/blog/linear-onboarding-teardown) — anti-onboarding philosophy
- [Empty State UX Best Practices](https://www.eleken.co/blog-posts/empty-state-ux) — one action, visual anchor, contextual copy
