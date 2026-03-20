import { describe, it, expect } from 'vitest';
import { getCategoryColorClasses, ADAPTER_CATEGORY_COLORS } from '../category-colors';

describe('getCategoryColorClasses', () => {
  it('returns correct classes for "messaging" category', () => {
    expect(getCategoryColorClasses('messaging')).toBe(
      'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200'
    );
  });

  it('returns correct classes for "automation" category', () => {
    expect(getCategoryColorClasses('automation')).toBe(
      'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200'
    );
  });

  it('returns correct classes for "internal" category', () => {
    expect(getCategoryColorClasses('internal')).toBe(
      'bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200'
    );
  });

  it('returns correct classes for "custom" category', () => {
    expect(getCategoryColorClasses('custom')).toBe(
      'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
    );
  });

  it('returns empty string for unknown category', () => {
    expect(getCategoryColorClasses('unknown')).toBe('');
  });

  it('returns empty string for empty string category', () => {
    expect(getCategoryColorClasses('')).toBe('');
  });

  it('ADAPTER_CATEGORY_COLORS contains all expected categories', () => {
    expect(Object.keys(ADAPTER_CATEGORY_COLORS)).toEqual([
      'messaging',
      'automation',
      'internal',
      'custom',
    ]);
  });
});
