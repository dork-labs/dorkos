---
title: 'Shadcn Sidebar Redesign — API, State Management, Tailwind v4, and Dialog Lifting'
date: 2026-03-03
type: external-best-practices
status: active
tags: [shadcn, sidebar, react, tailwind-v4, zustand, dialog, state-management, mobile]
feature_slug: agent-centric-ux
searches_performed: 10
sources_count: 18
---

## Research Summary

Shadcn's Sidebar component is fully production-ready with React 19 and Tailwind v4. It handles mobile/desktop switching automatically via an internal `isMobile` hook at 768px (matching DorkOS's existing breakpoint exactly). The component supports controlled state via `open`/`onOpenChange` props on `SidebarProvider`, making Zustand integration straightforward — but there is a meaningful tension between using SidebarProvider's built-in cookie persistence vs. DorkOS's existing `localStorage` approach. The key implementation decision is whether to make `SidebarProvider` a thin bridge to Zustand (recommended) or let Shadcn own the state entirely.

For dialog lifting, the existing Zustand approach is already correct — the dialogs should remain in `app-store.ts` and be lifted from `SessionSidebar` to a root-level `DialogHost` component to survive sidebar remounts. Shadcn Sidebar's `--sidebar-*` CSS variables require explicit definition in `index.css` alongside the existing `--background` palette.

---

## Key Findings

### 1. SidebarProvider API — Controlled vs. Cookie-Based State

Shadcn `SidebarProvider` supports two modes:

**Uncontrolled (cookie-persisted, default):**

```tsx
<SidebarProvider defaultOpen={true}>
  <Sidebar />
  <SidebarInset>{children}</SidebarInset>
</SidebarProvider>
```

Persists state in a cookie named `sidebar:state` with 7-day max-age. Good for SSR apps (Next.js) but creates a parallel persistence mechanism alongside DorkOS's existing `localStorage` store.

**Controlled (Zustand-bridged, recommended for DorkOS):**

```tsx
const { sidebarOpen, setSidebarOpen } = useAppStore();

<SidebarProvider open={sidebarOpen} onOpenChange={setSidebarOpen}>
  <Sidebar />
  <SidebarInset>{children}</SidebarInset>
</SidebarProvider>;
```

This keeps Zustand as the single source of truth. The `onOpenChange` callback fires for both desktop toggle and mobile Sheet dismiss events. There is a known bug in older versions where `onOpenChange` fails to trigger on mobile — resolved in current shadcn/ui releases.

**Props reference for `SidebarProvider`:**

| Prop           | Type                      | Description                                           |
| -------------- | ------------------------- | ----------------------------------------------------- |
| `defaultOpen`  | `boolean`                 | Initial open state (uncontrolled)                     |
| `open`         | `boolean`                 | Controlled open state                                 |
| `onOpenChange` | `(open: boolean) => void` | State change callback                                 |
| `style`        | `React.CSSProperties`     | Override `--sidebar-width` / `--sidebar-width-mobile` |

**Width customization:**

```tsx
<SidebarProvider
  style={{
    "--sidebar-width": "20rem",       // default: 16rem
    "--sidebar-width-mobile": "18rem", // default: 18rem
  } as React.CSSProperties}
>
```

### 2. useSidebar Hook — Full API

The `useSidebar` hook is available to any component inside `SidebarProvider`. It exposes:

```tsx
const {
  state, // "expanded" | "collapsed"
  open, // boolean — desktop open state
  setOpen, // (open: boolean) => void
  openMobile, // boolean — mobile Sheet open state (separate from desktop)
  setOpenMobile, // (open: boolean) => void
  isMobile, // boolean — whether in mobile mode
  toggleSidebar, // () => void — toggles the correct state based on isMobile
} = useSidebar();
```

Critical insight: **mobile and desktop open states are separate**. On mobile, `open` refers to the desktop collapsed state while `openMobile` tracks the Sheet. `toggleSidebar()` correctly routes to either `setOpen` or `setOpenMobile` based on `isMobile`. The DorkOS Zustand store currently conflates these into a single `sidebarOpen` — this will require a decision on how to handle the separation.

