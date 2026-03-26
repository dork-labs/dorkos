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
