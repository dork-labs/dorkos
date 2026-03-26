/**
 * URL-synced filter state hook — bridges FilterSchema to TanStack Router search params.
 *
 * Reads filter values from URL search params and provides setters that update the URL.
 * Supports debounced text inputs via per-filter debounce options.
 *
 * @module shared/model/use-filter-state
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useRouter, useSearch } from '@tanstack/react-router';
import type { FilterDefinition, FilterSchema, FilterValues } from '../lib/filter-engine';

// Alias for the route-agnostic search updater type used internally.
// We cast to this when calling navigate without a `to:` — the hook is
// intentionally generic across routes so TanStack Router can't infer the
// route-specific search type at compile time.
type AnySearchUpdater = (
  prev: Record<string, string | undefined>
) => Record<string, string | undefined>;

// ── Types ─────────────────────────────────────────────────────

/** Per-filter debounce configuration. Keys match filter definition keys. */
export type FilterDebounceConfig<TDefs> = Partial<Record<keyof TDefs, number>>;

/** Options for useFilterState. */
export interface UseFilterStateOptions<TDefs> {
  /** Milliseconds to debounce per filter key before committing to URL. */
  debounce?: FilterDebounceConfig<TDefs>;
}

/** Return type of useFilterState. */
export interface UseFilterStateReturn<
  TDefs extends Record<string, FilterDefinition<unknown, unknown>>,
> {
  /** Committed (debounced) values — what's reflected in the URL. */
  values: FilterValues<TDefs>;
  /** Live input values — may differ from `values` during debounce window. */
  inputValues: FilterValues<TDefs>;
  /** Active sort field key. */
  sortField: string;
  /** Active sort direction. */
  sortDirection: 'asc' | 'desc';
  /** True when any filter has an active (non-default) value. */
  isFiltered: boolean;
  /** Number of active filters. */
  activeCount: number;
  /** Set a filter value by name, updating the URL. */
  set(name: keyof TDefs, value: unknown): void;
  /** Clear a single filter, removing its URL param. */
  clear(name: keyof TDefs): void;
  /** Clear all filter params while preserving unrelated URL params (e.g. `view`). */
  clearAll(): void;
  /** Set sort state — encoded as `field:direction` in the URL. */
  setSort(field: string, direction?: 'asc' | 'desc'): void;
  /** Human-readable description of active filters. */
  describeActive(): string;
  /** Pass-through to allow UI components to access filter metadata. */
  schema: FilterSchema<unknown, TDefs>;
}

// ── Helpers ───────────────────────────────────────────────────

const DEFAULT_SORT_DIRECTION = 'asc' as const;

/**
 * Parse `field:direction` sort param.
 *
 * @param raw - Raw URL string value (e.g. `"lastSeen:desc"`)
 */
function parseSortParam(raw: string | undefined): { field: string; direction: 'asc' | 'desc' } {
  if (!raw) return { field: '', direction: DEFAULT_SORT_DIRECTION };
  const colonIdx = raw.indexOf(':');
  if (colonIdx === -1) return { field: raw, direction: DEFAULT_SORT_DIRECTION };
  const field = raw.slice(0, colonIdx);
  const dir = raw.slice(colonIdx + 1);
  return { field, direction: dir === 'desc' ? 'desc' : 'asc' };
}

/**
 * Deserialize all filter params from the raw URL search record.
 *
 * @param definitions - Filter definition map from schema
 * @param search - Raw URL search params record
 */
function deserializeAll<TItem, TDefs extends Record<string, FilterDefinition<TItem, unknown>>>(
  definitions: TDefs,
  search: Record<string, string>
): FilterValues<TDefs> {
  return Object.fromEntries(
    Object.entries(definitions).map(([key, def]) => {
      const raw = search[key];
      return [key, raw !== undefined ? def.deserialize(raw) : def.defaultValue];
    })
  ) as FilterValues<TDefs>;
}

/**
 * Serialize a single filter value to its URL string, returning undefined when it equals the default
 * so the URL stays clean when no filter is active.
 *
 * @param def - Filter definition
 * @param value - Current value
 */
function serializeOrOmit<TItem>(
  def: FilterDefinition<TItem, unknown>,
  value: unknown
): string | undefined {
  const serialized = def.serialize(value as never);
  const defaultSerialized = def.serialize(def.defaultValue as never);
  return serialized === defaultSerialized ? undefined : serialized;
}

// ── Hook ──────────────────────────────────────────────────────

