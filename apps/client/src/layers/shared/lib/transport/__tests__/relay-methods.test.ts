/** The relay claim-feed and binding-move calls send exactly the requests the hand-written ones did (DOR-5473). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRelayMethods } from '../relay-methods';
import { answer, firstRequest } from './request-stub';

/** The first request, with `fetch`'s own GET default named. */
function sent(fetchMock: ReturnType<typeof answer>) {
  const request = firstRequest(fetchMock);
  return { ...request, method: request.method ?? 'GET' };
}

afterEach(() => vi.unstubAllGlobals());

describe('createRelayMethods', () => {
  const methods = createRelayMethods('/api', () => 'client-1');

  it('sends each moved call at the same path, method and body', async () => {
    const calls: Array<[() => Promise<unknown>, ReturnType<typeof sent>]> = [
      [
        () => methods.moveBinding('b 1/x', 'agent-2'),
        {
          url: '/api/relay/bindings/b%201%2Fx/move',
          method: 'POST',
          body: '{"agentId":"agent-2"}',
        },
      ],
      [
        () => methods.listUnclaimedChats(),
        { url: '/api/relay/unclaimed-chats', method: 'GET', body: undefined },
      ],
      [
        () => methods.listUnclaimedChats('pending'),
        { url: '/api/relay/unclaimed-chats?status=pending', method: 'GET', body: undefined },
      ],
      [
        () => methods.claimUnclaimedChat('c/1', { agentId: 'agent-2', label: 'Ops', bridge: true }),
        {
          url: '/api/relay/unclaimed-chats/c%2F1/claim',
          method: 'POST',
          body: '{"agentId":"agent-2","label":"Ops","bridge":true}',
        },
      ],
      [
        () => methods.ignoreUnclaimedChat('c/1'),
        { url: '/api/relay/unclaimed-chats/c%2F1/ignore', method: 'POST', body: undefined },
      ],
      [
        () => methods.blockUnclaimedChat('c/1'),
        { url: '/api/relay/unclaimed-chats/c%2F1/block', method: 'POST', body: undefined },
      ],
    ];
    for (const [call, expected] of calls) {
      const fetchMock = answer({ binding: {}, chats: [] });
      await call();
      expect(sent(fetchMock)).toEqual(expected);
      expect(fetchMock.mock.calls[0]![1]).toMatchObject({ credentials: 'include' });
    }
  });

  it('unwraps the moved binding and the chat list', async () => {
    answer({ binding: { id: 'b1' } });
    await expect(methods.moveBinding('b1', 'a2')).resolves.toEqual({ id: 'b1' });
    answer({ chats: [{ id: 'c1' }] });
    await expect(methods.listUnclaimedChats()).resolves.toEqual([{ id: 'c1' }]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 204 }))
    );
    await expect(methods.ignoreUnclaimedChat('c1')).resolves.toBeUndefined();
  });
});
