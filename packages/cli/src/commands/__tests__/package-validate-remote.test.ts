import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  parseValidateRemoteArgs,
  runValidateRemote,
  resolveMarketplaceJsonUrl,
  resolveDorkosSidecarUrl,
} from '../package-validate-remote.js';

const validMarketplace = {
  name: 'dorkos',
  owner: { name: 'Dork Labs' },
  plugins: [
    {
      name: 'code-reviewer',
      source: { source: 'github', repo: 'dork-labs/code-reviewer' },
      description: 'Reviews PRs',
    },
  ],
};

const validSidecar = {
  schemaVersion: 1,
  plugins: {
    'code-reviewer': { type: 'agent' },
  },
};

function mockResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Not Found',
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

function collectWrites(spy: ReturnType<typeof vi.spyOn>): string {
  return (spy.mock.calls as unknown[][]).map((call) => String(call[0])).join('');
}

describe('parseValidateRemoteArgs', () => {
  it('returns the first positional argument as url', () => {
    expect(parseValidateRemoteArgs(['https://github.com/dork-labs/marketplace'])).toEqual({
      url: 'https://github.com/dork-labs/marketplace',
    });
  });

  it('throws when no positional argument is supplied', () => {
    expect(() => parseValidateRemoteArgs([])).toThrow(/Missing required <marketplace-url>/);
  });
});

describe('resolveMarketplaceJsonUrl', () => {
  it('appends the .claude-plugin path to a bare repo URL', () => {
    expect(resolveMarketplaceJsonUrl('https://github.com/dork-labs/marketplace')).toBe(
      'https://github.com/dork-labs/marketplace/raw/main/.claude-plugin/marketplace.json'
    );
  });

  it('strips .git suffix', () => {
    expect(resolveMarketplaceJsonUrl('https://github.com/dork-labs/marketplace.git')).toBe(
      'https://github.com/dork-labs/marketplace/raw/main/.claude-plugin/marketplace.json'
    );
  });

  it('passes through a full raw URL', () => {
    const full =
      'https://raw.githubusercontent.com/dork-labs/marketplace/main/.claude-plugin/marketplace.json';
    expect(resolveMarketplaceJsonUrl(full)).toBe(full);
  });

  it('passes through a legacy marketplace.json URL', () => {
    const legacy = 'https://example.com/marketplace.json';
    expect(resolveMarketplaceJsonUrl(legacy)).toBe(legacy);
  });
});

describe('resolveDorkosSidecarUrl', () => {
  it('appends the .claude-plugin path', () => {
    expect(resolveDorkosSidecarUrl('https://github.com/dork-labs/marketplace')).toBe(
      'https://github.com/dork-labs/marketplace/raw/main/.claude-plugin/dorkos.json'
    );
  });

  it('passes through a full sidecar URL', () => {
    const full =
      'https://raw.githubusercontent.com/dork-labs/marketplace/main/.claude-plugin/dorkos.json';
    expect(resolveDorkosSidecarUrl(full)).toBe(full);
  });
});

