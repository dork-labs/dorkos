import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCommunityMethods } from '../community-methods';
import { communityStubs } from '../../direct/community-stubs';

const connection = {
  ref: 'community-a',
  remoteCommunityId: 'remote-id',
  label: 'Team',
  pinnedOrigin: 'https://community.example.com',
  connectedHumanMemberId: null,
  status: 'pending',
  expiresAt: '2026-09-16T18:00:00.000Z',
};
afterEach(() => vi.unstubAllGlobals());
function answer(body: unknown, status = 200) {
  const mock = vi
    .fn()
    .mockResolvedValue(new Response(status === 204 ? null : JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', mock);
  return mock;
}

describe('community connection transport', () => {
  it('starts through the local server and returns only the approval descriptor', async () => {
    const response = {
      connection,
      approvalUrl: 'https://community.example.com/pair?code=public-code',
    };
    const fetch = answer(response, 201);
    const input = { url: connection.pinnedOrigin, installName: 'My laptop' };
    await expect(createCommunityMethods('/api').startCommunityConnection(input)).resolves.toEqual(
      response
    );
    expect(fetch).toHaveBeenCalledWith(
      '/api/community-connections',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify(input),
      })
    );
  });
  it('rejects credential fields in browser responses and foreign approval links', async () => {
    answer({
      connection: { ...connection, bearer: 'must-never-reach-ui' },
      approvalUrl: 'https://community.example.com/pair',
    });
    await expect(
      createCommunityMethods('/api').startCommunityConnection({
        url: connection.pinnedOrigin,
        installName: 'Laptop',
      })
    ).rejects.toThrow();
    answer({ connection, approvalUrl: 'https://other.example/pair' });
    await expect(
      createCommunityMethods('/api').startCommunityConnection({
        url: connection.pinnedOrigin,
        installName: 'Laptop',
      })
    ).rejects.toThrow('invalid approval');
  });
  it('keeps distinct refs on local read and poll requests', async () => {
    const fetch = answer({ connection });
    const methods = createCommunityMethods('/api');
    await methods.getCommunityConnection('community-a');
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ status: 'pending', connection })));
    await methods.pollCommunityConnection('community-b');
    expect(fetch.mock.calls.map((call) => call[0])).toEqual([
      '/api/community-connections/community-a',
      '/api/community-connections/community-b/poll',
    ]);
  });
  it('handles no-content cancellation and disconnect without a JSON parse error', async () => {
    const fetch = answer(null, 204);
    const methods = createCommunityMethods('/api');
    await methods.cancelCommunityConnection('a/b');
    await methods.disconnectCommunity('community-b');
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      '/api/community-connections/a%2Fb/cancel',
      expect.objectContaining({ method: 'POST' })
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      '/api/community-connections/community-b',
      expect.objectContaining({ method: 'DELETE' })
    );
  });
  it('preserves a local authorization refusal rather than reporting success', async () => {
    answer({ error: 'Only this install’s owner can manage community connections.' }, 403);
    await expect(createCommunityMethods('/api').listCommunityConnections()).rejects.toMatchObject({
      status: 403,
    });
  });
  it('refuses server-owned mutations in embedded mode', async () => {
    await expect(communityStubs.listCommunityConnections()).resolves.toEqual([]);
    await expect(communityStubs.disconnectCommunity('community-a')).rejects.toThrow(
      'web or desktop'
    );
  });
});
