import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getDb } from '@/db/client';

import { fetchInstallCount, fetchInstallCounts } from '../telemetry';

vi.mock('@/db/client', () => ({
  getDb: vi.fn(),
}));

/**
 * Extract every string literal from a Drizzle SQL/predicate object by walking
 * its `queryChunks` recursively. Drizzle stores `eq()` and `and()` predicates
 * as a tree of chunks containing column references and parameter values; the
 * raw object is full of circular refs (table → column → table) so JSON.stringify
 * is a non-starter. This walker collects every string + every `value` it sees.
 */
function collectDrizzleStrings(node: unknown, seen = new WeakSet<object>()): string[] {
  if (node === null || node === undefined) return [];
  if (typeof node === 'string') return [node];
  if (typeof node !== 'object') return [];
  if (seen.has(node as object)) return [];
  seen.add(node as object);

  const out: string[] = [];
  // Drizzle column: { name: 'package_name', ... }
  const maybeName = (node as { name?: unknown }).name;
  if (typeof maybeName === 'string') out.push(maybeName);
  // Drizzle Param: { value: 'success', ... }
  const maybeValue = (node as { value?: unknown }).value;
  if (typeof maybeValue === 'string') out.push(maybeValue);
  // Drizzle SQL: { queryChunks: [...] }
  const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
  if (Array.isArray(chunks)) {
    for (const chunk of chunks) out.push(...collectDrizzleStrings(chunk, seen));
  }
  return out;
}

interface MockChain {
  select: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  groupBy: ReturnType<typeof vi.fn>;
}

/**
 * Build a chainable Drizzle mock. The terminal call (`.where()` for
 * `fetchInstallCount`, `.groupBy()` for `fetchInstallCounts`) resolves to the
 * given rows; all earlier calls return the same chain instance so we can also
 * assert on what was passed to each step.
 */
function buildChain(terminal: 'where' | 'groupBy', rows: unknown[]): MockChain {
  const chain: MockChain = {
    select: vi.fn(),
    from: vi.fn(),
    where: vi.fn(),
    groupBy: vi.fn(),
  };
  chain.select.mockReturnValue(chain);
  chain.from.mockReturnValue(chain);
  if (terminal === 'where') {
    chain.where.mockResolvedValue(rows);
    chain.groupBy.mockReturnValue(chain);
  } else {
    chain.where.mockReturnValue(chain);
    chain.groupBy.mockResolvedValue(rows);
  }
  return chain;
}

describe('fetchInstallCount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 0 when the result rows array is empty', async () => {
    const chain = buildChain('where', []);
    vi.mocked(getDb).mockReturnValue(chain as never);

    const count = await fetchInstallCount('code-reviewer');

    expect(count).toBe(0);
  });

  it('returns the count when one row is present', async () => {
    const chain = buildChain('where', [{ count: 42 }]);
    vi.mocked(getDb).mockReturnValue(chain as never);

    const count = await fetchInstallCount('code-reviewer');

    expect(count).toBe(42);
  });

  it('returns 0 when the row exists but count is null/undefined', async () => {
    const chain = buildChain('where', [{ count: undefined }]);
    vi.mocked(getDb).mockReturnValue(chain as never);

    const count = await fetchInstallCount('code-reviewer');

    expect(count).toBe(0);
  });

  it('passes a where filter combining marketplace, packageName, and outcome=success', async () => {
    const chain = buildChain('where', [{ count: 7 }]);
    vi.mocked(getDb).mockReturnValue(chain as never);

    await fetchInstallCount('test-pkg');

    expect(chain.select).toHaveBeenCalledTimes(1);
    expect(chain.from).toHaveBeenCalledTimes(1);
    expect(chain.where).toHaveBeenCalledTimes(1);
    // The where clause is a Drizzle SQL predicate tree (full of circular refs).
    // Walk it and collect every column name + parameter value.
    const predicate = chain.where.mock.calls[0]![0];
    const tokens = collectDrizzleStrings(predicate);
    expect(tokens).toContain('marketplace');
    expect(tokens).toContain('package_name');
    expect(tokens).toContain('outcome');
    expect(tokens).toContain('success');
    expect(tokens).toContain('test-pkg');
    expect(tokens).toContain('dorkos-community');
  });

  it('calls getDb() lazily inside the function (not at module import time)', async () => {
    // Reset import-time call count, then invoke and assert exactly one call.
    vi.mocked(getDb).mockClear();
    const chain = buildChain('where', [{ count: 1 }]);
    vi.mocked(getDb).mockReturnValue(chain as never);

    expect(getDb).not.toHaveBeenCalled();
    await fetchInstallCount('lazy-pkg');
    expect(getDb).toHaveBeenCalledTimes(1);
  });
});

describe('fetchInstallCounts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns an empty object when no rows are returned', async () => {
    const chain = buildChain('groupBy', []);
    vi.mocked(getDb).mockReturnValue(chain as never);

    const counts = await fetchInstallCounts();

    expect(counts).toEqual({});
  });

  it('returns a map of packageName → count for every row', async () => {
    const chain = buildChain('groupBy', [
      { packageName: 'foo', count: 5 },
      { packageName: 'bar', count: 12 },
      { packageName: 'baz', count: 1 },
    ]);
    vi.mocked(getDb).mockReturnValue(chain as never);

    const counts = await fetchInstallCounts();

    expect(counts).toEqual({ foo: 5, bar: 12, baz: 1 });
  });

  it('passes a where filter scoped to marketplace=dorkos-community AND outcome=success', async () => {
    const chain = buildChain('groupBy', [{ packageName: 'foo', count: 1 }]);
    vi.mocked(getDb).mockReturnValue(chain as never);

    await fetchInstallCounts();

    expect(chain.select).toHaveBeenCalledTimes(1);
    expect(chain.from).toHaveBeenCalledTimes(1);
    expect(chain.where).toHaveBeenCalledTimes(1);
    expect(chain.groupBy).toHaveBeenCalledTimes(1);

    const predicate = chain.where.mock.calls[0]![0];
    const tokens = collectDrizzleStrings(predicate);
    expect(tokens).toContain('marketplace');
    expect(tokens).toContain('outcome');
    expect(tokens).toContain('dorkos-community');
    expect(tokens).toContain('success');
    // Per-package filter must NOT be present on the aggregate query.
    expect(tokens).not.toContain('package_name');
  });

  it('groups by the package_name column', async () => {
    const chain = buildChain('groupBy', [{ packageName: 'foo', count: 1 }]);
    vi.mocked(getDb).mockReturnValue(chain as never);

    await fetchInstallCounts();

    const groupByArg = chain.groupBy.mock.calls[0]![0];
    // The Drizzle column object exposes its underlying name on `.name`.
    expect((groupByArg as { name?: string }).name).toBe('package_name');
  });

  it('calls getDb() lazily inside the function (not at module import time)', async () => {
    vi.mocked(getDb).mockClear();
    const chain = buildChain('groupBy', []);
    vi.mocked(getDb).mockReturnValue(chain as never);

    expect(getDb).not.toHaveBeenCalled();
    await fetchInstallCounts();
    expect(getDb).toHaveBeenCalledTimes(1);
  });
});
