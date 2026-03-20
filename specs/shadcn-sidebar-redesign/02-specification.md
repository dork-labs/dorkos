---
number: 86
slug: shadcn-sidebar-redesign
title: 'Shadcn Sidebar Redesign — Agent-Centric Sidebar with Glanceable Status'
status: draft
created: 2026-03-03
authors: ['Claude Code']
ideation: specs/shadcn-sidebar-redesign/01-ideation.md
research: research/20260303_shadcn_sidebar_redesign.md
---

# Shadcn Sidebar Redesign

## Status

Draft

## Overview

Replace DorkOS's custom 392-line `SessionSidebar` and custom motion.dev sidebar layout in `App.tsx` with Shadcn's `Sidebar` component. The migration targets the standalone web path only — embedded mode (Obsidian plugin) is unchanged. The redesign gives the agent identity header visual breathing room, adds glanceable agent context status chips, lifts all dialog ownership to a root-level `DialogHost`, and deletes ~200 lines of custom overlay/push animation code.

## Background / Problem Statement

The current sidebar implementation has four problems:

1. **Monolithic component**: `SessionSidebar.tsx` (392 lines) owns session list rendering, 7 dialog instances, onboarding overlay, Pulse notification toasts, tab badge logic, and all footer UI. This violates single responsibility and makes the component hard to maintain.

2. **Custom layout code in App.tsx**: Lines 219-256 implement separate mobile overlay (AnimatePresence + motion.div with backdrop) and desktop push (motion.div with width animation) patterns. This is ~40 lines of bespoke layout code that Shadcn handles automatically.

3. **Agent header compression**: The close button (`PanelLeftClose`) shares the same row as `AgentHeader`, forcing the agent identity (colored dot, emoji, name, description, path, K Switch button, gear icon) into a cramped horizontal space.

4. **Dialog lifecycle bug on mobile**: All 7 dialogs (Settings, Pulse, Relay, Mesh, DirectoryPicker, AgentDialog, OnboardingFlow) are rendered inside `SessionSidebar`. On mobile, closing the sidebar Sheet unmounts these dialogs mid-interaction.

## Goals

- Replace custom sidebar layout with Shadcn `SidebarProvider` + `Sidebar` + `SidebarInset` for the standalone path
- Reduce `SessionSidebar.tsx` from 392 to ~150 lines by extracting dialog rendering and creating focused sub-components
- Delete ~200 lines of custom sidebar/overlay code from `App.tsx`
- Fix the agent header compression by moving the close button to `SidebarTrigger` in `SidebarInset`
- Add glanceable Pulse/Relay/Mesh status chips in the sidebar footer
- Lift all dialogs to a root-level `DialogHost` that survives sidebar unmount
- Use Shadcn's built-in mobile Sheet (backdrop, swipe-to-close, auto-close-on-nav)
- Use Shadcn's built-in Cmd+B keyboard shortcut

## Non-Goals

- Collapsible icon-only rail mode (future iteration — Shadcn supports `collapsible="icon"` when ready)
- Relay/Pulse/Mesh panel content redesigns
- Agent persona editing flows
- Mobile-native app considerations
- Onboarding flow redesign (ProgressCard moves to new footer location)
- Embedded mode (Obsidian plugin) changes — keeps current custom overlay
- SessionItem internal expand/collapse rework (wrapping in SidebarMenuButton but preserving detail expansion)

## Technical Dependencies

- **Shadcn Sidebar** (`sidebar.tsx`) — installed via `pnpm dlx shadcn@latest add sidebar` from `apps/client/`
- **Radix Sheet** — transitive dependency of Shadcn Sidebar (handles mobile drawer)
- **React 19** — confirmed compatible with current Shadcn releases
- **Tailwind CSS v4** — Shadcn Sidebar uses CSS custom properties directly (not `@theme inline` utilities)
- **Existing entity hooks**: `usePulseEnabled`, `useActiveRunCount`, `useCompletedRunBadge`, `useRelayEnabled`, `useRelayAdapters`, `useRegisteredAgents`, `useMeshStatus`

## Detailed Design

### 1. Install Shadcn Sidebar

```bash
cd apps/client && pnpm dlx shadcn@latest add sidebar
```

