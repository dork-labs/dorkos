/**
 * `ChatBridgeDelivery` routing: which room posts reach the platform chat, under
 * which principal, with which wire text (chats-as-channels §6.1–§6.7), and what
 * happens when the platform says no (§10). Shared setup and the mocking stance
 * live in `deliver.fixtures.ts`.
 */
import { describe, it, expect, vi } from 'vitest';
import type { PublishOptions } from '@dorkos/relay';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { RoomEntry } from '@dorkos/shared/room-schemas';
import { ChatMessageStore } from '../../../session/chat-messages/chat-message-store.js';
import { ChatMessageService } from '../../../session/chat-messages/chat-message-service.js';
import { runtimeRegistry } from '../../../core/runtime-registry.js';
import { describeSessionFor } from '../../../extensions/agent-send/agent-send-defaults.js';
import { roomSessionPlace } from '../../../rooms/repo/room-turn-place.js';
import {
  agentLookupFor,
  createRoomHarness,
  outcomeRunner,
} from '../../../rooms/__tests__/room-test-harness.js';
import { ChatBridgeDelivery } from '../index.js';
import {
  ADAPTER,
  AGENT_PATH,
  BINDING_ID,
  bindingRow,
  externalIdentity,
  makeBinding,
  subjectFor,
  useDeliveryFixture,
} from './deliver.fixtures.js';
import { turnsOver } from '../../../session/chat-messages/__tests__/chat-turns.fixture.js';

