---
slug: settings-tabs-status-bar
number: 20
created: 2026-02-13
status: implemented
---

# Settings Tabs & Status Bar Configuration

**Slug:** settings-tabs-status-bar
**Author:** Claude Code
**Date:** 2026-02-13
**Related:** N/A

---

## 1) Intent & Assumptions

**Task brief:** Restructure the settings dialog to use a tabbed layout (using shadcn/Base UI tab components) and add a new "Status Bar" section where users can toggle each status bar item on or off. The dialog currently has 2 inline sections (Preferences + Server) that will grow as more configuration surfaces are added (context files, system prompts, etc.).

**Assumptions:**

- Tabs are the right organizational pattern for 3-6 sections in a modal dialog (validated in prior UX discussion)
- All 5 current status bar items should be individually toggleable
- Status bar visibility preferences are client-only (localStorage, no server persistence)
- All toggles default to ON (showing everything by default)
- The project uses `@radix-ui/react-*` for headless primitives, wrapped in shadcn-style components

**Out of scope:**

- Sidebar navigation (overkill for current section count)
- New "Context Files" or "System Prompt" tabs (future work, but tabs should accommodate them)
- Rethinking the Server info section's content
- Mobile-specific tab variants (ResponsiveTabs wrapper) — standard horizontal tabs work in both Dialog and Drawer

---

## 2) Pre-reading Log

- `apps/client/src/components/settings/SettingsDialog.tsx`: 294 lines. Two sections: Preferences (7 controls) and Server (read-only config). Uses `ResponsiveDialog`, `SettingRow` helper component, `ConfigRow`/`ConfigBadgeRow` for server info. Fetches server config via TanStack Query.
- `apps/client/src/components/status/StatusLine.tsx`: 61 lines. Renders 5 items (CwdItem, PermissionModeItem, ModelItem, CostItem, ContextItem) separated by dot separators. Some conditional (cwd, cost, context), some always shown (permission, model).
- `apps/client/src/stores/app-store.ts`: 166 lines. Zustand store with localStorage persistence pattern. Each setting has a getter (initialized from localStorage) and setter (persists to localStorage). `resetPreferences()` clears all keys.
- `apps/client/src/components/status/CwdItem.tsx`: Display-only, shows folder icon + last path segment
- `apps/client/src/components/status/PermissionModeItem.tsx`: Interactive dropdown with 4 modes
- `apps/client/src/components/status/ModelItem.tsx`: Interactive dropdown with 3 model options
- `apps/client/src/components/status/CostItem.tsx`: Display-only, shows $X.XX
- `apps/client/src/components/status/ContextItem.tsx`: Display-only with color warnings at 80%/95%
- `apps/client/src/components/ui/`: 12 components installed. NO tabs component exists yet.
- `apps/client/package.json`: Uses `@radix-ui/react-*` packages. `@radix-ui/react-tabs` is in lockfile but not in package.json — needs explicit install. Also has `radix-ui` umbrella package v1.4.3.
- `apps/client/src/components/settings/__tests__/SettingsDialog.test.tsx`: 176 lines, 6 tests covering rendering, preference controls, server config, badges, uptime formatting.
- `guides/design-system.md`: 8pt grid spacing, neutral gray palette, 200ms animations, `text-sm font-semibold` for section headers.

---

## 3) Codebase Map

**Primary Components/Modules:**

- `apps/client/src/components/settings/SettingsDialog.tsx` — Main settings UI (will be restructured with tabs)
- `apps/client/src/components/status/StatusLine.tsx` — Status bar (will read new visibility prefs)
- `apps/client/src/stores/app-store.ts` — Preference state (will add 5 new toggles)

**Shared Dependencies:**

- `apps/client/src/components/ui/switch.tsx` — Toggle control (already used)
- `apps/client/src/components/ui/separator.tsx` — Section dividers (already used)
- `apps/client/src/components/ui/responsive-dialog.tsx` — Dialog/Drawer wrapper
- `apps/client/src/lib/utils.ts` — `cn()` utility

**Data Flow:**
User toggles switch in Settings → Zustand store updates → localStorage persists → StatusLine reads store → item conditionally renders

**Feature Flags/Config:** None needed. Pure client-side preferences.

**Potential Blast Radius:**

- Direct: 3 files (SettingsDialog, StatusLine, app-store)
- New: 1 file (tabs.tsx UI component)
- Tests: 1 file (SettingsDialog.test.tsx)
- Indirect: None — StatusLine consumers don't change

---

## 4) Root Cause Analysis

N/A — This is a feature, not a bug fix.

---

## 5) Research

### Base UI Tabs Component

Base UI provides `Tabs.Root`, `Tabs.List`, `Tabs.Tab`, `Tabs.Panel`, and `Tabs.Indicator`. Key props:

- `defaultValue` / `value` on Root for controlled/uncontrolled
- `activateOnFocus` on List (arrow key behavior)
- `keepMounted` on Panel (preserve DOM when hidden)
- Data attributes: `[data-active]` on active tab

The project already has `@base-ui/react` or can use `@radix-ui/react-tabs` (already in lockfile). Either works — the existing components use Radix primitives.

### Tab Organization Approaches

**Approach 1: Three tabs (Preferences / Status Bar / Server)**

- Pros: Minimal change, clean separation, each tab has distinct purpose
- Cons: Preferences tab stays large (7 items), may need sub-splitting later
- Complexity: Low

**Approach 2: Four tabs (General / Chat / Status Bar / Server)**

- Pros: Better categorization (theme/font in General, tool calls/timestamps in Chat)
- Cons: More tabs upfront, some tabs feel thin (General has only 3 items)
- Complexity: Low-Medium

**Approach 3: Three tabs now, split later**

- Pros: Pragmatic — don't over-organize until there's enough content
- Cons: Will need a second migration when splitting Preferences
- Complexity: Lowest now, adds future work

### UX Best Practices

- **Android Material Design**: Recommends grouping preferences into 2-level max hierarchy, separating app info from settings
- **Salt Design System**: Preferences dialogs should use tabs when 3+ distinct sections exist
- **Reset scope**: Per-tab reset is clearer than global reset (NVIDIA pattern)
- **Tab memory**: Remember last-selected tab across dialog open/close within a session
- **Read-only vs editable**: Server tab should use de-emphasized backgrounds/borders to signal non-interactive nature (already achieved with ConfigRow pattern)

### Recommendation

**Approach 1: Three tabs** — Preferences, Status Bar, Server. Keep it simple now. The Preferences tab with 7 items is not yet unwieldy. When future sections arrive (context files, system prompts), they naturally become new tabs. If Preferences grows past ~12 items, split into General/Chat at that point.

---

## 6) Decisions (Resolved)

| #   | Question              | Decision                                                                                      |
| --- | --------------------- | --------------------------------------------------------------------------------------------- |
| 1   | Tab component library | **Radix UI** (`@radix-ui/react-tabs`) — consistent with all existing UI primitives            |
| 2   | Tab memory            | **React state** — remembers last tab across open/close, resets on page refresh                |
| 3   | Reset scope           | **Preferences tab only** — `resetPreferences()` resets all prefs including status bar toggles |
| 4   | Empty status bar      | **Collapse completely** — status bar area disappears; re-enable via Settings                  |
| 5   | Tab count             | **3 tabs** — Preferences / Status Bar / Server. Split Preferences later when content grows    |
