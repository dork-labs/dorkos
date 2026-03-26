/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import {
  textFilter,
  enumFilter,
  dateRangeFilter,
  booleanFilter,
  numericRangeFilter,
  createFilterSchema,
  createSortOptions,
  applySortAndFilter,
} from '../filter-engine';

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

// ── enumFilter ────────────────────────────────────────────────

interface StatusItem {
  name: string;
  status: string;
}

const statusItems: StatusItem[] = [
  { name: 'Alpha', status: 'active' },
  { name: 'Beta', status: 'idle' },
  { name: 'Gamma', status: 'active' },
  { name: 'Delta', status: 'error' },
];

describe('enumFilter (single)', () => {
  const schema = createFilterSchema<StatusItem>({
    status: enumFilter({
      field: (item) => item.status,
      options: ['active', 'idle', 'error'],
    }),
  });

  it('filters to exact match', () => {
    const result = schema.applyFilters(statusItems, { status: 'active' });
    expect(result).toHaveLength(2);
    expect(result.every((i) => i.status === 'active')).toBe(true);
  });

  it('returns all items when value is default empty string', () => {
    const result = schema.applyFilters(statusItems, { status: '' });
    expect(result).toHaveLength(4);
  });

  it('isActive is false for empty string', () => {
    const filter = enumFilter({ field: (i: StatusItem) => i.status, options: ['active'] });
    expect(filter.isActive('')).toBe(false);
  });

  it('isActive is true for non-empty value', () => {
    const filter = enumFilter({ field: (i: StatusItem) => i.status, options: ['active'] });
    expect(filter.isActive('active')).toBe(true);
  });
});

describe('enumFilter (multi)', () => {
  const schema = createFilterSchema<StatusItem>({
    status: enumFilter({
      field: (item) => item.status,
      options: ['active', 'idle', 'error'],
      multi: true,
    }),
  });

  it('matches any of the selected values', () => {
    const result = schema.applyFilters(statusItems, { status: ['active', 'error'] });
    expect(result).toHaveLength(3);
    expect(result.map((i) => i.name).sort()).toEqual(['Alpha', 'Delta', 'Gamma'].sort());
  });

  it('returns all items when selection is empty array', () => {
    const result = schema.applyFilters(statusItems, { status: [] });
    expect(result).toHaveLength(4);
  });

  it('isActive is false for empty array', () => {
    const filter = enumFilter({
      field: (i: StatusItem) => i.status,
      options: ['active'],
      multi: true,
    });
    expect(filter.isActive([])).toBe(false);
  });

  it('isActive is true for non-empty array', () => {
    const filter = enumFilter({
      field: (i: StatusItem) => i.status,
      options: ['active'],
      multi: true,
    });
    expect(filter.isActive(['active'])).toBe(true);
  });
});

describe('enumFilter serialization', () => {
  it('round-trips single value', () => {
    const filter = enumFilter({
      field: (i: StatusItem) => i.status,
      options: ['active', 'idle', 'error'],
    });
    expect(filter.deserialize(filter.serialize('idle'))).toBe('idle');
  });

  it('round-trips multi value', () => {
    const filter = enumFilter({
      field: (i: StatusItem) => i.status,
      options: ['active', 'idle', 'error'],
      multi: true,
    });
    const result = filter.deserialize(filter.serialize(['active', 'error']));
    expect(result).toEqual(['active', 'error']);
  });

  it('invalid single value falls back to default empty string', () => {
    const filter = enumFilter({
      field: (i: StatusItem) => i.status,
      options: ['active', 'idle', 'error'],
    });
    expect(filter.deserialize('unknown')).toBe('');
  });

  it('invalid values in multi are filtered out', () => {
    const filter = enumFilter({
      field: (i: StatusItem) => i.status,
      options: ['active', 'idle', 'error'],
      multi: true,
    });
    expect(filter.deserialize('active,unknown,idle')).toEqual(['active', 'idle']);
  });
});

// ── dateRangeFilter ───────────────────────────────────────────

interface TimestampItem {
  name: string;
  createdAt: string;
}