/**
 * URL-synced filter state hook.
 *
 * Reads filter values from TanStack Router search params and exposes typed setters that
 * write back to the URL. Supports per-filter debounce so text inputs don't hammer the URL
 * on every keystroke.
 *
 * @param schema - Filter schema created with `createFilterSchema`
 * @param options - Optional debounce configuration per filter key
 */
export function useFilterState<
  TItem,
  TDefs extends Record<string, FilterDefinition<TItem, unknown>>,
>(
  schema: FilterSchema<TItem, TDefs>,
  options: UseFilterStateOptions<TDefs> = {}
): UseFilterStateReturn<TDefs> {
  const { debounce: debounceConfig = {} } = options;
  const navigate = useNavigate();
  // strict: false — works across any route without a registered search schema
  const search = useSearch({ strict: false }) as Record<string, string>;

  const { definitions, defaultValues } = schema;

  // Committed values — derived from URL
  const values = deserializeAll(definitions, search);

  // Input values — may lead committed values during debounce window
  const [inputValues, setInputValues] = useState<FilterValues<TDefs>>(values);

  // Sync inputValues when URL changes externally (e.g. browser back/forward)
  const prevSearchRef = useRef(search);
  useEffect(() => {
    if (prevSearchRef.current !== search) {
      prevSearchRef.current = search;
      setInputValues(deserializeAll(definitions, search));
    }
  }, [search, definitions]);

  // Timer refs for debounce — one per filter key
  const timersRef = useRef<Partial<Record<keyof TDefs, ReturnType<typeof setTimeout>>>>({});

  const { field: sortField, direction: sortDirection } = parseSortParam(search.sort);

  // ── Actions ─────────────────────────────────────────────────

  const commitToUrl = useCallback(
    (name: keyof TDefs, serialized: string | undefined) => {
      // Cast required: this hook is route-agnostic (strict: false), so TanStack
      // Router cannot resolve the route-specific search type at compile time.
      const updater: AnySearchUpdater = (prev) => ({ ...prev, [name as string]: serialized });
      navigate({ search: updater as never });
    },
    [navigate]
  );

  const set = useCallback(
    (name: keyof TDefs, value: unknown) => {
      const def = definitions[name as string];
      if (!def) return;

      const serialized = serializeOrOmit(def as FilterDefinition<TItem, unknown>, value);
      const delay = (debounceConfig as Record<keyof TDefs, number | undefined>)[name];

      if (delay !== undefined && delay > 0) {
        // Update live input immediately
        setInputValues((prev) => ({ ...prev, [name]: value }));

        // Debounce URL commit
        const existing = timersRef.current[name];
        if (existing !== undefined) clearTimeout(existing);
        timersRef.current[name] = setTimeout(() => {
          delete timersRef.current[name];
          commitToUrl(name, serialized);
        }, delay);
      } else {
        // No debounce — commit directly and keep inputValues in sync
        setInputValues((prev) => ({ ...prev, [name]: value }));
        commitToUrl(name, serialized);
      }
    },
    [definitions, debounceConfig, commitToUrl]
  );

  const clear = useCallback(
    (name: keyof TDefs) => {
      const defaultVal = defaultValues[name];
      const def = definitions[name as string];
      if (!def) return;
      setInputValues((prev) => ({ ...prev, [name]: defaultVal }));
      commitToUrl(name, undefined);
    },
    [definitions, defaultValues, commitToUrl]
  );

  const clearAll = useCallback(() => {
    const filterKeys = new Set(Object.keys(definitions));
    setInputValues({ ...defaultValues });
    const updater: AnySearchUpdater = (prev) => {
      const next = { ...prev };
      for (const key of filterKeys) {
        delete next[key];
      }
      // Also remove sort param on clear all
      delete next.sort;
      return next;
    };
    navigate({ search: updater as never });
  }, [definitions, defaultValues, navigate]);

  const setSort = useCallback(
    (field: string, direction: 'asc' | 'desc' = DEFAULT_SORT_DIRECTION) => {
      const updater: AnySearchUpdater = (prev) => ({ ...prev, sort: `${field}:${direction}` });
      navigate({ search: updater as never });
    },
    [navigate]
  );

  // ── Derived state ────────────────────────────────────────────

  const isFiltered = schema.isFiltered(values);
  const activeCount = schema.activeCount(values);

  const describeActive = useCallback(() => {
    return schema.describeActive(values);
  }, [schema, values]);

  return {
    values,
    inputValues,
    sortField,
    sortDirection,
    isFiltered,
    activeCount,
    set,
    clear,
    clearAll,
    setSort,
    describeActive,
    schema: schema as unknown as FilterSchema<unknown, TDefs>,
  };
}
