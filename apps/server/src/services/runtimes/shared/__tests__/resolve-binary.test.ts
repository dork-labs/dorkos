import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import { resolveRuntimeBinary } from '../resolve-binary.js';

// Existence is the only real-world dependency; mock it so the precedence and
// authoritative short-circuit rules are tested in isolation.
vi.mock('node:fs', () => ({ existsSync: vi.fn() }));

describe('resolveRuntimeBinary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the FIRST existing candidate and skips ones whose path does not exist', async () => {
    vi.mocked(existsSync).mockImplementation((p) => p === '/b');

    const result = await resolveRuntimeBinary([
      { resolve: () => '/a' },
      { resolve: () => '/b' },
      { resolve: () => '/c' },
    ]);

    expect(result).toBe('/b');
  });

  it('skips a candidate that produces null and tries the next source', async () => {
    vi.mocked(existsSync).mockImplementation((p) => p === '/present');

    const result = await resolveRuntimeBinary([
      { resolve: () => null },
      { resolve: () => '/present' },
    ]);

    expect(result).toBe('/present');
  });

  it('falls through a non-authoritative candidate whose path is absent', async () => {
    vi.mocked(existsSync).mockImplementation((p) => p === '/present');

    const result = await resolveRuntimeBinary([
      { resolve: () => '/missing' },
      { resolve: () => '/present' },
    ]);

    expect(result).toBe('/present');
  });

  it('uses an authoritative candidate when its path exists', async () => {
    vi.mocked(existsSync).mockImplementation((p) => p === '/configured');
    const laterCandidate = vi.fn(() => '/present');

    const result = await resolveRuntimeBinary([
      { resolve: () => '/configured', authoritative: true },
      { resolve: laterCandidate },
    ]);

    expect(result).toBe('/configured');
    // The authoritative candidate won — later sources were never consulted.
    expect(laterCandidate).not.toHaveBeenCalled();
  });

  it('short-circuits to null when an authoritative candidate is set-but-absent (never falls through)', async () => {
    // /present WOULD resolve, but the authoritative configured path is honored:
    // a set-but-absent override reports missing rather than probing PATH.
    vi.mocked(existsSync).mockImplementation((p) => p === '/present');
    const laterCandidate = vi.fn(() => '/present');

    const result = await resolveRuntimeBinary([
      { resolve: () => '/configured', authoritative: true },
      { resolve: laterCandidate },
    ]);

    expect(result).toBeNull();
    expect(laterCandidate).not.toHaveBeenCalled();
  });

  it('falls through an authoritative candidate that produces null (unset config), not a miss', async () => {
    vi.mocked(existsSync).mockImplementation((p) => p === '/present');

    const result = await resolveRuntimeBinary([
      { resolve: () => null, authoritative: true },
      { resolve: () => '/present' },
    ]);

    expect(result).toBe('/present');
  });

  it('awaits async producers (a PATH lookup that shells out)', async () => {
    vi.mocked(existsSync).mockImplementation((p) => p === '/from-path');

    const result = await resolveRuntimeBinary([
      { resolve: () => null },
      { resolve: async () => '/from-path' },
    ]);

    expect(result).toBe('/from-path');
  });

  it('returns null when no candidate resolves an existing path', async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const result = await resolveRuntimeBinary([
      { resolve: () => null },
      { resolve: () => '/nope' },
      { resolve: async () => null },
    ]);

    expect(result).toBeNull();
  });
});
