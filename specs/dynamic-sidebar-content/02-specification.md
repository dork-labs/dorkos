---
slug: dynamic-sidebar-content
number: 156
status: draft
created: 2026-03-20
---

# Dynamic Route-Aware Sidebar & Header Content

**Status:** Draft
**Authors:** Claude Code, 2026-03-20
**Spec Number:** 156
**Branch:** preflight/dynamic-sidebar-content
**Ideation:** `specs/dynamic-sidebar-content/01-ideation.md`

---

## Overview

Make the sidebar and header content dynamic based on the current route. The dashboard (`/`) gets its own sidebar and header, while the session route (`/session`) keeps the current sidebar and header. A 100ms cross-fade animation smooths the transition. The sidebar footer remains static across all routes.

This builds directly on spec 154 (Dashboard Home Route) which established TanStack Router with the pathless `_shell` layout route (AppShell).

## Background / Problem Statement

After spec 154, AppShell renders a single `<AgentSidebar />` regardless of which route is active. The dashboard route shows the same session-list sidebar as the chat route, which is confusing — the dashboard has no active session, so the sessions tab is irrelevant. The header always shows `AgentIdentityChip` + `CommandPaletteTrigger`, which is session-specific content that doesn't apply to the dashboard.

The sidebar and header need to adapt to the active route so each view feels purposeful rather than like a one-size-fits-all layout.

## Goals

- Route-aware sidebar content: different sidebar body for `/` vs `/session`
- Route-aware header content: different header for `/` vs `/session`
- Animated cross-fade transition (100ms) when switching between sidebar variants
- Static sidebar footer (SidebarFooterBar) across all routes — never animates
- Extensible system that can accommodate future routes and non-route-based switching
- Zero changes to embedded mode (Obsidian)

## Non-Goals

- Full dashboard sidebar content (this spec uses a minimal placeholder)
- Full dashboard header content (minimal placeholder)
- Mobile-specific sidebar layouts
- Server-side changes or new API endpoints
- Main content area route transitions (separate concern)
- Dev playground sidebar changes

## Technical Dependencies

No new packages required. Uses existing:

| Package                  | Version           | Purpose                        |
| ------------------------ | ----------------- | ------------------------------ |
| `motion/react`           | Already installed | AnimatePresence for cross-fade |
| `@tanstack/react-router` | Already installed | `useRouterState` for pathname  |

## Detailed Design

### 1. Architecture: Private Switch Hooks in AppShell

Two private hooks in `AppShell.tsx` read the current pathname via `useRouterState` and return the appropriate component for the sidebar body and header content. This is the "Content Map / Switch Hook" pattern recommended by research.

```typescript
// Private to AppShell.tsx — not exported

interface SidebarSlot {
  /** Stable key for AnimatePresence — triggers cross-fade on change */
  key: string;
  /** The sidebar body component to render */
  body: React.ReactNode;
}

function useSidebarSlot(): SidebarSlot {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  switch (pathname) {
    case '/':
      return { key: 'dashboard', body: <DashboardSidebar /> };
    default:
      return { key: 'session', body: <SessionSidebar /> };
  }
}

interface HeaderSlot {
  key: string;
  content: React.ReactNode;
}

function useHeaderSlot(): HeaderSlot {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  switch (pathname) {
    case '/':
      return { key: 'dashboard', content: <DashboardHeader /> };
    default:
      return { key: 'session', content: <SessionHeader /> };
  }
}
```

**Why this approach:**

- **Synchronous** — no flash of empty sidebar during route transitions
- **FSD-compliant** — AppShell is app-level orchestration, can import from any layer
- **Extensible** — add a new case for any future route (e.g., `/settings`, `/mesh`)
- **Non-route switching** — the hook can also read Zustand, feature flags, or query params
- **Trivial animation** — return a `key` that AnimatePresence uses to trigger cross-fade

### 2. AppShell Changes

The sidebar and header regions in AppShell become dynamic:

