# Mobile Responsive Scale System

| Field | Value |
|-------|-------|
| **Status** | Draft |
| **Authors** | Dorian Collier |
| **Date** | 2026-02-11 |
| **App** | `apps/client` (@dorkos/client) |
| **Depends on** | Tailwind CSS v4, React 19, Vite 6, shadcn/ui, Lucide icons |

---

## 1. Overview

This specification defines a CSS custom property scale multiplier system for the DorkOS client that makes text, icons, and interactive elements proportionally larger on mobile devices. The system provides a single centralized "dial" (`--mobile-scale`) that controls how much bigger UI elements render on screens narrower than 768px, with optional per-category overrides for fine-tuning text, icon, and interactive element scales independently.

The implementation also standardizes all icon instances across the client to three canonical sizes (12px, 16px, 20px on desktop), fixes touch target deficiencies, addresses iOS Safari input zoom, adds safe area inset support for notched devices, and converts hover-only interaction patterns to mobile-friendly alternatives.

---

## 2. Background / Problem Statement

The DorkOS client was designed desktop-first. On mobile devices:

- **Text is too small.** Body text renders at 14px (`text-sm`), which falls below Apple HIG's recommended 17pt for mobile body text.
- **Icons are undersized.** The codebase uses five different icon size classes (`h-2.5`, `h-3`, `h-3.5`, `h-4`, `h-5`) with no semantic meaning. Most interactive icons are 12-14px, well below the 20px recommended for mobile tap clarity.
- **Touch targets are too small.** Many buttons use `p-0.5` (2px) or `p-1` (4px) padding, resulting in interactive areas far below the 44px WCAG 2.5.5 AAA minimum.
- **Hover-only patterns are invisible on touch.** Timestamps on messages, expand chevrons on session items, and table action overlays rely on CSS `:hover` which has no equivalent on mobile.
- **No iOS Safe Area support.** Fixed-position elements (sidebar, drawer, chat input) do not account for the iPhone notch or home indicator bar.
- **iOS auto-zoom on input focus.** The chat textarea uses `text-sm` (14px), which triggers Safari's auto-zoom behavior on any input below 16px.

The scale multiplier approach solves these problems at the design token level, so every component automatically benefits without per-component media queries.

---

## 3. Goals

- Provide a single `--mobile-scale` CSS custom property (default 1.25) that scales all text, icon, and button height tokens on screens < 768px
- Allow per-category overrides (`--mobile-scale-text`, `--mobile-scale-icon`, `--mobile-scale-interactive`) for fine-grained control
- Standardize all ~55 icon instances to 3 semantic sizes: `icon-xs` (12px), `icon-sm` (16px), `icon-md` (20px) on desktop
- Ensure all touch targets meet the 44px minimum on mobile
- Prevent iOS Safari auto-zoom on input focus
- Support iOS safe area insets on notched devices
- Prevent pull-to-refresh interference in the chat scroll area
- Convert hover-only patterns to mobile-friendly alternatives (long-press or hidden)
- Maintain pixel-perfect desktop appearance (all multipliers resolve to 1 on desktop)
- Wire custom font sizes `text-3xs` (10px) and `text-2xs` (11px) through the scale system

---

## 4. Non-Goals

- Server-side changes (no modifications to `apps/server/`)
- Obsidian plugin changes (no modifications to `apps/obsidian-plugin/`)
- New component library or design system overhaul
- PWA features (service worker, manifest, etc.)
- Bottom navigation pattern or mobile navigation redesign
- Scaling spacing utilities (padding, margins, gaps remain unchanged on mobile)
- Responsive layout breakpoints (the existing sidebar overlay pattern is already handled)

---

## 5. Technical Dependencies

| Dependency | Version | Role |
|------------|---------|------|
| Tailwind CSS | v4 | `@theme inline` directive for runtime CSS variable resolution |
| Vite | 6.x | Dev server, CSS processing |
| React | 19.x | Component rendering |
| Lucide React | latest | Icon library (all ~55 icon instances) |
| motion | latest | Existing animation library (must remain unaffected) |

**Critical Tailwind v4 Requirement:** The `@theme inline` directive is mandatory. Standard `@theme` outputs `var(--font-size-sm)` in utility classes, which resolves at definition time in `:root` where the scale multiplier variables may not be contextually correct. `@theme inline` instead inlines the full `calc()` expression into each utility class, ensuring CSS variables resolve at runtime in the DOM context where the media query has taken effect.

---

## 6. Detailed Design

### 6.1 CSS Custom Property Architecture

The system introduces three layers of CSS custom properties:

**Layer 1 -- Configuration properties** (user-facing, tunable):
```css
:root {
  --mobile-scale: 1.25;
  /* Optional per-category overrides (uncomment to fine-tune): */
  /* --mobile-scale-text: 1.15; */
  /* --mobile-scale-icon: 1.25; */
  /* --mobile-scale-interactive: 1.30; */
}
```

**Layer 2 -- Active multiplier properties** (internal, resolved by media query):
```css
:root {
  --_st: 1;  /* active text scale multiplier */
  --_si: 1;  /* active icon scale multiplier */
  --_sb: 1;  /* active button/interactive scale multiplier */
}

@media (max-width: 767px) {
  :root {
    --_st: var(--mobile-scale-text, var(--mobile-scale, 1.25));
    --_si: var(--mobile-scale-icon, var(--mobile-scale, 1.25));
    --_sb: var(--mobile-scale-interactive, var(--mobile-scale, 1.25));
  }
}
```

