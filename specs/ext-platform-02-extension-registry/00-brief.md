---
slug: ext-platform-02-extension-registry
number: 182
created: 2026-03-26
status: brief
project: extensibility-platform
phase: 2
---

# Phase 2: Extension Point Registry

**Project:** Extensibility Platform
**Phase:** 2 of 4
**Depends on:** Nothing (can be built in parallel with Phase 1)
**Enables:** Phase 3 (extensions register into the proven registry), Phase 4 (agent-built extensions target registry slots)

---

## Scope

Create the extensibility infrastructure that both built-in features and future extensions register into. This phase extracts the implicit extension patterns that already exist in the codebase — hardcoded arrays in the command palette, dialog lists in DialogHost, sidebar footer buttons — and replaces them with a queryable registry. Built-in features register into the registry at startup; the registry API is the same one extensions will use in Phase 3.

This is a pure refactor of existing code. No user-visible behavior changes. The registry proves the pattern works with zero risk before extensions add complexity.

## Deliverables

### 1. Extension Point Registry Store

**Problem:** Extension points are implicit — hardcoded arrays and static component lists. There's no dynamic way to add contributions to these surfaces.

**Solution:**

- Create `layers/shared/model/extension-registry.ts` — a Zustand store mapping slot IDs to registered component/item arrays
- Define canonical slot IDs matching the UI surfaces that accept contributions
- Each registration returns an unsubscribe function for cleanup (learned from Obsidian's `register*()` pattern)
- The store is typed: each slot ID has a specific contribution interface

**Slot IDs (v1):**

| Slot ID                 | Location                     | Contribution Type          |
| ----------------------- | ---------------------------- | -------------------------- |
| `sidebar.footer`        | `SidebarFooterBar`           | Icon buttons               |
| `sidebar.tabs`          | `SessionSidebar`             | Tab panels                 |
| `dashboard.sections`    | `DashboardPage`              | Dashboard cards/widgets    |
| `header.actions`        | Header components            | Action buttons             |
| `command-palette.items` | `use-palette-items.ts`       | Commands and quick actions |
| `dialog`                | `DialogHost`                 | Modal panels               |
| `settings.tabs`         | `SettingsDialog`             | Settings sections          |
| `session.canvas`        | `AgentCanvas` (from Phase 1) | Canvas content renderers   |

**Key source files:**

- `apps/client/src/layers/shared/model/app-store.ts` — Existing Zustand store pattern to follow

### 2. Slot Query Components/Hooks

**Problem:** Once contributions are in the registry, existing components need a way to query and render them.

**Solution:**

- Create `useSlotContributions(slotId)` hook — returns sorted array of contributions for a given slot
- Each slot component queries contributions and renders them alongside built-in content
- Priority ordering: contributions have an optional `priority` field for sort order

### 3. Built-in Feature Migration

**Problem:** Existing features use hardcoded arrays and static imports. These need to register dynamically to prove the pattern.

**Solution:** Migrate existing hardcoded UI registrations to use the registry:

| Current Pattern                             | Migration                                      |
| ------------------------------------------- | ---------------------------------------------- |
| `FEATURES[]` in `use-palette-items.ts`      | Register at app init → query from registry     |
| `QUICK_ACTIONS[]` in `use-palette-items.ts` | Register at app init → query from registry     |
| Dialog components in `DialogHost.tsx`       | Query from registry alongside built-in dialogs |
| Footer buttons in `SidebarFooterBar.tsx`    | Query from registry alongside built-in buttons |

Each migration preserves exact existing behavior — the registry just becomes the intermediary.

**Key source files:**

- `apps/client/src/layers/features/command-palette/model/use-palette-items.ts` — `FEATURES[]` and `QUICK_ACTIONS[]` static arrays
- `apps/client/src/layers/widgets/app-layout/ui/DialogHost.tsx` — 6 dialogs rendered statically
- `apps/client/src/layers/features/session-list/ui/SidebarFooterBar.tsx` — Footer icon buttons
- `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx` — Tab system with `visibleTabs` memo
- `apps/client/src/layers/widgets/dashboard/ui/DashboardPage.tsx` — Dashboard sections in priority order

## Key Decisions (Settled)

1. **Registry is a Zustand store** — Consistent with existing state management patterns. Reactive (components re-render when contributions change). Accessible outside React via `getState()`.
2. **Slot IDs are string constants, not enums** — Allows extensions (Phase 3) to use them without importing internal types. Type safety via a mapping type.
3. **Auto-cleanup via unsubscribe** — Every `register()` call returns an `() => void` cleanup function. The extension lifecycle (Phase 3) collects these for automatic deactivation cleanup.
4. **Built-in features register first** — They register during app initialization, before any extensions. This ensures built-in features always appear even if the extension system fails.
5. **Priority ordering** — Lower number = higher priority. Built-in features use priorities 0-99. Extensions use 100+. This ensures built-in features appear first by default.

## Open Questions (For /ideate)

1. **Registry API shape** — `registry.register(slotId, contribution)` vs `registry.registerComponent(slotId, component, meta)` vs separate methods per contribution type?
2. **How do typed slots work?** — Each slot accepts a specific contribution shape (e.g., `sidebar.footer` wants `{ icon, label, onClick }`, `dashboard.sections` wants `{ component, title, priority }`). How is this typed without making the registry overly complex?
3. **Empty state handling** — When a slot has zero contributions (e.g., all built-in features unregistered), what renders? Each slot component handles its own empty state, or does the registry provide a fallback mechanism?
4. **FSD layer placement** — The registry store lives in `shared/model/`. The `useSlotContributions` hook lives in `shared/model/`. But the migration of `DialogHost`, `SidebarFooterBar`, etc. crosses FSD boundaries. Is this a concern? (Probably not — each component queries the shared registry, maintaining the unidirectional dependency.)
5. **Should `session.canvas` (from Phase 1) be pre-registered?** — Or does the canvas only accept content via the `ui_command` in Phase 1, and the registry integration comes in Phase 3?
6. **Testing strategy** — Unit tests for the registry store (register, query, unregister, priority ordering). Integration tests for migrated components (same behavior, now via registry). What's the right balance?

## Reference Material

### Existing ideation docs

- `specs/plugin-extension-system/01-ideation.md` (spec #173) — Extension points table, architectural patterns, slot ID proposals

### Research

- `research/20260323_plugin_extension_ui_architecture_patterns.md` — VSCode contribution points, Obsidian register/cleanup, Backstage extension factories, Grafana panel props

### Architecture docs

- `contributing/architecture.md` — Hexagonal architecture
- `contributing/state-management.md` — Zustand patterns
- `contributing/project-structure.md` — FSD layer rules

## Acceptance Criteria

- [ ] `extension-registry.ts` exists in `layers/shared/model/` as a Zustand store
- [ ] All 8 slot IDs are defined with typed contribution interfaces
- [ ] `useSlotContributions(slotId)` hook returns sorted contributions for any slot
- [ ] `register()` returns an unsubscribe function; calling it removes the contribution
- [ ] Priority ordering works: lower number appears first
- [ ] `FEATURES[]` in `use-palette-items.ts` is registered via the registry — existing palette tests pass unchanged
- [ ] `QUICK_ACTIONS[]` in `use-palette-items.ts` is registered via the registry — existing palette tests pass unchanged
- [ ] `DialogHost` queries the registry for additional dialogs (built-in dialogs still render as before)
- [ ] `SidebarFooterBar` queries the registry for additional buttons (built-in buttons still render as before)
- [ ] No user-visible behavior change — this is a pure refactor
- [ ] Registry is exported from `@/layers/shared/model` barrel
- [ ] Unit tests for registry store: register, query, unregister, priority ordering, duplicate ID handling
