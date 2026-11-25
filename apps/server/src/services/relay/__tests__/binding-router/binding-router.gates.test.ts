import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
// The package root, as the route that seals the limits imports it; this suite resolves it to
// source, the same module `turnPowerOptions` checks the seal with.
import { sealTurnLimits } from '@dorkos/relay';
import { UNPROVEN_TEAMMATE_ORIGIN } from '@dorkos/shared/permission-semantics';
import { turnPowerOptions } from '../../../../../../../packages/relay/src/adapters/claude-code/turn-shaping-sender.js';
import { createTestDb } from '@dorkos/test-utils/db';
import { UnclaimedChatStore, type UnclaimedChat } from '../../unclaimed-chat-store.js';
import type { UnclaimedChatBurst } from '../../binding-router.js';
import { registerTestHomes } from '../../../core/agent-identity/__tests__/agent-home-fixture.js';
import {
  AGENT_CWD,
  AGENT_PATH,
  binding,
  envelope,
  useRouterHarness,
  type InboundHandler,
} from './binding-router.fixtures.js';

vi.mock('node:fs/promises');

describe('BindingRouter gates', () => {
  const h = useRouterHarness();
  const hello = () => envelope({ payload: { content: 'hello' } });
  const routedToAgent = () =>
    h.relayCore.publish.mock.calls.some(([subject]) => String(subject).startsWith('relay.agent.'));

  describe('permission enforcement', () => {
    it.each([
      ['canReceive=false', () => h.bind(binding({ canReceive: false }))],
      // A paused binding is a resolve() miss; the router still finds it to say "paused".
      [
        'a paused binding',
        () => h.bindingStore.resolveIncludingDisabled.mockReturnValue(binding({ enabled: false })),
      ],
    ])('drops inbound messages on %s', async (_label, arrange) => {
      arrange();
      await h.handler(hello());
      expect(routedToAgent()).toBe(false);
      expect(h.agentManager.createSession).not.toHaveBeenCalled();
    });

    it.each([
      [{}, { canReply: true, canInitiate: false }],
      [
        { canReply: false, canInitiate: true },
        { canReply: false, canInitiate: true },
      ],
    ])('carries %o onto the payload as __bindingPermissions', async (overrides, expected) => {
      h.bind(binding(overrides));
      await h.handler(hello());
      expect(h.lastPayload().__bindingPermissions).toEqual({
        ...expected,
        permissionMode: 'acceptEdits',
      });
    });

    it('canInitiate=false does not block inbound routing — replies keep flowing (DOR-239)', async () => {
      h.bind(binding({ canInitiate: false }));
      await h.handler(hello());
      expect(routedToAgent()).toBe(true);
    });

    it("refuses a binding whose folder is another agent's home (DESK_NOT_OWN, DOR-2356)", async () => {
      registerTestHomes([AGENT_PATH, '/agents/b'], { managed: { [AGENT_CWD]: '/agents/b' } });
      h.bind();
      await h.handler(hello());
      expect(routedToAgent()).toBe(false);
      expect(h.agentManager.createSession).not.toHaveBeenCalled();
    });
  });

  describe('whose words a direct chat holds (DOR-2980)', () => {
    const from = (userId?: string, extra: Record<string, unknown> = {}) =>
      envelope({ payload: { content: 'hi', platformData: userId ? { userId } : {}, ...extra } });
    it.each([
      ['a stranger, with no one listed', [], from('stranger'), true],
      ['a sender off the list', ['owner'], from('stranger'), true],
      ['a sender with no id', ['owner'], from(), true],
      ['a listed person in a direct message', ['owner'], from('owner'), false],
      [
        'a listed person in a group',
        ['owner'],
        { ...from('owner'), subject: 'relay.human.telegram.tg-bot.group.123' },
        true,
      ],
      [
        'a publisher claiming the words are trusted',
        [],
        from('stranger', { __untrustedWords: false }),
        true,
      ],
    ])('marks %s as untrusted=%s', async (_label, approvers, env, untrusted) => {
      h.approvers = approvers;
      h.bind();
      await h.handler(env);
      expect(h.lastPayload().__untrustedWords).toBe(untrusted);
    });
  });

  describe('the limits a message carries (DOR-5201)', () => {
    const AGENT = 'relay.agent.default.porter';
    const CHAIN = {
      asks: 'never',
      reach: 'everything',
      teammate: [{ roomId: 'r1', authorId: 'a1' }],
    };
    /** What the turn the router started is sent with. */
    const turnOf = (payload: Record<string, unknown>) =>
      turnPowerOptions(false, false, payload, h.relayCore.publish.mock.calls.at(-1)![2]!.from);

    it('keeps the server’s sealed stamp from an agent, so the turn still carries it', async () => {
      h.bind();
      const stamp = sealTurnLimits(AGENT, {
        permissionCeiling: CHAIN,
        carriedMarks: { outsider: true },
      });
      await h.handler(
        envelope({ from: AGENT, payload: { content: 'hi', __carriedTurnLimits: stamp } })
      );
      expect(h.lastPayload().__carriedTurnLimits).toEqual(stamp);
      expect(turnOf(h.lastPayload())).toEqual({
        permissionCeiling: ['runtime-default', CHAIN],
        carriedMarks: { outsider: true },
      });
    });

    it('reads a chain nobody sealed as unproven, naming no room of its own', async () => {
      h.bind();
      await h.handler(
        envelope({
          from: AGENT,
          payload: { content: 'hi', __carriedTurnLimits: { permissionCeiling: CHAIN } },
        })
      );
      expect(turnOf(h.lastPayload())).toEqual({
        permissionCeiling: ['runtime-default', { ...CHAIN, teammate: [UNPROVEN_TEAMMATE_ORIGIN] }],
      });
    });
  });

  describe('the empty-content gate (DOR-866)', () => {
    const media = (content: string) =>
      envelope({ payload: { content, platformData: { media: { type: 'photo' } } } });

    it('drops a captionless-media envelope on an unbridged binding, and routes one with a caption', async () => {
      h.bind();
      await expect(h.handler(media(''))).resolves.toEqual({
        handled: false,
        reason: 'no text content',
      });
      expect(h.agentManager.createSession).not.toHaveBeenCalled();
      await h.handler(media('a real caption'));
      expect(h.agentManager.createSession).toHaveBeenCalledTimes(1);
    });

    it('hands the unfiltered envelope to a bridged binding', async () => {
      h.bind(binding({ bridge: 'room' }));
      await h.handler(media(''));
      expect(h.bridgeIngest.ingest).toHaveBeenCalledWith(
        expect.objectContaining({ bridge: 'room' }),
        expect.objectContaining({ payload: expect.objectContaining({ content: '' }) }),
        expect.anything()
      );
      expect(h.agentManager.createSession).not.toHaveBeenCalled();
    });
  });

  describe('relay_flow emit (onFlow)', () => {
    it('fires once with the routing skeleton, and never for a message that did not reach the agent', async () => {
      const onFlow = vi.fn();
      const { handler } = await h.startRouter({ onFlow });
      h.bind();
      h.relayCore.publish.mockResolvedValueOnce({ messageId: 'msg-2', deliveredTo: 0 });
      await handler(hello());
      await handler(envelope({ from: 'agent:session-abc' }));
      expect(onFlow).not.toHaveBeenCalled();
      await handler(hello());
      expect(onFlow).toHaveBeenCalledExactlyOnceWith({
        bindingId: 'bind-1',
        adapterId: 'tg-bot',
        agentId: 'agent-a',
        direction: 'inbound',
        at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      });
    });
  });

  describe('testBinding()', () => {
    it.each([
      ['an unknown binding', undefined, AGENT_PATH, 'Binding not found'],
      [
        'a paused binding',
        binding({ enabled: false }),
        AGENT_PATH,
        'Binding is paused (enabled=false)',
      ],
      [
        'an agent missing from the mesh',
        binding({ enabled: true }),
        undefined,
        'not found in mesh registry',
      ],
    ])('reports %s without routing', (_label, row, projectPath, reason) => {
      h.bindingStore.getById.mockReturnValue(row);
      h.meshCore.getProjectPath.mockReturnValue(projectPath);
      expect(h.router.testBinding('bind-1')).toMatchObject({
        ok: false,
        resolved: false,
        reason: expect.stringContaining(reason),
      });
    });

    it('returns ok with the agent when routing succeeds, without invoking it', () => {
      h.bindingStore.getById.mockReturnValue(binding({ enabled: true }));
      expect(h.router.testBinding('bind-1')).toMatchObject({
        ok: true,
        wouldDeliverTo: 'agent-a',
        details: 'Routing succeeded. No agent was invoked.',
      });
      expect(h.relayCore.publish).not.toHaveBeenCalled();
      expect(h.agentManager.createSession).not.toHaveBeenCalled();
    });
  });
});