**Layer 3 -- Tailwind design tokens** (consumed by utility classes via `@theme inline`):
```css
@theme inline {
  /* Font sizes -- scaled by --_st */
  --font-size-3xs: calc(0.625rem * var(--_st));    /* 10px desktop */
  --font-size-2xs: calc(0.6875rem * var(--_st));   /* 11px desktop */
  --font-size-xs: calc(0.75rem * var(--_st));      /* 12px desktop */
  --font-size-sm: calc(0.875rem * var(--_st));     /* 14px desktop */
  --font-size-base: calc(1rem * var(--_st));       /* 16px desktop */
  --font-size-lg: calc(1.125rem * var(--_st));     /* 18px desktop */
  --font-size-xl: calc(1.25rem * var(--_st));      /* 20px desktop */

  /* Icon sizes -- scaled by --_si (3 standard sizes) */
  --size-icon-xs: calc(0.75rem * var(--_si));      /* 12px desktop */
  --size-icon-sm: calc(1rem * var(--_si));         /* 16px desktop */
  --size-icon-md: calc(1.25rem * var(--_si));      /* 20px desktop */

  /* Interactive element heights -- scaled by --_sb */
  --size-btn-sm: calc(2rem * var(--_sb));          /* 32px desktop */
  --size-btn-md: calc(2.25rem * var(--_sb));       /* 36px desktop */
  --size-btn-lg: calc(2.5rem * var(--_sb));        /* 40px desktop */
}
```

The underscore-prefixed internal variables (`--_st`, `--_si`, `--_sb`) follow the convention of "private" CSS custom properties. They are not intended for external use; consumers should only modify the `--mobile-scale*` configuration properties.

### 6.2 Existing `@theme inline` Migration

The current `index.css` (line 4-30) already uses `@theme inline` for custom text sizes and color tokens. The existing custom text sizes must be replaced with the scaled versions:

**Current** (`apps/client/src/index.css`, lines 5-8):
```css
@theme inline {
  --text-2xs: 0.6875rem;
  --text-2xs--line-height: 1rem;
  --text-3xs: 0.625rem;
  --text-3xs--line-height: 0.875rem;
  /* ... color tokens ... */
}
```

**New** (replace the text size entries, keep color tokens unchanged):
```css
@theme inline {
  /* Scaled font sizes */
  --font-size-3xs: calc(0.625rem * var(--_st));
  --font-size-3xs--line-height: 0.875rem;
  --font-size-2xs: calc(0.6875rem * var(--_st));
  --font-size-2xs--line-height: 1rem;
  --font-size-xs: calc(0.75rem * var(--_st));
  --font-size-sm: calc(0.875rem * var(--_st));
  --font-size-base: calc(1rem * var(--_st));
  --font-size-lg: calc(1.125rem * var(--_st));
  --font-size-xl: calc(1.25rem * var(--_st));

  /* Icon sizes */
  --size-icon-xs: calc(0.75rem * var(--_si));
  --size-icon-sm: calc(1rem * var(--_si));
  --size-icon-md: calc(1.25rem * var(--_si));

  /* Interactive element heights */
  --size-btn-sm: calc(2rem * var(--_sb));
  --size-btn-md: calc(2.25rem * var(--_sb));
  --size-btn-lg: calc(2.5rem * var(--_sb));

  /* ... existing color tokens remain unchanged ... */
}
```

Note: The `--text-2xs` and `--text-3xs` naming changes to `--font-size-2xs` and `--font-size-3xs` to align with Tailwind v4's standard font-size token namespace. Any existing uses of `text-2xs` and `text-3xs` utility classes will need no changes as Tailwind v4 resolves them via the `--font-size-*` namespace.

### 6.3 Icon Size Standardization

All ~55 icon instances are migrated from ad-hoc Tailwind size classes to three semantic token sizes. The icon tokens are consumed via Tailwind's arbitrary value syntax: `size-[--size-icon-sm]` (which generates `width: var(--size-icon-sm); height: var(--size-icon-sm)`).

#### Icon Size Mapping Table

| Old Class | Old Size | New Token | Desktop Size | Mobile Size (x1.25) | Notes |
|-----------|----------|-----------|-------------|---------------------|-------|
| `h-2.5 w-2.5` | 10px | `--size-icon-xs` | 12px | 15px | Minor bump on desktop (10 -> 12) |
| `h-3 w-3` | 12px | `--size-icon-xs` | 12px | 15px | No desktop change |
| `h-3.5 w-3.5` | 14px | `--size-icon-sm` | 16px | 20px | Minor bump on desktop (14 -> 16) |
| `h-4 w-4` | 16px | `--size-icon-md` | 20px | 25px | Bump on desktop (16 -> 20) |

#### Tailwind Usage Pattern

Replace paired `h-N w-N` classes with single `size-[--size-icon-*]`:

```tsx
// Before:
<Check className="h-3 w-3 text-green-500" />

// After:
<Check className="size-[--size-icon-xs] text-green-500" />
```

```tsx
// Before:
<PanelLeft className="h-4 w-4" />

// After:
<PanelLeft className="size-[--size-icon-md]" />
```

```tsx
// Before:
<FolderOpen className="h-3.5 w-3.5 text-muted-foreground" />

// After:
<FolderOpen className="size-[--size-icon-sm] text-muted-foreground" />
```

#### Complete Icon Inventory

The following table lists every icon instance that must be migrated, organized by file with line numbers:

**`apps/client/src/App.tsx`**

| Line | Icon | Old Class | New Token |
|------|------|-----------|-----------|
| 85 | `PanelLeft` | `h-4 w-4` | `size-[--size-icon-md]` |
| 127 | `PanelLeft` | `h-4 w-4` | `size-[--size-icon-md]` |

**`apps/client/src/components/chat/ToolCallCard.tsx`**

