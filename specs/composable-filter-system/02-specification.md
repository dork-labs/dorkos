---
slug: composable-filter-system
number: 180
created: 2026-03-26
status: specified
---

# Composable Filter System

## Status

Specified

## Authors

Claude Code — 2026-03-26

## Overview

A shared, composable content filtering system for DorkOS. Replaces the bespoke `AgentFilterBar` with a three-layer architecture: a pure filter engine (shared/lib), a URL-synced state hook (shared/model), and compound UI components (shared/ui). Designed to serve the agents list today and scale to task runs, tasks, logs, dead letters, and future list views without per-consumer reimplementation.

The system follows the headless + composable UI pattern: filtering logic is framework-agnostic and independently testable, URL persistence is handled by a single hook, and UI is expressed as compound components that consumers arrange to fit their layout.

**FSD placement note:** The `FilterBar` compound component lives in `shared/ui/filter-bar.tsx`, consistent with existing compound components in `shared/ui` (Command, Sidebar, NavigationLayout). Unlike pure shadcn atoms, `FilterBar` has a richer contract — it expects a typed `filterState` context — but this is the same pattern as `SidebarProvider`/`SidebarMenu` which already live in `shared/ui`. The filter engine (pure logic) stays in `shared/lib`, the URL sync hook stays in `shared/model`.

## Background / Problem Statement

The current agents list has a bespoke `AgentFilterBar` component with three hardcoded filters (text search, status chips, namespace dropdown). This approach has several limitations:

- **Not reusable** — every new list view (task runs, logs, dead letters) would need its own filter implementation
- **No URL persistence** — filter state lives in local `useState`, resets on navigation, can't be shared
- **Limited filter types** — no date range, no multi-select, no sort support
- **Not responsive** — desktop status chips are hidden on mobile in favor of a dropdown, but the two presentations aren't coordinated
- **Tightly coupled** — filter logic, state management, and UI are interleaved in one component

World-class developer tools (Linear, Notion, GitHub) share a common pattern: composable filter systems where filters are defined declaratively, persisted in URLs, and rendered through flexible UI that adapts to context.

## Goals

- Provide a shared filter system usable across any list view in DorkOS
- Support five filter types: text search, enum (single/multi), date range, boolean, numeric range
- Sync all filter state to URL search params via TanStack Router for persistence and shareability
- Allow each consumer to promote one filter to always-visible ("primary slot") while others live behind a `+ Filter` popover
- Render active filters as inline chips on desktop, collapsed badge on mobile
- Include sort as a first-class concept alongside filtering
- Delete `FleetHealthBar` and `AgentFilterBar` — replaced entirely by the new system
- Add filter components to the dev playground for visual testing

## Non-Goals

