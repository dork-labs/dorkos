import { describe, expect, it } from 'vitest';
import { randomUuidFromValues } from '../random-uuid-polyfill';

describe('randomUuidFromValues', () => {
  it('makes version 4 ids in the RFC 9562 layout, a different one each time', () => {
    const ids = new Set(Array.from({ length: 200 }, () => randomUuidFromValues()));
    expect(ids.size).toBe(200);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });
});