### 3. Mobile Behavior — Sheet, Breakpoint, and Auto-Close

Shadcn Sidebar automatically renders as a Radix `Sheet` (drawer) on mobile. The mobile behavior is:

- **Breakpoint**: Hardcoded at **768px** via `MOBILE_BREAKPOINT` constant in `use-mobile.jsx`. This **exactly matches** DorkOS's existing `useIsMobile()` hook at `max-width: 767px`.
- **Auto-close on navigation**: The mobile Sheet automatically closes when the pathname changes (built-in behavior).
- **Backdrop**: Provided automatically by the Sheet component — no custom backdrop needed.
- **Swipe to close**: Sheet inherits Vaul/Radix swipe behavior on touch devices.

The breakpoint is **not configurable via props**. GitHub issue #5747 requesting this was closed as "not planned." To change it, you must edit the `MOBILE_BREAKPOINT` constant in the installed `sidebar.tsx` file. Since DorkOS and Shadcn both use 768px, no change is needed.

**Customizing breakpoint (if needed):**
Edit `apps/client/src/layers/shared/ui/sidebar.tsx` after installation:

```typescript
const MOBILE_BREAKPOINT = 768; // change here
```

### 4. Sidebar Component Props

```tsx
<Sidebar
  side="left" // "left" | "right"
  variant="sidebar" // "sidebar" | "floating" | "inset"
  collapsible="offcanvas" // "offcanvas" | "icon" | "none"
/>
```

**Collapsible options:**

- `offcanvas`: Slides completely off-screen (matches current DorkOS behavior)
- `icon`: Collapses to icon-only strip (for future icon-rail mode)
- `none`: Always visible, non-collapsible

**Variant options:**

- `sidebar`: Standard sidebar that pushes main content
- `floating`: Sidebar floats over content with border radius
- `inset`: Sidebar sits within a rounded main content area

For DorkOS, `collapsible="offcanvas"` with `variant="sidebar"` matches the existing behavior.

### 5. Tailwind v4 Compatibility

Shadcn/ui is fully compatible with Tailwind v4 as of early 2025. Key details:

