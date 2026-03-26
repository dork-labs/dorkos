/**
 * Composable filter engine — pure TypeScript, no React dependency.
 *
 * Provides filter type factories, schema builder, and pure filtering functions.
 * @module shared/lib/filter-engine
 */
import { z } from 'zod';

// ── Types ────────────────────────────────────────────────────

/**
 * Base filter definition with type-safe match, serialize, and deserialize.
 *
 * Method shorthands (`match`, `isActive`) are intentionally used instead of
 * function properties so that TypeScript treats them bivariantly under
 * `strictFunctionTypes`. This allows `FilterDefinition<ConcreteItem, string>`
 * to satisfy constraints like `FilterDefinition<SomeItem, unknown>` when
 * building generic schema maps.
 */
export interface FilterDefinition<TItem, TValue> {
  type: 'text' | 'enum' | 'dateRange' | 'boolean' | 'numericRange';
  defaultValue: TValue;
  label?: string;
  serialize(value: TValue): string;
  deserialize(raw: string): TValue;
  match(item: TItem, value: TValue): boolean;
  isActive(value: TValue): boolean;
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
  def: FilterDefinition<TItem, unknown>
): def is EnumFilterDefinition<TItem> {
  return def.type === 'enum';
}

/** Configuration for text filter. */
interface TextFilterConfig<TItem> {
  fields: Array<(item: TItem) => string | undefined | null>;
}

/** Infer filter values from a definitions record. */
export type FilterValues<TDefs extends Record<string, FilterDefinition<unknown, unknown>>> = {
  [K in keyof TDefs]: TDefs[K] extends FilterDefinition<unknown, infer V> ? V : never;
};

/** The schema object returned by createFilterSchema. */
export interface FilterSchema<
  TItem,
  TDefs extends Record<string, FilterDefinition<TItem, unknown>>,
> {
  definitions: TDefs;
  defaultValues: FilterValues<TDefs>;
  applyFilters(items: TItem[], values: Partial<FilterValues<TDefs>>): TItem[];
  isFiltered(values: Partial<FilterValues<TDefs>>): boolean;
  activeCount(values: Partial<FilterValues<TDefs>>): number;
  describeActive(values: Partial<FilterValues<TDefs>>): string;
  searchValidator: z.ZodObject<Record<string, z.ZodTypeAny>>;
}

// ── Filter Factories ─────────────────────────────────────────

/** Text search filter — matches substring across multiple accessor functions. */
export function textFilter<TItem>(
  config: TextFilterConfig<TItem>
): FilterDefinition<TItem, string> {
  return {
    type: 'text',
    defaultValue: '',
    serialize(v) {
      return v;
    },
    deserialize(raw) {
      return raw ?? '';
    },
    match(item, value) {
      if (!value.trim()) return true;
      const q = value.toLowerCase();
      return config.fields.some((accessor) => {
        const fieldValue = accessor(item);
        return fieldValue != null && String(fieldValue).toLowerCase().includes(q);
      });
    },
    isActive(value) {
      return value.trim().length > 0;
    },
  };
}

// ── Enum Filter ──────────────────────────────────────────────

/** Configuration for enum filter. */
interface EnumFilterConfig<TItem> {
  field: (item: TItem) => string | undefined | null;
  options: string[];
  multi?: boolean;
  labels?: Record<string, string>;
  colors?: Record<string, string>;
  dynamic?: boolean;
  label?: string;
}

/** Preset duration values in milliseconds. */
const PRESET_DURATIONS: Record<string, number> = {
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 604_800_000,
  '30d': 2_592_000_000,
};

/** Enum filter — supports single-select and multi-select modes. */
export function enumFilter<TItem>(config: EnumFilterConfig<TItem>): EnumFilterDefinition<TItem> {
  const { options, multi = false, labels, colors, dynamic, label } = config;

  if (multi) {
    return {
      type: 'enum',
      defaultValue: [] as string[],
      label,
      options,
      labels,
      colors,
      multi: true,
      dynamic,
      serialize(value) {
        return (value as string[]).join(',');
      },
      deserialize(raw) {
        if (!raw) return [];
        return raw
          .split(',')
          .map((v) => v.trim())
          .filter((v) => options.includes(v));
      },
      match(item, value) {
        const selected = value as string[];
        if (selected.length === 0) return true;
        const fieldValue = config.field(item);
        return fieldValue != null && selected.includes(fieldValue);
      },
      isActive(value) {
        return (value as string[]).length > 0;
      },
    };
  }

  return {
    type: 'enum',
    defaultValue: '',
    label,
    options,
    labels,
    colors,
    multi: false,
    dynamic,
    serialize(value) {
      return value as string;
    },
    deserialize(raw) {
      if (raw && options.includes(raw)) return raw;
      return '';
    },
    match(item, value) {
      if (!value) return true;
      const fieldValue = config.field(item);
      return fieldValue === value;
    },
    isActive(value) {
      return Boolean(value);
    },
  };
}