This installs `sidebar.tsx` to `layers/shared/ui/` (per `components.json` alias config) and adds `use-mobile.tsx`. After installation: delete the generated `use-mobile.tsx` and update `sidebar.tsx` to import `useIsMobile` from `@/layers/shared/model` instead. Both hooks are identical (`MOBILE_BREAKPOINT = 768`).

### 2. CSS Variables (`index.css`)

Add `--sidebar-*` variables to `:root` and `.dark` blocks. These are consumed directly by `sidebar.tsx` as CSS custom properties — they do NOT go in `@theme inline`.

**Light mode** (add after existing `:root` variables):

```css
:root {
  /* ... existing vars ... */

  /* Sidebar — subtly distinct from main background */
  --sidebar-background: 0 0% 96%;
  --sidebar-foreground: 0 0% 9%;
  --sidebar-primary: 0 0% 9%;
  --sidebar-primary-foreground: 0 0% 98%;
  --sidebar-accent: 0 0% 92%;
  --sidebar-accent-foreground: 0 0% 9%;
  --sidebar-border: 0 0% 83%;
  --sidebar-ring: 217 91% 60%;
}
```

**Dark mode** (add after existing `.dark` variables):

```css
.dark {
  /* ... existing vars ... */

  --sidebar-background: 0 0% 6%;
  --sidebar-foreground: 0 0% 93%;
  --sidebar-primary: 0 0% 93%;
  --sidebar-primary-foreground: 0 0% 9%;
  --sidebar-accent: 0 0% 12%;
  --sidebar-accent-foreground: 0 0% 93%;
  --sidebar-border: 0 0% 25%;
  --sidebar-ring: 213 94% 68%;
}
```

Rationale: Sidebar background is intentionally slightly different from `--background` (96% vs 98% light, 6% vs 4% dark) for subtle visual hierarchy. Calibrated to the pure neutral gray palette.

### 3. App.tsx Layout Refactor

**Standalone path** (`embedded={false}`): Replace the custom mobile overlay + desktop push layout with:

```tsx
<SidebarProvider
  open={sidebarOpen}
  onOpenChange={setSidebarOpen}
  style={{ "--sidebar-width": "20rem" } as React.CSSProperties}
>
  <AppSidebar />
  <SidebarInset>
    <header className="flex items-center gap-2 px-3 py-2">
      <SidebarTrigger />
    </header>
    <main className="flex-1 overflow-hidden">
      {activeSessionId ? (
        <ChatPanel key={activeSessionId} sessionId={activeSessionId} ... />
      ) : (
        <ChatEmptyState />
      )}
    </main>
  </SidebarInset>
</SidebarProvider>
<DialogHost />
<CommandPaletteDialog />
<Toaster />
```

**Embedded path** (`embedded={true}`): Completely unchanged. The existing AnimatePresence overlay code stays.

**Remove**:

- Custom Cmd+B handler effect (lines 74-85) — Shadcn has built-in `SIDEBAR_KEYBOARD_SHORTCUT = "b"`
- Custom Escape key handler for standalone mode — Shadcn Sheet handles this for mobile; desktop offcanvas doesn't need escape
- Floating `PanelLeft` toggle button (lines 196-216) — replaced by `SidebarTrigger` in `SidebarInset` header
- Mobile overlay AnimatePresence block (lines 219-244) — replaced by Shadcn Sheet
- Desktop push motion.div block (lines 245-256) — replaced by `SidebarProvider` + `Sidebar`

**Keep**:

- Embedded mode overlay code (lines 89-169)
- Embedded Escape key handler (scoped to containerRef)
- Embedded floating toggle button
- PermissionBanner rendering
- OnboardingFlow first-run detection and AnimatePresence transition
- All agent visual / favicon / document title hooks

### 4. SessionSidebar Refactor

The component becomes a thin composition of Shadcn Sidebar sub-components. All dialog rendering moves to `DialogHost`.

```tsx
export function SessionSidebar() {
  // ... hooks for sessions, createMutation, handleSessionClick ...

  return (
    <Sidebar collapsible="offcanvas">
      <SidebarHeader>
        <AgentHeader cwd={selectedCwd} onOpenPicker={...} onOpenAgentDialog={...} />
        <NewSessionButton onClick={...} disabled={...} />
      </SidebarHeader>

      <SidebarContent>
        {groupedSessions.length > 0 ? (
          groupedSessions.map((group) => (
            <SidebarGroup key={group.label}>
              {!hideHeader && (
                <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
              )}
              <SidebarMenu>
                {group.sessions.map((session) => (
                  <SidebarMenuItem key={session.id}>
                    <SidebarMenuButton
                      isActive={session.id === activeSessionId}
                      onClick={() => handleSessionClick(session.id)}
                    >
                      <span className="truncate">{session.title}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroup>
          ))
        ) : (
          <div className="...">No conversations yet</div>
        )}
      </SidebarContent>

      <SidebarFooter>
        {shouldShowOnboarding && <ProgressCard ... />}
        <AgentContextChips />
        <SidebarFooterBar />
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
```

