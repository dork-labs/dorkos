# Composable Filter System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a shared, composable content filtering system that replaces the bespoke AgentFilterBar with a three-layer architecture (engine + URL hook + compound UI) usable across any list view.

**Architecture:** Pure filter engine in `shared/lib` (no React), URL-synced state hook in `shared/model` (TanStack Router), compound UI components in `shared/ui` (FilterBar.\*). Consumers define schemas in their feature's `lib/` and compose UI via compound components.

**Tech Stack:** React 19, TypeScript, TanStack Router (validateSearch/useSearch/useNavigate), Zod, Radix Popover/Command, Tailwind CSS 4, Vitest

**Spec:** `specs/composable-filter-system/02-specification.md`

---

## File Map

### New Files

| File                                                         | Layer        | Responsibility                                                                               |
| ------------------------------------------------------------ | ------------ | -------------------------------------------------------------------------------------------- |
| `shared/lib/filter-engine.ts`                                | shared/lib   | Filter type factories, schema builder, `applyFilters`, `applySortAndFilter`                  |
| `shared/lib/__tests__/filter-engine.test.ts`                 | shared/lib   | Pure function tests for all filter types                                                     |
| `shared/model/use-filter-state.ts`                           | shared/model | URL-synced filter state hook                                                                 |
| `shared/model/__tests__/use-filter-state.test.ts`            | shared/model | Hook tests with mock router                                                                  |
| `shared/ui/filter-bar.tsx`                                   | shared/ui    | Compound components: FilterBar, Search, Primary, AddFilter, Sort, ResultCount, ActiveFilters |
| `shared/ui/__tests__/FilterBar.test.tsx`                     | shared/ui    | Component tests                                                                              |
| `features/agents-list/lib/agent-filter-schema.ts`            | features     | Agent-specific schema + sort definitions                                                     |
| `features/agents-list/__tests__/agent-filter-schema.test.ts` | features     | Consumer integration tests                                                                   |
| `dev/sections/filter-bar-sections.ts`                        | dev          | Playground section registry                                                                  |
| `dev/showcases/FilterBarShowcase.tsx`                        | dev          | Playground demo component                                                                    |

All paths are relative to `apps/client/src/layers/` unless otherwise noted (dev files are at `apps/client/src/dev/`).

### Modified Files

| File                                                | Change                                                 |
| --------------------------------------------------- | ------------------------------------------------------ |
| `shared/lib/index.ts`                               | Add filter-engine exports                              |
| `shared/model/index.ts`                             | Add useFilterState export                              |
| `shared/ui/index.ts`                                | Add FilterBar exports                                  |
| `features/agents-list/ui/AgentsList.tsx`            | Replace bespoke filtering with shared system           |
| `features/agents-list/ui/AgentEmptyFilterState.tsx` | Accept `filterDescription` prop for explicit messaging |
| `features/agents-list/index.ts`                     | Remove deleted exports, add schema export              |
| `apps/client/src/router.tsx` (line 54-56)           | Merge filter schema into agentsSearchSchema            |
| `apps/client/src/dev/playground-config.ts`          | Add filter-bar page config                             |
| `apps/client/src/dev/playground-registry.ts`        | Add FILTER_BAR_SECTIONS                                |

### Deleted Files

| File                                         | Reason                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------- |
| `features/agents-list/ui/AgentFilterBar.tsx` | Replaced by shared FilterBar                                                          |
| `features/agents-list/ui/FleetHealthBar.tsx` | Intentional simplification — color dots in Primary dropdown preserve status awareness |

---

## Task 1: Filter Engine — Type Definitions and Text Filter

**Files:**

- Create: `apps/client/src/layers/shared/lib/filter-engine.ts`
- Create: `apps/client/src/layers/shared/lib/__tests__/filter-engine.test.ts`

- [ ] **Step 1: Write failing tests for textFilter**

```ts
/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { textFilter, createFilterSchema } from '../filter-engine';

interface TestItem {
  name: string;
  description: string | undefined;
  tags: string[];
}

const items: TestItem[] = [
  { name: 'Deploy Bot', description: 'Deploys code', tags: ['ci', 'deploy'] },
  { name: 'Review Agent', description: undefined, tags: ['review'] },
  { name: 'Test Runner', description: 'Runs tests', tags: ['ci', 'test'] },
];

describe('textFilter', () => {
  const schema = createFilterSchema<TestItem>({
    search: textFilter({
      fields: [(a) => a.name, (a) => a.description, (a) => a.tags.join(' ')],
    }),
  });

  it('matches substring in name', () => {
    const result = schema.applyFilters(items, { search: 'deploy' });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Deploy Bot');
  });

  it('matches substring in description', () => {
    const result = schema.applyFilters(items, { search: 'runs' });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Test Runner');
  });

  it('matches substring in tags', () => {
    const result = schema.applyFilters(items, { search: 'ci' });
    expect(result).toHaveLength(2);
  });

  it('is case-insensitive', () => {
    const result = schema.applyFilters(items, { search: 'DEPLOY' });
    expect(result).toHaveLength(1);
  });

  it('returns all items when search is empty', () => {
    const result = schema.applyFilters(items, { search: '' });
    expect(result).toHaveLength(3);
  });

  it('handles undefined field values gracefully', () => {
    const result = schema.applyFilters(items, { search: 'undefined' });
    expect(result).toHaveLength(0);
  });
});

describe('textFilter serialization', () => {
  it('round-trips through serialize/deserialize', () => {
    const filter = textFilter({ fields: [(a: TestItem) => a.name] });
    expect(filter.deserialize(filter.serialize('hello world'))).toBe('hello world');
  });

  it('isActive returns false for empty string', () => {
    const filter = textFilter({ fields: [(a: TestItem) => a.name] });
    expect(filter.isActive('')).toBe(false);
    expect(filter.isActive('  ')).toBe(false);
  });

  it('isActive returns true for non-empty string', () => {
    const filter = textFilter({ fields: [(a: TestItem) => a.name] });
    expect(filter.isActive('hello')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/client/src/layers/shared/lib/__tests__/filter-engine.test.ts`
