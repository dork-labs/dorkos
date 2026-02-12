# Mobile Responsive Scale System

**Slug:** mobile-responsive-scale-system
**Author:** Claude Code
**Date:** 2026-02-11
**Related:** N/A

---

## 1) Intent & Assumptions

- **Task brief:** Implement a CSS custom property scale multiplier system that makes buttons, text, icons, and interactive elements proportionally larger on mobile. Includes fixing critical mobile issues: safe areas, viewport, overscroll, hover-only controls, input zoom. The system provides a centralized "dial" (`--mobile-scale`) that controls how much bigger UI elements are on mobile relative to desktop, with optional per-category overrides for text, icons, and interactive elements.
- **Assumptions:**
  - Desktop is the source of truth; mobile sizes are derived via multiplication
  - Tailwind CSS v4 with `@theme inline` supports `calc()` referencing external `var()` (confirmed by research)
  - Shadcn/UI components using standard Tailwind utilities (`text-sm`, `h-10`) will automatically inherit scaled values
  - The existing `useIsMobile` hook (768px breakpoint) aligns with the CSS media query breakpoint
  - Lucide React icons (SVG) handle fractional pixel sizes without rendering issues
- **Out of scope:**
  - Server-side changes
  - Obsidian plugin changes
  - New component library or design system overhaul
  - PWA features (service workers, offline support, push notifications)
  - Bottom navigation pattern (current sidebar pattern is sufficient for our chat app)

---

## 2) Pre-reading Log

- `apps/client/src/index.css`: Main CSS file. Has `@theme inline` block with custom text sizes (`--text-2xs`, `--text-3xs`), HSL color tokens, Streamdown styles, hover-only table action icons. No mobile-specific CSS. No safe areas, overscroll, or viewport units.
- `apps/client/index.html`: Viewport meta tag is `width=device-width, initial-scale=1.0` — missing `viewport-fit=cover`.
- `guides/design-system.md`: Documents 8pt grid spacing, typography scale, color palette, motion specs. No mobile-specific guidance.
- `apps/client/src/hooks/use-is-mobile.ts`: `MOBILE_BREAKPOINT = 768`, uses `matchMedia` to detect mobile.
- `apps/client/src/components/ui/responsive-dialog.tsx`: Existing pattern — switches Dialog (desktop) to Drawer (mobile) using `useIsMobile`.
- `apps/client/src/App.tsx`: Handles mobile sidebar as overlay (fixed + backdrop), desktop as push layout. Uses `useIsMobile` for layout switching.

---

## 3) Codebase Map

### Primary Components Requiring Changes

| File | Role | Issues |
|------|------|--------|
| `apps/client/src/index.css` | Theme definitions, global CSS | Add scale system, safe areas, overscroll |
| `apps/client/index.html` | Viewport meta | Add `viewport-fit=cover` |
| `apps/client/src/App.tsx` | Root layout, sidebar | Fixed positioning + keyboard, sidebar width on small phones |
| `apps/client/src/components/chat/ChatInput.tsx` | Message input | `text-sm` textarea (iOS zoom), small send/stop buttons |
| `apps/client/src/components/chat/MessageItem.tsx` | Message display | Hover-only timestamp, `text-[10px]` bullet |
| `apps/client/src/components/chat/ToolCallCard.tsx` | Tool cards | `h-3 w-3` icons, `text-3xs` labels |
| `apps/client/src/components/chat/TaskListPanel.tsx` | Task list | `h-3 w-3` status icons |
| `apps/client/src/components/chat/ToolApproval.tsx` | Tool approval | `h-3 w-3` icons, small buttons |
| `apps/client/src/components/chat/QuestionPrompt.tsx` | Interactive questions | `text-sm` input (iOS zoom), small options |
| `apps/client/src/components/chat/MessageList.tsx` | Message scroll | Scroll-to-bottom button may be covered by keyboard |
| `apps/client/src/components/sessions/SessionSidebar.tsx` | Session list | `h-3.5 w-3.5` icons, `p-1` footer buttons (tiny touch targets) |
| `apps/client/src/components/sessions/SessionItem.tsx` | Session entry | `p-0.5` copy/expand buttons, hover-only expand chevron, `text-[11px]` |
| `apps/client/src/components/sessions/DirectoryPicker.tsx` | Directory picker | `h-3.5 w-3.5` icons, `p-1` toggle buttons, `text-[11px]` |
| `apps/client/src/components/status/*.tsx` | Status line items | `h-3 w-3` icons, `text-xs` labels, `text-[10px]` descriptions |
| `apps/client/src/components/commands/CommandPalette.tsx` | Command palette | `text-xs`/`text-sm` labels |
| `apps/client/src/components/ui/dialog.tsx` | Modal dialog | Fixed positioning needs safe-area |
| `apps/client/src/components/ui/drawer.tsx` | Mobile drawer | Fixed positioning needs safe-area |