**Hooks/logic that stay in SessionSidebar**: `useSessions`, `useDirectoryState`, `createMutation`, `handleSessionClick`, `justCreatedId` state, auto-select-first-session effect, Pulse notification toast logic, tab badge logic, `groupedSessions` memo, `resolvedAgents` for DirectoryPicker.

**Hooks/logic that move to DialogHost or new components**: All 7 dialog JSX blocks (Settings, Pulse, Relay, Mesh, DirectoryPicker, AgentDialog, OnboardingFlow step modal). The onboarding step modal (`onboardingStep !== null`) moves to DialogHost.

### 5. Session Items with SidebarMenuButton

Wrap each session in `SidebarMenuItem` > `SidebarMenuButton` for consistent Shadcn styling and ARIA accessibility:

```tsx
<SidebarMenuItem key={session.id}>
  <SidebarMenuButton
    isActive={session.id === activeSessionId}
    onClick={() => handleSessionClick(session.id)}
    className="h-auto py-2"
  >
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-muted-foreground text-xs">{formatRelativeTime(session.updatedAt)}</span>
      <span className="text-muted-foreground/70 truncate text-xs">{session.title}</span>
    </div>
  </SidebarMenuButton>
</SidebarMenuItem>
```

The existing `SessionItem` expand/collapse detail view is removed from the initial migration. Session items become simpler — showing relative time and title only, with the `isActive` styling handled by `SidebarMenuButton`. The expand-to-show-details interaction (session ID, timestamps, permission mode) can be revisited in a future iteration if needed.

### 6. SidebarRail

Include `<SidebarRail />` after `<SidebarFooter>` inside the `<Sidebar>` component. This adds an invisible hover-target strip at the sidebar edge for mouse-over toggle — a common pattern in dashboard UIs.

### 7. DialogHost Component

New component rendered at App.tsx root level, outside `SidebarProvider`:

```tsx
function DialogHost() {
  const {
    settingsOpen,
    setSettingsOpen,
    pulseOpen,
    setPulseOpen,
    relayOpen,
    setRelayOpen,
    meshOpen,
    setMeshOpen,
    pickerOpen,
    setPickerOpen,
    agentDialogOpen,
    setAgentDialogOpen,
  } = useAppStore();
  const [selectedCwd] = useDirectoryState();
  const { recentCwds } = useAppStore();
  const recentPaths = useMemo(() => recentCwds.map((r) => r.path), [recentCwds]);
  const { data: resolvedAgents } = useResolvedAgents(recentPaths);
  const [onboardingStep, setOnboardingStep] = useState<number | null>(null);

  return (
    <>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <DirectoryPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onSelect={(path) => setSelectedCwd(path)}
        initialPath={selectedCwd}
        resolvedAgents={resolvedAgents}
      />
      <ResponsiveDialog open={pulseOpen} onOpenChange={setPulseOpen}>
        {/* ... PulsePanel content ... */}
      </ResponsiveDialog>
      <ResponsiveDialog open={relayOpen} onOpenChange={setRelayOpen}>
        {/* ... RelayPanel content ... */}
      </ResponsiveDialog>
      <ResponsiveDialog open={meshOpen} onOpenChange={setMeshOpen}>
        {/* ... MeshPanel content ... */}
      </ResponsiveDialog>
      {selectedCwd && (
        <AgentDialog
          projectPath={selectedCwd}
          open={agentDialogOpen}
          onOpenChange={setAgentDialogOpen}
        />
      )}
      {onboardingStep !== null && (
        <div className="bg-background fixed inset-0 z-50">
          <OnboardingFlow initialStep={onboardingStep} onComplete={() => setOnboardingStep(null)} />
        </div>
      )}
    </>
  );
}
```

