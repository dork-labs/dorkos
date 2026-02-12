# Mobile Responsive Scale System -- Task Breakdown

| Field | Value |
|-------|-------|
| **Spec** | `specs/mobile-responsive-scale-system/02-specification.md` |
| **Feature Slug** | `mobile-responsive-scale-system` |
| **Created** | 2026-02-11 |
| **Total Tasks** | 9 |
| **Total Phases** | 5 |

---

## Phase 1: Foundation (CSS Infrastructure)

### Task 1.1: Add scale system CSS variables and `@theme inline` tokens to index.css

**Status:** Not Started
**Blocked by:** None
**Files to modify:**
- `apps/client/src/index.css`

**Description:**

Add the Mobile Responsive Scale System CSS custom properties and update the existing `@theme inline` block in `apps/client/src/index.css`. This establishes the three-layer CSS variable architecture: configuration properties, active multipliers, and Tailwind design tokens.

**Implementation:**

1. Add the following CSS **before** the existing `@theme inline` block in `apps/client/src/index.css`:

```css
/* ============================================
   Mobile Responsive Scale System
   ============================================
   A single "dial" (--mobile-scale) controls how much bigger
   UI elements render on screens < 768px. Default is 1.25 (25% larger).

   To adjust: change --mobile-scale in :root below.
   For per-category control, uncomment the override variables.
   See guides/design-system.md for full documentation.
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

2. Replace the existing custom text size entries in the `@theme inline` block. The current entries (approximately lines 5-8) are:

```css
@theme inline {
  --text-2xs: 0.6875rem;
  --text-2xs--line-height: 1rem;
  --text-3xs: 0.625rem;
  --text-3xs--line-height: 0.875rem;
  /* ... color tokens ... */
}
```

Replace those text size entries (keeping all existing color tokens unchanged) with:

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

  /* ... existing color tokens remain unchanged ... */
}
```

Note: The `--text-2xs` and `--text-3xs` naming changes to `--font-size-2xs` and `--font-size-3xs` to align with Tailwind v4's standard font-size token namespace. Existing uses of `text-2xs` and `text-3xs` utility classes need no changes as Tailwind v4 resolves them via the `--font-size-*` namespace.

3. Append the following mobile-specific CSS rules at the end of the file (before any Obsidian-specific sections):

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

**Acceptance criteria:**
- `turbo build --filter=@lifeos/client` succeeds
- Tailwind generates utility classes that include `calc()` expressions
- Desktop appearance is unchanged (all multipliers resolve to 1)
- On a simulated 375px viewport, `text-sm` computes to `calc(0.875rem * 1.25)` = 17.5px
- The `@theme inline` directive is used (NOT plain `@theme`), which is critical for runtime CSS variable resolution
- Existing color tokens in `@theme inline` are untouched

---

### Task 1.2: Update viewport meta tag in index.html

**Status:** Not Started
**Blocked by:** None
**Files to modify:**
- `apps/client/index.html`

**Description:**

Add `viewport-fit=cover` to the existing viewport meta tag. This allows the app to extend into the safe area on notched iOS devices, while `env(safe-area-inset-*)` values (added in Task 1.1) provide the actual inset dimensions for padding.

**Implementation:**

In `apps/client/index.html` (line 5), change:

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
```

To:

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
```

**Acceptance criteria:**
- The viewport meta tag contains `viewport-fit=cover`
- App builds successfully with `turbo build --filter=@lifeos/client`

---

## Phase 2: Icon Standardization

### Task 2.1: Migrate all icon instances across 19 files to 3 standard token sizes

**Status:** Not Started
**Blocked by:** Task 1.1 (icon CSS tokens must exist in `@theme inline`)
**Files to modify (19 files, ~55 replacements):**
- `apps/client/src/App.tsx`
- `apps/client/src/components/chat/ToolCallCard.tsx`
- `apps/client/src/components/chat/TaskListPanel.tsx`
- `apps/client/src/components/chat/ToolApproval.tsx`
- `apps/client/src/components/chat/MessageItem.tsx`
- `apps/client/src/components/chat/ChatInput.tsx`
- `apps/client/src/components/chat/MessageList.tsx`
- `apps/client/src/components/chat/QuestionPrompt.tsx`
- `apps/client/src/components/sessions/SessionItem.tsx`
- `apps/client/src/components/sessions/SessionSidebar.tsx`
- `apps/client/src/components/sessions/DirectoryPicker.tsx`
- `apps/client/src/components/status/CwdItem.tsx`
- `apps/client/src/components/status/ModelItem.tsx`
- `apps/client/src/components/status/ContextItem.tsx`
- `apps/client/src/components/status/PermissionModeItem.tsx`
- `apps/client/src/components/status/CostItem.tsx`
- `apps/client/src/components/ui/dropdown-menu.tsx`
- `apps/client/src/components/ui/path-breadcrumb.tsx`
- `apps/client/src/components/ui/dialog.tsx`