| Line | Icon | Old Class | New Token |
|------|------|-----------|-----------|
| 16 | `Loader2` | `h-3 w-3` | `size-[--size-icon-xs]` |
| 17 | `Loader2` | `h-3 w-3` | `size-[--size-icon-xs]` |
| 18 | `Check` | `h-3 w-3` | `size-[--size-icon-xs]` |
| 19 | `X` | `h-3 w-3` | `size-[--size-icon-xs]` |
| 35 | `ChevronDown` | `h-3 w-3` | `size-[--size-icon-xs]` |

**`apps/client/src/components/chat/TaskListPanel.tsx`**

| Line | Icon | Old Class | New Token |
|------|------|-----------|-----------|
| 13 | `Loader2` | `h-3 w-3` | `size-[--size-icon-xs]` |
| 14 | `Circle` | `h-3 w-3` | `size-[--size-icon-xs]` |
| 15 | `CheckCircle2` | `h-3 w-3` | `size-[--size-icon-xs]` |
| 39 | `Loader2` | `h-3 w-3` | `size-[--size-icon-xs]` |
| 49 | `ChevronRight` | `h-3 w-3` | `size-[--size-icon-xs]` |
| 49 | `ChevronDown` | `h-3 w-3` | `size-[--size-icon-xs]` |
| 50 | `ListTodo` | `h-3 w-3` | `size-[--size-icon-xs]` |

**`apps/client/src/components/chat/ToolApproval.tsx`**

| Line | Icon | Old Class | New Token |
|------|------|-----------|-----------|
| 59 | `Shield` | `h-4 w-4` | `size-[--size-icon-md]` |
| 80 | `Check` | `h-3 w-3` | `size-[--size-icon-xs]` |
| 87 | `X` | `h-3 w-3` | `size-[--size-icon-xs]` |

**`apps/client/src/components/chat/MessageItem.tsx`**

| Line | Icon | Old Class | New Token |
|------|------|-----------|-----------|
| 69 | `ChevronRight` | `h-4 w-4` | `size-[--size-icon-md]` |
| 71 | `span` (bullet) | `h-4 w-4` | `size-[--size-icon-md]` |

**`apps/client/src/components/chat/ChatInput.tsx`**

| Line | Icon | Old Class | New Token |
|------|------|-----------|-----------|
| 142 | `Square` | `h-3.5 w-3.5` | `size-[--size-icon-sm]` |
| 157 | `CornerDownLeft` | `h-3.5 w-3.5` | `size-[--size-icon-sm]` |

**`apps/client/src/components/chat/MessageList.tsx`**

| Line | Icon | Old Class | New Token |
|------|------|-----------|-----------|
| 165 | `ArrowDown` | `h-4 w-4` | `size-[--size-icon-md]` |

**`apps/client/src/components/chat/QuestionPrompt.tsx`**

| Line | Icon | Old Class | New Token |
|------|------|-----------|-----------|
| 89 | `Check` | `h-4 w-4` | `size-[--size-icon-md]` |
| 139 | `MessageSquare` | `h-3.5 w-3.5` | `size-[--size-icon-sm]` |
| 241 | `Check` | `h-3 w-3` | `size-[--size-icon-xs]` |

**`apps/client/src/components/sessions/SessionItem.tsx`**

| Line | Icon | Old Class | New Token |
|------|------|-----------|-----------|
| 50 | `Check` | `h-3 w-3` | `size-[--size-icon-xs]` |
| 52 | `Copy` | `h-3 w-3` | `size-[--size-icon-xs]` |
| 98 | `ShieldOff` | `h-3 w-3` | `size-[--size-icon-xs]` |
| 116 | `ChevronDown` | `h-3.5 w-3.5` | `size-[--size-icon-sm]` |

**`apps/client/src/components/sessions/SessionSidebar.tsx`**

| Line | Icon | Old Class | New Token |
|------|------|-----------|-----------|
| 84 | `FolderOpen` | `h-3.5 w-3.5` | `size-[--size-icon-sm]` |
| 93 | `PanelLeftClose` | `h-4 w-4` | `size-[--size-icon-md]` |
| 101 | `Plus` | `h-3.5 w-3.5` | `size-[--size-icon-sm]` |
| 157 | `Route` | `h-3.5 w-3.5` | `size-[--size-icon-sm]` |
| 170 | `HeartPulse` | `h-3.5 w-3.5` | `size-[--size-icon-sm]` |
| 183 | `ThemeIcon` | `h-3.5 w-3.5` | `size-[--size-icon-sm]` |

**`apps/client/src/components/sessions/DirectoryPicker.tsx`**

| Line | Icon | Old Class | New Token |
|------|------|-----------|-----------|
| 117 | `Clock` | `h-3.5 w-3.5` | `size-[--size-icon-sm]` |
| 126 | `Folder` | `h-3.5 w-3.5` | `size-[--size-icon-sm]` |
| 146 | `Eye` | `h-3.5 w-3.5` | `size-[--size-icon-sm]` |
| 148 | `EyeOff` | `h-3.5 w-3.5` | `size-[--size-icon-sm]` |
| 163 | `Loader2` | `h-4 w-4` | `size-[--size-icon-md]` |
| 176 | `Folder` | `h-4 w-4` | `size-[--size-icon-md]` |
| 186 | `FolderOpen` | `h-4 w-4` | `size-[--size-icon-md]` |
| 201 | `Folder` | `h-4 w-4` | `size-[--size-icon-md]` |

**`apps/client/src/components/status/CwdItem.tsx`**

| Line | Icon | Old Class | New Token |
|------|------|-----------|-----------|
| 11 | `Folder` | `h-3 w-3` | `size-[--size-icon-xs]` |

**`apps/client/src/components/status/ModelItem.tsx`**