This ensures dialogs survive sidebar open/close cycles and mobile Sheet unmounts. The `onboardingStep` trigger mechanism needs to be communicated from the sidebar's ProgressCard — either via Zustand (add `onboardingStep`/`setOnboardingStep` to store) or by lifting the `ProgressCard`'s `onStepClick` handler to use the existing onboarding state.

### 8. AgentContextChips Component

New file: `apps/client/src/layers/features/session-list/ui/AgentContextChips.tsx`

Compact row of status chips in `SidebarFooter`, showing Pulse/Relay/Mesh status at a glance:

```tsx
export function AgentContextChips() {
  const pulseEnabled = usePulseEnabled();
  const { data: activeRunCount = 0 } = useActiveRunCount(pulseEnabled);
  const relayEnabled = useRelayEnabled();
  const { data: agents = [] } = useRegisteredAgents();
  const { setPulseOpen, setRelayOpen, setMeshOpen } = useAppStore();

  return (
    <div className="flex items-center gap-1 px-2 py-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={() => setPulseOpen(true)}
            className={cn(
              'relative rounded-md p-1.5 transition-colors',
              pulseEnabled
                ? 'text-muted-foreground hover:text-foreground'
                : 'text-muted-foreground/25 hover:text-muted-foreground/40'
            )}
            aria-label="Pulse scheduler"
          >
            <icons.pulse className="size-(--size-icon-sm)" />
            {activeRunCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 size-2 animate-pulse rounded-full bg-green-500" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">
          {pulseEnabled
            ? activeRunCount > 0
              ? `${activeRunCount} run${activeRunCount > 1 ? 's' : ''} active`
              : 'Pulse — no active runs'
            : 'Pulse is disabled'}
        </TooltipContent>
      </Tooltip>

      {/* Similar pattern for Relay and Mesh chips */}
    </div>
  );
}
```

Design principles:

- **Tooltip-first**: Status details shown in tooltips, not inline text. The footer is too narrow for labels.
- **Muted disabled states**: `text-muted-foreground/25` for disabled features — visually de-emphasizes without hiding.
- **Status dots**: Green animated dot for active Pulse runs; amber dot for unviewed completions.
- **Tappable**: Each chip opens its respective panel dialog.

### 9. SidebarFooterBar Component

New file: `apps/client/src/layers/features/session-list/ui/SidebarFooterBar.tsx`

Bottom bar with branding, settings, and theme toggle:

```tsx
export function SidebarFooterBar() {
  const { setSettingsOpen } = useAppStore();
  const { theme, setTheme } = useTheme();
  const ThemeIcon = { light: Sun, dark: Moon, system: Monitor }[theme];

  const cycleTheme = useCallback(() => {
    const themeOrder: Theme[] = ['light', 'dark', 'system'];
    const idx = themeOrder.indexOf(theme);
    setTheme(themeOrder[(idx + 1) % themeOrder.length]);
  }, [theme, setTheme]);

  return (
    <div className="border-border flex items-center border-t px-2 py-1.5">
      <a
        href="https://dorkian.com"
        target="_blank"
        rel="noopener noreferrer"
        className="text-2xs text-muted-foreground/50 hover:text-muted-foreground transition-colors"
      >
        DorkOS by Dorkian
      </a>
      <div className="ml-auto flex items-center gap-0.5">
        <button
          onClick={() => setSettingsOpen(true)}
          className="text-muted-foreground/50 hover:text-muted-foreground rounded-md p-1 transition-colors"
          aria-label="Settings"
        >
          <Settings className="size-(--size-icon-sm)" />
        </button>
        <button
          onClick={cycleTheme}
          className="text-muted-foreground/50 hover:text-muted-foreground rounded-md p-1 transition-colors"
          aria-label={`Theme: ${theme}. Click to cycle.`}
        >
          <ThemeIcon className="size-(--size-icon-sm)" />
        </button>
        {import.meta.env.DEV && <DevtoolsToggle />}
      </div>
    </div>
  );
}
```

### 10. AgentHeader Breathing Room

Remove the close button from `AgentHeader`'s row. The sidebar close button is now `SidebarTrigger` in `SidebarInset` header — completely outside the sidebar. This means:

- The `flex items-center gap-1.5` wrapper that put AgentHeader + PanelLeftClose on the same row in SessionSidebar (lines 159-176) is removed
- AgentHeader gets the full width of `SidebarHeader`
- The `K Switch` button and gear icon no longer compete with a close button