// ── Date Range Filter ─────────────────────────────────────────

/** Value type for dateRangeFilter. */
export interface DateRangeFilterValue {
  preset?: string;
  after?: string;
  before?: string;
}

/** Configuration for date range filter. */
interface DateRangeFilterConfig<TItem> {
  field: (item: TItem) => string | null;
  presets?: string[];
  label?: string;
}

/** Date range filter — supports presets and explicit after/before bounds. */
export function dateRangeFilter<TItem>(
  config: DateRangeFilterConfig<TItem>
): FilterDefinition<TItem, DateRangeFilterValue> {
  return {
    type: 'dateRange',
    defaultValue: {},
    label: config.label,
    serialize(value) {
      const parts: string[] = [];
      if (value.preset) parts.push(`preset:${value.preset}`);
      if (value.after) parts.push(`after:${value.after}`);
      if (value.before) parts.push(`before:${value.before}`);
      return parts.join(',');
    },
    deserialize(raw) {
      if (!raw) return {};
      const result: DateRangeFilterValue = {};
      for (const part of raw.split(',')) {
        const colonIdx = part.indexOf(':');
        if (colonIdx === -1) continue;
        const key = part.slice(0, colonIdx);
        const val = part.slice(colonIdx + 1);
        if (key === 'preset') result.preset = val;
        else if (key === 'after') result.after = val;
        else if (key === 'before') result.before = val;
      }
      return result;
    },
    match(item, value) {
      const fieldRaw = config.field(item);
      if (fieldRaw == null) return false;
      if (value.preset) {
        const ms = PRESET_DURATIONS[value.preset];
        if (ms == null) return true;
        return Date.now() - ms < Date.parse(fieldRaw);
      }
      const fieldTime = Date.parse(fieldRaw);
      if (value.after && fieldTime < Date.parse(value.after)) return false;
      if (value.before && fieldTime > Date.parse(value.before)) return false;
      return true;
    },
    isActive(value) {
      return Boolean(value.preset ?? value.after ?? value.before);
    },
  };
}

// ── Boolean Filter ────────────────────────────────────────────

/** Configuration for boolean filter. */
interface BooleanFilterConfig<TItem> {
  field: (item: TItem) => boolean;
  label?: string;
}

/** Boolean filter — null means no filter applied. */
export function booleanFilter<TItem>(
  config: BooleanFilterConfig<TItem>
): FilterDefinition<TItem, boolean | null> {
  return {
    type: 'boolean',
    defaultValue: null,
    label: config.label,
    serialize(value) {
      if (value === null) return '';
      return String(value);
    },
    deserialize(raw) {
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      return null;
    },
    match(item, value) {
      if (value === null) return true;
      return config.field(item) === value;
    },
    isActive(value) {
      return value !== null;
    },
  };
}

// ── Numeric Range Filter ──────────────────────────────────────

/** Value type for numericRangeFilter. */
export interface NumericRangeFilterValue {
  min?: number;
  max?: number;
}

/** Configuration for numeric range filter. */
interface NumericRangeFilterConfig<TItem> {
  field: (item: TItem) => number;
  label?: string;
}

/** Numeric range filter — supports min, max, or both bounds. */
export function numericRangeFilter<TItem>(
  config: NumericRangeFilterConfig<TItem>
): FilterDefinition<TItem, NumericRangeFilterValue> {
  return {
    type: 'numericRange',
    defaultValue: {},
    label: config.label,
    serialize(value) {
      const parts: string[] = [];
      if (value.min !== undefined) parts.push(`min:${value.min}`);
      if (value.max !== undefined) parts.push(`max:${value.max}`);
      return parts.join(',');
    },
    deserialize(raw) {
      if (!raw) return {};
      const result: NumericRangeFilterValue = {};
      for (const part of raw.split(',')) {
        const colonIdx = part.indexOf(':');
        if (colonIdx === -1) continue;
        const key = part.slice(0, colonIdx);
        const val = Number(part.slice(colonIdx + 1));
        if (!isNaN(val)) {
          if (key === 'min') result.min = val;
          else if (key === 'max') result.max = val;
        }
      }
      return result;
    },
    match(item, value) {
      const fieldValue = config.field(item);
      if (value.min !== undefined && fieldValue < value.min) return false;
      if (value.max !== undefined && fieldValue > value.max) return false;
      return true;
    },
    isActive(value) {
      return value.min !== undefined || value.max !== undefined;
    },
  };
}