| Line | Icon | Old Class | New Token |
|------|------|-----------|-----------|
| 34 | `Bot` | `h-3 w-3` | `size-[--size-icon-xs]` |

**`apps/client/src/components/status/ContextItem.tsx`**

| Line | Icon | Old Class | New Token |
|------|------|-----------|-----------|
| 13 | `Layers` | `h-3 w-3` | `size-[--size-icon-xs]` |

**`apps/client/src/components/status/PermissionModeItem.tsx`**

| Line | Icon | Old Class | New Token |
|------|------|-----------|-----------|
| 56 | `Icon` (dynamic) | `h-3 w-3` | `size-[--size-icon-xs]` |
| 73 | `MIcon` (dynamic) | `h-3 w-3` | `size-[--size-icon-xs]` |

**`apps/client/src/components/status/CostItem.tsx`**

| Line | Icon | Old Class | New Token |
|------|------|-----------|-----------|
| 10 | `DollarSign` | `h-3 w-3` | `size-[--size-icon-xs]` |

**`apps/client/src/components/ui/dropdown-menu.tsx`**

| Line | Icon | Old Class | New Token |
|------|------|-----------|-----------|
| 60 | container span | `h-3.5 w-3.5` | `size-[--size-icon-sm]` |
| 62 | `Check` | `h-3 w-3` | `size-[--size-icon-xs]` |

**`apps/client/src/components/ui/path-breadcrumb.tsx`**

| Line | Icon | Old Class | New Token |
|------|------|-----------|-----------|
| 29 | chevron (dynamic) | `h-2.5 w-2.5` / `h-3 w-3` | `size-[--size-icon-xs]` for both |

**`apps/client/src/components/ui/dialog.tsx`**

| Line | Icon | Old Class | New Token |
|------|------|-----------|-----------|
| 42 | `X` | `h-4 w-4` | `size-[--size-icon-md]` |

### 6.4 Touch Target Fixes

On mobile (< 768px), interactive elements must meet the 44px minimum touch target. This is achieved with mobile-only padding increases using Tailwind's responsive prefix `max-sm:` or a custom `@media` block.

#### ChatInput.tsx (lines 139, 154)
Stop and send buttons currently use `p-1.5` (padding: 6px). With icon-sm at 20px on mobile, the total is 32px -- still below 44px.

**Fix:** Change `p-1.5` to `p-1.5 max-sm:p-2.5` on both button elements:
```tsx
// Line 139 (stop button):
className="rounded-md bg-destructive p-1.5 max-sm:p-2.5 text-destructive-foreground hover:bg-destructive/90"

// Line 154 (send button):
className="rounded-md bg-primary p-1.5 max-sm:p-2.5 text-primary-foreground hover:bg-primary/90"
```

#### SessionItem.tsx (line 44-55)
The `CopyButton` uses `p-0.5` (2px padding). With icon-xs at 15px on mobile, total is 19px.

**Fix:** Change to `p-0.5 max-sm:p-2`:
```tsx
className="p-0.5 max-sm:p-2 rounded hover:bg-secondary/80 ..."
```

The expand toggle button (line 104) also uses `p-0.5`. Same fix:
```tsx
className={cn(
  'p-0.5 max-sm:p-2 rounded transition-all duration-150',
  ...
)}
```

#### SessionSidebar.tsx (lines 153-184)
Footer icon buttons use `p-1` (4px). With icon-sm at 20px on mobile, total is 28px.

**Fix:** Change to `p-1 max-sm:p-2`:
```tsx
className="p-1 max-sm:p-2 rounded-md text-muted-foreground/50 hover:text-muted-foreground ..."
```

Apply to: Relay status button (line 153), Heartbeat status button (line 166), Theme toggle button (line 178).

#### DirectoryPicker.tsx (lines 139-150)
Hidden folder toggle uses `p-1` (4px). With icon-sm at 20px on mobile, total is 28px.

**Fix:** Change to `p-1 max-sm:p-2`.

#### ToolApproval.tsx (lines 75-88)
Approve/Deny buttons use `px-3 py-1` (4px vertical). With text-xs on mobile and icon, the vertical height is approximately 28px.

**Fix:** Change to `px-3 py-1 max-sm:py-2` on both buttons.

### 6.5 Hover-Only Pattern Conversions

Three hover-only patterns exist in the codebase that need mobile alternatives.

#### 6.5.1 Message Timestamps (MessageItem.tsx, line 62)

**Current:** Timestamps are invisible by default (`text-muted-foreground/0`) and revealed on group hover (`group-hover:text-muted-foreground/60`).

**Mobile approach:** On mobile, always show timestamps at reduced opacity. No long-press needed -- timestamps are non-interactive metadata.

```tsx
<span className="absolute right-4 top-1 text-xs text-muted-foreground/0 group-hover:text-muted-foreground/60 max-sm:text-muted-foreground/40 transition-colors duration-150">
  {formatTime(message.timestamp)}
</span>
```

#### 6.5.2 Session Expand Chevron (SessionItem.tsx, lines 102-118)

**Current:** The chevron is `opacity-0 group-hover:opacity-100` when collapsed.

**Mobile approach:** Hide the chevron entirely on mobile. The expanded details section is accessible by tapping the session item itself (add toggle-on-tap behavior). This keeps the design minimal per user preference.

```tsx
<button
  onClick={handleExpandToggle}
  className={cn(
    'p-0.5 max-sm:p-2 rounded transition-all duration-150 max-sm:hidden',
    expanded
      ? 'opacity-100 text-muted-foreground'
      : 'opacity-0 group-hover:opacity-100 text-muted-foreground/60 hover:text-muted-foreground'
  )}
  aria-label="Session details"
>
```