describe('ChatBridgeDelivery routing (chats-as-channels §6)', () => {
  const t = useDeliveryFixture();
  const { bridgeRequest, makeDelivery, noticesOf, seedInbound, agentPost, operatorPost } = t;

  it('M5: a peer-message aside cannot use the inbound reply exemption; the same bridge delivers a real reply', async () => {
    const posted: RoomEntry[] = [];
    t.harness = createRoomHarness({
      agents: agentLookupFor({
        [AGENT_PATH]: { name: 'ana', displayName: 'Ana', responseMode: 'mention-only' },
      }),
      runner: outcomeRunner((request) => {
        if (request.prompt.includes('PRIVATE_ASIDE_TEST')) {
          expect(request.sessionId).toBe('m5-seat');
          posted.push(
            t.harness.service.postFromTool(request.room.id, {
              authorId: request.authorId,
              callerSessionId: request.sessionId ?? undefined,
              text: 'Explicit post from the private aside.',
            })
          );
        }
        return { text: null };
      }),
    });
    const room = t.harness.service.createBridgedRoom(bridgeRequest('555', true));
    const author = t.harness.authors.resolveAgent(AGENT_PATH, 'Ana');
    t.harness.store.bindRoomSession(room.id, author.id, 'm5-seat', new Date().toISOString());
    const external = t.harness.authors.resolveExternal({
      platformType: 'telegram',
      instanceId: ADAPTER,
      platformUserId: 'outsider',
      displayName: 'Guest',
    });
    const inbound = t.harness.store.appendEntry({
      roomId: room.id,
      id: 'm5-inbound',
      authorId: external.id,
      kind: 'post',
      body: { text: 'An inbound question.' },
      mentions: [],
      sessionId: null,
      cascadeRoot: 'm5-inbound',
      cascadeDepth: 0,
      parentEntryId: null,
      threadRootEntryId: null,
      createdAt: new Date().toISOString(),
    });
    t.harness.bridges.recordInboundRef({
      roomId: room.id,
      entryId: inbound.id,
      adapterId: ADAPTER,
      chatId: '555',
      platformMessageId: 'm5-platform',
      createdAt: new Date().toISOString(),
    });
    t.binding = makeBinding({ canInitiate: false, canReply: true });
    // Publication enters the real consent gate; only this post-gate seam reaches the platform.
    const adapterDelivery = vi.fn(() => ({ success: true, responseMessageId: 'm5-outbound' }));
    t.nextAdapterResult = adapterDelivery;
    const delivery = makeDelivery(bindingRow(room.id, '555'));
    const receipts = new ChatMessageStore(t.harness.db);
    const inbox = t.harness.service.createSeatMessages(receipts, () => undefined);
    runtimeRegistry.setDb(t.harness.db);
    runtimeRegistry.register(new FakeAgentRuntime('claude-code'));
    t.harness.db.$client
      .prepare(
        "INSERT INTO session_metadata(session_id,runtime,agent_path,launch_origin,created_at) VALUES ('m5-seat','claude-code',?,'room','2026-11-15')"
      )
      .run(AGENT_PATH);
    receipts.insert({
      id: 'm5-ask',
      fromSessionId: 'm5-seat',
      toSessionId: 'peer-chat',
      fromAgentPath: AGENT_PATH,
      fromAgentId: 'agent-1',
      fromAgentName: 'Ana',
      fromChatTitle: null,
      kind: 'message',
      text: 'A real private question',
      summary: null,
      nonce: null,
      delivery: 'queue',
      status: 'delivered',
      queueMessageId: null,
      ceilingJson: '"none"',
      replyToId: null,
    });
    const placement = roomSessionPlace({
      bindings: t.harness.store.sessionLedger,
      authors: t.harness.authors,
      worktrees: () => null,
    });
    const chats = new ChatMessageService({
      store: receipts,
      meshCore: () => undefined,
      describeSession: describeSessionFor(() => placement),
      chatTitle: async () => null,
      sessionCwd: async () => AGENT_PATH,
      isBusy: async () => false,
      turns: turnsOver(async () => {
        throw new Error('No ordinary dispatch for a bridged-seat answer');
      }),
      steerInto: async () => false,
      interruptTurn: async () => false,
      canonicalId: async (id) => id,
      turnLevelOf: () => ({ asks: 'never', reach: 'everything' }),
      emitActivity: () => undefined,
      onLifecycle: () => () => undefined,
      seatMessages: () => inbox,
    });
    const answer = await chats.send(
      { sessionId: 'peer-chat', agentPath: '/agents/peer' },
      { to: 'm5-seat', message: 'PRIVATE_ASIDE_TEST', replyTo: 'm5-ask' }
    );
    await inbox.idle();
    expect(receipts.get(answer.messageId)?.status).toBe('delivered');
    expect(posted).toHaveLength(1);
    // Invoke the real bridge before asserting its classification: the no-aside mutant must
    // actually deliver through the reply exemption, not fail on a decorative root assertion.
    const privateOutcome = await delivery.deliverEntry(posted[0]!);
    expect(adapterDelivery).not.toHaveBeenCalled();
    expect(privateOutcome).toBe('blocked');
    expect(noticesOf(room.id, 'bridge_blocked')).toHaveLength(1);
    expect(posted[0]!.cascadeRoot).not.toBe(inbound.id);
    expect(t.publish).toHaveBeenCalledTimes(1);
    expect(t.publish.mock.calls[0]![2].from).toBe('relay.bridge.initiate.tg-main.555');
    // Live positive control: identical binding, gate and outbound seam, genuine inbound root.
    const positive = agentPost(room.id, 'A genuine answer.', inbound.id);
    expect(await delivery.deliverEntry(positive)).toBe('delivered');
    expect(t.publish).toHaveBeenCalledTimes(2);
    expect(adapterDelivery).toHaveBeenCalledTimes(1);
    expect(t.publish.mock.calls[1]![2].from).toBe('relay.bridge.reply.tg-main.555');
    chats.stop();
    inbox.stop();
  });

  it('A6.1: an inbound message never round-trips back to the platform', async () => {
    const room = t.harness.service.createBridgedRoom(bridgeRequest('555'));
    const delivery = makeDelivery(bindingRow(room.id, '555'));
    const inbound = seedInbound(room.id, '555', 'hi from the chat', 'pm-1');

    const outcome = await delivery.deliverEntry(inbound);

    expect(outcome).toBe('echo');
    expect(t.publish).not.toHaveBeenCalled();
  });

  it('A6.2: a retry for an already-delivered entry sends nothing; a crash-simulated ref suppresses the retry', async () => {
    const room = t.harness.service.createBridgedRoom(bridgeRequest('555'));
    const delivery = makeDelivery(bindingRow(room.id, '555'));
    const inbound = seedInbound(room.id, '555', 'ping', 'pm-1');
    const answer = agentPost(room.id, 'pong', inbound.id);

    const first = await delivery.deliverEntry(answer);
    const second = await delivery.deliverEntry(answer);
    expect(first).toBe('delivered');
    expect(second).toBe('noop');
    // One send, not two — idempotence on the entry (§6.3).
    expect(t.publish).toHaveBeenCalledTimes(1);

    // A crash between ref-write and send is simulated by a pre-seeded null-id
    // outbound ref on a fresh entry: the retry finds it and no-ops, so a person
    // never sees a duplicate.
    const answer2 = agentPost(room.id, 'second answer', inbound.id);
    t.harness.bridges.recordOutboundRef({
      roomId: room.id,
      entryId: answer2.id,
      chatId: '555',
      adapterId: ADAPTER,
      createdAt: new Date().toISOString(),
    });
    const retry = await delivery.deliverEntry(answer2);
    expect(retry).toBe('noop');
    expect(t.publish).toHaveBeenCalledTimes(1); // still one — no duplicate
  });

  it('a scripted greeting stays in the app: the bridge never delivers it', async () => {
    const room = t.harness.service.createBridgedRoom(bridgeRequest('555'));
    const delivery = makeDelivery(bindingRow(room.id, '555'));
    t.binding = makeBinding({ canReply: true, canInitiate: true });
    const agent = t.harness.authors.resolveAgent(AGENT_PATH, 'Ana');
    // The control: the same agent's ordinary post here is delivered.
    expect(await delivery.deliverEntry(agentPost(room.id, 'hello'))).toBe('delivered');
    const greeting = t.harness.service.postAgentGreeting(room.id, {
      authorId: agent.id,
      text: 'Hi there. Your agents are ready.',
      greeting: 'first-run',
    });
    expect(await delivery.deliverEntry(greeting)).toBe('skipped');
    expect(t.publish).toHaveBeenCalledTimes(1);
  });

  it('A6.3: a cockpit post reaches the chat when canInitiate is on, is blocked (with a notice) when off', async () => {
    const room = t.harness.service.createBridgedRoom(bridgeRequest('555'));
    const delivery = makeDelivery(bindingRow(room.id, '555'));

    t.binding = makeBinding({ canInitiate: true });
    const okPost = operatorPost(room.id, 'hello from cockpit');
    expect(await delivery.deliverEntry(okPost)).toBe('delivered');

    t.binding = makeBinding({ canInitiate: false });
    const blockedPost = operatorPost(room.id, 'blocked cockpit message');
    expect(await delivery.deliverEntry(blockedPost)).toBe('blocked');
    expect(noticesOf(room.id, 'bridge_blocked')).toHaveLength(1);
  });

  it('A6.4: an agent answer reaches the chat with canReply on, is blocked with canReply off', async () => {
    const room = t.harness.service.createBridgedRoom(bridgeRequest('555'));
    const delivery = makeDelivery(bindingRow(room.id, '555'));
    const inbound = seedInbound(room.id, '555', 'question', 'pm-1');

    // canInitiate OFF proves this rode canReply, not the initiate blanket.
    t.binding = makeBinding({ canInitiate: false, canReply: true });
    const answer = agentPost(room.id, 'the answer', inbound.id);
    expect(await delivery.deliverEntry(answer)).toBe('delivered');

    t.binding = makeBinding({ canInitiate: false, canReply: false });
    const inbound2 = seedInbound(room.id, '555', 'question 2', 'pm-2');
    const answer2 = agentPost(room.id, 'blocked answer', inbound2.id);
    expect(await delivery.deliverEntry(answer2)).toBe('blocked');
  });

  it('A6.4 companion: reply and initiate publish under distinguishable principals, with a dotted chat id', async () => {
    // A chat id containing a dot: a positional parse bug cannot hide behind a
    // passing gate decision (spec §6.4).
    const room = t.harness.service.createBridgedRoom(bridgeRequest('55.5'));
    const delivery = makeDelivery(bindingRow(room.id, '55.5'));
    const inbound = seedInbound(room.id, '55.5', 'q', 'pm-1');

    const answer = agentPost(room.id, 'a', inbound.id);
    await delivery.deliverEntry(answer);
    const cockpit = operatorPost(room.id, 'c');
    await delivery.deliverEntry(cockpit);

    const froms = t.publish.mock.calls.map((c) => (c[2] as PublishOptions).from);
    expect(froms).toContain('relay.bridge.reply.tg-main.55.5');
    expect(froms).toContain('relay.bridge.initiate.tg-main.55.5');

    // DOR-889: every bridge delivery asserts the server trust marker, or the
    // publish pipeline's bridge-principal guard would reject it as a
    // caller-supplied `relay.bridge.*` `from`. Both the reply and the initiate
    // above carry it.
    const markers = t.publish.mock.calls.map((c) => (c[2] as PublishOptions).serverBridgePrincipal);
    expect(markers.every((m) => m === true)).toBe(true);
  });

  it('A6.5: a post whose author is neither the bound agent nor the operator is refused inside deliver, before any publish', async () => {
    const room = t.harness.service.createBridgedRoom(bridgeRequest('555', true));
    const delivery = makeDelivery(bindingRow(room.id, '555'));
    // An external human's post with NO inbound ref — the author check, not echo
    // suppression, is what must refuse it.
    const identity = externalIdentity('999', 'Stranger');
    if (!identity) throw new Error('identity');
    const { entry } = t.harness.service.postExternal(room.id, { identity, text: 'sneak this out' });
    const full = t.harness.store.getEntryById(room.id, entry.id);

    const outcome = await delivery.deliverEntry(full!);

    expect(outcome).toBe('refused_author');
    expect(t.publish).not.toHaveBeenCalled();
  });

  it('A6.7: a delivered answer to a forum-topic message carries that topic message_thread_id', async () => {
    const room = t.harness.service.createBridgedRoom(bridgeRequest('555', true));
    const delivery = makeDelivery(bindingRow(room.id, '555'));
    const inbound = seedInbound(room.id, '555', 'in a topic', 'pm-1', '42');

    const answer = agentPost(room.id, 'answering in the topic', inbound.id);
    expect(await delivery.deliverEntry(answer)).toBe('delivered');

    const payload = t.publish.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.messageThreadId).toBe('42');
    expect(payload.replyToMessageId).toBe('pm-1');
    // The bound agent's own posts are NOT prefixed — the bot is its identity (§6.7).
    expect(payload.content).toBe('answering in the topic');
  });

  it('A6.9 (DOR-899): an operator post carries the real name on the wire — never "You:" — and NOT in the stored body', async () => {
    const room = t.harness.service.createBridgedRoom(bridgeRequest('555'));
    const delivery = makeDelivery(bindingRow(room.id, '555'));
    const wire = (i: number) =>
      (t.publish.mock.calls[i][1] as Record<string, unknown>).content as string;

    // Nothing configured (the fixture default): a neutral label.
    const first = operatorPost(room.id, 'raw cockpit text');
    await delivery.deliverEntry(first);
    expect(wire(0)).toBe('Operator: raw cockpit text');

    // The author-registry row stays 'You', so the name came from the resolver.
    t.operatorDisplayName = () => 'Dorian';
    await delivery.deliverEntry(operatorPost(room.id, 'second'));
    expect(t.harness.authors.getById(t.harness.human)!.displayName).toBe('You');
    expect(wire(1)).toBe('Dorian: second');
    // The stored entry body is exactly what was typed (§6.7).
    expect(t.harness.store.getEntryById(room.id, first.id)!.body.text).toBe('raw cockpit text');
  });

  describe('the consent table (§6.6)', () => {
    it('case 7: a paused binding (enabled:false) blocks even an inbound-rooted reply', async () => {
      const room = t.harness.service.createBridgedRoom(bridgeRequest('555'));
      const delivery = makeDelivery(bindingRow(room.id, '555'));
      const inbound = seedInbound(room.id, '555', 'q', 'pm-1');
      t.binding = makeBinding({ enabled: false, canReply: true });
      const answer = agentPost(room.id, 'blocked by pause', inbound.id);
      expect(await delivery.deliverEntry(answer)).toBe('blocked');
    });

    it('case 9: a cross-room root does NOT launder an initiate — S with canInitiate off blocks', async () => {
      // Two bridged chats. An agent post in room S whose cascade root is an
      // entry from room R (an inbound message there) must classify as an
      // initiate in S, so S's canInitiate:false blocks it.
      const roomR = t.harness.service.createBridgedRoom(bridgeRequest('111'));
      const roomS = t.harness.service.createBridgedRoom({
        ...bridgeRequest('222'),
        bindingId: BINDING_ID,
      });
      const delivery = makeDelivery(bindingRow(roomS.id, '222'));
      const inboundR = seedInbound(roomR.id, '111', 'stranger in R', 'pm-r');
      // A post in S that (wrongly) inherits R's root.
      const agent = t.harness.authors.resolveAgent(AGENT_PATH, 'Ana');
      const leak = t.harness.service.post(roomS.id, {
        authorId: agent.id,
        text: 'laundered',
        trigger: { root: inboundR.id, depth: 1 },
      });
      t.binding = makeBinding({ canInitiate: false, canReply: true });

      expect(await delivery.deliverEntry(leak)).toBe('blocked');
      // It published under the INITIATE principal, not reply — the root did not launder.
      const from = (t.publish.mock.calls[0][2] as PublishOptions).from;
      expect(from).toBe('relay.bridge.initiate.tg-main.222');
    });

    it('case 10: a self-rooted agent answer (post-restart) blocks with the dedicated restart copy', async () => {
      const room = t.harness.service.createBridgedRoom(bridgeRequest('555'));
      const delivery = makeDelivery(bindingRow(room.id, '555'));
      t.binding = makeBinding({ canInitiate: false, canReply: true });
      // A self-rooted agent post — the shape a late answer takes after a restart
      // dropped its live claim (§6.6).
      const orphan = agentPost(room.id, 'answer with lost provenance');

      expect(await delivery.deliverEntry(orphan)).toBe('blocked');
      const notice = noticesOf(room.id, 'bridge_blocked');
      expect(notice).toHaveLength(1);
      expect(notice[0].body.text).toContain('lost its provenance');
    });
  });
});

