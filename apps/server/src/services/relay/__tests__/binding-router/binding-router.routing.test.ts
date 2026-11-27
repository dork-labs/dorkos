import { describe, it, expect, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { isDispatchId, newDispatchId } from '../../../../lib/identity/dispatch-id.js';
import { currentDispatchId } from '../../../../lib/dispatch-context.js';
import { recentDispatches, resetDispatchBuffers } from '../../../observability/dispatch-buffers.js';
import {
  AGENT_CWD,
  AGENT_PATH,
  binding,
  chatEnvelope,
  envelope,
  useRouterHarness,
} from './binding-router.fixtures.js';

vi.mock('node:fs/promises');

describe('BindingRouter routing', () => {
  const h = useRouterHarness();

  it('routes to relay.agent.{runtimeType}.{sessionId}, naming the agent and its cwd', async () => {
    h.bind();
    await h.handler(envelope({ payload: { text: 'hello' } }));
    expect(h.relayCore.subscribe).toHaveBeenCalledWith('relay.human.>', expect.any(Function));
    expect(h.bindingStore.resolve).toHaveBeenCalledWith('tg-bot', '123', undefined);
    expect(h.agentManager.createSession).toHaveBeenCalledWith(AGENT_CWD, 'acceptEdits', AGENT_PATH);
    expect(h.relayCore.publish).toHaveBeenCalledWith(
      'relay.agent.claude-code.session-abc',
      expect.objectContaining({ text: 'hello', cwd: AGENT_CWD, forAgent: AGENT_PATH }),
      expect.objectContaining({ from: 'tg' })
    );
  });

  it('falls back to relay.agent.<sessionId> when no runtimeResolver is provided', async () => {
    const { handler } = await h.startRouter({ runtimeResolver: undefined });
    h.bind();
    await handler(envelope());
    expect(h.relayCore.publish).toHaveBeenCalledWith(
      'relay.agent.session-abc',
      'hi',
      expect.any(Object)
    );
  });

  describe('the dispatch id crosses the bus', () => {
    const forwardedId = () =>
      (h.relayCore.publish.mock.calls.at(-1)?.[2] as { dispatchId?: string } | undefined)
        ?.dispatchId;

    it('continues a carried id, and mints a fresh one for a missing or malformed id', async () => {
      h.bind();
      const carried = newDispatchId();
      await h.handler(envelope({ dispatchId: carried }));
      expect(forwardedId()).toBe(carried);
      // Adopting a malformed id from the wire would let a stranger choose the traceId.
      for (const dispatchId of [undefined, '../../etc/passwd']) {
        await h.handler(envelope({ dispatchId }));
        expect(forwardedId()).not.toBe(dispatchId);
        expect(isDispatchId(forwardedId()!)).toBe(true);
      }
    });

    it('opens no dispatch, and routes nothing, for a message this server produced', async () => {
      h.bind();
      resetDispatchBuffers();
      for (const from of ['agent:ana', 'relay.system.notice']) await h.handler(envelope({ from }));
      expect(recentDispatches(10)).toHaveLength(0);
      expect(h.bindingStore.resolve).not.toHaveBeenCalled();
      expect(h.relayCore.publish).not.toHaveBeenCalled();
    });

    it.each([
      ['the chat subject cannot be read', { subject: 'relay.agent.nonsense' }],
      ['nothing connects the chat to an agent', {}],
    ])('drops, and closes the dispatch as refused, when %s', async (_label, overrides) => {
      resetDispatchBuffers();
      await h.handler(envelope(overrides));
      const [row] = recentDispatches(10);
      expect(row).toMatchObject({ outcome: 'refused' });
      expect(row.endedAt).not.toBeNull();
      expect(h.relayCore.publish).not.toHaveBeenCalled();
    });

    it('makes the id ambient for everything the routing does', async () => {
      h.bind();
      const carried = newDispatchId();
      let ambient: string | undefined;
      h.agentManager.createSession.mockImplementation(async () => {
        ambient = currentDispatchId();
        return { id: 'session-abc' };
      });
      await h.handler(envelope({ dispatchId: carried }));
      expect(ambient).toBe(carried);
    });
  });

  describe('session strategies', () => {
    const fromUser = (chatId: string, platformData: Record<string, unknown>) =>
      chatEnvelope(chatId, { payload: { content: 'hi', platformData } });
    // `per-user` once read a field the envelope does not have, so it equalled
    // `per-chat` and one person's turn could read another's conversation.
    it.each([
      ['per-chat reuses one chat', 'per-chat', chatEnvelope('123'), chatEnvelope('123'), 1],
      ['per-chat separates two chats', 'per-chat', chatEnvelope('123'), chatEnvelope('456'), 2],
      ['stateless never reuses', 'stateless', chatEnvelope('123'), chatEnvelope('123'), 2],
      [
        'per-user separates two Slack users in one channel',
        'per-user',
        fromUser('C123', { userId: 'U-alice' }),
        fromUser('C123', { userId: 'U-bob' }),
        2,
      ],
      [
        'per-user separates two Telegram users in one group (numeric fromId)',
        'per-user',
        fromUser('-100', { fromId: 111 }),
        fromUser('-100', { fromId: 222 }),
        2,
      ],
      [
        "per-user reuses one user's session",
        'per-user',
        fromUser('-100', { fromId: 111 }),
        fromUser('-100', { fromId: 111 }),
        1,
      ],
    ])('%s', async (_label, strategy, first, second, sessions) => {
      h.bind(binding({ sessionStrategy: strategy }));
      await h.handler(first);
      await h.handler(second);
      expect(h.agentManager.createSession).toHaveBeenCalledTimes(sessions);
    });
  });

  describe('a bridged binding (chats-as-channels §5.1)', () => {
    const bridged = () =>
      binding({ id: 'bind-bridged', bridge: 'room', roomId: 'room-1', chatId: '123' });

    it('A2.1/A5.2/A7.3: reaches ingest and never the session creator or the session map', async () => {
      h.bind(bridged());
      await h.handler(envelope());
      expect(h.bridgeIngest.ingest).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'bind-bridged', bridge: 'room' }),
        expect.objectContaining({ subject: 'relay.human.telegram.tg-bot.123' }),
        { agentPath: AGENT_PATH }
      );
      expect(h.agentManager.createSession).not.toHaveBeenCalled();
      expect(h.relayCore.publish).not.toHaveBeenCalled();
      expect(h.router.getAllSessions()).toEqual([]);
    });

    it('surfaces a refused ingest verdict', async () => {
      h.bind(bridged());
      const verdict = { handled: false, reason: 'per-chat ingest ceiling reached' };
      h.bridgeIngest.ingest.mockResolvedValueOnce({ status: 'refused', reason: 'x', verdict });
      await expect(h.handler(envelope())).resolves.toEqual(verdict);
    });
  });
});