On mobile, tapping the session row should toggle expansion in addition to navigating. Modify the `onClick` handler on the session row (line 87-88) to toggle expansion on mobile:

```tsx
onClick={() => {
  if (isMobile) {
    setExpanded(prev => !prev);
  }
  onClick();
}}
```

This requires importing `useIsMobile` in `SessionItem.tsx` (or passing `isMobile` as a prop).

#### 6.5.3 Table Action Overlay (index.css, lines 153-176)

**Current:** Table action icons are hidden by default and shown on hover via CSS `opacity: 0` / `:hover opacity: 1`.

**Mobile approach:** On mobile, always show table action icons at reduced opacity. Add a media query override:

```css
@media (max-width: 767px) {
  .msg-assistant div:has(> div > [data-streamdown="table"]) > div:first-child:not(:has(table)) {
    opacity: 0.6;
    pointer-events: auto;
  }
}
```

### 6.6 iOS Input Zoom Prevention

iOS Safari auto-zooms the viewport when a user focuses an input with `font-size < 16px`. The scale system naturally fixes this because `text-sm` on mobile resolves to `calc(0.875rem * 1.25) = 17.5px`, which is above the 16px threshold.

**Verification points:**
- `ChatInput.tsx` line 123: textarea uses `text-sm` class -- will be 17.5px on mobile. No change needed.
- `QuestionPrompt.tsx` line 218: "Other" textarea uses `text-sm` class -- same resolution. No change needed.

If the user sets `--mobile-scale` below 1.143 (which would make `text-sm` < 16px), a fallback is needed. Add to `index.css`:

```css
@media (max-width: 767px) {
  textarea, input[type="text"], input[type="email"], input[type="search"], select {
    font-size: max(1rem, var(--font-size-sm)) !important;
  }
}
```

### 6.7 Safe Area & Viewport Changes

#### 6.7.1 Viewport Meta Tag

**File:** `apps/client/index.html`, line 5

**Current:**
```html
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
```

**New:**
```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
```

The `viewport-fit=cover` allows the app to extend into the safe area, while `env(safe-area-inset-*)` values provide the actual inset dimensions for padding.

#### 6.7.2 Safe Area Insets

Add to `index.css`:

```css
@supports (padding-bottom: env(safe-area-inset-bottom)) {
  /* Chat input area sits at the bottom -- needs safe area padding */
  .chat-input-container {
    padding-bottom: env(safe-area-inset-bottom);
  }

  /* Sidebar -- needs safe area on the left (landscape) and bottom */
  .sidebar-container {
    padding-left: env(safe-area-inset-left);
    padding-bottom: env(safe-area-inset-bottom);
  }

  /* Drawer content -- needs bottom safe area */
  [data-vaul-drawer] {
    padding-bottom: env(safe-area-inset-bottom);
  }
}
```

Note: The `chat-input-container` and `sidebar-container` class names need to be added to the respective components:
- `ChatPanel.tsx`: Add `chat-input-container` to the div wrapping `<ChatInput>`
- `SessionSidebar.tsx`: The sidebar root div (line 72) gets `sidebar-container`

Alternatively, use Tailwind's arbitrary value: `pb-[env(safe-area-inset-bottom)]`.

#### 6.7.3 Overscroll Behavior

Prevent pull-to-refresh in the chat scroll area. Add to `index.css`:

```css
@media (max-width: 767px) {
  /* Prevent pull-to-refresh in chat scroll */
  body {
    overscroll-behavior: contain;
  }
}
```

Also add `touch-action: pan-y` to the chat scroll container to prevent accidental horizontal swipes:

```css
@media (max-width: 767px) {
  .chat-scroll-area {
    touch-action: pan-y;
  }
}
```

The class `chat-scroll-area` should be added to the scrollable message list container in `MessageList.tsx`.

### 6.8 Full index.css Additions

The following CSS is added to `apps/client/src/index.css`. The additions are organized by concern:

```css
/* ============================================
   Mobile Responsive Scale System
   ============================================ */

:root {
  /* Configuration -- adjust these to tune mobile scaling */
  --mobile-scale: 1.25;
  /* Optional per-category overrides: */
  /* --mobile-scale-text: 1.15; */
  /* --mobile-scale-icon: 1.25; */
  /* --mobile-scale-interactive: 1.30; */

  /* Internal active multipliers (1 on desktop) */
  --_st: 1;
  --_si: 1;
  --_sb: 1;
}

@media (max-width: 767px) {
  :root {
    --_st: var(--mobile-scale-text, var(--mobile-scale, 1.25));
    --_si: var(--mobile-scale-icon, var(--mobile-scale, 1.25));
    --_sb: var(--mobile-scale-interactive, var(--mobile-scale, 1.25));
  }
}
```

And update the existing `@theme inline` block:

```css
@theme inline {
  /* Scaled font sizes */
  --font-size-3xs: calc(0.625rem * var(--_st));
  --font-size-3xs--line-height: 0.875rem;
  --font-size-2xs: calc(0.6875rem * var(--_st));
  --font-size-2xs--line-height: 1rem;
  --font-size-xs: calc(0.75rem * var(--_st));
  --font-size-sm: calc(0.875rem * var(--_st));
  --font-size-base: calc(1rem * var(--_st));
  --font-size-lg: calc(1.125rem * var(--_st));
  --font-size-xl: calc(1.25rem * var(--_st));

  /* Icon sizes (3 standard tokens) */
  --size-icon-xs: calc(0.75rem * var(--_si));
  --size-icon-sm: calc(1rem * var(--_si));
  --size-icon-md: calc(1.25rem * var(--_si));

  /* Interactive element heights */
  --size-btn-sm: calc(2rem * var(--_sb));
  --size-btn-md: calc(2.25rem * var(--_sb));
  --size-btn-lg: calc(2.5rem * var(--_sb));

  /* ... existing color tokens unchanged ... */
}
```

