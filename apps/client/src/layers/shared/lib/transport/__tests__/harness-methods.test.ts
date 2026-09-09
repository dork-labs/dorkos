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

describe('createHarnessMethods().adoptHarness', () => {
  it('POSTs /harness/adopt with the project and the skill in the BODY, never the URL', async () => {
    // A body for the reason the sync beside it uses one, plus a second: the
    // skill's name is a folder name, and a folder name in a URL is a folder name
    // in an access log. Seeded defect: build a query string here and the two
    // paths a person owns are logged by every proxy in front of the app.
    const answer = { moved: [], declared: [], refusals: [], status: READY_STATUS };
    const fetchMock = vi.fn(
      async (_url: unknown, _init?: RequestInit) =>
        new Response(JSON.stringify(answer), { status: 200 })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await createHarnessMethods('/api').adoptHarness('/repo', 'release-notes');

    expect(result.moved).toEqual([]);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/harness/adopt');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    // Exactly two fields, and `claudeOnly` is not one of them: the app has no
    // affordance for it, so a client that sent it would be documenting a
    // decision nobody can make here.
    expect(JSON.parse(init.body as string)).toEqual({
      projectPath: '/repo',
      name: 'release-notes',
    });
  });

  it('throws on a non-OK response rather than resolving a half-answer', async () => {
    // A refusal is a 200 carrying a sentence; a 403 or a 409 is not an answer
    // the page can draw, so it has to reach the mutation's error path.
    globalThis.fetch = vi.fn(
      async (_url: unknown, _init?: RequestInit) =>
        new Response(JSON.stringify({ error: 'Only a person can move a skill' }), { status: 403 })
    ) as unknown as typeof fetch;

    await expect(
      createHarnessMethods('/api').adoptHarness('/repo', 'release-notes')
    ).rejects.toThrow();
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

  it('throws a sentence naming the surface when something asks it to move a skill', async () => {
    // The file's own convention for a write half: a descriptive error, never a
    // quiet no-op. Nothing in a vault calls this — the page answers
    // `unavailable` and lists nothing to move — so reaching it means somebody
    // wired a new surface to it, and the error is what tells them.
    await expect(harnessStubs.adoptHarness()).rejects.toThrow(
      'Moving a skill into .agents/skills is not supported in embedded mode'
    );
  });

  it('resolves a FULL response the response schema accepts, so it cannot drift', async () => {
    // Purpose: the stub is hand-written and the schema is the contract. Parsing
    // it here is what makes a field added to `HarnessStatusResponseSchema` red
    // in this file rather than `undefined` in an Obsidian vault.
    const status = await harnessStubs.getHarnessStatus('/vault/project');

    expect(() => HarnessStatusResponseSchema.parse(status)).not.toThrow();
  });
});
