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

### Light Mode

| Token              | Value     | Usage                          |
| ------------------ | --------- | ------------------------------ |
| `--bg-primary`     | `#FAFAFA` | Page background                |
| `--bg-secondary`   | `#F5F5F5` | User message tint, code blocks |
| `--bg-surface`     | `#FFFFFF` | Elevated cards, popovers       |
| `--text-primary`   | `#171717` | Body text                      |
| `--text-secondary` | `#525252` | Labels, metadata               |
| `--text-tertiary`  | `#A3A3A3` | Placeholders, timestamps       |
| `--border-subtle`  | `#E5E5E5` | Dividers                       |
| `--border-default` | `#D4D4D4` | Card borders, inputs           |

### Dark Mode

| Token              | Value     | Usage                          |
| ------------------ | --------- | ------------------------------ |
| `--bg-primary`     | `#0A0A0A` | Page background                |
| `--bg-secondary`   | `#171717` | User message tint, code blocks |
| `--bg-surface`     | `#262626` | Elevated cards, popovers       |
| `--text-primary`   | `#EDEDED` | Body text                      |
| `--text-secondary` | `#A3A3A3` | Labels, metadata               |
| `--text-tertiary`  | `#737373` | Placeholders, timestamps       |
| `--border-subtle`  | `#262626` | Dividers                       |
| `--border-default` | `#404040` | Card borders, inputs           |

### Accent

One accent color, used sparingly: **blue** (`#3B82F6` light / `#60A5FA` dark`). Reserved for:

- Focus rings
- Active links
- The send button

Everything else is grayscale. Color should mean something. If everything is colored, nothing is.

---

## Typography

System fonts. They load instantly, render crisply, and feel native to the platform.

### Font Stacks

```
Sans:  system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif
Mono:  ui-monospace, 'SF Mono', 'Cascadia Code', 'Fira Code', Menlo, Consolas, monospace
```

### Scale

| Token       | Size | Line Height | Usage                     |
| ----------- | ---- | ----------- | ------------------------- |
| `text-xs`   | 11px | 1.4         | Timestamps, tool status   |
| `text-sm`   | 13px | 1.5         | Code, metadata, labels    |
| `text-base` | 15px | 1.6         | Message body text         |
| `text-lg`   | 17px | 1.5         | In-message headings (h3+) |

### Weights

- **400 (normal)** — Body text, most content
- **500 (medium)** — Labels ("You", "Claude"), session titles
- **600 (semibold)** — In-message headings, emphasis

### Line Length

Messages are constrained to `max-width: 65ch` (~520px at 15px). This is the typographic sweet spot for reading comfort. Code blocks may overflow wider.

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

**Message entrance:** Fade in + slide up 8px, 200ms ease-out. Only animate the _newest_ message; history loads instantly.

**Tool card expand:** Height + opacity transition, 300ms ease-in-out.

**Button press:** Scale to 0.97 on active, spring back.

**Send button:** Subtle scale pulse on hover (1.05), quick press feedback.

**Sidebar toggle:** Width transition 200ms, content fades.

**Command palette:** Fade in + scale from 0.98, 150ms ease-out.

**Streaming cursor:** Blinking pipe character, 1s infinite.

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

### Sidebar

- Fixed width 256px
- **Temporal grouping**: Sessions grouped by Today / Yesterday / Previous 7 Days / Previous 30 Days / Older
- **Group headers**: `text-[11px]`, uppercase, `tracking-wider`, `text-muted-foreground/70`
- **Session items**: Single-line layout: truncated title (left), relative time (right). No preview text.
- **Relative time**: "Just now", "5m ago", "3h ago" (today), "Yesterday", "Mon" (this week), "Jan 5" (older)
- **Active session**: `bg-secondary` background
- **"New chat" button**: Solid `bg-primary`, full-width, centered icon + text
- **Permission toggle**: Inline beneath button, shield icon, toggles between "Require approval" / "Skip permissions"
- **Empty state**: Centered "No conversations yet" message
- **Item spacing**: `space-y-0.5` within groups, `space-y-5` between groups

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
| `sidebar-container`    | SessionSidebar root          | Left + bottom safe area insets  |
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
| Component library        | `apps/client/src/components/ui/`            |
| Chat components          | `apps/client/src/components/chat/`          |
| Session components       | `apps/client/src/components/sessions/`      |
| App state                | `apps/client/src/stores/app-store.ts`       |
| Chat state               | `apps/client/src/hooks/use-chat-session.ts` |