```tsx
export function AppShell() {
  // ... existing hooks unchanged ...

  const sidebarSlot = useSidebarSlot();
  const headerSlot = useHeaderSlot();

  return (
    <TooltipProvider>
      <MotionConfig reducedMotion="user">
        <AnimatePresence mode="wait">
          {showOnboarding ? (
            /* ... unchanged onboarding gate ... */
          ) : (
            <motion.div key="main-app" /* ... unchanged ... */>
              <div data-testid="app-shell" className="...">
                <PermissionBanner sessionId={activeSessionId} />
                <SidebarProvider
                  open={sidebarOpen}
                  onOpenChange={setSidebarOpen}
                  className="flex-1 overflow-hidden"
                  style={{ '--sidebar-width': '20rem' } as React.CSSProperties}
                >
                  <Sidebar variant="floating">
                    {/* ── Dynamic sidebar body with cross-fade ── */}
                    <AnimatePresence mode="wait" initial={false}>
                      <motion.div
                        key={sidebarSlot.key}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.1 }}
                        className="flex min-h-0 flex-1 flex-col overflow-hidden"
                      >
                        {sidebarSlot.body}
                      </motion.div>
                    </AnimatePresence>

                    {/* ── Static footer — never animates ── */}
                    <SidebarFooter className="border-t p-3">
                      {shouldShowOnboarding && (
                        <div className="mb-2">
                          <ProgressCard
                            onStepClick={(stepIndex) => setOnboardingStep(stepIndex)}
                            onDismiss={dismissOnboarding}
                          />
                        </div>
                      )}
                      <SidebarFooterBar />
                    </SidebarFooter>
                    <SidebarRail />
                  </Sidebar>

                  <SidebarInset className="overflow-hidden">
                    {/* ── Dynamic header with cross-fade ── */}
                    <header className="relative flex h-9 shrink-0 items-center gap-2 border-b px-2 transition-[border-color] duration-300"
                      style={/* ... agent border color, unchanged ... */}
                    >
                      <SidebarTrigger className="-ml-0.5" />
                      <Separator orientation="vertical" className="mr-1 h-4" />
                      <AnimatePresence mode="wait" initial={false}>
                        <motion.div
                          key={headerSlot.key}
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          transition={{ duration: 0.1 }}
                          className="flex flex-1 items-center gap-2"
                        >
                          {headerSlot.content}
                        </motion.div>
                      </AnimatePresence>
                    </header>
                    <main className="flex-1 overflow-hidden">
                      <Outlet />
                    </main>
                  </SidebarInset>
                </SidebarProvider>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        <DialogHost />
        <CommandPaletteDialog />
        <ShortcutsPanel />
        <Toaster />
      </MotionConfig>
    </TooltipProvider>
  );
}
```

**Key structural changes:**

1. `<AgentSidebar />` replaced with `AnimatePresence` wrapper + `sidebarSlot.body`
2. Header inner content replaced with `AnimatePresence` wrapper + `headerSlot.content`
3. `SidebarFooter` (with `ProgressCard` + `SidebarFooterBar`) moves from inside `AgentSidebar` to `AppShell` — outside the AnimatePresence, so it never animates
4. `SidebarRail` also outside AnimatePresence — static chrome
5. `SidebarTrigger` and `Separator` stay in the header — static chrome that persists across routes

### 3. Rename AgentSidebar → SessionSidebar

The current `AgentSidebar` is renamed to `SessionSidebar` to clarify its role as the session-route sidebar. This is a pure rename — no logic changes.

**File:** `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx` (renamed from `AgentSidebar.tsx`)

Changes:

- Remove `SidebarFooter`, `SidebarRail` rendering (moved to AppShell)
- Remove `ProgressCard` and `useOnboarding` imports (moved to AppShell)
- Remove `SidebarFooterBar` import (moved to AppShell)
- Keep all session-specific logic: header (Dashboard link + New Session), tabs, tab panels, auto-select, keyboard shortcuts