No changes to AgentHeader's internal layout are needed — just removing the external constraint.

### 11. Zustand Store Updates

Add to `app-store.ts`:

```typescript
// New state for agent dialog (currently local state in SessionSidebar)
agentDialogOpen: false,
setAgentDialogOpen: (open: boolean) => set({ agentDialogOpen: open }),

// Onboarding step state (currently local state in SessionSidebar)
onboardingStep: null as number | null,
setOnboardingStep: (step: number | null) => set({ onboardingStep: step }),
```

Desktop `sidebarOpen` continues to connect to `SidebarProvider` via `open`/`onOpenChange`. Mobile Sheet state is internal to Shadcn — not persisted in Zustand. The mobile-specific `setSidebarOpen(false)` calls in `handleSessionClick` and `createMutation.onSuccess` can be removed — Shadcn's mobile Sheet auto-closes on navigation.

### 12. Data Flow Diagram

```
App.tsx
├── TooltipProvider
│   ├── MotionConfig
│   │   ├── [embedded path — unchanged]
│   │   └── [standalone path]
│   │       ├── SidebarProvider (open={sidebarOpen}, onOpenChange={setSidebarOpen})
│   │       │   ├── Sidebar (collapsible="offcanvas")
│   │       │   │   ├── SidebarHeader
│   │       │   │   │   ├── AgentHeader (full width, no close button)
│   │       │   │   │   └── NewSessionButton
│   │       │   │   ├── SidebarContent
│   │       │   │   │   └── SidebarGroup* (Today, Yesterday, ...)
│   │       │   │   │       ├── SidebarGroupLabel
│   │       │   │   │       └── SidebarMenu
│   │       │   │   │           └── SidebarMenuItem*
│   │       │   │   │               └── SidebarMenuButton (isActive)
│   │       │   │   ├── SidebarFooter
│   │       │   │   │   ├── ProgressCard (onboarding, conditional)
│   │       │   │   │   ├── AgentContextChips (Pulse/Relay/Mesh status)
│   │       │   │   │   └── SidebarFooterBar (branding + settings + theme)
│   │       │   │   └── SidebarRail
│   │       │   └── SidebarInset
│   │       │       ├── header → SidebarTrigger
│   │       │       └── main → ChatPanel | ChatEmptyState
│   │       ├── DialogHost (Settings, Pulse, Relay, Mesh, DirectoryPicker,
│   │       │                AgentDialog, OnboardingFlow step modal)
│   │       ├── CommandPaletteDialog
│   │       └── Toaster
```

### 13. File Changes Summary

| File                                             | Change                                      | Lines Before → After (est.) |
| ------------------------------------------------ | ------------------------------------------- | --------------------------- |
| `layers/shared/ui/sidebar.tsx`                   | NEW — Shadcn install                        | 0 → ~350 (generated)        |
| `features/session-list/ui/SessionSidebar.tsx`    | Major refactor                              | 392 → ~150                  |
| `features/session-list/ui/AgentHeader.tsx`       | Minor — remove close button constraint      | 133 → ~130                  |
| `features/session-list/ui/AgentContextChips.tsx` | NEW                                         | 0 → ~80                     |
| `features/session-list/ui/SidebarFooterBar.tsx`  | NEW                                         | 0 → ~60                     |
| `App.tsx`                                        | Major — SidebarProvider layout + DialogHost | 280 → ~200                  |
| `shared/model/app-store.ts`                      | Minor — add agentDialogOpen, onboardingStep | 408 → ~420                  |
| `index.css`                                      | Minor — add --sidebar-\* CSS vars           | 426 → ~445                  |
| `features/session-list/index.ts`                 | Minor — export new components               | 7 → ~10                     |

**Net code change**: ~200 lines of custom sidebar/overlay code deleted, ~140 lines of new focused components added, plus ~350 generated Shadcn sidebar code.

## User Experience

### Desktop

- Sidebar pushes main content (same behavior as current)
- `SidebarTrigger` button appears in `SidebarInset` header when sidebar is closed
- Cmd+B / Ctrl+B toggles sidebar (Shadcn built-in)
- SidebarRail allows hover-expand at sidebar edge
- Agent header has full width with no competing close button
- Status chips at bottom give at-a-glance Pulse/Relay/Mesh status
- Full footer with branding, settings gear, and theme toggle