describe('dateRangeFilter', () => {
  const now = Date.now();
  const tsItems: TimestampItem[] = [
    { name: 'Recent', createdAt: new Date(now - 3_600_000 / 2).toISOString() }, // 30m ago
    { name: 'OldMonth', createdAt: new Date(now - 10 * 86_400_000).toISOString() }, // 10d ago
    { name: 'LastWeek', createdAt: new Date(now - 5 * 86_400_000).toISOString() }, // 5d ago
  ];

  const schema = createFilterSchema<TimestampItem>({
    date: dateRangeFilter({ field: (item) => item.createdAt }),
  });

  it('preset 24h returns only items within last 24 hours', () => {
    const result = schema.applyFilters(tsItems, { date: { preset: '24h' } });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Recent');
  });

  it('preset 7d returns items within last 7 days', () => {
    const result = schema.applyFilters(tsItems, { date: { preset: '7d' } });
    expect(result).toHaveLength(2);
    expect(result.map((i) => i.name).sort()).toEqual(['LastWeek', 'Recent']);
  });

  it('no filter (empty object) returns all items', () => {
    const result = schema.applyFilters(tsItems, { date: {} });
    expect(result).toHaveLength(3);
  });

  it('isActive is false for empty object', () => {
    const filter = dateRangeFilter({ field: (i: TimestampItem) => i.createdAt });
    expect(filter.isActive({})).toBe(false);
  });

  it('isActive is true when preset is set', () => {
    const filter = dateRangeFilter({ field: (i: TimestampItem) => i.createdAt });
    expect(filter.isActive({ preset: '24h' })).toBe(true);
  });
});

// ── booleanFilter ─────────────────────────────────────────────

interface FlagItem {
  name: string;
  active: boolean;
}

describe('booleanFilter', () => {
  const flagItems: FlagItem[] = [
    { name: 'A', active: true },
    { name: 'B', active: false },
    { name: 'C', active: true },
  ];

  const schema = createFilterSchema<FlagItem>({
    active: booleanFilter({ field: (item) => item.active, label: 'Active' }),
  });

  it('filters to true values', () => {
    const result = schema.applyFilters(flagItems, { active: true });
    expect(result).toHaveLength(2);
    expect(result.every((i) => i.active)).toBe(true);
  });

  it('filters to false values', () => {
    const result = schema.applyFilters(flagItems, { active: false });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('B');
  });

  it('null returns all items', () => {
    const result = schema.applyFilters(flagItems, { active: null });
    expect(result).toHaveLength(3);
  });

  it('isActive is false for null', () => {
    const filter = booleanFilter({ field: (i: FlagItem) => i.active });
    expect(filter.isActive(null)).toBe(false);
  });

  it('isActive is true for true or false', () => {
    const filter = booleanFilter({ field: (i: FlagItem) => i.active });
    expect(filter.isActive(true)).toBe(true);
    expect(filter.isActive(false)).toBe(true);
  });
});

// ── numericRangeFilter ────────────────────────────────────────

interface ScoreItem {
  name: string;
  score: number;
}

describe('numericRangeFilter', () => {
  const scoreItems: ScoreItem[] = [
    { name: 'Low', score: 10 },
    { name: 'Mid', score: 50 },
    { name: 'High', score: 90 },
  ];

  const schema = createFilterSchema<ScoreItem>({
    score: numericRangeFilter({ field: (item) => item.score }),
  });

  it('filters by min bound', () => {
    const result = schema.applyFilters(scoreItems, { score: { min: 50 } });
    expect(result).toHaveLength(2);
    expect(result.map((i) => i.name).sort()).toEqual(['High', 'Mid'].sort());
  });

  it('filters by max bound', () => {
    const result = schema.applyFilters(scoreItems, { score: { max: 50 } });
    expect(result).toHaveLength(2);
    expect(result.map((i) => i.name).sort()).toEqual(['Low', 'Mid'].sort());
  });

  it('filters by min and max range', () => {
    const result = schema.applyFilters(scoreItems, { score: { min: 20, max: 80 } });
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Mid');
  });

  it('empty object returns all items', () => {
    const result = schema.applyFilters(scoreItems, { score: {} });
    expect(result).toHaveLength(3);
  });

  it('isActive is false for empty object', () => {
    const filter = numericRangeFilter({ field: (i: ScoreItem) => i.score });
    expect(filter.isActive({})).toBe(false);
  });

  it('isActive is true when min or max is defined', () => {
    const filter = numericRangeFilter({ field: (i: ScoreItem) => i.score });
    expect(filter.isActive({ min: 0 })).toBe(true);
    expect(filter.isActive({ max: 100 })).toBe(true);
  });
});