```tsx
// SessionSidebar.tsx — formerly AgentSidebar.tsx
// Renders: SidebarHeader + SidebarTabRow + SidebarContent
// Does NOT render: SidebarFooter, SidebarRail (now in AppShell)

export function SessionSidebar() {
  // ... all existing logic unchanged ...

  return (
    <>
      <SidebarHeader className="border-b p-3">
        {/* Dashboard link + New session button — unchanged */}
      </SidebarHeader>

      <SidebarTabRow ... />

      <SidebarContent data-testid="session-list" className="!overflow-hidden">
        {/* Sessions, Schedules, Connections tab panels — unchanged */}
      </SidebarContent>
    </>
  );
}
```

**Barrel update:** `features/session-list/index.ts` exports `SessionSidebar` (and keeps `AgentSidebar` as a deprecated re-export if needed, though a clean rename is preferred).

### 4. New Component: DashboardSidebar

**File:** `apps/client/src/layers/features/dashboard-sidebar/ui/DashboardSidebar.tsx`

Minimal placeholder. Full content is a follow-up spec.

```tsx
import {
  SidebarHeader,
  SidebarContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
} from '@/layers/shared/ui';
import { LayoutDashboard, MessageSquare } from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';

/**
 * Dashboard sidebar — navigation and overview for the dashboard route.
 * Placeholder content; full design is a follow-up spec.
 */
export function DashboardSidebar() {
  const navigate = useNavigate();

  return (
    <>
      <SidebarHeader className="border-b p-3">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive
              className="text-foreground flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium"
            >
              <LayoutDashboard className="size-(--size-icon-sm)" />
              Dashboard
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={() => navigate({ to: '/session' })}
              className="text-muted-foreground hover:bg-accent hover:text-foreground flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-all duration-100 active:scale-[0.98]"
            >
              <MessageSquare className="size-(--size-icon-sm)" />
              Sessions
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent className="flex flex-1 items-center justify-center p-6">
        <p className="text-muted-foreground/60 text-center text-xs">Agent overview coming soon</p>
      </SidebarContent>
    </>
  );
}
```

**FSD placement:** `layers/features/dashboard-sidebar/` — a new feature module. This is a feature (not a widget) because it contains no composition of other features — it's self-contained sidebar content.

**Barrel:** `layers/features/dashboard-sidebar/index.ts` exports `DashboardSidebar`.

### 5. New Components: SessionHeader & DashboardHeader

These extract the header content into discrete components for the switch hook.

**File:** `apps/client/src/layers/features/top-nav/ui/SessionHeader.tsx`

```tsx
import { AgentIdentityChip } from './AgentIdentityChip';
import { CommandPaletteTrigger } from './CommandPaletteTrigger';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { AgentVisual } from '@/layers/entities/agent';

interface SessionHeaderProps {
  agent: AgentManifest | null | undefined;
  visual: AgentVisual;
  isStreaming: boolean;
}

/** Session route header — agent identity chip + command palette trigger. */
export function SessionHeader({ agent, visual, isStreaming }: SessionHeaderProps) {
  return (
    <>
      <AgentIdentityChip agent={agent} visual={visual} isStreaming={isStreaming} />
      <div className="flex-1" />
      <CommandPaletteTrigger />
    </>
  );
}
```

**File:** `apps/client/src/layers/features/top-nav/ui/DashboardHeader.tsx`

```tsx
import { CommandPaletteTrigger } from './CommandPaletteTrigger';

/** Dashboard route header — title + command palette trigger. */
export function DashboardHeader() {
  return (
    <>
      <span className="text-muted-foreground text-sm font-medium">Dashboard</span>
      <div className="flex-1" />
      <CommandPaletteTrigger />
    </>
  );
}
```

**Barrel update:** `features/top-nav/index.ts` adds exports for `SessionHeader` and `DashboardHeader`.

### 6. Header Agent Border Color

