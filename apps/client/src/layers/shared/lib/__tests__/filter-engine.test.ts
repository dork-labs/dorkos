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