Expected: FAIL — `filter-engine` module not found

- [ ] **Step 3: Implement filter engine foundation + textFilter**

Create `apps/client/src/layers/shared/lib/filter-engine.ts` with:

```ts
/**
 * Composable filter engine — pure TypeScript, no React dependency.
 *
 * Provides filter type factories, schema builder, and pure filtering functions.
 * @module shared/lib/filter-engine
 */

// ── Types ────────────────────────────────────────────────────

/** Base filter definition with type-safe match, serialize, and deserialize. */
export interface FilterDefinition<TItem, TValue> {
  /** Discriminant for the UI to know what control to render. */
  type: 'text' | 'enum' | 'dateRange' | 'boolean' | 'numericRange';
  /** The "no filter" state. */
  defaultValue: TValue;
  /** Human-readable label for this filter. */
  label?: string;
  /** Serialize value for URL params. */
  serialize: (value: TValue) => string;
  /** Deserialize from URL params, falling back to defaultValue on invalid input. */
  deserialize: (raw: string) => TValue;
  /** Filtering predicate — returns true if item matches the filter value. */
  match: (item: TItem, value: TValue) => boolean;
  /** Whether the filter differs from defaultValue. */
  isActive: (value: TValue) => boolean;
}

/** Extended definition for enum filters — carries typed UI metadata. */
export interface EnumFilterDefinition<TItem> extends FilterDefinition<TItem, string | string[]> {
  type: 'enum';
  options: string[];
  labels?: Record<string, string>;
  colors?: Record<string, string>;
  multi: boolean;
  dynamic?: boolean;
}

/** Type guard for enum filter definitions. */
export function isEnumFilter<TItem>(
  def: FilterDefinition<TItem, any>
): def is EnumFilterDefinition<TItem> {
  return def.type === 'enum';
}

/** Configuration for text filter. */
interface TextFilterConfig<TItem> {
  fields: Array<(item: TItem) => string | undefined | null>;
}

/** Infer filter values from a definitions record. */
type FilterValues<TDefs extends Record<string, FilterDefinition<any, any>>> = {
  [K in keyof TDefs]: TDefs[K] extends FilterDefinition<any, infer V> ? V : never;
};

/** The schema object returned by createFilterSchema. */
export interface FilterSchema<TItem, TDefs extends Record<string, FilterDefinition<TItem, any>>> {
  definitions: TDefs;
  defaultValues: FilterValues<TDefs>;
  applyFilters: (items: TItem[], values: Partial<FilterValues<TDefs>>) => TItem[];
  isFiltered: (values: Partial<FilterValues<TDefs>>) => boolean;
  activeCount: (values: Partial<FilterValues<TDefs>>) => number;
  describeActive: (values: Partial<FilterValues<TDefs>>) => string;
  searchValidator: import('zod').ZodObject<any>;
}

// ── Filter Factories ─────────────────────────────────────────

/** Text search filter — matches substring across multiple accessor functions. */
export function textFilter<TItem>(
  config: TextFilterConfig<TItem>
): FilterDefinition<TItem, string> {
  return {
    type: 'text',
    defaultValue: '',
    serialize: (v) => v,
    deserialize: (raw) => raw ?? '',
    match: (item, value) => {
      if (!value.trim()) return true;
      const q = value.toLowerCase();
      return config.fields.some((accessor) => {
        const fieldValue = accessor(item);
        return fieldValue != null && String(fieldValue).toLowerCase().includes(q);
      });
    },
    isActive: (value) => value.trim().length > 0,
  };
}

// ── Schema Builder ───────────────────────────────────────────

/** Create a typed filter schema from a record of filter definitions. */
export function createFilterSchema<
  TItem,
  TDefs extends Record<string, FilterDefinition<TItem, any>> = Record<
    string,
    FilterDefinition<TItem, any>
  >,
>(definitions: TDefs): FilterSchema<TItem, TDefs> {
  const defaultValues = Object.fromEntries(
    Object.entries(definitions).map(([key, def]) => [key, def.defaultValue])
  ) as FilterValues<TDefs>;

  // searchValidator built in Task 2 — placeholder for now
  return {
    definitions,
    defaultValues,

    applyFilters(items, values) {
      return items.filter((item) =>
        Object.entries(definitions).every(([key, def]) => {
          const value = (values as any)[key] ?? def.defaultValue;
          if (!def.isActive(value)) return true;
          return def.match(item, value);
        })
      );
    },

    isFiltered(values) {
      return Object.entries(definitions).some(([key, def]) => {
        const value = (values as any)[key] ?? def.defaultValue;
        return def.isActive(value);
      });
    },

    activeCount(values) {
      return Object.entries(definitions).filter(([key, def]) => {
        const value = (values as any)[key] ?? def.defaultValue;
        return def.isActive(value);
      }).length;
    },

    describeActive(values) {
      const parts: string[] = [];
      for (const [key, def] of Object.entries(definitions)) {
        const value = (values as any)[key] ?? def.defaultValue;
        if (!def.isActive(value)) continue;
        const label = def.label ?? key;
        if (def.type === 'text') {
          parts.push(`search '${value}'`);
        } else if (isEnumFilter(def) && def.labels) {
          // Resolve enum value labels for human-readable output
          const resolveLabel = (v: string) => def.labels?.[v] ?? v;
          const display = Array.isArray(value)
            ? (value as string[]).map(resolveLabel).join(', ')
            : resolveLabel(value as string);
          parts.push(`${label} ${display}`);
        } else {
          parts.push(`${label} ${Array.isArray(value) ? value.join(', ') : String(value)}`);
        }
      }
      return parts.join(' and ');
    },

    searchValidator: null as any, // Implemented in Task 2
  };
}
```