The current header has a dynamic `borderBottomColor` based on `agentVisual.color`. This should only apply on the session route (the dashboard has no active agent context).

In the `useHeaderSlot` hook, include the border style:

```typescript
function useHeaderSlot(): HeaderSlot {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  switch (pathname) {
    case '/':
      return {
        key: 'dashboard',
        content: <DashboardHeader />,
        borderStyle: undefined, // No agent border on dashboard
      };
    default:
      return {
        key: 'session',
        content: (
          <SessionHeader agent={currentAgent} visual={agentVisual} isStreaming={isStreaming} />
        ),
        borderStyle: currentAgent
          ? { borderBottomColor: `color-mix(in srgb, ${agentVisual.color} 25%, var(--border))` }
          : undefined,
      };
  }
}
```

The `header` element's `style` prop reads `headerSlot.borderStyle`.

### 7. Onboarding Props Migration

`ProgressCard` and `useOnboarding` are currently consumed inside `AgentSidebar`. After the refactor, they live in `AppShell` (inside `SidebarFooter`, outside the AnimatePresence). The hooks `shouldShowOnboarding`, `dismissOnboarding`, and `setOnboardingStep` are already called in `AppShell` — the only addition is rendering `ProgressCard` there.

**Net effect:** `SessionSidebar` no longer imports from `@/layers/features/onboarding`. This is a clean decoupling — onboarding is app-level chrome, not session-specific.

## User Experience

### Navigation Flow

1. **User opens DorkOS** → Lands on `/` → Sees **dashboard sidebar** (navigation links, placeholder) and **dashboard header** ("Dashboard" title)
2. **User clicks "Sessions" in dashboard sidebar** → Navigates to `/session` → Sidebar cross-fades (100ms) to **session sidebar** (sessions/schedules/connections tabs), header cross-fades to **session header** (agent chip + Cmd+K)
3. **User clicks "Dashboard" in session sidebar header** → Navigates to `/` → Sidebar cross-fades back to dashboard sidebar
4. **Browser Back/Forward** → Same cross-fade transitions
5. **Sidebar footer** (branding, theme, settings) stays put throughout — no animation

### Animation Specification

| Property                  | Value                                               |
| ------------------------- | --------------------------------------------------- |
| Animation type            | Opacity cross-fade                                  |
| Duration                  | 100ms                                               |
| Easing                    | Linear (default for opacity)                        |
| AnimatePresence mode      | `wait` (old exits before new enters)                |
| `initial` on first render | `false` (no animation on page load)                 |
| Reduced motion            | Respected via `<MotionConfig reducedMotion="user">` |

### Embedded Mode (Obsidian)

Zero changes. Embedded mode never enters the router. `App.tsx` renders `<ChatPanel>` directly with Zustand state. The dynamic sidebar system is entirely within `AppShell`, which is only reached via the router.

## Testing Strategy

### Unit Tests — Switch Hooks

**New test file:** `apps/client/src/__tests__/app-shell-slots.test.tsx`

Test the `useSidebarSlot` and `useHeaderSlot` hooks:

- Returns `{ key: 'dashboard', ... }` when pathname is `/`
- Returns `{ key: 'session', ... }` when pathname is `/session`
- Returns `{ key: 'session', ... }` for unknown paths (fallback)

**Mock approach:** Use TanStack Router's `createMemoryRouter` with controlled initial entries.

### Unit Tests — Component Rendering

**`SessionSidebar` tests:** Existing `AgentSidebar.test.tsx` renamed to `SessionSidebar.test.tsx`:

- Verify `SidebarFooter` is NOT rendered by SessionSidebar (it moved to AppShell)
- All existing tab/session tests remain unchanged

**`DashboardSidebar` tests:** New `DashboardSidebar.test.tsx`:

- Renders "Dashboard" as active nav item
- Renders "Sessions" link that navigates to `/session`
- Shows placeholder content

**`DashboardHeader` tests:** New `DashboardHeader.test.tsx`:

- Renders "Dashboard" text
- Renders CommandPaletteTrigger