**Description:**

Migrate all ~55 icon instances from ad-hoc Tailwind size classes (`h-N w-N`) to three semantic token sizes using Tailwind's arbitrary value syntax: `size-[--size-icon-*]`.

**Size mapping:**

| Old Class | New Token Class | Desktop Size | Mobile Size (x1.25) |
|-----------|----------------|-------------|---------------------|
| `h-2.5 w-2.5` (10px) | `size-[--size-icon-xs]` | 12px | 15px |
| `h-3 w-3` (12px) | `size-[--size-icon-xs]` | 12px | 15px |
| `h-3.5 w-3.5` (14px) | `size-[--size-icon-sm]` | 16px | 20px |
| `h-4 w-4` (16px) | `size-[--size-icon-md]` | 20px | 25px |

**Pattern:** Replace paired `h-N w-N` classes with single `size-[--size-icon-*]`:

```tsx
// Before:
<Check className="h-3 w-3 text-green-500" />
// After:
<Check className="size-[--size-icon-xs] text-green-500" />

// Before:
<PanelLeft className="h-4 w-4" />
// After:
<PanelLeft className="size-[--size-icon-md]" />

// Before:
<FolderOpen className="h-3.5 w-3.5 text-muted-foreground" />
// After:
<FolderOpen className="size-[--size-icon-sm] text-muted-foreground" />
```

**Complete icon inventory by file:**

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

**Acceptance criteria:**
- All ~55 icon instances use one of the three token classes: `size-[--size-icon-xs]`, `size-[--size-icon-sm]`, `size-[--size-icon-md]`
- No remaining `h-2.5 w-2.5`, `h-3 w-3`, `h-3.5 w-3.5`, or `h-4 w-4` on Lucide icon elements in the listed files
- `turbo build --filter=@lifeos/client` succeeds
- Visual inspection: all icons render at expected sizes on desktop
- No broken layouts from size changes

---

## Phase 3: Touch Target & Hover Fixes

### Task 3.1: Add mobile-only touch target padding to undersized buttons

**Status:** Not Started
**Blocked by:** Task 2.1 (icon sizes affect touch target calculations)
**Files to modify:**
- `apps/client/src/components/chat/ChatInput.tsx`
- `apps/client/src/components/sessions/SessionItem.tsx`
- `apps/client/src/components/sessions/SessionSidebar.tsx`
- `apps/client/src/components/sessions/DirectoryPicker.tsx`
- `apps/client/src/components/chat/ToolApproval.tsx`

**Description:**

