import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HarnessStatusResponseSchema } from '@dorkos/shared/harness-schemas';

import { createHarnessMethods } from '../harness-methods';
import { harnessStubs } from '../../embedded-mode-stubs';

const originalFetch = globalThis.fetch;

const READY_STATUS = {
  projectPath: '/repo',
  state: 'ready',
  computedAt: '2026-09-08T09:00:00.000Z',
  enabled: ['claude-code'],
  notEnabled: [],
  clean: true,
  counts: { skills: 0, drifted: 0, conflicts: 0, orphans: 0, adoptable: 0, pendingApproval: 0 },
  sweepPreview: [],
  rows: [],
  projectLevel: [],
  pendingApproval: [],
};

beforeEach(() => vi.restoreAllMocks());
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('createHarnessMethods().getHarnessStatus', () => {
  it('GETs /harness/status with the project path in the query string', async () => {
    const fetchMock = vi.fn(
      async (_url: unknown, _init?: RequestInit) =>
        new Response(JSON.stringify(READY_STATUS), { status: 200 })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const methods = createHarnessMethods('/api');
    const status = await methods.getHarnessStatus('/repo');

    expect(status.state).toBe('ready');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/harness/status?projectPath=%2Frepo');
  });

  it('escapes a path with spaces and a plus rather than pasting it into the URL', async () => {
    // Purpose: the path is a byte string the filesystem owns. `buildQueryString`
    // is what keeps `/Users/me/my repo+2` from arriving as a different folder.
    const fetchMock = vi.fn(
      async (_url: unknown, _init?: RequestInit) =>
        new Response(JSON.stringify(READY_STATUS), { status: 200 })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await createHarnessMethods('/api').getHarnessStatus('/Users/me/my repo+2');

    expect(fetchMock.mock.calls[0][0]).toBe(
      '/api/harness/status?projectPath=%2FUsers%2Fme%2Fmy+repo%2B2'
    );
  });

  it('throws on a non-OK response rather than resolving a half-status', async () => {
    globalThis.fetch = vi.fn(
      async (_url: unknown, _init?: RequestInit) =>
        new Response(JSON.stringify({ error: 'nope' }), { status: 403 })
    ) as unknown as typeof fetch;

    await expect(createHarnessMethods('/api').getHarnessStatus('/repo')).rejects.toThrow();
  });
});

describe('the embedded (Obsidian) harness stub', () => {
  it('answers `unavailable` with the app sentence, never an empty list of skills', async () => {
    // Purpose: Decision 26. An empty list would tell an Obsidian reader they
    // have no skills, which is the same lie this whole change is fixing.
    const status = await harnessStubs.getHarnessStatus('/vault/project');

    expect(status.state).toBe('unavailable');
    expect(status.detail).toBe('Agent file sharing runs in the DorkOS app.');
    expect(status.projectPath).toBe('/vault/project');
  });

  it('resolves a FULL response the response schema accepts, so it cannot drift', async () => {
    // Purpose: the stub is hand-written and the schema is the contract. Parsing
    // it here is what makes a field added to `HarnessStatusResponseSchema` red
    // in this file rather than `undefined` in an Obsidian vault.
    const status = await harnessStubs.getHarnessStatus('/vault/project');

    expect(() => HarnessStatusResponseSchema.parse(status)).not.toThrow();
  });
});
