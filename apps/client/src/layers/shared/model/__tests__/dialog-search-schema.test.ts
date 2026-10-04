import { describe, it, expect } from 'vitest';
import {
  dialogSearchSchema,
  DIALOG_ADDRESS_KEYS,
  DIALOG_MODIFIER_KEYS,
} from '../dialog-search-schema';

describe('dialog search params — modifier or address (DOR-2107)', () => {
  it('classifies every schema key exactly once', () => {
    // Purpose: a new dialog param must be placed deliberately, or tab history
    // silently treats it as a new page (or swallows a profile's Back steps).
    const classified = [...DIALOG_MODIFIER_KEYS, ...DIALOG_ADDRESS_KEYS];
    expect(new Set(classified).size).toBe(classified.length);
    expect([...classified].sort()).toEqual(Object.keys(dialogSearchSchema.shape).sort());
  });
});