### Icon Size Inventory

| Size | Tailwind Class | Pixel Value | Instance Count | Where Used |
|------|---------------|-------------|----------------|------------|
| 10px | `h-2.5 w-2.5` | 0.625rem | 1 | PathBreadcrumb (sm variant) |
| 12px | `h-3 w-3` | 0.75rem | ~25 | ToolCallCard, TaskListPanel, Status items, ToolApproval, SessionItem, DropdownMenu |
| 14px | `h-3.5 w-3.5` | 0.875rem | ~15 | ChatInput, SessionSidebar, DirectoryPicker, QuestionPrompt, DropdownMenu |
| 16px | `h-4 w-4` | 1rem | ~15 | App sidebar toggle, Dialog close, MessageItem, ToolApproval, MessageList, DirectoryPicker |

### Font Size Inventory

| Size | Tailwind Class | Pixel Value | Instance Count | Critical Issues |
|------|---------------|-------------|----------------|-----------------|
| 10px | `text-[10px]` / `text-3xs` | 0.625rem | 3 | Below minimum readable size |
| 11px | `text-[11px]` / `text-2xs` | 0.6875rem | 3 | Below minimum readable size |
| 12px | `text-xs` | 0.75rem | 33+ | Common for metadata, timestamps |
| 14px | `text-sm` | 0.875rem | 15+ | **Triggers iOS input zoom** when used on `<textarea>`/`<input>` |
| 16px | `text-base` | 1rem | ~5 | Body text |

### Touch Target Inventory (Below 44px)

| Element | Padding | Icon Size | Total Size | File:Line |
|---------|---------|-----------|------------|-----------|
| Copy button | `p-0.5` (2px) | 12px | ~16px | SessionItem:46 |
| Expand chevron | `p-0.5` (2px) | 12px | ~16px | SessionItem:105 |
| Status buttons (Route, Heart, Theme) | `p-1` (4px) | 14px | ~22px | SessionSidebar:154,167,179 |
| Hidden files toggle | `p-1` (4px) | 14px | ~22px | DirectoryPicker:141 |
| View toggle buttons | `p-1.5` (6px) | 14px | ~26px | DirectoryPicker:88 |
| Send/Stop buttons | `p-1.5` (6px) | 14px | ~26px | ChatInput:139,154 |
| Sidebar toggle | `p-1.5` (6px) | 16px | ~28px | App:82,124 |
| Close sidebar | `p-2` (8px) | 16px | ~32px | SessionSidebar:90 |
| Scroll-to-bottom | `p-2` (8px) | 16px | ~32px | MessageList:162 |

### Hover-Only Patterns (Invisible on Touch)

| Element | Pattern | File:Line |
|---------|---------|-----------|
| Message timestamp | `text-muted-foreground/0` → `group-hover:text-muted-foreground/60` | MessageItem:62 |
| Session expand chevron | `opacity-0 group-hover:opacity-100` | SessionItem:108 |
| Table action icons | CSS `opacity: 0` → `:hover opacity: 1` | index.css:173-175 |

### Missing Mobile CSS

- No `env(safe-area-inset-*)` anywhere
- No `overscroll-behavior` anywhere
- No `dvh`/`svh`/`lvh` viewport units
- No `-webkit-overflow-scrolling: touch`
- No `touch-action: manipulation`
- Viewport meta missing `viewport-fit=cover`

---

## 4) Root Cause Analysis

N/A (feature, not bug fix)

---

## 5) Research

### Critical Technical Finding: `@theme inline` Required

The research confirmed that Tailwind v4's `@theme` directive does NOT properly resolve `calc()` expressions referencing external CSS variables. The `@theme inline` directive must be used instead. The difference:

- **`@theme`**: Outputs `var(--font-size-sm)` — the variable is resolved where it's defined (`:root`), not where it's used. External `var()` references may fail.
- **`@theme inline`**: Outputs `calc(0.875rem * var(--_st))` directly into the utility class — the variable resolves at runtime in the DOM context. Works correctly.

Both `@theme` and `@theme inline` can be mixed in the same CSS file. Use `@theme` for static tokens (colors, radii), `@theme inline` for computed/dynamic tokens.

### Potential Solutions

**1. CSS Scale Multiplier System (Recommended)**
- Description: Define `--mobile-scale` master dial + optional per-category overrides. Desktop = baseline, mobile sizes = desktop * multiplier. Use `@theme inline` to wire into Tailwind utilities.
- Pros:
  - Single dial scales everything proportionally
  - Per-category fine-tuning (text, icons, interactive)
  - Zero JS runtime cost (pure CSS)
  - Desktop sizes are source of truth, mobile is derived
  - Shadcn/UI components automatically inherit scaled values
  - Easy to adjust — change one number, test, iterate