**Note:** The Zod `searchValidator` and remaining filter types will be added in subsequent tasks. This task establishes the foundation and textFilter only.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run apps/client/src/layers/shared/lib/__tests__/filter-engine.test.ts`
Expected: All textFilter tests PASS

- [ ] **Step 5: Commit**

```bash
git add apps/client/src/layers/shared/lib/filter-engine.ts apps/client/src/layers/shared/lib/__tests__/filter-engine.test.ts
git commit -m "feat(client): add filter engine foundation with textFilter"
```

---

## Task 2: Filter Engine — enumFilter + Zod searchValidator

**Files:**

- Modify: `apps/client/src/layers/shared/lib/filter-engine.ts`
- Modify: `apps/client/src/layers/shared/lib/__tests__/filter-engine.test.ts`

- [ ] **Step 1: Write failing tests for enumFilter**

Add to the test file:

```ts
import { enumFilter } from '../filter-engine';

describe('enumFilter (single)', () => {
  const schema = createFilterSchema<TestItem>({
    tag: enumFilter({
      field: (a) => a.tags[0],
      options: ['ci', 'review', 'test'],
    }),
  });

  it('matches exact value', () => {
    const result = schema.applyFilters(items, { tag: 'ci' });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Deploy Bot');
  });

  it('returns all when default (empty string)', () => {
    const result = schema.applyFilters(items, { tag: '' });
    expect(result).toHaveLength(3);
  });
});

describe('enumFilter (multi)', () => {
  const schema = createFilterSchema<TestItem>({
    tag: enumFilter({
      field: (a) => a.tags[0],
      options: ['ci', 'review', 'test'],
      multi: true,
    }),
  });

  it('matches any of selected values', () => {
    const result = schema.applyFilters(items, { tag: ['ci', 'review'] });
    expect(result).toHaveLength(2);
  });

  it('returns all when empty array', () => {
    const result = schema.applyFilters(items, { tag: [] });
    expect(result).toHaveLength(3);
  });
});

