# DorkOS Design System

**Version:** 1.0
**Philosophy:** Less, but better.

---

## Design Philosophy

This interface exists to disappear. Every pixel serves the conversation. Nothing decorates — everything communicates.

We follow three principles inherited from Dieter Rams and Jony Ive:

1. **Inevitable design** — It couldn't be any other way. Each element feels like it belongs exactly where it is.
2. **Honesty of materials** — The interface doesn't pretend. No fake depth, no gratuitous gradients, no decoration disguised as function.
3. **Quiet confidence** — The best interfaces don't announce themselves. They simply work, and the user feels the difference without being able to name it.

### What We Optimize For

- **Readability** over decoration
- **Calm** over stimulation
- **Speed** over spectacle
- **Content** over chrome

### Anti-Patterns

- Purple/brand gradients
- Pure black (`#000`) or pure white (`#FFF`) backgrounds
- Heavy message bubbles with rounded corners and drop shadows
- Dramatic animations (bounces, spins, elastic effects)
- Custom display fonts for UI elements
- Decorative borders or dividers

---

## Color

We avoid pure extremes. Pure white on screens produces glare; pure black creates harsh contrast. Instead, we use **off-white** and **near-black** — colors that feel natural and reduce eye strain.

Tokens are defined as HSL custom properties in `:root`/`.dark` in `apps/client/src/index.css` and exposed to Tailwind via `@theme inline`. Use the Tailwind semantic class names in components, not raw hex values.

### Light Mode

| Tailwind class       | HSL value      | Usage                          |
| -------------------- | -------------- | ------------------------------ |
| `bg-background`      | `0 0% 98%`     | Page background                |
| `bg-muted`           | `0 0% 96%`     | Subtle backgrounds             |
| `bg-secondary`       | `0 0% 92%`     | User message tint              |
| `bg-card`            | `0 0% 100%`    | Elevated cards, popovers       |
| `text-foreground`    | `0 0% 9%`      | Body text                      |
| `text-muted-foreground` | `0 0% 32%`  | Labels, metadata               |
| `border-border`      | `0 0% 83%`     | Card borders, inputs           |

### Dark Mode

| Tailwind class       | HSL value      | Usage                          |
| -------------------- | -------------- | ------------------------------ |
| `bg-background`      | `0 0% 4%`      | Page background                |
| `bg-muted`           | `0 0% 9%`      | Subtle backgrounds             |
| `bg-secondary`       | `0 0% 14%`     | User message tint              |
| `bg-card`            | `0 0% 4%`      | Elevated cards, popovers       |
| `text-foreground`    | `0 0% 93%`     | Body text                      |
| `text-muted-foreground` | `0 0% 64%`  | Labels, metadata               |
| `border-border`      | `0 0% 25%`     | Card borders, inputs           |

### Accent

One accent color, used sparingly: **blue** (HSL `217 91% 60%` light / `213 94% 68%` dark). Used for focus rings (`ring`), active links, and the send button.

Everything else is grayscale. Color should mean something. If everything is colored, nothing is.

---

## Typography

System fonts. They load instantly, render crisply, and feel native to the platform.

### Font Stacks

Default stacks (from `--font-sans` and `--font-mono` in `index.css`):

```
Sans:  system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif
Mono:  ui-monospace, 'SF Mono', 'Cascadia Code', 'Fira Code', Menlo, Consolas, monospace
```

Users can override font family via Settings → Appearance. The app store (`setFontFamily`) loads Google Fonts dynamically and updates `--font-sans`/`--font-mono` via JavaScript. Avoid hardcoding specific font names in component styles.

### Scale

Base values at desktop (no mobile scaling applied). Actual rendered sizes multiply by `--_st` on mobile (default 1.25x). Users can apply a further `--user-font-scale` via Settings → Appearance.

