import { describe, it, expect } from 'vitest';
import { isDynamicImportError } from '../dynamic-import-error';

describe('isDynamicImportError', () => {
  it.each([
    'Failed to fetch dynamically imported module: https://app/assets/index-abc123.js',
    'Loading chunk 5 failed',
    'Importing a module script failed',
    'ChunkLoadError',
  ])('returns true for a stale-chunk error: %s', (message) => {
    expect(isDynamicImportError(new Error(message))).toBe(true);
  });

  it('returns false for an unrelated error', () => {
    expect(isDynamicImportError(new Error('TypeError: x is not a function'))).toBe(false);
  });
});