describe('ChatBridgeDelivery failures (chats-as-channels §10)', () => {
  const t = useDeliveryFixture();
  const { bridgeRequest, makeDelivery, noticesOf, operatorPost } = t;

  it('A10.1: a delivery failure leaves the entry, rolls the ref back, and writes exactly one bridge_undelivered notice', async () => {
    const room = t.harness.service.createBridgedRoom(bridgeRequest('555'));
    const delivery = makeDelivery(bindingRow(room.id, '555'));
    const post = operatorPost(room.id, 'never lands');
    // Every attempt fails transiently (no code = platform down / disconnected).
    t.nextAdapterResult = () => ({ success: false, error: 'ECONNRESET' });

    const outcome = await delivery.deliverEntry(post);

    expect(outcome).toBe('undelivered');
    // Ref rolled back so the reconnect scan can re-deliver it (§10.1).
    expect(t.harness.bridges.findRefByEntry(post.id)).toBeNull();
    // The entry itself is untouched, and one notice names it.
    expect(t.harness.store.getEntryById(room.id, post.id)).not.toBeNull();
    expect(noticesOf(room.id, 'bridge_undelivered')).toHaveLength(1);
    // Three attempts: the initial send plus two retries (retryBackoffMs has two).
    expect(t.publish).toHaveBeenCalledTimes(3);
  });

  it('A10.2: a 429 holds the chat in seq order — the second delivery cannot publish during the first retry_after wait', async () => {
    const room = t.harness.service.createBridgedRoom(bridgeRequest('555'));
    const waits: number[] = [];
    // The tag of every t.publish, in call order — 'first' or 'second' by content.
    // This is the load-bearing assertion: a SET of outcomes ({both delivered},
    // {waits has 5000}) is satisfied by the WRONG interleaving too, so seq order
    // has to be proved on the ORDER of the calls themselves.
    const order: Array<'first' | 'second'> = [];
    let publishCount = 0;
    const delivery = new ChatBridgeDelivery({
      entries: t.harness.store,
      rooms: t.harness.service,
      bridges: t.harness.bridges,
      authors: t.harness.authors,
      publisher: {
        publish: (async (_subject: string, payload: unknown, _opts: PublishOptions) => {
          const content = (payload as { content?: string }).content ?? '';
          order.push(content.includes('first') ? 'first' : 'second');
          publishCount += 1;
          // The VERY FIRST publish (the first entry's first attempt) is rate
          // limited; everything after succeeds. If the chain held, "everything
          // after" is: the first entry's retry, then the second entry. If the
          // chain were broken, the second entry would publish DURING the first's
          // retry_after sleep and land here as the second call.
          if (publishCount === 1) {
            return {
              messageId: 'm',
              deliveredTo: 0,
              adapterResult: { success: false, code: 'rate_limited' as const, retryAfterMs: 5000 },
            };
          }
          return {
            messageId: 'm',
            deliveredTo: 1,
            adapterResult: { success: true, responseMessageId: 't' },
          };
        }) as never,
      },
      lifecycle: { unbridge: async () => {} },
      resolveSubject: subjectFor,
      operatorAuthorId: () => t.harness.human,
      sleep: async (ms) => {
        waits.push(ms);
      },
      retryBackoffMs: [1, 1],
    });

    const first = operatorPost(room.id, 'first');
    const second = operatorPost(room.id, 'second');
    const [a, b] = await Promise.all([delivery.deliverEntry(first), delivery.deliverEntry(second)]);

    expect(a).toBe('delivered');
    expect(b).toBe('delivered');
    // The 429's retry_after was honoured exactly.
    expect(waits).toContain(5000);
    // Seq order held ACROSS the wait: the first entry is published (429) then
    // re-published (success) before the second entry is published at all. Remove
    // the per-chat serialization and the second would jump the queue during the
    // first's sleep, giving ['first', 'second', 'first'] — which this rejects.
    expect(order).toEqual(['first', 'first', 'second']);
  });

  it('A10.3: a 403 archives the room, turns the bridge off, and writes a notice with the reason', async () => {
    const room = t.harness.service.createBridgedRoom(bridgeRequest('555'));
    const seed = bindingRow(room.id, '555');
    const delivery = makeDelivery(seed);
    const post = operatorPost(room.id, 'to a chat that kicked us');
    t.nextAdapterResult = () => ({
      success: false,
      code: 'chat_unavailable',
      error: 'Forbidden: bot was blocked by the user',
    });

    const outcome = await delivery.deliverEntry(post);

    expect(outcome).toBe('terminal');
    // Terminal, not retried — one attempt only.
    expect(t.publish).toHaveBeenCalledTimes(1);
    // The room is archived and the bridge row stamped (via BridgeLifecycle).
    expect(t.harness.store.getRoom(room.id)?.archived).toBe(true);
    expect(t.harness.bridges.findBridgeByRoom(room.id)?.archivedAt).not.toBeNull();
    // The disconnect notice carries the platform's own reason.
    const disconnect = noticesOf(room.id, 'bridge_disconnected');
    expect(disconnect).toHaveLength(1);
    expect(disconnect[0].body.text).toContain('blocked');
  });

  describe('sweepStrandedRefs — the startup stranded-ref sweep (spec §10.1 crash divergence, DOR-898)', () => {
    /** An outbound ref written but never patched — simulates a crash between the write and the send. */
    function seedStrandedRef(roomId: string, chatId: string, entryId: string, createdAt: string) {
      t.harness.bridges.recordOutboundRef({
        roomId,
        entryId,
        chatId,
        adapterId: ADAPTER,
        createdAt,
      });
    }

    const WELL_PAST_THRESHOLD = new Date(Date.now() - 20 * 60_000).toISOString();

    it('a stranded null-id ref gets exactly one bridge_undelivered notice across sweeps, and is neither deleted nor re-sent', async () => {
      const room = t.harness.service.createBridgedRoom(bridgeRequest('900'));
      const delivery = makeDelivery(bindingRow(room.id, '900'));
      const post = operatorPost(room.id, 'crashed before the send landed');
      seedStrandedRef(room.id, '900', post.id, WELL_PAST_THRESHOLD);

      // Two startup sweeps: damped, so still exactly one notice.
      await delivery.sweepStrandedRefs();
      await delivery.sweepStrandedRefs();

      // Never re-sent: the crashed send may have already reached the platform.
      expect(t.publish).not.toHaveBeenCalled();
      // Never deleted: a rollback would return the entry to the catch-up
      // scan's candidate set and risk a duplicate on the next reconnect.
      const ref = t.harness.bridges.findRefByEntry(post.id);
      expect(ref).not.toBeNull();
      expect(ref?.direction).toBe('outbound');
      expect(ref?.platformMessageId).toBeNull();
      // The same notice code the exhausted-retry path writes (spec §10.1) —
      // exactly one, naming this entry.
      const notices = noticesOf(room.id, 'bridge_undelivered');
      expect(notices).toHaveLength(1);
      expect(notices[0].body.text).toContain('crashed before the send landed');
    });
  });
});
