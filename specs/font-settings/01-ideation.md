---
slug: font-settings
number: 23
created: 2026-02-13
status: implemented
---

# Font Selection Settings

**Slug:** font-settings
**Author:** Claude Code
**Date:** 2026-02-13
**Branch:** preflight/font-settings
**Related:** N/A

---

## 1) Intent & Assumptions

- **Task brief:** Add a setting to change the font used in the app. The selected font should be saved to localStorage. Font options should include curated Google Fonts pairings (sans + mono). The audience is both hardcore devs and casual users.
- **Assumptions:**
  - Each font "choice" is a pairing: one sans-serif for UI text + one monospace for code
  - Fonts load from Google Fonts CDN (with preconnect + display=swap)
  - Only the _selected_ font pairing is loaded (not all fonts at once)
  - System fonts remain the default (no external load until user changes)
  - Font preference persists in localStorage, same pattern as other settings
  - Geist is now available on Google Fonts (confirmed 2026)
- **Out of scope:**
  - Per-element font customization (e.g., different font for sidebar vs chat)
  - Custom font upload or arbitrary font URL input
  - Font size settings (separate concern)
  - Font weight customization

## 2) Pre-reading Log

- `apps/client/src/index.css`: CSS variables and Tailwind v4 config. Current font stacks are system fonts: `--font-sans: system-ui, -apple-system, ...` and `--font-mono: ui-monospace, 'SF Mono', ...`. These are defined in `@theme` block.
- `apps/client/index.html`: Standard Vite HTML entry. No Google Fonts link tags currently. This is where preconnect and font stylesheet links will go.
- `apps/client/src/stores/app-store.ts`: Zustand store with localStorage persistence. Existing pattern: `showStatusBarCwd: boolean` persisted as `gateway-show-status-bar-cwd`. Has `resetPreferences()` that resets all persisted values.
- `apps/client/src/components/settings/SettingsDialog.tsx`: Tabbed settings dialog with "General", "Status Bar" tabs. Uses shadcn Switch components for toggles. This is where the font selector UI will live.
- `apps/client/src/stores/__tests__/app-store.test.ts`: Tests use `vi.resetModules()` + dynamic import pattern.
- `guides/design-system.md`: Documents current typography — system fonts, 4 sizes (xs/sm/base/lg), 3 weights (400/500/600). States "System fonts. They load instantly, render crisply, and feel native to the platform."

## 3) Codebase Map

**Primary components/modules:**

- `apps/client/src/stores/app-store.ts` — Zustand store; will add `fontFamily` state + setter
- `apps/client/src/components/settings/SettingsDialog.tsx` — Settings UI; will add font selector
- `apps/client/index.html` — Will add Google Fonts preconnect; dynamic font link injection
- `apps/client/src/index.css` — CSS variables `--font-sans` and `--font-mono`; will need dynamic override

**Shared dependencies:**

- `apps/client/src/components/ui/select.tsx` — shadcn Select component (for font picker dropdown)
- `apps/client/src/components/ui/label.tsx` — shadcn Label
- Tailwind v4 `@theme` block in `index.css` — defines font CSS variables

**Data flow:**
User selects font in Settings → Zustand store updates → localStorage persists → CSS variables updated on `<html>` element → Google Fonts stylesheet dynamically loaded/swapped → All text re-renders with new font

**Feature flags/config:** None

**Potential blast radius:**