describe('BindingRouter claim feed (connection-scoping spec §Part 3)', () => {
  // A REAL store: damping, blocking and the no-body rule live in how the router calls it.
  const h = useRouterHarness();
  let claimStore: UnclaimedChatStore;
  let onUnclaimedChat: Mock<(chat: UnclaimedChat) => void>;
  let onUnclaimedChatBurst: Mock<(burst: UnclaimedChatBurst) => void>;
  let claimHandler: InboundHandler;
  const BODY = 'THE-MESSAGE-BODY-MUST-NEVER-APPEAR-IN-THE-CLAIM-FEED';

  /** An unbound inbound message in chat 999. */
  const unbound = (overrides: Record<string, unknown> = {}) =>
    envelope({
      subject: 'relay.human.telegram.tg-bot.999',
      payload: { content: BODY, senderName: 'Miguel', platformData: { fromId: 42 } },
      ...overrides,
    });
  const sighting = (chatId: string) => claimStore.list('pending').find((c) => c.chatId === chatId)!;

  beforeEach(async () => {
    claimStore = new UnclaimedChatStore(createTestDb());
    onUnclaimedChat = vi.fn();
    onUnclaimedChatBurst = vi.fn();
    ({ handler: claimHandler } = await h.startRouter({
      relayDir: '/tmp/relay-claim',
      unclaimedChats: claimStore,
      onUnclaimedChat,
      onUnclaimedChatBurst,
    }));
  });

  it('AC3.1-3.3: records one damped claim card with no body, fires once, and starts no turn', async () => {
    await claimHandler(unbound());
    await claimHandler(unbound());
    expect(claimStore.list('pending')).toHaveLength(1);
    expect(sighting('999').messageCount).toBe(2);
    expect(onUnclaimedChat).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ adapterId: 'tg-bot', chatId: '999', senderName: 'Miguel' })
    );
    expect(JSON.stringify(sighting('999'))).not.toContain(BODY);
    expect(JSON.stringify(onUnclaimedChat.mock.calls[0]![0])).not.toContain(BODY);
    expect(h.agentManager.createSession).not.toHaveBeenCalled();
    expect(h.relayCore.publish).not.toHaveBeenCalled();
  });

  it('DOR-907: records a broadcast on a group subject as a broadcast, apart from the folded kind', async () => {
    await claimHandler(
      unbound({
        subject: 'relay.human.telegram.tg-bot.group.555',
        payload: { content: BODY, platformData: { fromId: 7, chatType: 'channel' } },
      })
    );
    expect(sighting('555')).toMatchObject({ chatKind: 'group', platformChatType: 'channel' });
  });

  it('DOR-883: a group-add event with no text records the adder and the group', async () => {
    await claimHandler(
      unbound({
        subject: 'relay.human.telegram.tg-bot.group.888',
        payload: {
          content: '',
          senderName: 'Ana',
          channelName: 'Release train',
          platformData: { fromId: 42, chatType: 'supergroup' },
        },
      })
    );
    expect(sighting('888')).toMatchObject({ senderName: 'Ana', chatTitle: 'Release train' });
    expect(onUnclaimedChat).toHaveBeenCalledTimes(1);
  });

  it('a blocked chat is never written again, until a manual binding routes it (MAJOR 5)', async () => {
    await claimHandler(unbound());
    const chat = sighting('999');
    claimStore.block(chat.id);
    const before = claimStore.getById(chat.id)!;
    await claimHandler(unbound());
    expect(claimStore.getById(chat.id)).toEqual(before);
    expect(onUnclaimedChat).toHaveBeenCalledTimes(1);
    h.bind(binding({ id: 'bind-manual', chatId: '999', enabled: true }));
    await claimHandler(unbound());
    expect(h.agentManager.createSession).toHaveBeenCalled();
  });

  it('MAJOR 4: caps broadcasts across different chats per window, with one summary', async () => {
    for (let i = 0; i < 26; i++) {
      await claimHandler(unbound({ subject: `relay.human.telegram.tg-bot.chat-${i}` }));
    }
    expect(onUnclaimedChat).toHaveBeenCalledTimes(20);
    expect(onUnclaimedChatBurst).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ limit: 20 })
    );
    // Only the broadcast is capped, never the recording.
    expect(claimStore.list('pending')).toHaveLength(26);
  });
});