- Server-side filtering (all filtering is client-side in-memory; DorkOS lists are small)
- Saved/named filter views (Linear's "Custom Views" — can be added later)
- AND/OR filter composition (all filters compose with AND, which covers current needs)
- Column-header sorting for table views (future work when tabular views are built)
- Faceted search with per-value counts in the filter popover
- Async/server-side filtering (the `match` function is synchronous; all filtering is in-memory)

## Architecture

### Layer 1: Filter Engine (`shared/lib/filter-engine.ts`)

Pure TypeScript, no React dependency. Provides filter type factories and a schema system.

#### Filter Types

Five factory functions, each returning a `FilterDefinition<TValue>`:

| Factory                                                              | Value Type                                             | Use Case                                   |
| -------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------ |
| `textFilter({ fields })`                                             | `string`                                               | Substring search across accessor functions |
| `enumFilter({ field, options, multi?, labels?, colors?, dynamic? })` | `string \| string[]`                                   | Single or multi-select from known values   |
| `dateRangeFilter({ field, presets? })`                               | `{ preset?: string, after?: string, before?: string }` | Time-based filtering with preset shortcuts |
| `booleanFilter({ field, label? })`                                   | `boolean \| null`                                      | Tristate toggle (null = no filter)         |
| `numericRangeFilter({ field, label? })`                              | `{ min?: number, max?: number }`                       | Min/max numeric bounds                     |

Each `FilterDefinition` contains:

- `type: string` — discriminant for UI to select the right control
- `defaultValue: TValue` — the "no filter" state
- `serialize(value: TValue): string` — for URL params
- `deserialize(raw: string): TValue` — from URL params
- `match(item: TItem, value: TValue): boolean` — filtering predicate (field access via closured accessors, not string keys)
- `isActive(value: TValue): boolean` — whether the filter differs from default

#### Filter Schema

`createFilterSchema(definitions)` returns a typed `FilterSchema` object:

```ts
// Field access uses accessor functions (not string keys) for type safety
const schema = createFilterSchema<TopologyAgent>({
  search: textFilter({
    fields: [(a) => a.name, (a) => a.description, (a) => a.capabilities.join(' ')],
  }),
  status: enumFilter({
    field: (a) => a.healthStatus,
    options: ['active', 'inactive'],
    multi: true,
  }),
});
```

`createFilterSchema<T>` is generic over the item type. Accessor functions are type-checked: `(a) => a.name` will error if `name` doesn't exist on `T`.

A `FilterSchema` provides:

- `searchValidator: ZodSchema` — Zod schema for filter params only (consumer merges with route schema via `.merge()`)
- `applyFilters(items: T[], values: FilterValues): T[]` — pure filtering function
- `isFiltered(values: FilterValues): boolean` — any non-default filter active?
- `activeCount(values: FilterValues): number` — count of active filters
- `defaultValues: FilterValues` — all filters at defaults
- `describeActive(values: FilterValues): string` — human-readable summary of active filters for empty state copy. Output examples:
  - Single text filter: `"search 'deploy'"`
  - Single enum filter: `"status Active"`
  - Multi-enum: `"status Active, Inactive"`
  - Multiple filters: `"status Active and runtime Claude Code"`
  - Date range preset: `"last seen past 24h"`
  - No active filters: `""` (empty string)

#### Sort Options

`createSortOptions(definitions)` defines available sort fields:

```ts
const sorts = createSortOptions({
  name: { label: 'Name', accessor: (a) => a.name },
  lastSeen: { label: 'Last seen', accessor: (a) => a.lastSeenAt, direction: 'desc' },
});
```

`applySortAndFilter(items, filterValues, sortState)` applies filtering then sorting in a single call.

**Default sort:** When no `sort` param is in the URL, the first sort option is used with its specified `direction` (or `'asc'` if none specified).

### Layer 2: URL Sync Hook (`shared/model/use-filter-state.ts`)

React hook that bridges filter engine ↔ TanStack Router URL state.

```ts
const filterState = useFilterState(schema, options?)
```

**Returns:**

| Property                     | Type              | Description                                                    |
| ---------------------------- | ----------------- | -------------------------------------------------------------- |
| `values`                     | `FilterValues`    | Current committed filter values (used for filtering)           |
| `inputValues`                | `FilterValues`    | Current input values (may differ from `values` when debounced) |
| `sortField`                  | `string`          | Current sort field key                                         |
| `sortDirection`              | `'asc' \| 'desc'` | Current sort direction                                         |
| `isFiltered`                 | `boolean`         | Any non-default filter active?                                 |
| `activeCount`                | `number`          | Number of active filters                                       |
| `set(name, value)`           | `function`        | Set a single filter value                                      |
| `clear(name)`                | `function`        | Reset one filter to default                                    |
| `clearAll()`                 | `function`        | Reset all filters and sort to defaults                         |
| `setSort(field, direction?)` | `function`        | Change sort field/direction                                    |
| `describeActive()`           | `string`          | Human-readable active filter summary                           |

**Options:**

| Option     | Type                     | Default | Description                                                                                         |
| ---------- | ------------------------ | ------- | --------------------------------------------------------------------------------------------------- |
| `debounce` | `Record<string, number>` | `{}`    | Per-filter debounce in ms. When set, `inputValues` updates immediately while `values` is debounced. |

**URL format:** `?q=deploy&status=active,inactive&runtime=claude-code&sort=lastSeen:desc`

- Each filter key maps to a URL param
- Multi-select values are comma-separated
- Sort is encoded as `field:direction`
- Default values are omitted from the URL (clean URLs when no filters active)
- Uses TanStack Router's `useSearch` / `useNavigate` with atomic `search` updater to avoid clobbering sibling params (e.g., `?view=list`)
- `clearAll()` resets only filter/sort params — sibling route params (e.g., `view`) are left untouched

**Invalid URL values:** When a URL contains an invalid value for a filter (e.g., `?status=bogus` for an enum with options `['active', 'inactive']`), `deserialize` falls back to the filter's `defaultValue`. This ensures shared/bookmarked URLs degrade gracefully rather than crashing.

**Schema composition with route search params:** The `searchValidator` returned by `createFilterSchema` is a Zod schema covering only the filter params. The consumer merges it with the existing route schema in `router.tsx`:

```ts
// router.tsx — consumer merges filter schema with route-specific params
const agentsSearchSchema = z
  .object({
    view: z.enum(['list', 'topology']).optional().default('list'),
  })
  .merge(agentFilterSchema.searchValidator);
```

This keeps route-specific params (like `view`) separate from filter params. The `useFilterState` hook reads/writes only its own keys.

### Layer 3: UI Components (`shared/ui/filter-bar.tsx`)

Compound component pattern. `FilterBar` provides context; sub-components render controls.

```tsx
<FilterBar state={filterState}>
  <FilterBar.Search placeholder="Filter agents..." />
  <FilterBar.Primary name="status" />
  <FilterBar.AddFilter dynamicOptions={{ namespace: namespaceOptions }} />
  <FilterBar.Sort options={agentSortOptions} />
  <FilterBar.ResultCount count={filtered.length} total={agents.length} noun="agent" />
  <FilterBar.ActiveFilters />
</FilterBar>
```

**Type safety:** `FilterBar` is generic over the schema keys via inference from `state`. The `name` prop on `FilterBar.Primary` and keys in `FilterBar.AddFilter`'s `dynamicOptions` are constrained to `keyof FilterDefinitions` — typos like `name="statsu"` produce TypeScript errors. The generic is inferred from `state`, not explicitly passed: `<FilterBar state={filterState}>` infers the key union automatically.

#### `<FilterBar>` (container)

- Provides `filterState` via React context
- Renders `flex flex-wrap items-center gap-2 px-4 py-3`

#### `<FilterBar.Search>`

- Search icon + input bound to `filterState.inputValues.search`
- `h-8`, `text-sm`, `sm:max-w-[16rem]`, full-width on mobile
- Respects debounce when configured

#### `<FilterBar.Primary name={string}>`

- Always-visible multi-select dropdown for the named `enumFilter`
- Trigger label: "Status" (no selection), "Status: Active" (single), "Status: 2 selected" (multi)
- Popover: checkbox list with optional color dots (from `enumFilter.colors`)
- Works for any `enumFilter` — not hardcoded to status

#### `<FilterBar.AddFilter>`

- `+ Filter` button with dashed border
- Two-stage popover:
  1. Property picker: lists filters not promoted as primary, not `search`. Shows filter name + type icon. Active filters show checkmark.
  2. Value picker: renders appropriate control per filter type (checkboxes for enum, presets + date inputs for dateRange, toggle for boolean, min/max for numeric)
- Accepts `dynamicOptions` prop for enum filters whose options are not known at schema definition time. When a filter is defined with `enumFilter({ options: [], dynamic: true })`, its options array is empty in the schema. `dynamicOptions` provides the runtime options: `dynamicOptions={{ namespace: namespaceOptions }}`. These replace (not merge with) the schema-level options.
- **Accessibility:** The property picker is a listbox with arrow-key navigation. Selecting a property moves focus to the value picker. Escape goes back one stage before closing the popover entirely. Both stages have `role="listbox"` and `aria-label` attributes.

#### `<FilterBar.Sort>`

- Dropdown trigger: "Sort: Name ↑" / "Sort: Last seen ↓"
- Click arrow toggles direction
- Dropdown menu lists sort options

#### `<FilterBar.ResultCount>`

- Takes `count` (filtered), `total` (unfiltered), and `noun` props
- No filters (`count === total`): "{count} {noun}s" in muted text
- Filtered (`count < total`): "{count} of {total} {noun}s" with "Clear all" link
- Auto-pluralizes noun
- Pushed right via `ml-auto`

#### `<FilterBar.ActiveFilters>`

- **Desktop (sm+):** Inline removable chips. Each chip: `{label}: {value} ×`. Rendered after other controls in the flex row.
- **Mobile (<sm):** Badge button showing active count with accent border. Tapping opens a sheet listing active filters with remove buttons.
- Only renders when `filterState.isFiltered` is true

#### Visual Specifications

| Element         | Style                                                       |
| --------------- | ----------------------------------------------------------- |
| Search input    | `h-8 text-sm border-input rounded-md`                       |
| Primary trigger | `h-7 px-2.5 text-xs border rounded-md`                      |
| + Filter button | `h-7 px-2.5 text-xs border-dashed border-muted rounded-md`  |
| Sort trigger    | `h-7 px-2.5 text-xs border rounded-md`                      |
| Active chip     | `h-6 px-2 text-xs rounded-full border-muted bg-muted/50`    |
| Result count    | `text-xs text-muted-foreground`                             |
| Mobile badge    | `h-7 px-2 border rounded-md` with accent border when active |

## Consumer Integration: Agents List

### New Files

- `features/agents-list/lib/agent-filter-schema.ts` — schema and sort definitions

### Modified Files

- `features/agents-list/ui/AgentsList.tsx` — replace `useState<FilterState>` with `useFilterState`, replace `AgentFilterBar` with `FilterBar` compound components, remove `FleetHealthBar` usage
- `features/agents-list/ui/AgentEmptyFilterState.tsx` — use `filterState.describeActive()` for explicit filter naming in empty state copy
- `features/agents-list/index.ts` — update exports
- `widgets/agents/ui/AgentsPage.tsx` — no changes needed (topology data still passed as props)
- `router.tsx` — merge `agentFilterSchema.searchValidator` into existing `agentsSearchSchema` via `.merge()`

### Deleted Files

- `features/agents-list/ui/AgentFilterBar.tsx` — replaced entirely
- `features/agents-list/ui/FleetHealthBar.tsx` — removed per design decision. The at-a-glance health visualization is intentionally simplified ("less, but better"). The `FilterBar.Primary` for status shows color dots from `enumFilter.colors` alongside each option in the dropdown, preserving color-coded status awareness without a dedicated visualization component.

### Dev Playground

A new playground panel renders `FilterBar` with mock data, allowing:

- Toggle between schemas (agents, mock logs, mock tasks) to see different filter configurations
- Exercise all filter types
- Test responsive behavior at different widths

## Empty & Filtered States

### True Empty (no data)

Filter bar does not render. Existing empty states (e.g., `DiscoveryView` for agents) handle this case. No changes.

### Filtered Empty (filters match nothing)

- Filter bar remains visible
- `AgentEmptyFilterState` (and future equivalents) shows: "No agents match {filterState.describeActive()}"
- Primary action: "Clear all filters" button
- If only one filter is active, the message is more specific: "No agents with status Active"

### Result Count

- No filters: "12 agents"
- Filtered: "4 of 12 agents" + "Clear all" link

## Testing Strategy

### Engine Tests (`shared/lib/__tests__/filter-engine.test.ts`)

Pure function tests — no React, no DOM:

- Each filter type: match logic, serialize/deserialize round-trips, isActive detection
- `applyFilters`: single filter, multiple filters composed, no filters, empty items
- `describeActive`: human-readable output for various filter combinations
- Edge cases: empty options, undefined fields, null values

### Hook Tests (`shared/model/__tests__/use-filter-state.test.ts`)

`renderHook` with mock TanStack Router context:

- Reads initial state from URL search params
- Updates URL when filter changes via `set()`
- `clearAll()` resets URL and state
- Debounce: `inputValues` updates immediately, `values` delayed
- Atomic URL updates don't clobber sibling params

### Component Tests (`shared/ui/__tests__/FilterBar.test.tsx`)

React Testing Library:

- Search input renders and binds to filter state
- Primary dropdown opens with options, selecting updates state
- AddFilter popover shows available filters, excludes primary and search
- ActiveFilters renders chips on desktop (mock matchMedia for `sm`)
- ActiveFilters renders badge on mobile
- Chip removal clears that filter
- ResultCount shows correct format for filtered vs unfiltered

### Consumer Tests (`features/agents-list/__tests__/agent-filter-schema.test.ts`)

- Schema correctly filters agents by status, text search, runtime
- Sort options produce correct ordering
- Composed filters (status + search) narrow correctly

## Migration Path

1. Build the shared filter system (engine → hook → UI)
2. Add dev playground panel
3. Migrate agents list: swap `AgentFilterBar` → `FilterBar`, delete `FleetHealthBar`
4. Delete `AgentFilterBar.tsx` and `FleetHealthBar.tsx`
5. Update agents route with `validateSearch`

Future consumers (task runs, logs, dead letters) define their own schema in their feature's `lib/` directory and wire up `FilterBar` — no changes to the shared system needed.

## Dependencies

- TanStack Router (already in use) — `validateSearch`, `useSearch`, `useNavigate`
- Radix Popover (already in use via `shared/ui/popover`) — for AddFilter and Primary dropdowns
- Radix Command (already in use via `shared/ui/command`) — for searchable option lists in AddFilter

No new dependencies required.