| Token       | Base size | Usage                     |
| ----------- | --------- | ------------------------- |
| `text-xs`   | 12px      | Timestamps, tool status   |
| `text-sm`   | 14px      | Message body text, code, metadata, labels |
| `text-base` | 16px      | (unused in chat UI)                       |
| `text-lg`   | 18px      | In-message headings (h3+) |

### Weights

- **400 (normal)** — Body text, most content
- **500 (medium)** — Labels ("You", "Claude"), session titles
- **600 (semibold)** — In-message headings, emphasis

### Line Length

Messages are constrained to `max-width: 65ch` (~1040px in characters, roughly 520-544px at 16px). This is the typographic sweet spot for reading comfort. Code blocks may overflow wider.

---

## Spacing

We use an **8-point grid**. All spacing values are multiples of 4px, with 8px as the base unit.

### Scale (Tailwind mapping)

| Token     | Value | Tailwind | Usage                           |
| --------- | ----- | -------- | ------------------------------- |
| `space-1` | 4px   | `p-1`    | Tight padding (icon containers) |
| `space-2` | 8px   | `p-2`    | Base unit, small gaps           |
| `space-3` | 12px  | `p-3`    | Component padding               |
| `space-4` | 16px  | `p-4`    | Card padding, message gap       |
| `space-6` | 24px  | `p-6`    | Section spacing                 |
| `space-8` | 32px  | `p-8`    | Major divisions                 |

### Message Rhythm

- **Between messages:** 2px (almost continuous, grouped by time)
- **Message padding:** 16px horizontal, 12px vertical
- **Between message groups:** 24px
- **Tool card margin:** 8px top

---

## Motion

Animation should feel like physics, not decoration. Things should move because they _are_ moving — entering the viewport, responding to interaction, settling into place.

### Library

**motion.dev** (Motion) for React component animations. CSS transitions for simple hover/focus states.

### Timing

| Duration | Value | Usage                        |
| -------- | ----- | ---------------------------- |
| Instant  | 100ms | Active states, color changes |
| Fast     | 150ms | Hover states, focus rings    |
| Normal   | 200ms | Enter/exit, layout shifts    |
| Slow     | 300ms | Expand/collapse, overlays    |

### Easing

| Curve      | Value                                         | Usage                               |
| ---------- | --------------------------------------------- | ----------------------------------- |
| `ease-out` | `cubic-bezier(0, 0, 0.2, 1)`                  | Entrances (fast start, gentle stop) |
| `ease-in`  | `cubic-bezier(0.4, 0, 1, 1)`                  | Exits (gentle start, fast finish)   |
| `spring`   | `type: "spring", stiffness: 400, damping: 30` | Interactive elements                |

### Animation Catalog

**Message entrance:** Fade in + slide up 8px, spring `stiffness:320 damping:28` (settles ~250ms, no bounce). User messages also scale from 0.97→1. Only animate the _newest_ message; history loads instantly.

**Session switch:** 150ms opacity crossfade via `AnimatePresence mode="wait"`. Total transition 300ms (old exits, then new enters). Duration-based easing, not spring.

**Sidebar active indicator:** `layoutId` sliding background via spring `stiffness:280 damping:32` (smooth, deliberate slide). Animates across sidebar groups.

**Session row tap:** `whileTap` scale to 0.98, spring `stiffness:400 damping:30` (quick press feedback).

**Tool card expand:** Height + opacity transition, 300ms ease-in-out.

**Button press:** Scale to 0.97 on active, spring back.

**Send button:** Subtle scale pulse on hover (1.05), quick press feedback.

**Sidebar toggle:** Width transition 200ms, content fades.

**Command palette:** Spring entrance (scale 0.96 + y: -8, stiffness: 500, damping: 35). Sliding selection indicator via `layoutId`. Stagger items on open (first 8 only, 40ms per item). Directional x-axis page transitions (150ms ease-out). Item hover nudge (2px rightward). Preview panel width spring (stiffness: 400, damping: 35). Dialog width animates from 480px to 720px when preview panel appears.