// ── Sort ──────────────────────────────────────────────────────

/** A single sort option definition. */
export interface SortOption<TItem> {
  label: string;
  accessor: (item: TItem) => string | number | null;
  direction?: 'asc' | 'desc';
}

/** Record of named sort options. */
export type SortOptions<TItem> = Record<string, SortOption<TItem>>;

/** Current sort state — field key + direction. */
export interface SortState {
  field: string;
  direction: 'asc' | 'desc';
}

/**
 * Returns the sort options record with inferred types.
 *
 * @param options - Named sort option definitions
 */
export function createSortOptions<TItem>(options: SortOptions<TItem>): SortOptions<TItem> {
  return options;
}

/**
 * Applies filters then sorts the result.
 *
 * Null values from the accessor sort to the end regardless of direction.
 *
 * @param items - Source array
 * @param schema - Filter schema created with createFilterSchema
 * @param filterValues - Current filter values
 * @param sortOptions - Sort option definitions
 * @param sortState - Active sort field and direction
 */
export function applySortAndFilter<
  TItem,
  TDefs extends Record<string, FilterDefinition<TItem, unknown>>,
>(
  items: TItem[],
  schema: FilterSchema<TItem, TDefs>,
  filterValues: Partial<FilterValues<TDefs>>,
  sortOptions: SortOptions<TItem>,
  sortState: SortState
): TItem[] {
  const filtered = schema.applyFilters(items, filterValues);
  const option = sortOptions[sortState.field];
  if (!option) return filtered;

  return [...filtered].sort((a, b) => {
    const aVal = option.accessor(a);
    const bVal = option.accessor(b);

    // Null sorts to end
    if (aVal === null && bVal === null) return 0;
    if (aVal === null) return 1;
    if (bVal === null) return -1;

    const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
    return sortState.direction === 'desc' ? -cmp : cmp;
  });
}

// ── Schema Builder ───────────────────────────────────────────

/** Create a typed filter schema from a record of filter definitions. */
export function createFilterSchema<
  TItem,
  TDefs extends Record<string, FilterDefinition<TItem, unknown>> = Record<
    string,
    FilterDefinition<TItem, unknown>
  >,
>(definitions: TDefs): FilterSchema<TItem, TDefs> {
  const defaultValues = Object.fromEntries(
    Object.entries(definitions).map(([key, def]) => [key, def.defaultValue])
  ) as FilterValues<TDefs>;

  // Build Zod schema for URL search params
  const zodFields: Record<string, z.ZodTypeAny> = {};
  for (const key of Object.keys(definitions)) {
    zodFields[key] = z.string().optional();
  }
  const searchValidator = z.object(zodFields);

  return {
    definitions,
    defaultValues,
    searchValidator,

    applyFilters(items, values) {
      return items.filter((item) =>
        Object.entries(definitions).every(([key, def]) => {
          const value = (values as Record<string, unknown>)[key] ?? def.defaultValue;
          if (!def.isActive(value)) return true;
          return def.match(item, value);
        })
      );
    },

    isFiltered(values) {
      return Object.entries(definitions).some(([key, def]) => {
        const value = (values as Record<string, unknown>)[key] ?? def.defaultValue;
        return def.isActive(value);
      });
    },

    activeCount(values) {
      return Object.entries(definitions).filter(([key, def]) => {
        const value = (values as Record<string, unknown>)[key] ?? def.defaultValue;
        return def.isActive(value);
      }).length;
    },

    describeActive(values) {
      const parts: string[] = [];
      for (const [key, def] of Object.entries(definitions)) {
        const value = (values as Record<string, unknown>)[key] ?? def.defaultValue;
        if (!def.isActive(value)) continue;
        const label = def.label ?? key;
        if (def.type === 'text') {
          parts.push(`search '${String(value)}'`);
        } else if (isEnumFilter(def) && def.labels) {
          const resolveLabel = (v: string) => def.labels?.[v] ?? v;
          const display = Array.isArray(value)
            ? (value as string[]).map(resolveLabel).join(', ')
            : resolveLabel(value as string);
          parts.push(`${label} ${display}`);
        } else {
          parts.push(
            `${label} ${Array.isArray(value) ? (value as unknown[]).join(', ') : String(value)}`
          );
        }
      }
      return parts.join(' and ');
    },
  };
}
