import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchMarketplaceJson } from '../fetch';
import { fetchRegistryUpdatedAt } from '../updated-at';

vi.mock('../fetch', () => ({
  fetchMarketplaceJson: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal merged-entry stand-in — only `name` and `source` are read. */
function entry(name: string, source: unknown) {
  return { name, source } as never;
}

/** A GitHub commits API response carrying a single commit date. */
function commitResponse(date: string): Response {
  return new Response(JSON.stringify([{ commit: { committer: { date } } }]), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** An empty GitHub commits API response (path is not a directory in the repo). */
function emptyCommitResponse(): Response {
  return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
}

function mockRegistry(plugins: Array<ReturnType<typeof entry>>, pluginRoot?: string): void {
  vi.mocked(fetchMarketplaceJson).mockResolvedValue({
    marketplace: { metadata: pluginRoot ? { pluginRoot } : undefined },
    sidecar: null,
    plugins,
    orphans: [],
  } as never);
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fetchRegistryUpdatedAt', () => {
  it('stamps relative-path packages with the last-commit date of their directory', async () => {
    mockRegistry([
      entry('flow', './plugins/flow'),
      entry('code-reviewer', './plugins/code-reviewer'),
    ]);
    fetchSpy.mockImplementation((url) => {
      const u = String(url);
      if (u.includes('plugins%2Fflow'))
        return Promise.resolve(commitResponse('2026-07-18T17:41:20Z'));
      return Promise.resolve(commitResponse('2026-07-10T09:00:00Z'));
    });

    const result = await fetchRegistryUpdatedAt();

    expect(result).toEqual({
      flow: '2026-07-18T17:41:20Z',
      'code-reviewer': '2026-07-10T09:00:00Z',
    });
  });

  it('queries the package directory path against the registry commits API', async () => {
    mockRegistry([entry('flow', './plugins/flow')]);
    fetchSpy.mockResolvedValue(commitResponse('2026-07-18T17:41:20Z'));

    await fetchRegistryUpdatedAt();

    const calledUrl = String(fetchSpy.mock.calls[0]?.[0]);
    expect(calledUrl).toContain('https://api.github.com/repos/dork-labs/marketplace/commits');
    expect(calledUrl).toContain(`path=${encodeURIComponent('plugins/flow')}`);
    expect(calledUrl).toContain('per_page=1');
  });

  it('omits a package sourced from an external repo (no registry directory to date)', async () => {
    mockRegistry([
      entry('flow', './plugins/flow'),
      entry('lifeos-starter', {
        source: 'github',
        repo: 'doriancollier/lifeos-starter',
        ref: 'main',
      }),
    ]);
    fetchSpy.mockResolvedValue(commitResponse('2026-07-18T17:41:20Z'));

    const result = await fetchRegistryUpdatedAt();

    // The external-source package is absent; only the in-repo package is dated,
    // and no GitHub call is made for the external one.
    expect(result).toEqual({ flow: '2026-07-18T17:41:20Z' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('omits a package whose directory has no commits (empty API response)', async () => {
    mockRegistry([entry('flow', './plugins/flow'), entry('ghost', './plugins/ghost')]);
    fetchSpy.mockImplementation((url) => {
      const u = String(url);
      if (u.includes('plugins%2Fghost')) return Promise.resolve(emptyCommitResponse());
      return Promise.resolve(commitResponse('2026-07-18T17:41:20Z'));
    });

    const result = await fetchRegistryUpdatedAt();

    expect(result).toEqual({ flow: '2026-07-18T17:41:20Z' });
  });

  it('omits a package when its GitHub lookup fails, keeping the rest of the map', async () => {
    mockRegistry([
      entry('flow', './plugins/flow'),
      entry('code-reviewer', './plugins/code-reviewer'),
    ]);
    fetchSpy.mockImplementation((url) => {
      const u = String(url);
      if (u.includes('plugins%2Fcode-reviewer')) return Promise.reject(new Error('ENOTFOUND'));
      return Promise.resolve(commitResponse('2026-07-18T17:41:20Z'));
    });

    const result = await fetchRegistryUpdatedAt();

    expect(result).toEqual({ flow: '2026-07-18T17:41:20Z' });
  });

  it('expands bare relative-path names using the registry pluginRoot', async () => {
    mockRegistry([entry('flow', 'flow')], './plugins');
    fetchSpy.mockResolvedValue(commitResponse('2026-07-18T17:41:20Z'));

    await fetchRegistryUpdatedAt();

    const calledUrl = String(fetchSpy.mock.calls[0]?.[0]);
    expect(calledUrl).toContain(`path=${encodeURIComponent('plugins/flow')}`);
  });

  it('returns an empty map when the registry has no packages', async () => {
    mockRegistry([]);

    const result = await fetchRegistryUpdatedAt();

    expect(result).toEqual({});
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