### Mobile

- Sidebar opens as a Sheet (drawer) with backdrop
- Swipe-to-close on touch devices
- Auto-closes when a session is selected (Shadcn built-in)
- Same status chips and footer as desktop
- Dialogs survive sidebar close (DialogHost is outside SidebarProvider)

### Keyboard

- `Cmd+B` / `Ctrl+B` — toggle sidebar (Shadcn built-in)
- `Escape` — close mobile Sheet (Shadcn built-in)
- `Cmd+K` / `Ctrl+K` — command palette (unchanged)

## Testing Strategy

### Unit Tests — SessionSidebar

Update `__tests__/SessionSidebar.test.tsx`:

- **Test wrapper must include `SidebarProvider`**: Since `SessionSidebar` now uses `Sidebar` sub-components that require `SidebarProvider` context, the test wrapper needs `<SidebarProvider>` around the rendered component.
- **"New session" button test**: Verify button renders and mutation fires (preserved).
- **Session grouping test**: Verify `SidebarGroup`/`SidebarGroupLabel` renders time groups (adapted from current test).
- **Empty state test**: Verify "No conversations yet" renders when no sessions (preserved).
- **Auto-select first session test**: Verify `setActiveSession` called with first session ID (preserved).
- **Remove "Close sidebar" button tests**: The close button no longer lives in SessionSidebar — it's `SidebarTrigger` in `SidebarInset`.
- **NEW: AgentContextChips rendering**: Verify Pulse/Relay/Mesh chips render with correct enabled/disabled states.

### Unit Tests — AgentHeader

Update `__tests__/AgentHeader.test.tsx`:

- All existing tests should pass with minimal changes (AgentHeader's internal behavior is unchanged).
- The component no longer has a close button competing for space, but this was never in AgentHeader itself — it was in SessionSidebar's wrapper.

### Unit Tests — DialogHost

New test file `__tests__/DialogHost.test.tsx`:

- **Renders when dialog state is true**: Set `settingsOpen: true` in mock store, verify `SettingsDialog` renders.
- **Does not render when dialog state is false**: All store flags false, verify no dialogs in DOM.
- **Multiple dialogs can be open**: Set multiple flags true simultaneously.

### Unit Tests — AgentContextChips

New test file `__tests__/AgentContextChips.test.tsx`:

- **Renders Pulse chip with active runs**: Mock `useActiveRunCount` to return 3, verify green dot renders.
- **Renders muted chip when Pulse disabled**: Mock `usePulseEnabled` to return false, verify muted styling.
- **Clicking chip opens panel**: Verify `setPulseOpen(true)` called on click.
- **Tooltip content varies by state**: Verify tooltip text for enabled/disabled/active states.

### Unit Tests — SidebarFooterBar

New test file `__tests__/SidebarFooterBar.test.tsx`:

- **Renders branding link**: Verify "DorkOS by Dorkian" renders.
- **Settings button opens settings**: Verify `setSettingsOpen(true)` called.
- **Theme toggle cycles**: Verify theme cycles light → dark → system.

### Mocking Strategies

- **SidebarProvider context**: Tests for components inside Sidebar need `<SidebarProvider>` wrapper. Use `<SidebarProvider defaultOpen={true}>` in test wrappers.
- **Shadcn Sheet on mobile**: The Shadcn Sidebar renders as Sheet when `isMobile` is true (768px breakpoint). Tests should mock `matchMedia` (already done in existing tests).
- **Entity hooks**: Continue mocking `usePulseEnabled`, `useRelayEnabled`, `useRegisteredAgents`, etc. via `vi.mock()`.

## Performance Considerations

- **No new network requests**: AgentContextChips reuses existing entity hooks that are already fetching data.
- **Reduced re-renders**: DialogHost only re-renders when dialog state changes (Zustand selector). Decoupling dialogs from SessionSidebar eliminates unnecessary re-renders when sidebar state changes.
- **Shadcn Sheet vs custom AnimatePresence**: Shadcn uses Radix Sheet (portal-based) which is similarly lightweight. No performance regression expected.
- **SidebarRail**: The hover strip is CSS-only — no additional JS event listeners beyond what the Sidebar component already manages.

## Security Considerations

No security implications. This is a pure UI restructuring with no API changes, no new data fetching, and no changes to authentication or authorization flows.

## Documentation

Update the following:

- **`contributing/design-system.md`**: Update sidebar section to document the Shadcn Sidebar component, 320px width, and `--sidebar-*` CSS variables.
- **`contributing/keyboard-shortcuts.md`**: Update Cmd+B entry to note it's now Shadcn built-in.
- **`CLAUDE.md`**: Update the client FSD layers table to include new components (AgentContextChips, SidebarFooterBar, DialogHost). Update the `features/session-list/` row.

## Implementation Phases

### Phase 1: Foundation (CSS + Shadcn Install + Store Updates)

1. Install Shadcn Sidebar: `cd apps/client && pnpm dlx shadcn@latest add sidebar`
2. Resolve `use-mobile.tsx` conflict with existing `useIsMobile` hook
3. Add `--sidebar-*` CSS variables to `index.css` (both `:root` and `.dark`)
4. Add `agentDialogOpen` and `onboardingStep` to Zustand store

### Phase 2: Layout Migration (App.tsx + DialogHost)

1. Create `DialogHost` component in App.tsx (or extract to a file)
2. Refactor standalone path in App.tsx: wrap in `SidebarProvider` + `SidebarInset`
3. Add `SidebarTrigger` in `SidebarInset` header
4. Remove custom Cmd+B handler
5. Remove custom mobile overlay and desktop push code
6. Remove floating `PanelLeft` toggle button (standalone path only)
7. Verify embedded mode is completely unchanged

### Phase 3: Sidebar Internals (SessionSidebar + New Components)

1. Refactor SessionSidebar to use `Sidebar`, `SidebarHeader`, `SidebarContent`, `SidebarFooter`
2. Replace session list rendering with `SidebarGroup`/`SidebarMenu`/`SidebarMenuButton`
3. Add `SidebarRail`
4. Remove all 7 dialog JSX blocks from SessionSidebar
5. Remove close button wrapper around AgentHeader
6. Create `AgentContextChips` component
7. Create `SidebarFooterBar` component
8. Update `features/session-list/index.ts` barrel exports

### Phase 4: Tests + Cleanup

1. Update `SessionSidebar.test.tsx` — add SidebarProvider wrapper, remove close button tests
2. Update `AgentHeader.test.tsx` — verify no regressions
3. Add `DialogHost.test.tsx`
4. Add `AgentContextChips.test.tsx`
5. Add `SidebarFooterBar.test.tsx`
6. Run full test suite: `pnpm test -- --run`
7. Run typecheck: `pnpm typecheck`
8. Run lint: `pnpm lint`
9. Update documentation (design-system.md, keyboard-shortcuts.md, CLAUDE.md)

## Open Questions

1. ~~**`use-mobile.tsx` conflict**~~ (RESOLVED)
   **Answer:** Patch sidebar.tsx to import DorkOS's existing `useIsMobile()` from `shared/model`. Delete Shadcn's generated `use-mobile.tsx`. Both hooks are functionally identical (`MOBILE_BREAKPOINT = 768` with `matchMedia`), so keeping DorkOS's existing hook as the single source of truth is cleanest.

2. ~~**Onboarding step trigger**~~ (RESOLVED)
   **Answer:** Add `onboardingStep`/`setOnboardingStep` to Zustand store. Consistent with how all other dialog/overlay states are managed in `app-store.ts`. Transient (not persisted to localStorage).

3. ~~**SessionItem expand/collapse removal**~~ (RESOLVED)
   **Answer:** Remove detail expansion entirely. Session items show time + title only in `SidebarMenuButton`. Session details (ID, timestamps, permission mode) are available via the status bar and can be discovered through the session header. Cleaner sidebar.

## Related ADRs

- **ADR-0009**: Calm Tech Notification Layers — guides the status chip design (non-intrusive, tooltip-first)
- **ADR-0063**: Shadcn Command Dialog for Global Palette — established the pattern of using Shadcn primitives for major UI components

## References

- Ideation: `specs/shadcn-sidebar-redesign/01-ideation.md`
- Research: `research/20260303_shadcn_sidebar_redesign.md` (18 sources)
- Parent spec: #85 agent-centric-ux
- Shadcn Sidebar docs: https://ui.shadcn.com/docs/components/sidebar
- Persona: Kai (The Autonomous Builder) — needs quick agent switching and at-a-glance status
- Persona: Priya (The Knowledge Architect) — values clean architecture, "stays out of the way"