describe('BindingRouter session map', () => {
  const h = useRouterHarness();

  it('a restarted router reuses the session the last one saved', async () => {
    h.bind();
    await h.handler(envelope());
    vi.mocked(readFile).mockResolvedValue(vi.mocked(writeFile).mock.calls.at(-1)?.[1] as string);
    const { handler } = await h.startRouter();
    await handler(envelope());
    expect(h.agentManager.createSession).toHaveBeenCalledTimes(1);
  });

  it('reports each saved session by binding, reading chat ids with colons and per-user keys', async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify([
        ['b1:chat:12345', 'session-aaa'],
        ['b1:chat:foo:bar', 'session-colon'],
        ['b2:user:alice', 'session-ddd'],
      ])
    );
    const { router } = await h.startRouter();
    expect(router.getSessionsByBinding('b1').map((s) => s.chatId)).toEqual(['12345', 'foo:bar']);
    // A per-user key names a PERSON, never a chat to answer in.
    expect(router.getAllSessions()).toContainEqual({
      key: 'b2:user:alice',
      bindingId: 'b2',
      scope: 'user',
      userId: 'alice',
      sessionId: 'session-ddd',
      lastActivityAt: 0,
    });
    // takeChatSession vacates exactly the chat entry (§7.2), never a per-user one.
    expect(await router.takeChatSession('b1', '12345')).toEqual({ sessionId: 'session-aaa' });
    expect(router.getSessionsByBinding('b1')).toHaveLength(1);
    expect(await router.takeChatSession('b2', 'alice')).toBeUndefined();
  });

  it('saves the map and unsubscribes on shutdown', async () => {
    vi.mocked(writeFile).mockClear();
    await h.router.shutdown();
    expect(writeFile).toHaveBeenCalled();
    expect(h.unsubscribe).toHaveBeenCalled();
  });

  it('cleanupOrphanedSessions() drops deleted bindings only, so that chat gets a new session', async () => {
    h.bind();
    await h.handler(envelope());
    expect(await h.router.cleanupOrphanedSessions(new Set(['bind-1']))).toBe(0);
    expect(await h.router.cleanupOrphanedSessions(new Set())).toBe(1);
    await h.handler(envelope({ id: 'msg-2' }));
    expect(h.agentManager.createSession).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['publish()', 'publish failed'],
    ['createSession()', 'session creation failed'],
  ])('reports a throwing %s as not handled (DOR-789)', async (where, reason) => {
    h.bind();
    if (where === 'publish()') h.relayCore.publish.mockRejectedValue(new Error(reason));
    else h.agentManager.createSession.mockRejectedValue(new Error(reason));
    await expect(h.handler(envelope())).resolves.toEqual({ handled: false, reason });
  });

  it('deduplicates concurrent session creation for the same key (C1)', async () => {
    let resolveSession!: (value: { id: string }) => void;
    h.agentManager.createSession.mockImplementation(
      () => new Promise((resolve) => (resolveSession = resolve))
    );
    h.bind();
    const both = [h.handler(envelope()), h.handler(envelope())];
    await vi.waitFor(() => expect(h.agentManager.createSession).toHaveBeenCalled());
    resolveSession({ id: 'session-deduped' });
    await Promise.all(both);
    expect(h.agentManager.createSession).toHaveBeenCalledTimes(1);
    expect(h.relayCore.publish).toHaveBeenCalledTimes(2);
  });

  it('evicts the oldest entry when the map exceeds MAX_SESSIONS (I6)', async () => {
    const entries = Array.from({ length: 10_000 }, (_, i) => [
      `bind-old:chat:${i}`,
      `session-${i}`,
    ]);
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(entries));
    const { handler } = await h.startRouter();
    h.bind(binding({ id: 'bind-new' }));
    await handler(chatEnvelope('new-chat'));
    h.agentManager.createSession.mockClear();
    h.bind(binding({ id: 'bind-old' }));
    await handler(chatEnvelope('0'));
    expect(h.agentManager.createSession).toHaveBeenCalledTimes(1);
  });

  it('routes, cleans up and shuts down even when saving the map fails', async () => {
    h.bind();
    vi.mocked(writeFile).mockRejectedValue(new Error('ENOSPC: no space left'));
    await expect(h.handler(envelope())).resolves.toBeUndefined();
    expect(h.relayCore.publish).toHaveBeenCalledWith(
      'relay.agent.claude-code.session-abc',
      'hi',
      expect.any(Object)
    );
    await expect(h.router.cleanupOrphanedSessions(new Set())).resolves.toBe(1);
    await expect(h.router.shutdown()).resolves.toBeUndefined();
  });
});