**`SessionHeader` tests:** New `SessionHeader.test.tsx`:

- Renders AgentIdentityChip with provided props
- Renders CommandPaletteTrigger

### Integration Tests — Cross-Fade Animation

**New test file:** `apps/client/src/__tests__/sidebar-transition.test.tsx`

- Renders AppShell at `/`, verifies DashboardSidebar is present
- Navigates to `/session`, verifies SessionSidebar appears
- Verifies AnimatePresence key changes trigger re-render
- Verifies SidebarFooterBar is always present (doesn't animate)

### Existing Tests — No Changes Expected

Tests that mock `useSessionId` or `useDirectoryState` at the hook level need no changes. Tests that render `AgentSidebar` directly need the import path updated to `SessionSidebar`.

## Performance Considerations

- **No additional network requests** — sidebar switching is pure client-side component swap
- **AnimatePresence overhead** — negligible for a single 100ms opacity transition
- **Lazy loading opportunity** — `DashboardSidebar` and `SessionSidebar` can be code-split via `React.lazy()` in the future if sidebar variants grow heavy. Not needed for the placeholder.

## Security Considerations

- No new attack surface — all changes are client-side component composition
- No new data flows — sidebar content uses existing hooks and queries

## Documentation

- Update `contributing/project-structure.md` to document the new `dashboard-sidebar` feature module
- Update `contributing/architecture.md` to describe the sidebar/header slot pattern
- Update `AGENTS.md` client section to mention dynamic sidebar

## Implementation Phases

### Phase 1: Structural Refactor (Foundation)

1. Rename `AgentSidebar.tsx` → `SessionSidebar.tsx`
2. Remove `SidebarFooter`, `SidebarRail`, `ProgressCard`, `SidebarFooterBar` from `SessionSidebar`
3. Update barrel export in `features/session-list/index.ts`
4. Move footer rendering (SidebarFooter, ProgressCard, SidebarFooterBar, SidebarRail) to `AppShell.tsx`
5. Verify existing behavior is preserved (no visible change yet)

### Phase 2: Switch Hooks & AnimatePresence

1. Add `useSidebarSlot` private hook to `AppShell.tsx`
2. Wrap sidebar body in `AnimatePresence` + `motion.div` keyed by `sidebarSlot.key`
3. Add `useHeaderSlot` private hook to `AppShell.tsx`
4. Wrap header inner content in `AnimatePresence` + `motion.div` keyed by `headerSlot.key`
5. Create `SessionHeader.tsx` (extracts current header content)
6. Create `DashboardHeader.tsx` (placeholder header)

### Phase 3: Dashboard Sidebar

1. Create `features/dashboard-sidebar/` feature module
2. Create `DashboardSidebar.tsx` (placeholder with navigation)
3. Create barrel `features/dashboard-sidebar/index.ts`
4. Wire into `useSidebarSlot` for the `/` route

### Phase 4: Testing & Cleanup

1. Rename `AgentSidebar.test.tsx` → `SessionSidebar.test.tsx`, update assertions
2. Create `DashboardSidebar.test.tsx`
3. Create `SessionHeader.test.tsx`, `DashboardHeader.test.tsx`
4. Create `app-shell-slots.test.tsx` (integration)
5. Update any imports referencing `AgentSidebar` across the codebase
6. Update documentation

## Open Questions

None — all decisions resolved during ideation (see Section 6 of `01-ideation.md`).

## Related ADRs

- ADR-0157: Pathless Layout Route for App Shell — foundation this builds on
- New ADR to extract: Route-aware sidebar/header slot pattern

## References

- `specs/dynamic-sidebar-content/01-ideation.md` — Full ideation with research
- `specs/dashboard-home-route/02-specification.md` — Spec 154, prerequisite
- `research/20260320_route_aware_sidebar_patterns.md` — Approach comparison
- `contributing/animations.md` — Motion library patterns
- `contributing/design-system.md` — Calm Tech animation specs