- Cons:
  - Requires `@theme inline` (Tailwind v4 specific)
  - Overrides ALL instances of utilities like `text-sm` (may scale things you don't want scaled)
  - Subpixel rendering possible (mitigated by browser GPU rendering)
  - New pattern for team to learn
- Complexity: Medium
- Maintenance: Low

**2. Per-Component Responsive Classes (`md:text-lg`)**
- Description: Add responsive Tailwind prefixes to every element that needs mobile scaling.
- Pros: Explicit, visible in markup, no abstractions
- Cons: Touches every component file, very verbose, no centralized control, high maintenance, inconsistency risk
- Complexity: Low per-element, High at scale
- Maintenance: High

**3. rem-based Root Font Scaling**
- Description: Change `html { font-size }` at mobile breakpoint to scale all rem values.
- Pros: Extremely simple (one line), scales all rem values
- Cons: No per-category control, doesn't affect `px` values, too blunt, affects browser accessibility settings
- Complexity: Very Low
- Maintenance: Very Low

### Browser Support Verification

| Feature | Support | Notes |
|---------|---------|-------|
| `var()` fallback chains | 99%+ (since 2017) | Universal |
| `calc()` in CSS | 99%+ | Negligible performance cost |
| CSS `round()` | 95%+ (Baseline 2024) | Available if pixel snapping needed |
| `@theme inline` | Tailwind v4+ | Framework-specific |
| `env(safe-area-inset-*)` | 96%+ | Required for notched devices |
| `dvh`/`svh` viewport units | 96%+ (Baseline 2023) | iOS Safari fix |
| `overscroll-behavior` | 96%+ | Prevents accidental pull-to-refresh |
| `touch-action: manipulation` | 99%+ | Prevents double-tap zoom |

### Apple HIG & Material Design Alignment

| Metric | Apple HIG | Material Design | Our Target |
|--------|-----------|-----------------|------------|
| Min touch target | 44x44 pt | 48x48 dp | 44px (meets both when scaled) |
| Body text | 17pt (23px) | 16px | 16px desktop, 20px mobile (×1.25) |
| Min text size | 11pt (15px) | 11px | 12px desktop minimum |
| Input font | 16px+ | 16sp | `max(1rem, text-sm)` — always 16px+ |
| Icon standard | SF Symbols (point-based) | 18/24/36/48dp | 16/20/24px desktop (×1.25 mobile) |
| Spacing grid | 8pt multiples | 8dp multiples | 8px grid (existing) |
| Target spacing | — | 8dp between targets | 8px gap minimum |

### Recommendation

**Recommended approach:** CSS Scale Multiplier System (#1) with these implementation details:
- Use `@theme inline` for all computed tokens
- Start with `--mobile-scale: 1.25` as the master dial
- Don't use per-category overrides initially — test with uniform scale first
- Fix critical mobile issues (safe areas, viewport, overscroll) as part of the same implementation
- Standardize icons to 3 sizes: 16px (xs), 20px (sm), 24px (md) on desktop
- Replace hover-only patterns with always-visible on mobile using `md:opacity-0 md:group-hover:opacity-100`

---

## 6) Clarification

1. **Scale factor value:** The recommendation is `--mobile-scale: 1.25` (25% bigger on mobile). Would you prefer a different starting value? The system makes it trivial to change later.

2. **Icon standardization strictness:** Currently 4 icon sizes (12/14/16px + conditional 10px). Standardizing to 3 sizes (16/20/24px) would require changing ~55 icon instances. Should we:
   - (a) Standardize all icons to 3 sizes as part of this work
   - (b) Only standardize icons that are part of touch targets, leave decorative icons as-is
   - (c) Skip icon standardization and just let the scale multiplier make existing sizes bigger

3. **Spacing scale override scope:** The scale multiplier can optionally scale Tailwind's spacing utilities (`p-2`, `gap-3`, etc.) in addition to font sizes and explicit sizes. This would make padding and gaps proportionally bigger on mobile. Should we:
   - (a) Only scale font sizes, icon sizes, and explicit button heights (conservative)
   - (b) Also scale the spacing scale for padding/margins/gaps (comprehensive, more visual change)

4. **Custom font sizes (`text-3xs`, `text-2xs`, `text-[10px]`, `text-[11px]`):** These are below the minimum readable size on mobile. Should we:
   - (a) Eliminate them entirely — replace with `text-xs` (12px) minimum
   - (b) Keep them but wire them through the scale system so they grow on mobile
   - (c) Keep them as-is (decorative/non-critical text only)

5. **Hover-only patterns:** Should we make hover-only elements (timestamps, expand buttons, table actions) always visible on mobile, or use a tap-to-reveal pattern instead?