- All components updated for React 19 (no `forwardRef` — uses `data-slot` attributes instead)
- `tailwindcss-animate` replaced with `tw-animate-css`
- HSL color format is still supported (OKLCH is new default for fresh installs, but HSL works fine)
- The `new-york` style is now the only actively maintained style (matches DorkOS's config)
- CSS variables for sidebar are NOT declared in `@theme inline` by default — they stay in `:root` and `.dark`

**Critical CSS integration point:**

DorkOS's `index.css` uses the pattern:

```css
@theme inline {
  --color-background: hsl(var(--background));
  /* ... etc */
}
```

The Shadcn sidebar CSS variables use a **different naming convention**:

- Shadcn uses `--sidebar-background`, `--sidebar-foreground`, etc.
- The `@theme` block maps `--background` → `--color-background` for Tailwind utilities
- Sidebar variables are used directly as CSS custom properties by the `sidebar.tsx` component, NOT as Tailwind color utilities — so they do NOT need to be added to `@theme inline`

**Required CSS additions to `index.css`:**

```css
:root {
  /* ... existing vars ... */

  /* Sidebar-specific variables */
  --sidebar-background: 0 0% 96%; /* slightly off-white, different from --background */
  --sidebar-foreground: 0 0% 9%;
  --sidebar-primary: 0 0% 9%;
  --sidebar-primary-foreground: 0 0% 98%;
  --sidebar-accent: 0 0% 92%;
  --sidebar-accent-foreground: 0 0% 9%;
  --sidebar-border: 0 0% 83%;
  --sidebar-ring: 217 91% 60%;
}

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

**Pure neutral gray palette note:** DorkOS uses a pure neutral gray palette (`0 0% X%` hue-saturation format). The sidebar variables above are calibrated to match — `--sidebar-background` is intentionally slightly different from `--background` (96% vs 98%) to give the sidebar a subtle visual distinction, which is the Shadcn design intent.

**If you want the sidebar to match the main background exactly**, set `--sidebar-background: var(--background)`.

### 6. SidebarInset and Layout Structure

`SidebarInset` replaces the current `<main>` flex wrapper. It handles the layout shift when sidebar opens/closes:

```tsx
// Full structure required in App.tsx
<SidebarProvider open={sidebarOpen} onOpenChange={setSidebarOpen}>
  <Sidebar collapsible="offcanvas">
    <SidebarHeader>...</SidebarHeader>
    <SidebarContent>...</SidebarContent>
    <SidebarFooter>...</SidebarFooter>
    <SidebarRail />
  </Sidebar>
  <SidebarInset>
    <header>...</header>
    <main>{children}</main>
  </SidebarInset>
</SidebarProvider>
```

`SidebarRail` adds an invisible hover-target strip at the sidebar edge that allows mouse-over expand (optional but common in dashboard UIs).

### 7. Menu Components for Session List

The session list maps well to `SidebarMenu`:

```tsx
<SidebarContent>
  <SidebarGroup>
    <SidebarGroupLabel>Today</SidebarGroupLabel>
    <SidebarMenu>
      {sessions.map((session) => (
        <SidebarMenuItem key={session.id}>
          <SidebarMenuButton
            isActive={session.id === activeSessionId}
            onClick={() => handleSessionClick(session.id)}
          >
            <span>{session.title}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  </SidebarGroup>
</SidebarContent>
```

`SidebarMenuButton` accepts:

- `isActive`: boolean — applies active styling
- `asChild`: boolean — renders as child element (for links)
- `tooltip`: string — tooltip shown when sidebar is collapsed to icon mode

`SidebarMenuBadge` renders inline badges (useful for Pulse active run count):

```tsx
<SidebarMenuItem>
  <SidebarMenuButton>
    <icons.pulse />
    <span>Pulse</span>
  </SidebarMenuButton>
  {activeRunCount > 0 && <SidebarMenuBadge>{activeRunCount}</SidebarMenuBadge>}
</SidebarMenuItem>
```

### 8. State-Based Styling with Data Attributes

Shadcn Sidebar exposes CSS state via `data-*` attributes for conditional styling:

```tsx
// Hide a group when sidebar collapses to icon mode
<SidebarGroup className="group-data-[collapsible=icon]:hidden" />

// Show action only on active item
<SidebarMenuAction className="peer-data-[active=true]/menu-button:opacity-100" />

// Style based on sidebar state
<div className="group-data-[state=collapsed]/sidebar:hidden" />
```

### 9. Dialog Lifting Pattern — Zustand Registry

**Current problem:** All dialogs (Settings, Pulse, Relay, Mesh, DirectoryPicker, AgentDialog, OnboardingFlow) are rendered inside `SessionSidebar`. This causes two issues:

1. On mobile, `SessionSidebar` unmounts when the sidebar Sheet closes, unmounting dialogs mid-interaction
2. It violates the principle that dialogs are global UI, not sidebar-scoped

**Recommended pattern: Dialog Host at App Root**

Move dialog rendering to `App.tsx` (or a dedicated `DialogHost` component) while keeping state in Zustand:

```tsx
// App.tsx — add after SidebarProvider
function DialogHost() {
  const {
    settingsOpen, setSettingsOpen,
    pulseOpen, setPulseOpen,
    relayOpen, setRelayOpen,
    meshOpen, setMeshOpen,
    pickerOpen, setPickerOpen,
  } = useAppStore();
  const [selectedCwd] = useDirectoryState();

  return (
    <>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <DirectoryPicker open={pickerOpen} onOpenChange={setPickerOpen} ... />
      <ResponsiveDialog open={pulseOpen} onOpenChange={setPulseOpen}>
        <PulsePanel />
      </ResponsiveDialog>
      {/* etc. */}
    </>
  );
}

// In App.tsx render:
<SidebarProvider ...>
  <AppSidebar />           {/* cleaned-up SessionSidebar */}
  <SidebarInset>
    <main>...</main>
  </SidebarInset>
</SidebarProvider>
<DialogHost />             {/* outside SidebarProvider, always mounted */}
<CommandPaletteDialog />
<Toaster />
```

**Why this is correct:**

- Dialogs survive sidebar open/close and mobile Sheet unmounts
- `useAppStore()` is globally accessible — `DialogHost` can read state without prop drilling
- Zustand already has all the open/close state — no new patterns needed
- Matches how `CommandPaletteDialog` and `Toaster` are already rendered (outside main layout)

**Alternative: nice-modal-react registry pattern**
For a more scalable approach as more dialogs are added, eBay's `nice-modal-react` library allows:

```tsx
NiceModal.show(SettingsDialog);
// or
const modal = useModal(SettingsDialog);
modal.show();
```

This decouples dialog invocation from component hierarchy entirely. Overkill for current DorkOS scale but worth considering if dialog count grows significantly.

### 10. Status Chip Patterns in Sidebar Footer

Industry patterns for glanceable system status in sidebar footers:

**VS Code pattern**: Tiny colored status bar at the very bottom of the window with text labels. Uses semantic colors (green = connected, orange = warning, red = error).

**Linear pattern**: Footer shows workspace name + avatar. Status indicators are icon-only with tooltips — not persistent status chips.

**Notion pattern**: Footer shows user avatar + workspace switcher. Feature status shown as notification badges (red dot) on icon buttons.

**Recommended pattern for DorkOS sidebar footer** (based on current implementation analysis):
The current approach of icon buttons with dot badges in the footer is already aligned with best practices. The key improvements:

1. **Status dots on system icons**: Keep the green animated dot for active Pulse runs and amber dot for unviewed completions — this is exactly the Linear/GitHub pattern.
2. **Tooltip-first**: Show status details in tooltips, not inline text. The footer is too narrow for text labels.
3. **Muted disabled states**: Current `text-muted-foreground/25` for disabled features is correct — visually de-emphasizes without hiding.
4. **Connection indicator**: A subtle status dot on the Relay icon (connected/disconnected) follows VS Code's bottom-bar semantic color pattern.

---

## Detailed Analysis

### Zustand + SidebarProvider Integration

The cleanest integration keeps Zustand as the authority and treats `SidebarProvider` as a controlled component:

```tsx
// In App.tsx
const { sidebarOpen, setSidebarOpen } = useAppStore();

<SidebarProvider
  open={sidebarOpen}
  onOpenChange={(open) => {
    // setSidebarOpen already writes to localStorage
    setSidebarOpen(open);
  }}
>
```

**The mobile/desktop state split:** Shadcn tracks desktop state (`open`) and mobile state (`openMobile`) separately. When you pass controlled `open` to `SidebarProvider`, it controls the desktop state. Mobile state (`openMobile`) is managed internally by the Sheet. This means:

- When user opens sidebar on mobile → Sheet opens → `onOpenChange` does NOT fire (mobile uses `openMobile`)
- When user closes Sheet on mobile → `onOpenChange` does NOT fire

This is a subtle but important behavioral difference from DorkOS's current single `sidebarOpen`. The recommendation is to accept this split:

```typescript
// In app-store.ts — add mobile state
sidebarOpenMobile: false,
setSidebarOpenMobile: (open) => set({ sidebarOpenMobile: open }),
```

And connect it via the `useSidebar` hook inside a child component:

```tsx
// In a SidebarStateSync component inside SidebarProvider
function SidebarStateSync() {
  const { openMobile, setOpenMobile } = useSidebar();
  const { sidebarOpenMobile } = useAppStore();

  useEffect(() => {
    setOpenMobile(sidebarOpenMobile);
  }, [sidebarOpenMobile, setOpenMobile]);

  return null;
}
```

Or, more simply, accept that mobile Sheet state is not persisted (it resets on each mobile visit, which is correct UX behavior anyway).

**Simplest viable approach**: Only control desktop `open` state via Zustand. Let mobile Sheet state be fully internal to Shadcn. Remove the mobile-specific `setSidebarOpen(false)` calls in session click handlers — the Sheet's built-in auto-close-on-navigation will handle it.

### Embedded Mode (Obsidian Plugin)

The Obsidian plugin uses `embedded={true}` which forces overlay sidebar behavior. The current custom motion.dev overlay should be preserved for embedded mode since Shadcn `SidebarProvider` requires a specific DOM layout (`SidebarInset` as sibling to `Sidebar`) that doesn't work within Obsidian's `ItemView` container constraints.

**Recommendation**: Keep the current embedded mode implementation unchanged. Only migrate the standalone `embedded={false}` path to Shadcn Sidebar.

### FSD Layer Placement

The Shadcn Sidebar component file (`sidebar.tsx`) should go to:

- `apps/client/src/layers/shared/ui/sidebar.tsx` — as a Shadcn primitive

The `SessionSidebar` feature component wrapping it stays at:

- `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx`

The `SidebarProvider` and `SidebarInset` wrappers go in:

- `apps/client/src/App.tsx` — at the app layout level

### Installing the Component

```bash
# From apps/client directory
pnpm dlx shadcn@latest add sidebar
```

This adds `sidebar.tsx` to `components/ui/` (you'll need to move it to `layers/shared/ui/`) and also adds/updates `use-mobile.tsx` (check if it conflicts with existing `useIsMobile` hook — they likely have the same 768px constant).

---

## Potential Solutions / Approaches with Pros & Cons

### Option A: Full Shadcn Sidebar Migration (Recommended)

Replace the custom motion.dev layout with `SidebarProvider` + `Sidebar` + `SidebarInset` for the standalone path only. Keep embedded mode unchanged.

**Pros:**

- Eliminates 392 lines of custom sidebar + layout code from App.tsx
- Free mobile Sheet behavior with backdrop, swipe-to-close, and auto-close-on-nav
- `SidebarTrigger` provides a standard accessible toggle button
- Built-in `collapsible="icon"` mode available for free if ever needed
- Keyboard shortcut (`Cmd+B`) is built-in via `SIDEBAR_KEYBOARD_SHORTCUT = "b"` (can remove custom handler)
- Accessibility (ARIA attributes, focus management) handled by component

**Cons:**

- Requires adding `--sidebar-*` CSS variables to `index.css`
- Mobile and desktop state separation requires a small Zustand store update
- `SidebarProvider` needs to wrap almost the entire App, changing the layout DOM structure
- Embedded mode still needs custom implementation

### Option B: Partial Migration (Sidebar Content Only)

Keep current App.tsx layout (motion.dev animations, custom overlay) but replace `SessionSidebar`'s internal markup with Shadcn's `SidebarMenu`, `SidebarMenuItem`, etc. components.

**Pros:**

- Minimal layout disruption
- Motion animations preserved exactly
- No CSS variable additions needed
- No Zustand state changes

**Cons:**

- Still maintaining custom overlay/push layout code (complex, 392 lines stays)
- Doesn't get the Sheet behavior improvement on mobile
- Menu components are tightly coupled to SidebarProvider context — may not work outside it

### Option C: Use Shadcn Sheet Directly for Mobile

Keep desktop push sidebar (motion.dev), replace mobile overlay with Shadcn `Sheet` component directly.

**Pros:**

- Gets native Sheet behavior on mobile (swipe-to-close, backdrop, accessibility)
- Desktop animation stays custom
- No need for SidebarProvider at all

**Cons:**

- Still bifurcated implementation — two different patterns for mobile vs desktop
- Misses out on the unified SidebarProvider state management

### Recommendation

**Option A (Full Migration)** for the standalone path, keeping embedded mode as-is.

The key implementation steps:

1. Install `sidebar.tsx` → move to `layers/shared/ui/`
2. Add `--sidebar-*` CSS variables to `index.css` (calibrated to neutral gray palette)
3. Refactor `App.tsx` standalone path: replace custom motion layout with `SidebarProvider` + `SidebarInset`
4. Update `SessionSidebar` to use `SidebarHeader`, `SidebarContent`, `SidebarFooter`, `SidebarMenu` etc.
5. Remove Zustand-based Cmd+B handler (Shadcn's built-in handles it)
6. Lift dialogs to `DialogHost` component in `App.tsx`
7. Update Zustand store: desktop `sidebarOpen` connects to `SidebarProvider open`; mobile Sheet state is internal to Shadcn

---

## CSS Variable Integration Detail

The existing `index.css` `@theme inline` block does NOT need changes for sidebar variables. The sidebar component uses CSS variables directly (not Tailwind color utilities). The only required change is adding `--sidebar-*` declarations to `:root` and `.dark`:

```css
/* Pure neutral gray palette variants for sidebar */
:root {
  /* Sidebar: slightly different from main background for visual distinction */
  --sidebar-background: 0 0% 96%; /* vs --background: 0 0% 98% */
  --sidebar-foreground: 0 0% 9%; /* matches --foreground */
  --sidebar-primary: 0 0% 9%; /* matches --primary */
  --sidebar-primary-foreground: 0 0% 98%;
  --sidebar-accent: 0 0% 92%; /* matches --secondary */
  --sidebar-accent-foreground: 0 0% 9%;
  --sidebar-border: 0 0% 83%; /* matches --border */
  --sidebar-ring: 217 91% 60%; /* matches --ring */
}

.dark {
  --sidebar-background: 0 0% 6%; /* vs --background: 0 0% 4% — slightly lighter */
  --sidebar-foreground: 0 0% 93%;
  --sidebar-primary: 0 0% 93%;
  --sidebar-primary-foreground: 0 0% 9%;
  --sidebar-accent: 0 0% 12%; /* matches --accent */
  --sidebar-accent-foreground: 0 0% 93%;
  --sidebar-border: 0 0% 25%; /* matches --border */
  --sidebar-ring: 213 94% 68%; /* matches --ring */
}
```

If you prefer the sidebar to share the main background color exactly (no visual distinction):

```css
:root {
  --sidebar-background: var(--background);
  /* etc. */
}
```

---

## Research Gaps & Limitations

- Did not test actual shadcn sidebar behavior with the DorkOS Zustand store directly — the controlled `open`/`onOpenChange` integration is documented but behavioral edge cases (rapid toggle, concurrent mobile+desktop state) are unknown until tested
- The `SidebarTrigger` styling/positioning in the main content area (the floating toggle button replacement) needs hands-on adjustment — Shadcn's default trigger is inside a `<header>` bar, not a floating button
- Shadcn docs don't explicitly address the embedded/Obsidian use case; the assumption that it won't work cleanly in embedded mode is based on DOM structure requirements

## Contradictions & Disputes

- Some community articles report the mobile breakpoint as 1024px (achromatic.dev), but the official shadcn/ui source code and GitHub issues confirm it is **768px**. The 1024px reference may be from a third-party demo with a customized breakpoint.
- The `onOpenChange` not firing on mobile was a real bug (GitHub PR #5937) that has been fixed in the current release. If using an older pinned version, it may still be present.

## Search Methodology

- Searches performed: 10
- Most productive search terms: "shadcn sidebar API SidebarProvider useSidebar mobile Sheet 2025", "shadcn sidebar Zustand controlled open onOpenChange", "shadcn sidebar Tailwind v4 CSS variables"
- Primary sources: ui.shadcn.com official docs, GitHub issues/PRs, achromatic.dev blog