describe('runValidateRemote', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    fetchSpy.mockRestore();
  });

  it('returns 0 when both marketplace and sidecar fetches succeed', async () => {
    fetchSpy.mockImplementation((url) => {
      if (String(url).endsWith('marketplace.json')) {
        return Promise.resolve(mockResponse(validMarketplace));
      }
      return Promise.resolve(mockResponse(validSidecar));
    });

    const exitCode = await runValidateRemote({ url: 'https://github.com/dork-labs/marketplace' });

    expect(exitCode).toBe(0);
    const stdoutCalls = collectWrites(stdoutSpy);
    expect(stdoutCalls).toContain('[OK]   DorkOS schema');
    expect(stdoutCalls).toContain('[OK]   Sidecar present and valid (1 plugins)');
    expect(stdoutCalls).toContain('[OK]   Claude Code compatibility');
    expect(stdoutCalls).toContain('All checks passed');
  });

  it('returns 0 when marketplace is valid but sidecar is absent (404)', async () => {
    fetchSpy.mockImplementation((url) => {
      if (String(url).endsWith('marketplace.json')) {
        return Promise.resolve(mockResponse(validMarketplace));
      }
      return Promise.resolve(mockResponse('', false, 404));
    });

    const exitCode = await runValidateRemote({ url: 'https://github.com/dork-labs/marketplace' });

    expect(exitCode).toBe(0);
    const stdoutCalls = collectWrites(stdoutSpy);
    expect(stdoutCalls).toContain('[OK]   Sidecar absent');
  });

  it('returns 1 when marketplace fetch 404s', async () => {
    fetchSpy.mockResolvedValue(mockResponse('', false, 404));

    const exitCode = await runValidateRemote({ url: 'https://github.com/dork-labs/missing' });

    expect(exitCode).toBe(1);
    const stderrCalls = collectWrites(stderrSpy);
    expect(stderrCalls).toContain('[FAIL] Fetch marketplace.json');
  });

  it('returns 1 when marketplace JSON parse fails', async () => {
    fetchSpy.mockImplementation((url) => {
      if (String(url).endsWith('marketplace.json')) {
        return Promise.resolve(mockResponse('{ invalid json'));
      }
      return Promise.resolve(mockResponse('', false, 404));
    });

    const exitCode = await runValidateRemote({ url: 'https://github.com/dork-labs/marketplace' });

    expect(exitCode).toBe(1);
    const stderrCalls = collectWrites(stderrSpy);
    expect(stderrCalls).toContain('[FAIL] DorkOS schema');
  });

  it('returns 2 when inline x-dorkos fails CC strict validation', async () => {
    const leakyMarketplace = {
      ...validMarketplace,
      plugins: [
        {
          name: 'leaky',
          source: { source: 'github', repo: 'dork-labs/leaky' },
          'x-dorkos': { type: 'agent' },
        },
      ],
    };
    fetchSpy.mockImplementation((url) => {
      if (String(url).endsWith('marketplace.json')) {
        return Promise.resolve(mockResponse(leakyMarketplace));
      }
      return Promise.resolve(mockResponse('', false, 404));
    });

    const exitCode = await runValidateRemote({ url: 'https://github.com/dork-labs/marketplace' });

    expect(exitCode).toBe(2);
    const stderrCalls = collectWrites(stderrSpy);
    expect(stderrCalls).toContain('[FAIL] Claude Code compatibility');
  });

  it('returns 1 when the marketplace name is reserved', async () => {
    fetchSpy.mockImplementation((url) => {
      if (String(url).endsWith('marketplace.json')) {
        return Promise.resolve(
          mockResponse({ ...validMarketplace, name: 'claude-plugins-official' })
        );
      }
      return Promise.resolve(mockResponse('', false, 404));
    });

    const exitCode = await runValidateRemote({ url: 'https://github.com/dork-labs/marketplace' });

    // DorkOS schema itself rejects reserved names via .refine().
    expect(exitCode).toBe(1);
    const stderrCalls = collectWrites(stderrSpy);
    expect(stderrCalls.toLowerCase()).toContain('reserved');
  });

  it('returns 1 when the sidecar is present but invalid', async () => {
    fetchSpy.mockImplementation((url) => {
      if (String(url).endsWith('marketplace.json')) {
        return Promise.resolve(mockResponse(validMarketplace));
      }
      return Promise.resolve(mockResponse({ schemaVersion: 99, plugins: {} }));
    });

    const exitCode = await runValidateRemote({ url: 'https://github.com/dork-labs/marketplace' });

    expect(exitCode).toBe(1);
    const stderrCalls = collectWrites(stderrSpy);
    expect(stderrCalls).toContain('[FAIL] Sidecar dorkos.json');
  });
});