describe('enumFilter serialization', () => {
  it('round-trips single value', () => {
    const filter = enumFilter<TestItem>({ field: (a) => a.name, options: ['a', 'b'] });
    expect(filter.deserialize(filter.serialize('a'))).toBe('a');
  });

  it('round-trips multi value', () => {
    const filter = enumFilter<TestItem>({ field: (a) => a.name, options: ['a', 'b'], multi: true });
    expect(filter.deserialize(filter.serialize(['a', 'b']))).toEqual(['a', 'b']);
  });

  it('deserializes invalid value to default', () => {
    const filter = enumFilter<TestItem>({ field: (a) => a.name, options: ['a', 'b'] });
    expect(filter.deserialize('bogus')).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/client/src/layers/shared/lib/__tests__/filter-engine.test.ts`
Expected: FAIL — `enumFilter` not exported

- [ ] **Step 3: Implement enumFilter**

Add to `filter-engine.ts`:

```ts
/** Configuration for enum filter. */
interface EnumFilterConfig<TItem> {
  field: (item: TItem) => string | undefined | null;
  options: string[];
  multi?: boolean;
  labels?: Record<string, string>;
  colors?: Record<string, string>;
  dynamic?: boolean;
}

/** Enum filter — single or multi-select from a known set of values. */
export function enumFilter<TItem>(config: EnumFilterConfig<TItem>): EnumFilterDefinition<TItem> {
  const isMulti = config.multi ?? false;
  const defaultValue = isMulti ? ([] as string[]) : '';

  return {
    type: 'enum',
    defaultValue,
    serialize: (v) => (Array.isArray(v) ? v.join(',') : String(v)),
    deserialize: (raw) => {
      if (!raw) return defaultValue;
      if (isMulti) {
        const values = raw.split(',').filter((v) => config.options.includes(v) || config.dynamic);
        return values.length > 0 ? values : defaultValue;
      }
      return config.options.includes(raw) || config.dynamic ? raw : defaultValue;
    },
    match: (item, value) => {
      if (isMulti) {
        const selected = value as string[];
        if (selected.length === 0) return true;
        const fieldValue = config.field(item);
        return fieldValue != null && selected.includes(fieldValue);
      }
      const selected = value as string;
      if (!selected) return true;
      const fieldValue = config.field(item);
      return fieldValue != null && fieldValue === selected;
    },
    isActive: (value) => (Array.isArray(value) ? value.length > 0 : Boolean(value)),
    // Typed enum metadata — use EnumFilterDefinition interface, not `as any`
    options: config.options,
    labels: config.labels,
    colors: config.colors,
    multi: isMulti,
    dynamic: config.dynamic,
  } satisfies EnumFilterDefinition<TItem>;
}
```

- [ ] **Step 4: Write failing tests for searchValidator (Zod schema generation)**

```ts
describe('searchValidator', () => {
  it('generates a Zod schema that validates filter params', () => {
    const schema = createFilterSchema<TestItem>({
      search: textFilter({ fields: [(a) => a.name] }),
      status: enumFilter({ field: (a) => a.name, options: ['active', 'inactive'], multi: true }),
    });
    const validator = schema.searchValidator;
    expect(validator).toBeDefined();

    // Valid input
    const valid = validator.parse({ search: 'hello', status: 'active,inactive' });
    expect(valid.search).toBe('hello');

    // Missing params default
    const defaults = validator.parse({});
    expect(defaults.search).toBeUndefined();
  });
});
```

- [ ] **Step 5: Implement searchValidator in createFilterSchema**

Update `createFilterSchema` to build a Zod schema from definitions:

```ts
import { z } from 'zod';

// Inside createFilterSchema:
const zodFields: Record<string, z.ZodTypeAny> = {};
for (const [key, def] of Object.entries(definitions)) {
  zodFields[key] = z.string().optional();
}
const searchValidator = z.object(zodFields);
```

- [ ] **Step 6: Run all tests**

Run: `pnpm vitest run apps/client/src/layers/shared/lib/__tests__/filter-engine.test.ts`
Expected: All PASS

- [ ] **Step 7: Commit**

```bash
git add apps/client/src/layers/shared/lib/filter-engine.ts apps/client/src/layers/shared/lib/__tests__/filter-engine.test.ts
git commit -m "feat(client): add enumFilter and Zod searchValidator to filter engine"
```

---

## Task 3: Filter Engine — dateRangeFilter, booleanFilter, numericRangeFilter, sort

**Files:**

- Modify: `apps/client/src/layers/shared/lib/filter-engine.ts`
- Modify: `apps/client/src/layers/shared/lib/__tests__/filter-engine.test.ts`

- [ ] **Step 1: Write failing tests for remaining filter types**

```ts
import {
  dateRangeFilter,
  booleanFilter,
  numericRangeFilter,
  createSortOptions,
  applySortAndFilter,
} from '../filter-engine';

interface TimedItem {
  name: string;
  createdAt: string;
  enabled: boolean;
  count: number;
}

const timedItems: TimedItem[] = [
  {
    name: 'Alpha',
    createdAt: new Date(Date.now() - 3600_000).toISOString(),
    enabled: true,
    count: 5,
  },
  {
    name: 'Beta',
    createdAt: new Date(Date.now() - 86400_000 * 2).toISOString(),
    enabled: false,
    count: 12,
  },
  {
    name: 'Gamma',
    createdAt: new Date(Date.now() - 86400_000 * 10).toISOString(),
    enabled: true,
    count: 3,
  },
];

describe('dateRangeFilter', () => {
  const schema = createFilterSchema<TimedItem>({
    created: dateRangeFilter({ field: (a) => a.createdAt, presets: ['1h', '24h', '7d', '30d'] }),
  });

  it('filters by preset "24h"', () => {
    const result = schema.applyFilters(timedItems, { created: { preset: '24h' } });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Alpha');
  });

  it('filters by preset "7d"', () => {
    const result = schema.applyFilters(timedItems, { created: { preset: '7d' } });
    expect(result).toHaveLength(2);
  });

  it('returns all when no preset', () => {
    const result = schema.applyFilters(timedItems, { created: {} });
    expect(result).toHaveLength(3);
  });
});

describe('booleanFilter', () => {
  const schema = createFilterSchema<TimedItem>({
    enabled: booleanFilter({ field: (a) => a.enabled, label: 'Enabled' }),
  });

  it('filters true values', () => {
    const result = schema.applyFilters(timedItems, { enabled: true });
    expect(result).toHaveLength(2);
  });

  it('returns all when null (default)', () => {
    const result = schema.applyFilters(timedItems, { enabled: null });
    expect(result).toHaveLength(3);
  });
});

describe('numericRangeFilter', () => {
  const schema = createFilterSchema<TimedItem>({
    count: numericRangeFilter({ field: (a) => a.count, label: 'Count' }),
  });

  it('filters by min', () => {
    const result = schema.applyFilters(timedItems, { count: { min: 5 } });
    expect(result).toHaveLength(2);
  });

  it('filters by max', () => {
    const result = schema.applyFilters(timedItems, { count: { max: 5 } });
    expect(result).toHaveLength(2);
  });

  it('filters by range', () => {
    const result = schema.applyFilters(timedItems, { count: { min: 4, max: 10 } });
    expect(result).toHaveLength(1);
  });
});

describe('applySortAndFilter', () => {
  const schema = createFilterSchema<TimedItem>({
    enabled: booleanFilter({ field: (a) => a.enabled, label: 'Enabled' }),
  });
  const sortOptions = createSortOptions<TimedItem>({
    name: { label: 'Name', accessor: (a) => a.name },
    count: { label: 'Count', accessor: (a) => a.count, direction: 'desc' },
  });

  it('filters then sorts in a single call', () => {
    const result = applySortAndFilter(timedItems, schema, { enabled: true }, sortOptions, {
      field: 'name',
      direction: 'asc',
    });
    expect(result.map((r) => r.name)).toEqual(['Alpha', 'Gamma']);
  });

  it('sorts descending', () => {
    const result = applySortAndFilter(timedItems, schema, {}, sortOptions, {
      field: 'count',
      direction: 'desc',
    });
    expect(result.map((r) => r.name)).toEqual(['Beta', 'Alpha', 'Gamma']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run apps/client/src/layers/shared/lib/__tests__/filter-engine.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement dateRangeFilter, booleanFilter, numericRangeFilter, createSortOptions, applySortAndFilter**

Add all remaining filter factories and sort utilities to `filter-engine.ts`. Refer to spec section "Layer 1" for the full API. Key details:

- `dateRangeFilter` uses preset durations: `'1h'` = 3600s, `'24h'` = 86400s, `'7d'` = 604800s, `'30d'` = 2592000s. Compares `Date.now()` against the field accessor's ISO string.
- `booleanFilter` default is `null` (meaning "no filter"). `true` or `false` is active.
- `numericRangeFilter` default is `{}`. Active when `min` or `max` is set.
- `createSortOptions` returns a typed record of `{ label, accessor, direction? }`.
- `applySortAndFilter` calls `schema.applyFilters` then sorts by the accessor.

- [ ] **Step 4: Run all tests**

Run: `pnpm vitest run apps/client/src/layers/shared/lib/__tests__/filter-engine.test.ts`
Expected: All PASS

- [ ] **Step 5: Write describeActive tests**

```ts
describe('describeActive', () => {
  const schema = createFilterSchema<TestItem>({
    search: textFilter({ fields: [(a) => a.name] }),
    status: enumFilter({
      field: (a) => a.name,
      options: ['active', 'inactive'],
      multi: true,
      labels: { active: 'Active', inactive: 'Inactive' },
    }),
  });

  it('describes single text filter', () => {
    expect(schema.describeActive({ search: 'deploy', status: [] })).toBe("search 'deploy'");
  });

  it('describes single enum filter', () => {
    expect(schema.describeActive({ search: '', status: ['active'] })).toBe('status Active');
  });

  it('describes multiple filters', () => {
    expect(schema.describeActive({ search: 'deploy', status: ['active'] })).toBe(
      "search 'deploy' and status Active"
    );
  });

  it('returns empty string when no filters active', () => {
    expect(schema.describeActive({ search: '', status: [] })).toBe('');
  });
});
```

- [ ] **Step 6: Run all tests, fix describeActive if needed**

Run: `pnpm vitest run apps/client/src/layers/shared/lib/__tests__/filter-engine.test.ts`
Expected: All PASS

- [ ] **Step 7: Export from barrel**

Add to `apps/client/src/layers/shared/lib/index.ts` at line 84:

```ts
export {
  textFilter,
  enumFilter,
  dateRangeFilter,
  booleanFilter,
  numericRangeFilter,
  createFilterSchema,
  createSortOptions,
  applySortAndFilter,
  type FilterDefinition,
  type FilterSchema,
  type FilterValues,
} from './filter-engine';
```

- [ ] **Step 8: Commit**

```bash
git add apps/client/src/layers/shared/lib/filter-engine.ts apps/client/src/layers/shared/lib/__tests__/filter-engine.test.ts apps/client/src/layers/shared/lib/index.ts
git commit -m "feat(client): complete filter engine with all filter types, sort, and describeActive"
```

---

## Task 4: URL Sync Hook — useFilterState

**Files:**

- Create: `apps/client/src/layers/shared/model/use-filter-state.ts`
- Create: `apps/client/src/layers/shared/model/__tests__/use-filter-state.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Mock TanStack Router hooks
const mockNavigate = vi.fn();
const mockSearch: Record<string, string> = {};
vi.mock('@tanstack/react-router', () => ({
  useSearch: () => mockSearch,
  useNavigate: () => mockNavigate,
}));

import { useFilterState } from '../use-filter-state';
import { createFilterSchema, textFilter, enumFilter } from '../../lib/filter-engine';

interface TestItem {
  name: string;
  status: string;
}

const schema = createFilterSchema<TestItem>({
  search: textFilter({ fields: [(a) => a.name] }),
  status: enumFilter({ field: (a) => a.status, options: ['active', 'inactive'], multi: true }),
});

describe('useFilterState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(mockSearch).forEach((k) => delete mockSearch[k]);
  });

  it('returns default values when URL has no params', () => {
    const { result } = renderHook(() => useFilterState(schema));
    expect(result.current.values.search).toBe('');
    expect(result.current.values.status).toEqual([]);
    expect(result.current.isFiltered).toBe(false);
    expect(result.current.activeCount).toBe(0);
  });

  it('reads initial state from URL search params', () => {
    mockSearch.search = 'deploy';
    mockSearch.status = 'active,inactive';
    const { result } = renderHook(() => useFilterState(schema));
    expect(result.current.values.search).toBe('deploy');
    expect(result.current.values.status).toEqual(['active', 'inactive']);
    expect(result.current.isFiltered).toBe(true);
    expect(result.current.activeCount).toBe(2);
  });

  it('updates URL when set() is called', () => {
    const { result } = renderHook(() => useFilterState(schema));
    act(() => result.current.set('status', ['active']));
    expect(mockNavigate).toHaveBeenCalledWith(
      expect.objectContaining({ search: expect.any(Function) })
    );
  });

  it('clearAll resets all filters but preserves sibling route params', () => {
    mockSearch.search = 'deploy';
    mockSearch.status = 'active';
    mockSearch.view = 'topology'; // sibling param, not a filter
    const { result } = renderHook(() => useFilterState(schema));
    act(() => result.current.clearAll());
    expect(mockNavigate).toHaveBeenCalledWith(
      expect.objectContaining({ search: expect.any(Function) })
    );
    // Verify the search updater function preserves non-filter params
    const searchUpdater = mockNavigate.mock.calls[0][0].search;
    const newSearch = searchUpdater({ view: 'topology', search: 'deploy', status: 'active' });
    expect(newSearch.view).toBe('topology'); // preserved
    expect(newSearch.search).toBeUndefined(); // cleared
    expect(newSearch.status).toBeUndefined(); // cleared
  });

  it('describeActive returns human-readable summary', () => {
    mockSearch.search = 'deploy';
    mockSearch.status = 'active';
    const { result } = renderHook(() => useFilterState(schema));
    expect(result.current.describeActive()).toContain('deploy');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/client/src/layers/shared/model/__tests__/use-filter-state.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement useFilterState**

Create `apps/client/src/layers/shared/model/use-filter-state.ts`:

The hook should:

1. Read current URL search params via `useSearch({ strict: false })`
2. Deserialize each param through the schema's filter definitions
3. Provide `set(name, value)` that calls `navigate({ search: (prev) => ({ ...prev, [name]: serialize(value) }) })`
4. Provide `clear(name)` that removes the param (sets to undefined)
5. Provide `clearAll()` that removes all filter params (but preserves non-filter params like `view`)
6. Provide `setSort(field, direction)` that sets `sort` param as `field:direction`
7. Compute `isFiltered`, `activeCount`, `describeActive()` from deserialized values
8. Support `debounce` option per filter — uses `useState` for `inputValues` and `setTimeout` for committing to URL

Refer to spec section "Layer 2" for the complete return type.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run apps/client/src/layers/shared/model/__tests__/use-filter-state.test.ts`
Expected: All PASS

- [ ] **Step 5: Export from barrel**

Add to `apps/client/src/layers/shared/model/index.ts` at line 29:

```ts
export { useFilterState, type UseFilterStateReturn } from './use-filter-state';
```

- [ ] **Step 6: Commit**

```bash
git add apps/client/src/layers/shared/model/use-filter-state.ts apps/client/src/layers/shared/model/__tests__/use-filter-state.test.ts apps/client/src/layers/shared/model/index.ts
git commit -m "feat(client): add useFilterState hook with URL sync via TanStack Router"
```

---

## Task 5: UI Components — FilterBar compound components

**Files:**

- Create: `apps/client/src/layers/shared/ui/filter-bar.tsx`
- Create: `apps/client/src/layers/shared/ui/__tests__/FilterBar.test.tsx`

- [ ] **Step 1: Write failing tests for FilterBar rendering**

```ts
/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

// Mock useFilterState return value
const mockFilterState = {
  values: { search: '', status: [] },
  inputValues: { search: '', status: [] },
  sortField: 'name',
  sortDirection: 'asc' as const,
  isFiltered: false,
  activeCount: 0,
  set: vi.fn(),
  clear: vi.fn(),
  clearAll: vi.fn(),
  setSort: vi.fn(),
  describeActive: vi.fn(() => ''),
  schema: {
    definitions: {
      search: { type: 'text' },
      status: { type: 'enum', options: ['active', 'inactive'], multi: true, labels: { active: 'Active', inactive: 'Inactive' } },
    },
  },
};

import { FilterBar } from '../filter-bar';

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('min-width'), // simulate desktop
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

describe('FilterBar', () => {
  it('renders search input', () => {
    render(
      <FilterBar state={mockFilterState}>
        <FilterBar.Search placeholder="Filter agents..." />
      </FilterBar>
    );
    expect(screen.getByPlaceholderText('Filter agents...')).toBeInTheDocument();
  });

  it('renders result count', () => {
    render(
      <FilterBar state={mockFilterState}>
        <FilterBar.ResultCount count={12} total={12} noun="agent" />
      </FilterBar>
    );
    expect(screen.getByText('12 agents')).toBeInTheDocument();
  });

  it('renders filtered result count with clear link', () => {
    render(
      <FilterBar state={{ ...mockFilterState, isFiltered: true }}>
        <FilterBar.ResultCount count={4} total={12} noun="agent" />
      </FilterBar>
    );
    expect(screen.getByText(/4 of 12 agents/)).toBeInTheDocument();
    expect(screen.getByText('Clear all')).toBeInTheDocument();
  });

  it('renders sort dropdown', () => {
    const sortOptions = { name: { label: 'Name' }, lastSeen: { label: 'Last seen' } };
    render(
      <FilterBar state={mockFilterState}>
        <FilterBar.Sort options={sortOptions} />
      </FilterBar>
    );
    expect(screen.getByText(/Sort/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/client/src/layers/shared/ui/__tests__/FilterBar.test.tsx`
Expected: FAIL

- [ ] **Step 3: Implement FilterBar compound components**

Create `apps/client/src/layers/shared/ui/filter-bar.tsx`. This is the largest file — implement sub-components one at a time:

1. `FilterBarContext` + `FilterBar` container
2. `FilterBarSearch` — search icon + input
3. `FilterBarPrimary` — multi-select dropdown (uses Popover + checkboxes)
4. `FilterBarAddFilter` — two-stage popover (property picker → value picker)
5. `FilterBarSort` — sort dropdown (uses DropdownMenu)
6. `FilterBarResultCount` — count display with clear link
7. `FilterBarActiveFilters` — responsive: inline chips (sm+) / badge (mobile)

Attach sub-components: `FilterBar.Search = FilterBarSearch`, etc.

Refer to spec section "Layer 3" for exact visual specs, responsive behavior, and accessibility requirements.

Use existing shared/ui primitives: `Popover`, `PopoverTrigger`, `PopoverContent`, `Button`, `Input`, `DropdownMenu`, `Checkbox`, `Badge`, `ScrollArea`, `Sheet` (for mobile active filters).

If the file exceeds 300 lines, split into `filter-bar/` directory:

- `filter-bar/FilterBar.tsx` — container + context
- `filter-bar/FilterBarSearch.tsx`
- `filter-bar/FilterBarPrimary.tsx`
- `filter-bar/FilterBarAddFilter.tsx`
- `filter-bar/FilterBarSort.tsx`
- `filter-bar/FilterBarResultCount.tsx`
- `filter-bar/FilterBarActiveFilters.tsx`
- `filter-bar/index.ts` — re-exports

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run apps/client/src/layers/shared/ui/__tests__/FilterBar.test.tsx`
Expected: All PASS

- [ ] **Step 5: Add more interaction tests**

Add tests for:

- Search input `onChange` calls `filterState.set('search', value)`
- Primary dropdown opens, selecting an option calls `filterState.set`
- ActiveFilters shows chips on desktop, badge on mobile (mock matchMedia differently)
- Chip × button calls `filterState.clear(name)`

- [ ] **Step 6: Run all tests**

Run: `pnpm vitest run apps/client/src/layers/shared/ui/__tests__/FilterBar.test.tsx`
Expected: All PASS

- [ ] **Step 7: Export from barrel**

Add to `apps/client/src/layers/shared/ui/index.ts` at end:

```ts
export { FilterBar } from './filter-bar';
```

- [ ] **Step 8: Commit**

```bash
git add apps/client/src/layers/shared/ui/filter-bar.tsx apps/client/src/layers/shared/ui/__tests__/FilterBar.test.tsx apps/client/src/layers/shared/ui/index.ts
git commit -m "feat(client): add FilterBar compound UI components"
```

---

## Task 6: Agent Filter Schema + Route Integration

**Files:**

- Create: `apps/client/src/layers/features/agents-list/lib/agent-filter-schema.ts`
- Create: `apps/client/src/layers/features/agents-list/__tests__/agent-filter-schema.test.ts`
- Modify: `apps/client/src/router.tsx` (lines 54-56)

- [ ] **Step 1: Write failing tests for agent filter schema**

```ts
/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { agentFilterSchema, agentSortOptions } from '../lib/agent-filter-schema';
import { applySortAndFilter } from '@/layers/shared/lib';
import type { TopologyAgent } from '@dorkos/shared/mesh-schemas';

// Minimal mock agents (only fields used by the schema)
const agents = [
  {
    name: 'Deploy Bot',
    description: 'Deploys code',
    capabilities: ['ci'],
    healthStatus: 'active',
    runtime: 'claude-code',
    lastSeenAt: new Date().toISOString(),
    registeredAt: '2026-01-01T00:00:00Z',
    namespace: 'prod',
  },
  {
    name: 'Review Agent',
    description: 'Reviews PRs',
    capabilities: ['review'],
    healthStatus: 'inactive',
    runtime: 'cursor',
    lastSeenAt: new Date(Date.now() - 86400_000 * 3).toISOString(),
    registeredAt: '2026-02-01T00:00:00Z',
    namespace: 'dev',
  },
  {
    name: 'Test Runner',
    description: 'Runs tests',
    capabilities: ['ci', 'test'],
    healthStatus: 'stale',
    runtime: 'claude-code',
    lastSeenAt: null,
    registeredAt: '2026-03-01T00:00:00Z',
    namespace: 'prod',
  },
] as unknown as TopologyAgent[];

describe('agentFilterSchema', () => {
  it('filters by status multi-select', () => {
    const result = agentFilterSchema.applyFilters(agents, { status: ['active', 'stale'] });
    expect(result).toHaveLength(2);
  });

  it('filters by text search across name and capabilities', () => {
    const result = agentFilterSchema.applyFilters(agents, { search: 'ci' });
    expect(result).toHaveLength(2);
  });

  it('composes status + search filters', () => {
    const result = agentFilterSchema.applyFilters(agents, { search: 'ci', status: ['active'] });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Deploy Bot');
  });

  it('filters by runtime', () => {
    const result = agentFilterSchema.applyFilters(agents, { runtime: 'claude-code' });
    expect(result).toHaveLength(2);
  });
});

describe('agentSortOptions', () => {
  it('sorts by name ascending', () => {
    const result = applySortAndFilter(agents, agentFilterSchema, {}, agentSortOptions, {
      field: 'name',
      direction: 'asc',
    });
    expect(result.map((a) => a.name)).toEqual(['Deploy Bot', 'Review Agent', 'Test Runner']);
  });

  it('sorts by registered descending', () => {
    const result = applySortAndFilter(agents, agentFilterSchema, {}, agentSortOptions, {
      field: 'registered',
      direction: 'desc',
    });
    expect(result[0].name).toBe('Test Runner');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/client/src/layers/features/agents-list/__tests__/agent-filter-schema.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement agent filter schema**

Create `apps/client/src/layers/features/agents-list/lib/agent-filter-schema.ts`:

```ts
import type { TopologyAgent } from '@dorkos/shared/mesh-schemas';
import {
  createFilterSchema,
  textFilter,
  enumFilter,
  dateRangeFilter,
  createSortOptions,
} from '@/layers/shared/lib';

/** Filter schema for the agents list. */
export const agentFilterSchema = createFilterSchema<TopologyAgent>({
  search: textFilter({
    fields: [(a) => a.name, (a) => a.description, (a) => a.capabilities.join(' ')],
  }),
  status: enumFilter({
    field: (a) => a.healthStatus,
    options: ['active', 'inactive', 'stale', 'unreachable'],
    multi: true,
    labels: { active: 'Active', inactive: 'Inactive', stale: 'Stale', unreachable: 'Unreachable' },
    colors: {
      active: 'text-emerald-400',
      inactive: 'text-amber-400',
      stale: 'text-muted-foreground',
      unreachable: 'text-red-400',
    },
  }),
  runtime: enumFilter({
    field: (a) => a.runtime,
    options: ['claude-code', 'cursor', 'codex', 'other'],
    labels: { 'claude-code': 'Claude Code', cursor: 'Cursor', codex: 'Codex', other: 'Other' },
  }),
  lastSeen: dateRangeFilter({
    field: (a) => a.lastSeenAt,
    presets: ['1h', '24h', '7d', '30d'],
  }),
  namespace: enumFilter({
    field: (a) => a.namespace,
    options: [],
    dynamic: true,
  }),
});

/** Sort options for the agents list. */
export const agentSortOptions = createSortOptions<TopologyAgent>({
  name: { label: 'Name', accessor: (a) => a.name },
  lastSeen: { label: 'Last seen', accessor: (a) => a.lastSeenAt ?? '', direction: 'desc' },
  status: { label: 'Status', accessor: (a) => a.healthStatus },
  registered: { label: 'Registered', accessor: (a) => a.registeredAt, direction: 'desc' },
});
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run apps/client/src/layers/features/agents-list/__tests__/agent-filter-schema.test.ts`
Expected: All PASS

- [ ] **Step 5: Update router.tsx — merge filter schema into agentsSearchSchema**

In `apps/client/src/router.tsx`, modify lines 54-56:

```ts
// Before:
const agentsSearchSchema = z.object({
  view: z.enum(['list', 'topology']).optional().default('list'),
});

// After:
import { agentFilterSchema } from '@/layers/features/agents-list';

const agentsSearchSchema = z
  .object({
    view: z.enum(['list', 'topology']).optional().default('list'),
  })
  .merge(agentFilterSchema.searchValidator);
```

- [ ] **Step 6: Run typecheck**

Run: `pnpm typecheck`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add apps/client/src/layers/features/agents-list/lib/agent-filter-schema.ts apps/client/src/layers/features/agents-list/__tests__/agent-filter-schema.test.ts apps/client/src/router.tsx
git commit -m "feat(client): add agent filter schema and integrate with router search params"
```

---

## Task 7: Migrate AgentsList — Replace Bespoke Filters with Shared System

**Files:**

- Modify: `apps/client/src/layers/features/agents-list/ui/AgentsList.tsx`
- Modify: `apps/client/src/layers/features/agents-list/ui/AgentEmptyFilterState.tsx`
- Delete: `apps/client/src/layers/features/agents-list/ui/AgentFilterBar.tsx`
- Delete: `apps/client/src/layers/features/agents-list/ui/FleetHealthBar.tsx`
- Modify: `apps/client/src/layers/features/agents-list/index.ts`

- [ ] **Step 1: Update AgentEmptyFilterState to accept filterDescription**

```tsx
interface AgentEmptyFilterStateProps {
  onClearFilters: () => void;
  filterDescription?: string;
}

export function AgentEmptyFilterState({ onClearFilters, filterDescription }: AgentEmptyFilterStateProps) {
  return (
    <motion.div ...>
      <SearchX className="text-muted-foreground/50 size-10" />
      <p className="text-muted-foreground text-sm">
        {filterDescription
          ? `No agents match ${filterDescription}`
          : 'No agents match your filters'}
      </p>
      <Button variant="outline" size="sm" onClick={onClearFilters}>
        Clear filters
      </Button>
    </motion.div>
  );
}
```

- [ ] **Step 2: Rewrite AgentsList to use shared filter system**

Replace the entire filter section of `AgentsList.tsx`:

1. Remove imports: `AgentFilterBar`, `FilterState`, `StatusFilter`, `FleetHealthBar`
2. Add imports: `useFilterState` from `@/layers/shared/model`, `FilterBar` from `@/layers/shared/ui`, `applySortAndFilter` from `@/layers/shared/lib`, `agentFilterSchema`, `agentSortOptions` from the feature's lib
3. Replace `useState<FilterState>` with `useFilterState(agentFilterSchema)`
4. Replace `applyFilters(agents, filterState)` with `applySortAndFilter(agents, agentFilterSchema, filterState.values, agentSortOptions, { field: filterState.sortField, direction: filterState.sortDirection })`
5. Replace `<FleetHealthBar>` and `<AgentFilterBar>` with:

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

6. Update empty filter state: `<AgentEmptyFilterState onClearFilters={filterState.clearAll} filterDescription={filterState.describeActive()} />`
7. Remove the `handleStatusFilter`, `handleClearFilters` callbacks (no longer needed)
8. Remove the local `applyFilters` function (replaced by shared engine)

- [ ] **Step 3: Delete AgentFilterBar.tsx and FleetHealthBar.tsx**

```bash
rm apps/client/src/layers/features/agents-list/ui/AgentFilterBar.tsx
rm apps/client/src/layers/features/agents-list/ui/FleetHealthBar.tsx
```

- [ ] **Step 4: Update barrel exports**

In `apps/client/src/layers/features/agents-list/index.ts`, remove lines 9 and 13:

```ts
// Remove:
export { AgentFilterBar, type FilterState, type StatusFilter } from './ui/AgentFilterBar';
export { FleetHealthBar } from './ui/FleetHealthBar';

// Add:
export { agentFilterSchema, agentSortOptions } from './lib/agent-filter-schema';
```

- [ ] **Step 5: Run typecheck to catch any broken imports**

Run: `pnpm typecheck`
Expected: No errors. If other files imported `FilterState`, `StatusFilter`, `FleetHealthBar`, or `AgentFilterBar`, fix those imports.

- [ ] **Step 6: Run existing tests**

Run: `pnpm vitest run apps/client/src/layers/features/agents-list/`
Expected: Existing tests pass (or need minor updates for the new FilterBar rendering)

- [ ] **Step 7: Commit**

```bash
git add -A apps/client/src/layers/features/agents-list/
git commit -m "refactor(client): migrate agents list to shared composable filter system

Replaces AgentFilterBar and FleetHealthBar with the shared FilterBar
compound components. Filter state is now URL-synced via TanStack Router.
Adds status, runtime, lastSeen, and namespace filters with sort support."
```

---

## Task 8: Dev Playground Panel

**Files:**

- Create: `apps/client/src/dev/showcases/FilterBarShowcase.tsx`
- Create: `apps/client/src/dev/sections/filter-bar-sections.ts`
- Modify: `apps/client/src/dev/playground-registry.ts`
- Modify: `apps/client/src/dev/playground-config.ts`

- [ ] **Step 1: Create FilterBarShowcase component**

A playground demo that renders the FilterBar with mock data. Include:

- Mock agent data (5-8 items with varied statuses, runtimes, namespaces)
- FilterBar with all sub-components wired up
- A results list below showing filtered items (simple cards)
- Toggle to switch between "agents", "mock logs", "mock tasks" schemas to demonstrate reuse

Follow existing showcase patterns in `apps/client/src/dev/showcases/`.

- [ ] **Step 2: Create section registry entry**

Create `apps/client/src/dev/sections/filter-bar-sections.ts` following the pattern of existing section files.

- [ ] **Step 3: Register in playground-config.ts**

Add a new `PageConfig` entry to `PAGE_CONFIGS` array:

```ts
{
  id: 'filter-bar',
  label: 'Filter Bar',
  description: 'Composable filter system with text search, enum, date range, sort, and responsive active filters.',
  icon: Filter,
  group: 'features',
  sections: FILTER_BAR_SECTIONS,
  path: 'filter-bar',
}
```

- [ ] **Step 4: Verify in dev mode**

Run: `pnpm dev` → navigate to `/dev/filter-bar`
Expected: FilterBar renders with mock data, all filter types work, responsive behavior visible

- [ ] **Step 5: Commit**

```bash
git add apps/client/src/dev/showcases/FilterBarShowcase.tsx apps/client/src/dev/sections/filter-bar-sections.ts apps/client/src/dev/playground-registry.ts apps/client/src/dev/playground-config.ts
git commit -m "feat(client): add FilterBar to dev playground with multi-schema demo"
```

---

## Task 9: Final Verification

- [ ] **Step 1: Run full test suite**

Run: `pnpm test -- --run`
Expected: All tests pass

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: No errors

- [ ] **Step 3: Run lint**

Run: `pnpm lint`
Expected: No errors (or only pre-existing ones)

- [ ] **Step 4: Verify in browser**

Run: `pnpm dev` → navigate to `http://localhost:6241/agents?view=list`

Verify:

- Search input works — type to filter agents by name/description/capabilities
- Primary status dropdown — multi-select, color dots visible
- `+ Filter` popover — shows runtime, lastSeen, namespace options
- Sort dropdown — changes ordering
- Active filter chips — appear on desktop when filters set
- Mobile badge — resize browser to verify collapsed behavior
- URL params — filters appear in URL bar, survive page refresh
- Empty filter state — shows descriptive message with filter names
- "Clear all" — resets everything

- [ ] **Step 5: Verify no orphaned imports**

Run: `pnpm typecheck` confirms no files import from deleted `AgentFilterBar` or `FleetHealthBar`.

Check: `grep -r "FleetHealthBar\|AgentFilterBar" apps/client/src/ --include="*.ts" --include="*.tsx"` returns nothing.

- [ ] **Step 6: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix(client): address final verification issues in filter system"
```