On mobile (< 768px), interactive elements must meet the 44px minimum touch target (WCAG 2.5.5 AAA). Add mobile-only padding increases using `max-md:` Tailwind variant (which applies below 768px in Tailwind v4's default breakpoints, matching the `useIsMobile` hook).

Note on breakpoint: Tailwind v4's `md` breakpoint is 768px, so `max-md:` applies below 768px. This matches our mobile breakpoint. If `max-md:` does not work as expected, use `@media (max-width: 767px)` directly in CSS instead.

**Implementation:**

**ChatInput.tsx (lines 139, 154)** -- Stop and send buttons currently use `p-1.5` (6px padding). With icon-sm at 20px on mobile, total is 32px -- below 44px.

Change `p-1.5` to `p-1.5 max-md:p-2.5` on both button elements:

```tsx
// Line 139 (stop button):
className="rounded-md bg-destructive p-1.5 max-md:p-2.5 text-destructive-foreground hover:bg-destructive/90"

// Line 154 (send button):
className="rounded-md bg-primary p-1.5 max-md:p-2.5 text-primary-foreground hover:bg-primary/90"
```

**SessionItem.tsx (line 44-55)** -- CopyButton uses `p-0.5` (2px padding). With icon-xs at 15px on mobile, total is 19px.

Change to `p-0.5 max-md:p-2`:

```tsx
className="p-0.5 max-md:p-2 rounded hover:bg-secondary/80 ..."
```

The expand toggle button (line 104) also uses `p-0.5`. Same fix:

```tsx
className={cn(
  'p-0.5 max-md:p-2 rounded transition-all duration-150',
  ...
)}
```

**SessionSidebar.tsx (lines 153-184)** -- Footer icon buttons use `p-1` (4px). With icon-sm at 20px on mobile, total is 28px.

Change to `p-1 max-md:p-2` on all three footer buttons:

```tsx
className="p-1 max-md:p-2 rounded-md text-muted-foreground/50 hover:text-muted-foreground ..."
```

Apply to: Relay status button (line 153), Heartbeat status button (line 166), Theme toggle button (line 178).

**DirectoryPicker.tsx (lines 139-150)** -- Hidden folder toggle uses `p-1` (4px). With icon-sm at 20px on mobile, total is 28px.

Change to `p-1 max-md:p-2`.

**ToolApproval.tsx (lines 75-88)** -- Approve/Deny buttons use `px-3 py-1` (4px vertical). With text-xs on mobile and icon, the vertical height is approximately 28px.

Change to `px-3 py-1 max-md:py-2` on both buttons.

**Acceptance criteria:**
- On mobile viewport (< 768px), all modified buttons have >= 44px touch area
- On desktop viewport (>= 768px), padding is unchanged from current values
- `turbo build --filter=@lifeos/client` succeeds

---

### Task 3.2: Convert hover-only patterns to mobile-friendly alternatives

**Status:** Not Started
**Blocked by:** Task 2.1 (icon sizes must be standardized first)
**Files to modify:**
- `apps/client/src/components/chat/MessageItem.tsx`
- `apps/client/src/components/sessions/SessionItem.tsx`

**Description:**

Three hover-only patterns exist that are invisible on touch devices. Convert them to mobile-friendly alternatives.

**Implementation:**

**1. Message Timestamps (MessageItem.tsx, line 62)**

Current: Timestamps are invisible by default (`text-muted-foreground/0`) and revealed on group hover (`group-hover:text-muted-foreground/60`).

Mobile approach: Always show timestamps at reduced opacity on mobile. Add `max-md:text-muted-foreground/40`:

```tsx
<span className="absolute right-4 top-1 text-xs text-muted-foreground/0 group-hover:text-muted-foreground/60 max-md:text-muted-foreground/40 transition-colors duration-150">
  {formatTime(message.timestamp)}
</span>
```

**2. Session Expand Chevron (SessionItem.tsx, lines 102-118)**

Current: The chevron is `opacity-0 group-hover:opacity-100` when collapsed.

Mobile approach: Hide the chevron entirely on mobile with `max-md:hidden`. On mobile, tapping the session row toggles expansion.

```tsx
<button
  onClick={handleExpandToggle}
  className={cn(
    'p-0.5 max-md:p-2 rounded transition-all duration-150 max-md:hidden',
    expanded
      ? 'opacity-100 text-muted-foreground'
      : 'opacity-0 group-hover:opacity-100 text-muted-foreground/60 hover:text-muted-foreground'
  )}
  aria-label="Session details"
>
```

On mobile, tapping the session row should toggle expansion in addition to navigating. Modify the `onClick` handler on the session row (line 87-88):

```tsx
onClick={() => {
  if (isMobile) {
    setExpanded(prev => !prev);
  }
  onClick();
}}
```

This requires importing `useIsMobile` in `SessionItem.tsx` (from `@/hooks/use-is-mobile`) or passing `isMobile` as a prop.

**3. Table Action Overlay (index.css, lines 153-176)** -- Already handled in Task 1.1 via the CSS rule:

```css
@media (max-width: 767px) {
  .msg-assistant div:has(> div > [data-streamdown="table"]) > div:first-child:not(:has(table)) {
    opacity: 0.6;
    pointer-events: auto;
  }
}
```

No additional work needed for this pattern.

**Acceptance criteria:**
- On mobile: timestamps always visible at 40% opacity
- On mobile: session expand chevron is hidden; tapping session row toggles expansion
- On mobile: table action icons visible at 60% opacity
- On desktop: all hover patterns work exactly as before (no visual changes)

---

### Task 3.3: Create useLongPress hook (optional infrastructure)

**Status:** Not Started
**Blocked by:** None
**Files to create:**
- `apps/client/src/hooks/use-long-press.ts`

**Description:**

Create a utility hook for future hover-to-touch conversions. This hook is created but NOT wired into any components in this feature. It exists as infrastructure for future needs.

**Implementation:**

Create `apps/client/src/hooks/use-long-press.ts`:

```typescript
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

**Acceptance criteria:**
- File exists at `apps/client/src/hooks/use-long-press.ts`
- Hook exports `useLongPress` function
- Hook is NOT imported or used by any component (infrastructure only)
- `turbo typecheck` passes

---

## Phase 4: Safe Areas & Viewport

### Task 4.1: Add safe area CSS classes to components and overscroll/touch-action CSS

**Status:** Not Started
**Blocked by:** Task 1.1 (safe area CSS rules must exist in index.css)
**Files to modify:**
- `apps/client/src/components/chat/ChatPanel.tsx`
- `apps/client/src/components/sessions/SessionSidebar.tsx`
- `apps/client/src/components/chat/MessageList.tsx`

**Description:**

Add CSS class hooks to components so the safe area inset rules (defined in Task 1.1's CSS additions) and the `touch-action` / `chat-scroll-area` rules apply correctly.

**Implementation:**

**ChatPanel.tsx** -- Add `chat-input-container` class to the div wrapping `<ChatInput>`. Find the wrapper div around the ChatInput component and add the class:

```tsx
<div className="chat-input-container ...existing-classes...">
  <ChatInput ... />
</div>
```

This enables the safe area rule:
```css
.chat-input-container {
  padding-bottom: env(safe-area-inset-bottom);
}
```

**SessionSidebar.tsx** -- Add `sidebar-container` class to the sidebar root div (line 72):

```tsx
<div className="sidebar-container ...existing-classes...">
  {/* sidebar content */}
</div>
```

This enables the safe area rules:
```css
.sidebar-container {
  padding-left: env(safe-area-inset-left);
  padding-bottom: env(safe-area-inset-bottom);
}
```

**MessageList.tsx** -- Add `chat-scroll-area` class to the scrollable message list container:

```tsx
<div className="chat-scroll-area ...existing-classes..." ref={scrollContainerRef}>
  {/* messages */}
</div>
```

Also add the following to `index.css` (if not already present from Task 1.1):

```css
@media (max-width: 767px) {
  .chat-scroll-area {
    touch-action: pan-y;
  }
}
```

This prevents accidental horizontal swipes in the chat scroll area.

**Acceptance criteria:**
- `chat-input-container` class present on ChatInput wrapper in ChatPanel.tsx
- `sidebar-container` class present on sidebar root div in SessionSidebar.tsx
- `chat-scroll-area` class present on scroll container in MessageList.tsx
- On iPhone simulator with notch: content not obscured by notch or home indicator
- Chat scroll does not trigger pull-to-refresh on mobile
- Horizontal swipes in chat area are prevented on mobile
- `turbo build --filter=@lifeos/client` succeeds

---

## Phase 5: Testing & Documentation

### Task 5.1: Update tests for icon class changes

**Status:** Not Started
**Blocked by:** Task 3.1 and Task 3.2 (all component changes must be complete)
**Files to check/update:**
- `apps/client/src/components/chat/__tests__/ToolCallCard.test.tsx`
- `apps/client/src/components/chat/__tests__/MessageItem.test.tsx`
- `apps/client/src/components/chat/__tests__/TaskListPanel.test.tsx`
- `apps/client/src/components/chat/__tests__/QuestionPrompt.test.tsx`
- `apps/client/src/components/sessions/__tests__/SessionItem.test.tsx`

**Description:**

After icon class migrations (Task 2.1) and touch target/hover changes (Tasks 3.1, 3.2), existing tests that assert on CSS class names must be updated. Tests that only test behavior (click handlers, rendering text) need no changes.

**Implementation:**

For each test file listed above:

1. Search for assertions on old icon classes: `h-3 w-3`, `h-3.5 w-3.5`, `h-4 w-4`, `h-2.5 w-2.5`
2. Replace with the corresponding new token class:
   - `h-2.5 w-2.5` or `h-3 w-3` -> `size-[--size-icon-xs]`
   - `h-3.5 w-3.5` -> `size-[--size-icon-sm]`
   - `h-4 w-4` -> `size-[--size-icon-md]`
3. Search for assertions on old padding classes that changed (e.g., `p-0.5` -> `p-0.5 max-md:p-2`)
4. Update those assertions if they exist

Run the full test suite:

```bash
turbo test
```

If tests that snapshot rendered output exist, regenerate snapshots:

```bash
npx vitest run --update apps/client/
```

**Acceptance criteria:**
- `turbo test` passes with zero failures
- No test assertions reference old icon class names (`h-3 w-3`, etc.)
- No test assertions reference old padding values that were changed

---

### Task 5.2: Update design system guide with mobile section

**Status:** Not Started
**Blocked by:** Task 3.1 and Task 4.1 (all implementation must be complete)
**Files to modify:**
- `guides/design-system.md`

**Description:**

Add a "Mobile Responsive Scale" section to the design system guide documenting the scale system, icon size convention, and mobile-specific patterns.

**Implementation:**

Add the following section to `guides/design-system.md`:

**Mobile Responsive Scale section content:**

1. Document the `--mobile-scale` CSS custom property and its default value (1.25)
2. Document the three per-category overrides: `--mobile-scale-text`, `--mobile-scale-icon`, `--mobile-scale-interactive`
3. Document the internal multiplier variables: `--_st`, `--_si`, `--_sb`
4. Provide a table of scaled values at 1.25x:

| Element | Desktop | Mobile (x1.25) |
|---------|---------|----------------|
| Body text (`text-sm`) | 14px | 17.5px |
| Small text (`text-xs`) | 12px | 15px |
| Tiny text (`text-2xs`) | 11px | 13.75px |
| Micro text (`text-3xs`) | 10px | 12.5px |
| Large text (`text-base`) | 16px | 20px |
| Icon xs | 12px | 15px |
| Icon sm | 16px | 20px |
| Icon md | 20px | 25px |
| Button sm | 32px | 40px |
| Button md | 36px | 45px |
| Button lg | 40px | 50px |

5. Document the icon size convention:

```
Icon Size Convention:
  icon-xs (12px desktop): Decorative, status indicators, inline affordances
  icon-sm (16px desktop): Interactive icons in compact UI (sidebar, tool cards)
  icon-md (20px desktop): Primary action icons (buttons, navigation, prominent UI)
```

6. Document the Tailwind usage pattern for icons:

```tsx
// Use size-[--size-icon-*] for all icon sizing:
<Check className="size-[--size-icon-xs] text-green-500" />
<FolderOpen className="size-[--size-icon-sm] text-muted-foreground" />
<PanelLeft className="size-[--size-icon-md]" />
```

7. Document hover-only pattern mobile alternatives:

| Pattern | Desktop | Mobile |
|---------|---------|--------|
| Message timestamps | Hidden, shown on hover | Always visible at 40% opacity |
| Session expand chevron | Hidden, shown on hover | Hidden; tap session row to expand |
| Table action icons | Hidden, shown on hover | Always visible at 60% opacity |

8. Document the safe area inset classes: `chat-input-container`, `sidebar-container`, `chat-scroll-area`

9. Document how to adjust the scale:
   - Set `--mobile-scale: 1.0` for no mobile scaling
   - Set `--mobile-scale: 1.5` for 50% larger on mobile
   - Set per-category overrides for independent control

**Acceptance criteria:**
- `guides/design-system.md` contains a "Mobile Responsive Scale" section
- Section documents all CSS custom properties, icon sizes, scaled values, and mobile patterns
- Icon size convention is documented with usage examples

---

## Dependency Graph

```
Task 1.1 (CSS vars + @theme inline) ──┬──> Task 2.1 (Icon migration) ──┬──> Task 3.1 (Touch targets)  ──┬──> Task 5.1 (Tests)
                                       │                                ├──> Task 3.2 (Hover fixes)    ──┤
Task 1.2 (Viewport meta)              │                                └──> Task 3.3 (useLongPress)    │
                                       │                                                                 │
                                       └──> Task 4.1 (Safe areas)     ────────────────────────────────────┼──> Task 5.2 (Docs)
                                                                                                          │
```

**Summary:**
- Phase 1 (Tasks 1.1, 1.2): No dependencies, can start immediately
- Phase 2 (Task 2.1): Blocked by Task 1.1
- Phase 3 (Tasks 3.1, 3.2): Blocked by Task 2.1; Task 3.3 has no dependencies
- Phase 4 (Task 4.1): Blocked by Task 1.1
- Phase 5 (Tasks 5.1, 5.2): Blocked by Phase 3 and Phase 4 completion
