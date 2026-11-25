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

  it('is case-insensitive', () => {
    const result = schema.applyFilters(items, { search: 'DEPLOY' });
    expect(result).toHaveLength(1);
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
});

// ── describeActive ────────────────────────────────────────────

describe('describeActive', () => {
  it('describes a single text filter', () => {
    const schema = createFilterSchema<TestItem>({
      search: textFilter({ fields: [(a) => a.name] }),
    });
    expect(schema.describeActive({ search: 'deploy' })).toBe("search 'deploy'");
  });
});

// ── searchValidator ───────────────────────────────────────────