Additional mobile rules appended:

```css
/* iOS input zoom prevention (fallback for low --mobile-scale values) */
@media (max-width: 767px) {
  textarea, input[type="text"], input[type="email"], input[type="search"], select {
    font-size: max(1rem, var(--font-size-sm, 0.875rem)) !important;
  }

  /* Prevent pull-to-refresh */
  body {
    overscroll-behavior: contain;
  }

  /* Table action overlay -- always visible on mobile */
  .msg-assistant div:has(> div > [data-streamdown="table"]) > div:first-child:not(:has(table)) {
    opacity: 0.6;
    pointer-events: auto;
  }
}

/* Safe area insets */
@supports (padding-bottom: env(safe-area-inset-bottom)) {
  .chat-input-container {
    padding-bottom: env(safe-area-inset-bottom);
  }
  .sidebar-container {
    padding-left: env(safe-area-inset-left);
    padding-bottom: env(safe-area-inset-bottom);
  }
  [data-vaul-drawer] {
    padding-bottom: env(safe-area-inset-bottom);
  }
}
```

### 6.9 `useLongPress` Hook (Optional)

If future hover-only patterns require long-press behavior, a utility hook is provided. For the current scope, the simpler CSS-based approaches (always-visible on mobile, hidden on mobile) are preferred.

```typescript
// apps/client/src/hooks/use-long-press.ts
import { useRef, useCallback } from 'react';

interface UseLongPressOptions {
  ms?: number;
  onLongPress: () => void;
}

export function useLongPress({ onLongPress, ms = 500 }: UseLongPressOptions) {
  const timerRef = useRef<number | null>(null);

  const onTouchStart = useCallback(() => {
    timerRef.current = window.setTimeout(onLongPress, ms);
  }, [onLongPress, ms]);

  const onTouchEnd = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  return {
    onTouchStart,
    onTouchEnd,
    onTouchMove: onTouchEnd,
  };
}
```

This hook is created but not wired into any components in Phase 1-3. It exists as infrastructure for future hover-to-touch conversions.

---

## 7. User Experience

### 7.1 Mobile (< 768px)

| Element | Desktop | Mobile (x1.25) |
|---------|---------|----------------|
| Body text (`text-sm`) | 14px | 17.5px |
| Small text (`text-xs`) | 12px | 15px |
| Tiny text (`text-2xs`) | 11px | 13.75px |
| Micro text (`text-3xs`) | 10px | 12.5px |
| Large text (`text-base`) | 16px | 20px |
| Icon small (`icon-xs`) | 12px | 15px |
| Icon medium (`icon-sm`) | 16px | 20px |
| Icon large (`icon-md`) | 20px | 25px |
| Button height sm | 32px | 40px |
| Button height md | 36px | 45px |
| Button height lg | 40px | 50px |

### 7.2 Desktop (>= 768px)

All multipliers resolve to `1`. Desktop appearance is identical to the current design, with the exception of icon size standardization:

- Icons that were 10px (`h-2.5`) become 12px -- negligible visual difference
- Icons that were 14px (`h-3.5`) become 16px -- minor, intentional standardization
- Icons that were 16px (`h-4`) become 20px -- this is the most noticeable change

The 16px-to-20px bump affects approximately 15 icon instances across `App.tsx`, `MessageItem.tsx`, `MessageList.tsx`, `ToolApproval.tsx`, `QuestionPrompt.tsx`, `SessionSidebar.tsx`, `DirectoryPicker.tsx`, and `dialog.tsx`. These are primary action icons (sidebar toggle, close dialog, shield, checkmark, scroll-to-bottom) where 20px is within the standard range.

### 7.3 Hover-Only Patterns

| Pattern | Desktop | Mobile |
|---------|---------|--------|
| Message timestamps | Hidden, shown on hover | Always visible at 40% opacity |
| Session expand chevron | Hidden, shown on hover | Hidden; tap session row to expand |
| Table action icons | Hidden, shown on hover | Always visible at 60% opacity |

---

## 8. Testing Strategy

### 8.1 Unit Tests

No new unit tests are required for the CSS scale system itself, as it is pure CSS. However, existing tests must continue to pass:

- Run `turbo test` to verify all existing client tests pass after icon class changes
- Tests that snapshot or assert on CSS class names (e.g., checking for `h-3 w-3`) must be updated to `size-[--size-icon-xs]`

### 8.2 Component Test Updates

Tests that render components with icons may need class name assertion updates. Affected test files:

- `apps/client/src/components/chat/__tests__/ToolCallCard.test.tsx`
- `apps/client/src/components/chat/__tests__/MessageItem.test.tsx`
- `apps/client/src/components/chat/__tests__/TaskListPanel.test.tsx`
- `apps/client/src/components/chat/__tests__/QuestionPrompt.test.tsx`
- `apps/client/src/components/sessions/__tests__/SessionItem.test.tsx`

If these tests assert on specific CSS classes, update them. If they test behavior (click handlers, rendering), no changes needed.

### 8.3 Visual Testing

Manual visual verification across devices:

| Device / Viewport | What to Check |
|-------------------|---------------|
| Desktop 1440px | No visual changes from current design |
| Desktop 1024px | No visual changes |
| Tablet 768px | Breakpoint boundary -- should match desktop (multipliers = 1) |
| Mobile 767px | Scale system activates -- all text, icons, buttons 25% larger |
| Mobile 375px (iPhone SE) | Smallest supported viewport -- verify no overflow |
| Mobile 430px (iPhone Pro Max) | Verify safe area insets with notch |
| Android 360px | Verify basic functionality |