- Direct: 4 files (store, settings, index.html, index.css)
- New: 1 file (font loader utility or hook)
- Tests: store test, settings test
- All rendered text in the app changes (but that's the point)

## 4) Root Cause Analysis

N/A — This is a feature, not a bug fix.

## 5) Research

### Font Pairings (Sans + Mono)

All confirmed available on Google Fonts:

| #   | Sans-Serif         | Monospace       | Character                        | Audience Fit                  |
| --- | ------------------ | --------------- | -------------------------------- | ----------------------------- |
| 1   | **System Default** | System Default  | Native platform fonts            | Universal — zero load cost    |
| 2   | **Geist**          | Geist Mono      | Modern, Vercel/startup aesthetic | Devs who follow trends        |
| 3   | **Inter**          | JetBrains Mono  | Professional SaaS, most popular  | Power users + casual alike    |
| 4   | **IBM Plex Sans**  | IBM Plex Mono   | Enterprise, warm, polished       | Professional/corporate        |
| 5   | **Roboto**         | Roboto Mono     | Familiar, Google/Android         | Casual users, familiarity     |
| 6   | **Source Sans 3**  | Source Code Pro | Adobe, open-source, technical    | Developers, OSS community     |
| 7   | **Fira Sans**      | Fira Code       | Mozilla, code ligatures          | Developers who love ligatures |
| 8   | **Space Grotesk**  | Space Mono      | Creative, indie, distinctive     | Designers, creative devs      |

### Font Variants to Load

Per pairing, load only:

- **Regular (400)** — body text
- **Medium (500)** — buttons, labels
- **Semibold (600)** — headings

For mono: Regular (400) only (code doesn't need weight variety beyond what's already styled).

Prefer **variable fonts** when available (Inter, Geist, Fira Code) — single file replaces multiple weights.

### Implementation Approach

**Recommended: Dynamic Google Fonts link injection**

1. Add static preconnect hints in `index.html`
2. On app load, read font preference from localStorage
3. Dynamically create/update a `<link>` element for the selected Google Fonts stylesheet
4. Update CSS custom properties `--font-sans` and `--font-mono` on `document.documentElement`
5. System Default = remove the link element, revert to system font stack

**Why not load all fonts upfront?** 8 pairings × 2 families × 3 weights = massive page weight. Only load the selected pairing.

**Performance strategy:**

- `<link rel="preconnect" href="https://fonts.googleapis.com">` (static in HTML)
- `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>` (static in HTML)
- Dynamic `<link>` with `&display=swap` parameter
- Fallback to system fonts during load (FOUT is acceptable, FOIT is not)

### Potential Solutions

**1. Dynamic `<link>` injection + CSS variable override (Recommended)**

- Description: On font change, inject/update a Google Fonts `<link>` tag and set CSS vars
- Pros: Simple, no build-time dependency, minimal code, lazy-loads only selected font
- Cons: Brief FOUT on first load of a new font; depends on Google Fonts CDN availability
- Complexity: Low
- Maintenance: Low

**2. Fontsource npm packages (self-hosted)**

- Description: Install `@fontsource/inter`, `@fontsource/geist`, etc. as npm dependencies
- Pros: Self-hosted (faster per benchmarks), no CDN dependency, works offline
- Cons: Adds 8+ npm packages, increases bundle size even for unused fonts (unless tree-shaken), more complex build
- Complexity: Medium
- Maintenance: Medium (version updates)

**3. CSS `@import` with font-face (hybrid)**

- Description: Ship font files in `public/` directory, use `@font-face` declarations
- Pros: Full control, works offline, no CDN
- Cons: Large asset footprint in repo, manual font file management, complex CSS
- Complexity: High
- Maintenance: High

**Recommendation:** Option 1 (Dynamic link injection). It's the simplest, keeps the bundle small, and Google Fonts CDN is fast and reliable. The FOUT trade-off is acceptable with `display=swap`.

## 6) Clarification

1. **Font count — should we include all 8 pairings or trim to 5-6?**
   - 8 options gives variety but could feel overwhelming in a dropdown
   - 5-6 is a more curated experience
   - Recommendation: Include all 8 (System + 7 Google Fonts pairings). A dropdown with 8 items is not overwhelming, and each fills a distinct niche.

2. **Should changing the font show a live preview in the settings dialog?**
   - Option A: Apply font immediately on selection (settings dialog text changes too)
   - Option B: Show a preview sample string but don't apply until "confirmed"
   - Recommendation: Option A — apply immediately. There's no "save" button pattern; other settings (like toggles) apply instantly. Consistent with existing UX.

3. **Should the font setting have its own Settings tab, or go under "General"?**
   - Option A: New "Appearance" tab (future home for font size, theme, etc.)
   - Option B: Under existing "General" tab
   - Recommendation: Option A — "Appearance" tab. It's future-proof and the General tab shouldn't get cluttered.

4. **Should we show font preview text in the dropdown (each option rendered in its font)?**
   - This would require pre-loading all fonts, defeating the lazy-load strategy
   - Option A: Yes — pre-load all fonts, show preview (heavy)
   - Option B: No — show font names in system font, apply on selection (lightweight)
   - Option C: Show a small preview image/SVG for each font (medium)
   - Recommendation: Option B for v1. Keep it lightweight. Users can try fonts and switch.