**Streaming cursor:** 2px wide block, 1.1em tall, `blink-cursor` keyframe at 1s step-end infinite. Appended via `::after` on the last text element inside Streamdown's DOM using a `:last-child` chain. Fades in on appearance (`cursor-fade-in`, 150ms ease-out). Only the deepest matching element renders it; shallower matches use `display: none` to prevent duplicates.

**Scroll-to-bottom button:** Fade in + slide up 10px, 150ms ease-out. Fade out + slide down on exit. Right-aligned in message area overlay wrapper.

**New messages pill:** Fade in + slide up 8px, 200ms ease-out. Fade out on exit (150ms). Centered horizontally in message area overlay wrapper. Appears when new messages arrive while user is scrolled up; dismissed on click or reaching bottom.

### What NOT to Animate

- Message content (text should just appear)
- Scroll position (use native smooth scroll)
- Colors on non-interactive elements
- Anything during initial page load

---

## Components

### Messages

**Flat layout.** No bubbles. AI chat responses are often long and contain code — bubbles add visual noise.

- **User messages:** Subtle background tint (`bg-secondary`), full-width
- **Assistant messages:** No background, content speaks for itself
- **Avatars:** 28px circles. User = primary color with User icon. Claude = subtle warm gray with Bot icon.
- **Labels:** "You" and "Claude" in `text-xs`, `text-secondary`, `font-medium`

### Code Blocks

- **Inline code:** `font-mono`, `text-sm`, light background tint, 3px border-radius, 2px 5px padding
- **Fenced blocks:** Shiki syntax highlighting with `github-light` / `github-dark` themes (via Streamdown)
- **Block chrome:** Language label (top-left, `text-xs`, `text-tertiary`, uppercase tracking). Copy button appears on hover (top-right).
- **Border:** 1px `border-subtle`, 8px border-radius

### Tool Call Cards

- 1px border, 8px border-radius, `bg-surface` background
- Status icon: spinning loader (running), checkmark (complete), X (error)
- Tool name in `font-mono`
- Expandable with smooth height animation
- Hover: border darkens slightly, subtle shadow appears

### Scroll Overlays

Both overlays live in a `relative flex-1 min-h-0` wrapper in ChatPanel, positioned `absolute` **outside** the scroll container. This ensures they stay fixed relative to the message viewport, not the scrollable content.

- **Scroll-to-bottom button:** `absolute bottom-4 right-4`. Rounded circle, `bg-background`, 1px border, `shadow-sm` → `shadow-md` on hover. `ArrowDown` icon from lucide-react. `aria-label="Scroll to bottom"`. Visible when user is 200px+ from bottom.
- **"New messages" pill:** `absolute bottom-16 left-1/2 -translate-x-1/2`. Rounded pill, `bg-foreground text-background` (inverted for high contrast in both themes), `text-xs font-medium`, `px-3 py-1.5`. `role="status" aria-live="polite"`. Visible when new messages arrive while scrolled up.
- **Layout when both visible:** Pill centered at `bottom-16` (64px), button right-aligned at `bottom-4` (16px). Non-overlapping. Both clickable, both scroll to bottom, both dismiss when bottom is reached.

### Input Area

- Full-width textarea with auto-resize
- Placeholder: "Message Claude..." in `text-tertiary`
- Border: 1px `border-default`, lightens on focus to `accent`
- Send button: circular, `accent` color, icon-only
- Stop button: circular, muted red, square icon

### Sidebar (AgentSidebar)

Built on **Shadcn Sidebar** (`layers/shared/ui/sidebar.tsx`) with `collapsible="offcanvas"` mode. The main sidebar component is `AgentSidebar` (in `features/session-list/`).

