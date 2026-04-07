import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchMarketplaceJson, fetchPackageReadme, githubSourceToRawReadme } from '../fetch';

const VALID_MARKETPLACE_FIXTURE = JSON.stringify({
  name: 'dorkos-community',
  plugins: [
    {
      name: 'code-reviewer',
      source: 'https://github.com/dorkos-community/code-reviewer',
      description: 'A code review agent',
      type: 'agent',
      category: 'code-quality',
    },
  ],
});

const INVALID_MARKETPLACE_FIXTURE = JSON.stringify({
  // missing top-level `name`
  plugins: [
    {
      name: 'code-reviewer',
      source: 'https://github.com/dorkos-community/code-reviewer',
    },
  ],
});

function mockFetchResponse(
  body: string,
  init: { ok: boolean; status?: number; statusText?: string }
) {
  return {
    ok: init.ok,
    status: init.status ?? (init.ok ? 200 : 500),
    statusText: init.statusText ?? '',
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

const originalFetch = global.fetch;

beforeEach(() => {
  global.fetch = vi.fn() as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('fetchMarketplaceJson', () => {
  it('returns parsed marketplace on 200', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(
      mockFetchResponse(VALID_MARKETPLACE_FIXTURE, { ok: true, status: 200 })
    );

    const result = await fetchMarketplaceJson();

    expect(result.name).toBe('dorkos-community');
    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0].name).toBe('code-reviewer');
  });

  it('throws on non-2xx status', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(
      mockFetchResponse('not found', { ok: false, status: 404, statusText: 'Not Found' })
    );

    await expect(fetchMarketplaceJson()).rejects.toThrow(/404/);
  });

  it('throws when payload fails schema validation', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(
      mockFetchResponse(INVALID_MARKETPLACE_FIXTURE, { ok: true, status: 200 })
    );

    await expect(fetchMarketplaceJson()).rejects.toThrow(/parse failed/);
  });
});

describe('fetchPackageReadme', () => {
  it('returns README text on 200', async () => {
    const readmeBody = '# Code Reviewer\n\nA helpful agent.';
    vi.mocked(global.fetch).mockResolvedValueOnce(
      mockFetchResponse(readmeBody, { ok: true, status: 200 })
    );

    const result = await fetchPackageReadme('https://github.com/dorkos-community/code-reviewer');

    expect(result).toBe(readmeBody);
  });

  it('returns empty string on 404', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(
      mockFetchResponse('', { ok: false, status: 404, statusText: 'Not Found' })
    );

    const result = await fetchPackageReadme('https://github.com/dorkos-community/code-reviewer');

    expect(result).toBe('');
  });

  it('returns empty string on non-GitHub URL', async () => {
    const result = await fetchPackageReadme('https://gitlab.com/some/repo');

    expect(result).toBe('');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('githubSourceToRawReadme', () => {
  it('handles plain GitHub URL', () => {
    expect(githubSourceToRawReadme('https://github.com/dorkos-community/code-reviewer')).toBe(
      'https://raw.githubusercontent.com/dorkos-community/code-reviewer/main/README.md'
    );
  });

  it('handles URL with .git suffix', () => {
    expect(githubSourceToRawReadme('https://github.com/dorkos-community/code-reviewer.git')).toBe(
      'https://raw.githubusercontent.com/dorkos-community/code-reviewer/main/README.md'
    );
  });

  it('handles URL with trailing slash', () => {
    expect(githubSourceToRawReadme('https://github.com/dorkos-community/code-reviewer/')).toBe(
      'https://raw.githubusercontent.com/dorkos-community/code-reviewer/main/README.md'
    );
  });

  it('returns null for non-GitHub URLs', () => {
    expect(githubSourceToRawReadme('https://gitlab.com/some/repo')).toBeNull();
    expect(githubSourceToRawReadme('not a url at all')).toBeNull();
  });
});
