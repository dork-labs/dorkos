import { describe, expect, it, vi } from 'vitest';

// A test elsewhere may replace `node:fs` with only what it needs. Anything
// that imports this module transitively must still load (DOR-2321).
vi.mock('node:fs', () => ({ existsSync: vi.fn() }));

describe('bounded-read with node:fs replaced', () => {
  // Purpose: the open flags are read when a file is opened, not when the
  // module loads, so a partial `node:fs` mock does not break importing it.
  it('loads without touching node:fs', async () => {
    const mod = await import('../bounded-read.js');
    expect(typeof mod.readTextFileWithin).toBe('function');
  });
});