- **Width**: 320px (20rem) via `--sidebar-width` CSS custom property on `SidebarProvider`
- **CSS variables**: `--sidebar-*` in `index.css` (subtly distinct from main background — 96% vs 98% light, 6% vs 4% dark)
- **Mobile**: Renders as Radix Sheet (drawer) with backdrop and swipe-to-close
- **Desktop**: Push layout via `SidebarProvider` + `SidebarInset`
- **Toggle**: `Cmd+B` / `Ctrl+B` (Shadcn built-in `SIDEBAR_KEYBOARD_SHORTCUT`)
- **SidebarRail**: Invisible hover-target strip at sidebar edge for mouse-over toggle
- **SidebarTrigger**: Toggle button in `SidebarInset` header (outside the sidebar itself)
- **Tabbed views**: `SidebarTabRow` switches between Sessions, Schedules, and Connections views (see [Sidebar Tabs](#sidebar-tabs) below)
- **Temporal grouping**: Sessions grouped by Today / Yesterday / Previous 7 Days / Previous 30 Days / Older using `SidebarGroup` / `SidebarGroupLabel`
- **Session items**: `SidebarMenuButton` with relative time + truncated title
- **Active session**: `isActive` prop on `SidebarMenuButton`
- **"New chat" button**: In `SidebarHeader`, below `AgentHeader`
- **Footer**: `SidebarFooter` contains `ProgressCard` (onboarding), `SidebarFooterBar` (branding, settings, theme toggle)
- **Empty state**: Centered "No conversations yet" message
- **Dialogs**: All 7 dialogs (Settings, DirectoryPicker, Pulse, Relay, Mesh, AgentDialog, OnboardingFlow) rendered in `DialogHost` at the app root level, outside `SidebarProvider`

### Sidebar Tabs

The sidebar uses a custom tab bar (`SidebarTabRow`, not Radix Tabs) for switching between Sessions, Schedules, and Connections views. Keyboard shortcuts `Cmd+1`/`Cmd+2`/`Cmd+3` switch tabs directly.

| Element | Specification |
|---|---|
| Tab bar height | Auto (`py-1.5`) |
| Tab button padding | `p-2` |
| Tab icon size | `--size-icon-sm` |
| Sliding indicator | `h-0.5 rounded-full bg-foreground` |
| Indicator animation | Spring: stiffness 280, damping 32 |
| Schedules badge | `text-[10px] size-4 bg-green-500` (numeric count) |
| Connections dot | `size-1.5 rounded-full` (status indicator) |
| Status colors | green = ok, amber = partial, red = error |

All three views are mounted simultaneously and use CSS `hidden` toggling to preserve state (scroll position, expanded items) across tab switches. See ADR-0107 for the decision rationale.

ARIA semantics follow the WAI tablist pattern: `role="tablist"` on the container, `role="tab"` on each button with `aria-selected` and `aria-controls`, and `role="tabpanel"` on each view. Arrow keys navigate between tabs via roving tabindex.

### Tooltip

Standard shadcn Radix tooltip from `shared/ui/tooltip.tsx`. Used for:
- Disabled state indicators (e.g., "Pulse is disabled" on HeartPulse icon)
- Contextual information on icon-only buttons

`TooltipProvider` is mounted in `App.tsx`. Use `<Tooltip>` + `<TooltipTrigger>` + `<TooltipContent>` pattern.

### Toast Notifications (Sonner)

Theme-aware toast via `sonner` from `shared/ui/sonner.tsx`. `<Toaster />` mounted in `App.tsx`.

**When to toast:**
- Background actions with no immediate visible UI change ("Run triggered", "Schedule approved")
- Error notifications for failed mutations

**When NOT to toast:**
- Toggle on/off (switch state is self-evidencing)
- Form submission success (dialog closes)
- Cancel run (status updates inline)
- Reject schedule

Usage: `import { toast } from 'sonner'` then `toast('message')` or `toast.error('message')`.

### Command (cmdk)

Searchable combobox from `shared/ui/command.tsx`. Used with Popover for dropdown positioning. Primary use case: timezone selection in Pulse CreateScheduleDialog.

Pattern: `Popover` > `PopoverTrigger` > `PopoverContent` > `Command` > `CommandInput` + `CommandList` > `CommandGroup` > `CommandItem`.

**Global command palette**: The `features/command-palette/` module uses cmdk with `shouldFilter={false}` to disable built-in filtering, delegating all search to Fuse.js (`use-palette-search.ts`). Category prefixes: `@` for agents, `>` for commands. The palette uses a `pages` array state for sub-menu drill-down with breadcrumb navigation. List height transitions use the `--cmdk-list-height` CSS variable with a `max-height` cap:

```css
[cmdk-list] {
  max-height: min(var(--cmdk-list-height), 60vh);
  transition: max-height 150ms cubic-bezier(0.4, 0, 0.2, 1);
  overflow: hidden !important;
}
```

**Split-pane layout**: The palette dialog uses a flex-row container. `CommandList` takes remaining width; `AgentPreviewPanel` (60%) appears when an agent item is keyboard-selected. The `ResponsiveDialogContent` transitions between `max-w-[480px]` and `max-w-[720px]` via a CSS `transition-[max-width] duration-200`. On mobile (`useIsMobile()`), the preview panel is hidden entirely.

**Character highlighting**: `HighlightedText` renders Fuse.js match indices as `<mark>` elements with `bg-transparent text-foreground font-semibold`. All content passes through React's createElement pipeline (no raw HTML).

**PaletteFooter**: Dynamic keyboard hint bar using `<kbd>` elements styled with `border, rounded, monospace font, text-xs, text-muted-foreground`. Shows context-appropriate shortcuts (navigate, open, back, close).

---

## Interaction States

### Hover

Subtle. 150ms transition. Background opacity shift of 2-3%.

```css
.interactive:hover {
  background-color: hsl(var(--muted) / 0.5);
}
```

### Focus

Visible focus rings for keyboard navigation. Blue outline, 2px offset.

```css
:focus-visible {
  outline: 2px solid hsl(var(--ring));
  outline-offset: 2px;
}
```

### Active/Press

Scale down to 0.97-0.98 for 100ms. Immediate, tactile.

### Disabled

Opacity 0.5. No cursor change beyond `not-allowed`.

### Loading

- Streaming: blinking cursor after last character
- Tool running: spinning icon (Loader2 from lucide)
- History loading: three pulsing dots in message area

### 3-State Status Pattern

Status indicators that depend on both per-entity configuration and global feature flags use a 3-state model driven by `useAgentToolStatus()`:

| State | Visual | Meaning |
|-------|--------|---------|
| `enabled` | Full color, normal opacity | Feature is active for this agent |
| `disabled-by-agent` | Muted/dimmed appearance (`opacity-50`) | Agent manifest has explicitly opted out |
| `disabled-by-server` | Hidden (not rendered) | Feature is disabled server-wide |

In the sidebar, this pattern surfaces as badge indicators on the tab bar (schedule count badge, connections status dot). The `SidebarTabRow` shows badges only when the corresponding feature is enabled.

### 3-State Toggle Pattern (CapabilitiesTab)

The CapabilitiesTab uses a 3-state display for per-agent tool group toggles:

| State | Visual | Meaning |
|-------|--------|---------|
| Inherited (enabled) | Switch ON, "Inherited" badge | Agent inherits the global default (enabled) |
| Overridden (disabled) | Switch OFF, "Overridden" badge | Agent explicitly disables this tool group |
| Inherited (disabled) | Switch OFF, disabled, "Server disabled" badge | Server feature flag is off; toggle is non-interactive |

The toggle writes to the agent manifest's `enabledToolGroups` field. When a toggle is flipped, it sets an explicit value; when reset, the field is removed (returning to inherited behavior).

This pattern is reusable for any per-entity override of a global setting.

---

## Accessibility

- All interactive elements keyboard-accessible
- Focus indicators meet 3:1 contrast ratio (WCAG 2.1 AA)
- Color is never the sole indicator of state
- `aria-label` on icon-only buttons
- `prefers-reduced-motion` respected — disable entrance animations, reduce transitions to instant
- Text meets 4.5:1 contrast ratio against backgrounds

---

## Mobile Responsive Scale

### Overview

The app uses a CSS custom property scale multiplier system that makes text, icons, and interactive elements proportionally larger on mobile (< 768px). Desktop is the source of truth; mobile sizes are derived via multiplication.

### Configuration

- `--mobile-scale: 1.25` — Master dial (25% larger on mobile)
- Optional per-category overrides:
  - `--mobile-scale-text` — Text scaling
  - `--mobile-scale-icon` — Icon scaling
  - `--mobile-scale-interactive` — Button/interactive element scaling

### Internal Multipliers

- `--_st` — Text multiplier (1 on desktop, scale value on mobile)
- `--_si` — Icon multiplier
- `--_sb` — Interactive element multiplier

### Scaled Values at 1.25x

| Element                  | Desktop | Mobile (x1.25) |
| ------------------------ | ------- | -------------- |
| Body text (`text-sm`)    | 14px    | 17.5px         |
| Small text (`text-xs`)   | 12px    | 15px           |
| Tiny text (`text-2xs`)   | 11px    | 13.75px        |
| Micro text (`text-3xs`)  | 10px    | 12.5px         |
| Large text (`text-base`) | 16px    | 20px           |
| Icon xs                  | 12px    | 15px           |
| Icon sm                  | 16px    | 20px           |
| Icon md                  | 20px    | 25px           |
| Button sm                | 32px    | 40px           |
| Button md                | 36px    | 45px           |
| Button lg                | 40px    | 50px           |

### Icon Size Convention

Three standard sizes, use `size-[--size-icon-*]` for all icon sizing:

| Token     | Desktop | Use Case                                                 |
| --------- | ------- | -------------------------------------------------------- |
| `icon-xs` | 12px    | Decorative, status indicators, inline affordances        |
| `icon-sm` | 16px    | Interactive icons in compact UI (sidebar, tool cards)    |
| `icon-md` | 20px    | Primary action icons (buttons, navigation, prominent UI) |

Usage:

```tsx
<Check className="size-[--size-icon-xs] text-green-500" />
<FolderOpen className="size-[--size-icon-sm] text-muted-foreground" />
<PanelLeft className="size-[--size-icon-md]" />
```

### Hover Pattern Mobile Alternatives

| Pattern                | Desktop                | Mobile                            |
| ---------------------- | ---------------------- | --------------------------------- |
| Message timestamps     | Hidden, shown on hover | Always visible at 40% opacity     |
| Session expand chevron | Hidden, shown on hover | Hidden; tap session row to expand |
| Table action icons     | Hidden, shown on hover | Always visible at 60% opacity     |

### Safe Area Classes

| Class                  | Applied To                   | Purpose                         |
| ---------------------- | ---------------------------- | ------------------------------- |
| `chat-input-container` | ChatPanel input wrapper      | Bottom safe area inset          |
| `sidebar-container`    | AgentSidebar root            | Left + bottom safe area insets  |
| `chat-scroll-area`     | MessageList scroll container | `touch-action: pan-y` on mobile |

### Adjusting the Scale

```css
:root {
  --mobile-scale: 1; /* No mobile scaling */
  --mobile-scale: 1.25; /* Default: 25% larger */
  --mobile-scale: 1.5; /* 50% larger */

  /* Per-category overrides */
  --mobile-scale-text: 1.15;
  --mobile-scale-icon: 1.25;
  --mobile-scale-interactive: 1.3;
}
```

---

## Responsive Components

Interactive overlays that need different UX on desktop vs mobile use responsive wrappers. These keep the Radix primitive on desktop (keyboard nav, precise positioning) and swap to a Vaul Drawer on mobile (large touch targets, bottom-sheet pattern).

### `ResponsiveDropdownMenu`

Use instead of plain `DropdownMenu` when the menu appears in a touch-accessible area (status bars, toolbars, settings). Plain `DropdownMenu` is fine for desktop-only contexts (right-click menus, dense data tables).

| Sub-component                      | Desktop (≥768px)         | Mobile (<768px)                |
| ---------------------------------- | ------------------------ | ------------------------------ |
| `ResponsiveDropdownMenu`           | `DropdownMenu`           | `Drawer`                       |
| `ResponsiveDropdownMenuTrigger`    | `DropdownMenuTrigger`    | `DrawerTrigger`                |
| `ResponsiveDropdownMenuContent`    | `DropdownMenuContent`    | `DrawerContent` (auto-height)  |
| `ResponsiveDropdownMenuLabel`      | `DropdownMenuLabel`      | `DrawerHeader` + `DrawerTitle` |
| `ResponsiveDropdownMenuRadioGroup` | `DropdownMenuRadioGroup` | `<div role="radiogroup">`      |
| `ResponsiveDropdownMenuRadioItem`  | `DropdownMenuRadioItem`  | Custom button with iOS sizing  |

#### RadioItem Props

| Prop          | Type         | Required | Description                               |
| ------------- | ------------ | -------- | ----------------------------------------- |
| `value`       | `string`     | Yes      | Radio value                               |
| `children`    | `ReactNode`  | Yes      | Label text                                |
| `icon`        | `LucideIcon` | No       | Leading icon (renders in both modes)      |
| `description` | `string`     | No       | Secondary text below label                |
| `className`   | `string`     | No       | Additional classes (e.g., danger styling) |

#### Mobile Sizing (Apple HIG)

- `min-h-[44px]` touch targets
- `text-[17px]` labels (iOS body)
- `text-[13px]` descriptions (iOS footnote)
- Right-aligned `Check` icon for selected item
- `border-b border-border` separators between items

#### Simple Usage (ModelItem)

```tsx
<ResponsiveDropdownMenu>
  <ResponsiveDropdownMenuTrigger asChild>
    <button>Sonnet 4.5</button>
  </ResponsiveDropdownMenuTrigger>
  <ResponsiveDropdownMenuContent side="top" align="start">
    <ResponsiveDropdownMenuLabel>Model</ResponsiveDropdownMenuLabel>
    <ResponsiveDropdownMenuRadioGroup value={model} onValueChange={setModel}>
      <ResponsiveDropdownMenuRadioItem value="sonnet">Sonnet 4.5</ResponsiveDropdownMenuRadioItem>
      <ResponsiveDropdownMenuRadioItem value="opus">Opus 4.6</ResponsiveDropdownMenuRadioItem>
    </ResponsiveDropdownMenuRadioGroup>
  </ResponsiveDropdownMenuContent>
</ResponsiveDropdownMenu>
```

#### Rich Usage (PermissionModeItem)

```tsx
<ResponsiveDropdownMenuRadioItem
  value="default"
  icon={Shield}
  description="Prompt for each tool call"
>
  Default
</ResponsiveDropdownMenuRadioItem>
```

### `ResponsiveDialog`

Use instead of plain `Dialog` when the dialog content needs full-screen treatment on mobile. Shows as a centered `Dialog` on desktop and a `Drawer` on mobile. See `components/ui/responsive-dialog.tsx`.

---

## File Reference

| Concern                  | File                                        |
| ------------------------ | ------------------------------------------- |
| CSS variables & Tailwind | `apps/client/src/index.css`                 |
| shadcn config            | `apps/client/components.json`               |
| Component library        | `apps/client/src/layers/shared/ui/`                          |
| Chat components          | `apps/client/src/layers/features/chat/`                      |
| Session components       | `apps/client/src/layers/features/session-list/`              |
| App state                | `apps/client/src/layers/shared/model/app-store.ts`           |
| Chat state               | `apps/client/src/layers/features/chat/model/use-chat-session.ts` |
