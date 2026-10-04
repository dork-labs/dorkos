import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMarketplaceMethods } from '../marketplace-methods';

const originalFetch = globalThis.fetch;

/** Install a fetch that answers every call with `body` at `status`, and records it. */
function answerWith(body: unknown, status = 200) {
  const fetchMock = vi.fn(
    async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify(body), { status })
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const STATUS = {
  name: 'flow',
  type: 'plugin',
  scope: 'global',
  path: '/work/flow',
  state: 'active',
  parked: null,
  linkedAt: '2026-10-03T00:00:00.000Z',
};

describe('createMarketplaceMethods() dev links (DOR-2696)', () => {
  it('reports a made link as linked, and posts what the person approved', async () => {
    // Purpose: the 201 body is the link; expectedChange rides the body as sent.
    const fetchMock = answerWith(STATUS, 201);
    const result = await createMarketplaceMethods('/api').linkDevLink({
      path: '/work/flow',
      scope: 'global',
      via: 'app',
      expectedChange: 'CARD',
    });
    expect(result).toEqual({ status: 'linked', link: STATUS });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/marketplace/dev-links');
    expect(JSON.parse(String(init?.body))).toEqual({
      path: '/work/flow',
      scope: 'global',
      via: 'app',
      expectedChange: 'CARD',
    });
  });

  it('tells a 202 approval answer apart from a link', async () => {
    // Purpose: fetch treats 201 and 202 alike, so the body must decide.
    answerWith({ status: 'approval_required', approvalId: 'a1', approvalToken: 't' }, 202);
    const result = await createMarketplaceMethods('/api').linkDevLink({
      path: '/work/flow',
      scope: 'global',
    });
    expect(result.status).toBe('approval_required');
  });

  it('unlinks by encoded name with the scope in the body', async () => {
    const fetchMock = answerWith({ restored: 'removed' });
    await createMarketplaceMethods('/api').unlinkDevLink('flow', {
      scope: 'project',
      projectPath: '/work/app',
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/marketplace/dev-links/flow/unlink');
    expect(JSON.parse(String(init?.body))).toEqual({ scope: 'project', projectPath: '/work/app' });
  });

  it('carries the refusal code from a preview the server refused', async () => {
    // Purpose: the dialog acts on `code` (dev_link_changed) and shows the sentence.
    answerWith(
      { error: 'That path is a link. Use /real instead.', code: 'dev_link_path_not_real' },
      400
    );
    await expect(
      createMarketplaceMethods('/api').previewDevLink({ path: '/link', scope: 'global' })
    ).rejects.toMatchObject({
      message: 'That path is a link. Use /real instead.',
      code: 'dev_link_path_not_real',
    });
  });
});