### 8.4 Specific Mobile Checks

1. **Text readability:** Body text in chat messages should be ~17.5px
2. **Icon clarity:** Interactive icons should be visibly larger than desktop
3. **Touch targets:** All buttons should be comfortable to tap (>= 44px)
4. **Input focus:** Focusing the chat textarea should NOT trigger Safari zoom
5. **Safe areas:** Content should not be obscured by the iPhone notch or home bar
6. **Pull-to-refresh:** Scrolling up in the message list should NOT trigger browser refresh
7. **Timestamps:** Should be visible on mobile without hovering
8. **Session items:** Tapping should expand details; no chevron visible
9. **Table actions:** Should be visible at reduced opacity

### 8.5 Scale Override Testing

Verify the "dial" works by temporarily changing values:

1. Set `--mobile-scale: 1.0` -- mobile should look identical to desktop
2. Set `--mobile-scale: 1.5` -- mobile elements should be 50% larger
3. Set `--mobile-scale-text: 1.0` with `--mobile-scale: 1.25` -- text stays desktop size, icons/buttons scale
4. Set `--mobile-scale-icon: 1.5` -- icons scale independently to 50% larger

---

## 9. Performance Considerations

### 9.1 CSS calc() Overhead

The `calc()` expressions in `@theme inline` resolve at paint time. Modern browsers optimize constant `calc()` expressions with CSS custom properties. The performance impact is negligible:

- Each `calc(Xrem * var(--_st))` involves one multiplication
- CSS custom properties are resolved once per element per layout pass
- The `var()` fallback chain (`var(--mobile-scale-text, var(--mobile-scale, 1.25))`) is resolved at parse time, not per-frame

### 9.2 No JavaScript Runtime Cost

The entire scale system is pure CSS. No JavaScript runs to detect viewport size or compute sizes. The media query handles the desktop/mobile switch natively in the browser's CSS engine.

### 9.3 Bundle Size

- No new JavaScript dependencies
- CSS additions are approximately 60 lines (~1.5KB uncompressed, ~400 bytes gzipped)
- The `useLongPress` hook (if included) is ~20 lines (~300 bytes)

### 9.4 Layout Thrashing

The `@theme inline` approach avoids layout thrashing because:
- Tokens resolve at CSS parse time, not at JavaScript runtime
- No `ResizeObserver` or `matchMedia` listeners are added
- The existing `useIsMobile` hook (768px breakpoint) remains the only JS-side viewport listener

---

## 10. Security Considerations

This feature is purely client-side CSS and does not:
- Process user input in new ways
- Add new API endpoints
- Modify authentication or authorization flows
- Introduce new dependencies with security implications

No security review is required.

---

## 11. Documentation

### 11.1 Design System Guide Update

Add a "Mobile Responsive Scale" section to `guides/design-system.md`:

- Document the `--mobile-scale` custom property and its default value
- Document the three per-category overrides
- Document the three standard icon sizes and their token names
- Provide a table of scaled values at 1.25x

### 11.2 Inline Code Comments

Add a comment block at the top of the scale system section in `index.css` explaining:
- What the system does
- How to adjust the scale factor
- How to add per-category overrides
- Reference to the design system guide

### 11.3 Icon Size Convention

Document in `guides/design-system.md` or as a comment in `index.css`:

```
Icon Size Convention:
  icon-xs (12px desktop): Decorative, status indicators, inline affordances
  icon-sm (16px desktop): Interactive icons in compact UI (sidebar, tool cards)
  icon-md (20px desktop): Primary action icons (buttons, navigation, prominent UI)
```

---

## 12. Implementation Phases

### Phase 1: Foundation (CSS Infrastructure)

**Estimated effort:** 1-2 hours

**Files modified:**
- `apps/client/src/index.css` -- Add scale system variables, mobile media query, update `@theme inline` tokens, add safe area CSS, overscroll-behavior, iOS input zoom fix, table action mobile override
- `apps/client/index.html` -- Add `viewport-fit=cover` to viewport meta tag

**Verification:**
- `turbo build --filter=@dorkos/client` succeeds
- Tailwind generates utility classes that include `calc()` expressions
- Desktop appearance is unchanged (inspect computed styles, all multipliers = 1)
- On a simulated 375px viewport, `text-sm` computes to 17.5px

### Phase 2: Icon Standardization

**Estimated effort:** 2-3 hours

**Files modified (15 files, ~55 replacements):**
- `apps/client/src/App.tsx` (2 icons)
- `apps/client/src/components/chat/ToolCallCard.tsx` (5 icons)
- `apps/client/src/components/chat/TaskListPanel.tsx` (7 icons)
- `apps/client/src/components/chat/ToolApproval.tsx` (3 icons)
- `apps/client/src/components/chat/MessageItem.tsx` (2 icons + 1 span)
- `apps/client/src/components/chat/ChatInput.tsx` (2 icons)
- `apps/client/src/components/chat/MessageList.tsx` (1 icon)
- `apps/client/src/components/chat/QuestionPrompt.tsx` (3 icons)
- `apps/client/src/components/sessions/SessionItem.tsx` (4 icons)
- `apps/client/src/components/sessions/SessionSidebar.tsx` (6 icons)
- `apps/client/src/components/sessions/DirectoryPicker.tsx` (8 icons)
- `apps/client/src/components/status/CwdItem.tsx` (1 icon)
- `apps/client/src/components/status/ModelItem.tsx` (1 icon)
- `apps/client/src/components/status/ContextItem.tsx` (1 icon)
- `apps/client/src/components/status/PermissionModeItem.tsx` (2 icons)
- `apps/client/src/components/status/CostItem.tsx` (1 icon)
- `apps/client/src/components/ui/dropdown-menu.tsx` (2 instances)
- `apps/client/src/components/ui/path-breadcrumb.tsx` (1 dynamic)
- `apps/client/src/components/ui/dialog.tsx` (1 icon)