// ── applySortAndFilter ────────────────────────────────────────

describe('applySortAndFilter', () => {
  const sortItems: StatusItem[] = [
    { name: 'Charlie', status: 'active' },
    { name: 'Alice', status: 'idle' },
    { name: 'Bob', status: 'active' },
  ];

  const schema = createFilterSchema<StatusItem>({
    status: enumFilter({
      field: (item) => item.status,
      options: ['active', 'idle', 'error'],
    }),
  });

  const sortOptions = createSortOptions<StatusItem>({
    name: { label: 'Name', accessor: (item) => item.name },
    status: { label: 'Status', accessor: (item) => item.status },
  });

  it('filters then sorts ascending', () => {
    const result = applySortAndFilter(sortItems, schema, { status: 'active' }, sortOptions, {
      field: 'name',
      direction: 'asc',
    });
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('Bob');
    expect(result[1].name).toBe('Charlie');
  });

  it('sorts descending', () => {
    const result = applySortAndFilter(sortItems, schema, {}, sortOptions, {
      field: 'name',
      direction: 'desc',
    });
    expect(result[0].name).toBe('Charlie');
    expect(result[1].name).toBe('Bob');
    expect(result[2].name).toBe('Alice');
  });

  it('sorts null values to end', () => {
    interface NullableItem {
      name: string;
      value: string | null;
    }
    const nullItems: NullableItem[] = [
      { name: 'A', value: 'z' },
      { name: 'B', value: null },
      { name: 'C', value: 'a' },
    ];
    const nullSchema = createFilterSchema<NullableItem>({});
    const nullSortOptions = createSortOptions<NullableItem>({
      value: { label: 'Value', accessor: (item) => item.value },
    });
    const result = applySortAndFilter(nullItems, nullSchema, {}, nullSortOptions, {
      field: 'value',
      direction: 'asc',
    });
    expect(result[0].name).toBe('C');
    expect(result[1].name).toBe('A');
    expect(result[2].name).toBe('B');
  });
});

// ── describeActive ────────────────────────────────────────────

describe('describeActive', () => {
  it('describes a single text filter', () => {
    const schema = createFilterSchema<TestItem>({
      search: textFilter({ fields: [(a) => a.name] }),
    });
    expect(schema.describeActive({ search: 'deploy' })).toBe("search 'deploy'");
  });

  it('describes a single enum filter with labels', () => {
    const schema = createFilterSchema<StatusItem>({
      status: enumFilter({
        field: (item) => item.status,
        options: ['active', 'idle'],
        labels: { active: 'Active', idle: 'Idle' },
        label: 'Status',
      }),
    });
    expect(schema.describeActive({ status: 'active' })).toBe('Status Active');
  });

  it('describes multiple active filters joined with and', () => {
    const schema = createFilterSchema<StatusItem>({
      search: textFilter<StatusItem>({ fields: [(a) => a.name] }),
      status: enumFilter({
        field: (item) => item.status,
        options: ['active', 'idle'],
        label: 'Status',
      }),
    });
    const desc = schema.describeActive({ search: 'bot', status: 'active' });
    expect(desc).toBe("search 'bot' and Status active");
  });

  it('returns empty string when no filters are active', () => {
    const schema = createFilterSchema<TestItem>({
      search: textFilter({ fields: [(a) => a.name] }),
    });
    expect(schema.describeActive({ search: '' })).toBe('');
  });
});

// ── searchValidator ───────────────────────────────────────────

describe('searchValidator', () => {
  const schema = createFilterSchema<StatusItem>({
    search: textFilter<StatusItem>({ fields: [(a) => a.name] }),
    status: enumFilter({
      field: (item) => item.status,
      options: ['active', 'idle', 'error'],
    }),
  });

  it('generates a Zod schema with optional string fields', () => {
    const result = schema.searchValidator.safeParse({ search: 'hello', status: 'active' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.search).toBe('hello');
      expect(result.data.status).toBe('active');
    }
  });

  it('defaults missing params to undefined', () => {
    const result = schema.searchValidator.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.search).toBeUndefined();
      expect(result.data.status).toBeUndefined();
    }
  });

  it('validates successfully with partial params', () => {
    const result = schema.searchValidator.safeParse({ status: 'idle' });
    expect(result.success).toBe(true);
  });
});
