import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstallationUpdatesResult } from '@dorkos/shared/marketplace-schemas';

import { createMarketplaceMethods } from '../marketplace-methods';
import { marketplaceStubs } from '../../embedded-mode-stubs';

const originalFetch = globalThis.fetch;

const RESULT: InstallationUpdatesResult = {
  checks: [
    {
      packageName: 'flow',
      installedVersion: '0.7.2',
      latestVersion: '0.7.3',
      hasUpdate: true,
      marketplace: 'dorkos-community',
      status: 'update-available',
      installPath: '/home/.dork/plugins/flow',
      type: 'plugin',
      scope: 'global',
    },
  ],
};

/** Install a fetch that answers every call with `RESULT` and records it. */
function answerWithResult() {
  const fetchMock = vi.fn(
    async (_url: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify(RESULT), { status: 200 })
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('createMarketplaceMethods().checkMarketplaceUpdates', () => {
  it('GETs /marketplace/updates with no query for the every-scope view', async () => {
    // Purpose: the Installed view lists every scope, so its check must ask for
    // every scope too; a stray projectPath would narrow it to one project.
    const fetchMock = answerWithResult();

    const result = await createMarketplaceMethods('/api').checkMarketplaceUpdates();

    expect(result).toEqual(RESULT);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/marketplace/updates');
    expect(fetchMock.mock.calls[0][1]?.method ?? 'GET').toBe('GET');
  });

  it('escapes a project path into the query string', async () => {
    // Purpose: a path is a byte string the filesystem owns; it must arrive intact.
    const fetchMock = answerWithResult();

    await createMarketplaceMethods('/api').checkMarketplaceUpdates('/Users/me/my repo+2');

    expect(fetchMock.mock.calls[0][0]).toBe(
      '/api/marketplace/updates?projectPath=%2FUsers%2Fme%2Fmy+repo%2B2'
    );
  });
});

/** One target that runs nothing on its own. */
const TARGET = { installPath: '/x', latestVersion: '2.0.0', disclosed: null };

describe('createMarketplaceMethods().applyMarketplaceUpdates', () => {
  it('POSTs apply: true with exactly the named installations, each as it was shown', async () => {
    // Purpose: the route refuses any POST without the literal `apply: true`,
    // "Update all" must touch exactly the installations it showed, and each
    // must carry the version and disclosure the person saw, untouched: the
    // server installs only what still matches them (DOR-2306).
    const fetchMock = answerWithResult();
    const runs = {
      hooks: [{ event: 'Stop', matcher: null, command: 'echo hi', source: null }],
      schedules: [],
      mcpServers: [],
      lspServers: [],
      monitors: [],
      executables: [],
      skillTools: [],
    };
    const targets = [
      { installPath: '/home/.dork/plugins/flow', latestVersion: '2.0.0', disclosed: runs },
      { installPath: '/work/alpha/.dork/plugins/flow', latestVersion: '2.0.0', disclosed: null },
    ] as const;

    await createMarketplaceMethods('/api').applyMarketplaceUpdates({
      targets: [targets[0], targets[1]],
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/marketplace/updates');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ apply: true, targets });
  });

  it('refuses to pass off a waiting approval as a result', async () => {
    // Purpose: a 202 means nothing was reinstalled; the app must say so, not
    // report an apply with no checks as done.
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ status: 'requires_confirmation', confirmationToken: 't' }), {
          status: 202,
        })
    ) as unknown as typeof fetch;

    await expect(
      createMarketplaceMethods('/api').applyMarketplaceUpdates({ targets: [TARGET] })
    ).rejects.toThrow(/waiting for someone to approve/);
  });

  it('rejects with the server error rather than resolving a half-result', async () => {
    // Purpose: a refused batch (404 for an unknown path, 403 for approval) must
    // reach the person as an error, never as "nothing changed".
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'Package not installed: flow' }), { status: 404 })
    ) as unknown as typeof fetch;

    await expect(
      createMarketplaceMethods('/api').applyMarketplaceUpdates({
        targets: [{ ...TARGET, installPath: '/nope' }],
      })
    ).rejects.toThrow(/not installed/);
  });
});

describe('embedded mode', () => {
  it('answers the check with no checks, matching its empty installed list', async () => {
    // Purpose: Obsidian has no marketplace; an empty answer keeps any surface
    // that asks calm instead of throwing on mount.
    await expect(marketplaceStubs.checkMarketplaceUpdates()).resolves.toEqual({ checks: [] });
  });

  it('refuses to apply', async () => {
    await expect(marketplaceStubs.applyMarketplaceUpdates({ targets: [TARGET] })).rejects.toThrow(
      /not supported in embedded mode/
    );
  });
});