**Verification:**
- `turbo test` passes (update test assertions if needed)
- Visual inspection: all icons render at expected sizes
- No broken layouts from size changes

### Phase 3: Touch Target & Hover Fixes

**Estimated effort:** 2-3 hours

**Files modified:**
- `apps/client/src/components/chat/ChatInput.tsx` -- Mobile padding on stop/send buttons
- `apps/client/src/components/sessions/SessionItem.tsx` -- Mobile padding on copy/expand buttons, hide chevron on mobile, tap-to-expand on mobile
- `apps/client/src/components/sessions/SessionSidebar.tsx` -- Mobile padding on footer buttons
- `apps/client/src/components/sessions/DirectoryPicker.tsx` -- Mobile padding on toggle button
- `apps/client/src/components/chat/ToolApproval.tsx` -- Mobile padding on approve/deny buttons
- `apps/client/src/components/chat/MessageItem.tsx` -- Always-visible timestamps on mobile
- `apps/client/src/hooks/use-long-press.ts` -- New file (optional, for future use)

**Verification:**
- On mobile viewport, all buttons have >= 44px touch area
- Message timestamps visible on mobile without interaction
- Session items expandable via tap on mobile
- Table actions visible on mobile

### Phase 4: Safe Areas & Viewport

**Estimated effort:** 1-2 hours

**Files modified:**
- `apps/client/src/components/chat/ChatPanel.tsx` -- Add `chat-input-container` class to input wrapper
- `apps/client/src/components/sessions/SessionSidebar.tsx` -- Add `sidebar-container` class to root div
- `apps/client/src/components/chat/MessageList.tsx` -- Add `chat-scroll-area` class to scroll container

**Verification:**
- On iPhone simulator with notch: content not obscured, bottom elements have proper inset
- Chat scroll does not trigger pull-to-refresh
- Drawer bottom sheet respects safe area

### Phase 5: Testing & Polish

**Estimated effort:** 2-3 hours

**Activities:**
- Run full test suite: `turbo test`
- Visual testing across breakpoints (see Section 8.3)
- iOS Safari testing on real device or simulator
- Android Chrome testing on real device or emulator
- Scale override testing (see Section 8.5)
- Update `guides/design-system.md` with mobile section
- Code review and cleanup

---

## 13. Open Questions

1. **Desktop icon size bump acceptance:** The standardization changes `h-4 w-4` (16px) icons to `icon-md` (20px) on desktop. This affects ~15 icon instances. Is a 4px increase acceptable, or should a fourth size tier (`icon-lg` at 20px, keeping `icon-md` at 16px) be introduced?

2. **Obsidian plugin scope:** The Obsidian plugin embeds the same React app. Should the scale system be active inside Obsidian? Currently, the `.copilot-view-content` Obsidian theme bridge (index.css lines 191-216) does not interact with the scale system, so it would be inherited. The plugin runs inside Electron where viewport width may vary.

3. **Line-height scaling:** The current spec only scales `font-size`, not `line-height`. The existing line-height values (`--font-size-3xs--line-height: 0.875rem`, `--font-size-2xs--line-height: 1rem`) remain fixed. Should line-heights also scale, or does the fixed line-height provide adequate spacing at larger text sizes?

4. **`max-sm:` vs `@media` for touch targets:** Tailwind v4 supports the `max-sm:` variant for `@media (max-width: 639px)`. However, our mobile breakpoint is 768px (matching `useIsMobile`). We need to verify that a custom variant or `@media (max-width: 767px)` in the CSS is needed, or if `max-md:` (which would be `< 768px` in Tailwind v4's default breakpoints) is the correct prefix. The `sm` breakpoint in Tailwind defaults to 640px, so `max-sm:` would only apply below 640px, not our 768px threshold.

   **Resolution approach:** Either use `max-md:` (Tailwind's `md` breakpoint is 768px, so `max-md:` applies below 768px) or define a custom `@media` variant.

5. **Streamdown library compatibility:** The `StreamingText` component uses the `streamdown` library for markdown rendering. Verify that Streamdown's internally generated elements inherit the scaled `font-size` tokens correctly, since Streamdown's CSS is included via `@source` directive (index.css line 2).

---

## 14. References

- [Apple Human Interface Guidelines -- Layout](https://developer.apple.com/design/human-interface-guidelines/layout) -- 44pt touch targets, 17pt body text
- [Material Design -- Touch targets](https://m3.material.io/foundations/accessible-design/accessibility-basics) -- 48dp minimum
- [WCAG 2.5.5 Target Size (AAA)](https://www.w3.org/WAI/WCAG21/Understanding/target-size.html) -- 44x44px minimum
- [Tailwind CSS v4 -- @theme inline](https://tailwindcss.com/docs/theme) -- Runtime variable resolution
- [CSS env() -- Safe Area Insets](https://developer.mozilla.org/en-US/docs/Web/CSS/env) -- `safe-area-inset-*` values
- [Viewport meta -- viewport-fit](https://developer.mozilla.org/en-US/docs/Web/HTML/Viewport_meta_tag) -- `viewport-fit=cover`
- `apps/client/src/index.css` -- Current CSS infrastructure
- `apps/client/src/hooks/use-is-mobile.ts` -- Existing 768px breakpoint hook
- `guides/design-system.md` -- Existing design system documentation
