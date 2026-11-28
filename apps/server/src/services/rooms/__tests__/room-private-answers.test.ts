/**
 * DOR-4670: a room turn that answers with an accepted private `chat_send` has
 * answered, so the room must not say it "read this and did not reply". Only the
 * turn that sent it counts, only once the send is accepted, and nothing private
 * reaches the room.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DispatchSessionMessageResult } from '../../session/launch/launch-session.js';
import type { RoomTurnRequest } from '../room-turn-port.js';
import type { RoomSeatMessagesPort } from '../handoff/seat-message-types.js';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import {
  ChatMessageService,
  type ChatCaller,
  type ChatSendReceipt,
} from '../../session/chat-messages/chat-message-service.js';
import { ChatMessageStore } from '../../session/chat-messages/chat-message-store.js';
import {
  agentLookupFor,
  createRoomHarness,
  outcomeRunner,
  settleUntil,
} from './room-test-harness.js';
import { turnsOver } from '../../session/chat-messages/__tests__/chat-turns.fixture.js';

const agents = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'mention-only' },
  '/agents/bo': { name: 'bo', displayName: 'Bo', responseMode: 'mention-only' },
});
const ana: ChatCaller = { sessionId: 'ana-build-seat', agentPath: '/agents/ana' };
const anaInOps: ChatCaller = { sessionId: 'ana-ops-seat', agentPath: '/agents/ana' };
const bo: ChatCaller = { sessionId: 'bo-build-seat', agentPath: '/agents/bo' };
/** Bo's own chat, outside any room: an ordinary private DM target. */
const BO_DM = 'bo-dm';
/** Room seats, by session id, with the agent each belongs to. */
const SEATS = new Map([
  [ana.sessionId, ana.agentPath],
  [anaInOps.sessionId, anaInOps.agentPath],
  [bo.sessionId, bo.agentPath],
]);

let harness: ReturnType<typeof createRoomHarness>;
let chats: ChatMessageService;
let receipts: ChatMessageStore;
let inbox: RoomSeatMessagesPort;
let build: string;
let ops: string;
let dispatched: string[];
/** What Ana's turn does, by the seat it runs on. */
let anaTurn: (request: RoomTurnRequest) => Promise<void>;
/** What Bo's private aside turn does. */
let boTurn: () => Promise<void>;
let title: () => Promise<string | null>;
/** When set, the DM's turn fails inside dispatch, so the send's receipt comes back `failed`. */
let dmFails: boolean;
/** When set, the runtime never names its session, as on a first turn before the rename lands. */
let sessionUnnamed: boolean;
const releases: Array<() => void> = [];

/** A test-owned wait; cleanup releases every one still outstanding. */
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  releases.push(release);
  return { promise, release };
}

beforeEach(() => {
  title = async () => 'PRIVATE_TITLE';
  anaTurn = async () => undefined;
  boTurn = async () => undefined;
  dispatched = [];
  dmFails = false;
  sessionUnnamed = false;
  const runner = outcomeRunner(() => ({ text: null }));
  const run = runner.run.bind(runner);
  runner.run = async (request) => {
    // The scripted runner reports the session onto the claim before any tool runs.
    const result = run(sessionUnnamed ? { ...request, onSessionBound: () => undefined } : request);
    if (request.agentPath === ana.agentPath) await anaTurn(request);
    else await boTurn();
    return result;
  };
  harness = createRoomHarness({ agents, runner });
  const anaId = harness.authors.resolveAgent(ana.agentPath, 'Ana').id;
  const boId = harness.authors.resolveAgent(bo.agentPath, 'Bo').id;
  const now = new Date().toISOString();
  build = harness.service.createRoom(
    { kind: 'channel', title: 'Build', members: [], agentPaths: [ana.agentPath, bo.agentPath] },
    harness.human
  ).id;
  ops = harness.service.createRoom(
    { kind: 'channel', title: 'Ops', members: [], agentPaths: [ana.agentPath] },
    harness.human
  ).id;
  harness.store.bindRoomSession(build, anaId, ana.sessionId, now);
  harness.store.bindRoomSession(build, boId, bo.sessionId, now);
  harness.store.bindRoomSession(ops, anaId, anaInOps.sessionId, now);
  runtimeRegistry.setDb(harness.db);
  receipts = new ChatMessageStore(harness.db);
  inbox = harness.service.createSeatMessages(receipts, () => undefined);
  chats = new ChatMessageService({
    store: receipts,
    seatMessages: () => inbox,
    meshCore: () => undefined,
    describeSession: async (id) =>
      SEATS.has(id)
        ? {
            bound: true,
            roomBound: true,
            launchOrigin: 'room',
            agentPath: SEATS.get(id)!,
            startedByExtension: null,
          }
        : {
            bound: id === BO_DM,
            roomBound: false,
            launchOrigin: id === BO_DM ? 'interactive' : null,
            agentPath: id === BO_DM ? bo.agentPath : null,
            startedByExtension: null,
          },
    chatTitle: () => title(),
    sessionCwd: async () => '/agents/bo',
    isBusy: async () => false,
    turns: turnsOver(async (opts) => {
      if (opts.sessionId !== BO_DM) throw new Error('a seat must never use ordinary dispatch');
      dispatched.push(opts.sessionId);
      if (dmFails) {
        const row = receipts.listSentFrom(ana.sessionId).at(-1)!;
        receipts.update(row.id, { status: 'failed', failureReason: 'The turn could not start.' });
      }
      return {
        accepted: true,
        queued: false,
        queuePosition: 1,
        outcome: { messageId: opts.messageId ?? 'unset', requested: 'queue', applied: 'queue' },
      } as DispatchSessionMessageResult;
    }),
    steerInto: async () => false,
    interruptTurn: async () => false,
    canonicalId: async (id) => id,
    turnLevelOf: () => undefined,
    emitActivity: () => undefined,
    onLifecycle: () => () => undefined,
  });
});

afterEach(async () => {
  releases.splice(0).forEach((release) => release());
  inbox.stop();
  await inbox.idle();
  await harness.service.triggersIdle();
  try {
    for (const room of [build, ops]) {
      expect(noticesIn(room).filter((entry) => entry.body.notice === 'turn_failed')).toEqual([]);
    }
  } finally {
    chats.stop();
    harness.db.$client.close();
  }
});

function noticesIn(roomId: string) {
  return harness.store
    .listEntries(roomId, { limit: 100 })
    .filter((entry) => entry.kind === 'notice');
}

/** The "read this and did not reply" lines in a room. */
function declines(roomId = build) {
  return noticesIn(roomId).filter((entry) => entry.body.notice === 'agent_declined');
}

/** Ask Ana in a room, and wait until the room has settled her turn. */
async function ask(roomId = build, text = '@ana answer privately') {
  const entry = harness.service.post(roomId, { authorId: harness.human, text });
  await harness.service.triggersIdle();
  return entry;
}

/** A private message into Bo's room seat, through the same service `chat_send` calls. */
function sendToBoSeat(from = ana): Promise<ChatSendReceipt> {
  return chats.send(from, { to: bo.sessionId, message: 'PRIVATE_BODY' });
}

describe('a private reply from a room turn', () => {
  it('counts as the answer, and puts nothing private in the room', async () => {
    let receipt: ChatSendReceipt | undefined;
    anaTurn = async () => {
      receipt = await sendToBoSeat();
    };
    await ask();
    await inbox.idle();

    expect(receipt?.status).toBe('queued');
    expect(receipts.get(receipt!.messageId)?.status).toBe('delivered');
    expect(declines()).toEqual([]);
    expect(JSON.stringify(harness.store.listEntries(build, { limit: 100 }))).not.toMatch(
      /PRIVATE_BODY|PRIVATE_TITLE/u
    );
  });

  it('counts a private DM to an agent’s own chat too', async () => {
    anaTurn = async () => {
      await chats.send(ana, { to: BO_DM, message: 'PRIVATE_BODY' });
    };
    await ask();

    expect(dispatched).toEqual([BO_DM]);
    expect(declines()).toEqual([]);
  });

  it('does not count a send whose receipt comes back failed', async () => {
    dmFails = true;
    let receipt: ChatSendReceipt | undefined;
    anaTurn = async () => {
      receipt = await chats.send(ana, { to: BO_DM, message: 'PRIVATE_BODY' });
    };
    await ask();

    expect(receipt?.status).toBe('failed');
    expect(declines()).toHaveLength(1);
  });

  it('counts on a first turn, before the runtime has named its session', async () => {
    sessionUnnamed = true;
    anaTurn = async () => {
      await sendToBoSeat();
    };
    await ask();
    await inbox.idle();

    expect(declines()).toEqual([]);
  });

  it('still says a genuinely quiet turn did not reply', async () => {
    await ask();

    expect(declines()).toHaveLength(1);
    expect(receipts.listSentFrom(ana.sessionId)).toEqual([]);
  });

  it('does not count a refused send', async () => {
    anaTurn = async () => {
      await expect(
        chats.send(ana, { to: bo.sessionId, message: 'PRIVATE_BODY', replyTo: 'not-an-ask' })
      ).rejects.toMatchObject({ code: 'NOT_ALLOWED' });
    };
    await ask();

    expect(receipts.listSentFrom(ana.sessionId)).toEqual([]);
    expect(declines()).toHaveLength(1);
  });

  it('does not count an automatic report', async () => {
    anaTurn = async () => {
      await chats.send(ana, { to: bo.sessionId, message: 'PRIVATE_REPORT' }, 'report');
    };
    await ask();
    await inbox.idle();

    expect(receipts.listSentFrom(ana.sessionId)).toHaveLength(1);
    expect(declines()).toHaveLength(1);
  });

  it('answers only the turn that sent it, not the next quiet one', async () => {
    anaTurn = async () => {
      await sendToBoSeat();
    };
    await ask();
    await inbox.idle();
    expect(declines()).toEqual([]);

    anaTurn = async () => undefined;
    const next = await ask(build, '@ana and now?');

    expect(declines()).toHaveLength(1);
    expect(declines()[0]?.cascadeRoot).toBe(next.cascadeRoot);
  });

  it('does not let a late send from an earlier turn answer a newer one', async () => {
    const titleHeld = gate();
    let waiting = false;
    title = async () => {
      waiting = true;
      await titleHeld.promise;
      return 'PRIVATE_TITLE';
    };
    let late!: Promise<ChatSendReceipt>;
    anaTurn = async () => {
      late = sendToBoSeat();
      late.catch(() => undefined); // Cleanup releases the gate if an assertion fails first.
      await settleUntil(() => waiting, 'the first turn’s send is mid-flight');
    };
    await ask();
    expect(declines()).toHaveLength(1);

    const nextHeld = gate();
    let nextRunning = false;
    anaTurn = async () => {
      nextRunning = true;
      await nextHeld.promise;
    };
    harness.service.post(build, { authorId: harness.human, text: '@ana a new question' });
    await settleUntil(() => nextRunning, 'the second turn is running');
    titleHeld.release();
    const receipt = await late;
    nextHeld.release();
    await harness.service.triggersIdle();
    await inbox.idle();

    expect(receipts.get(receipt.messageId)?.status).toBe('delivered');
    expect(declines()).toHaveLength(2);
  });

  it('answers only its own turn, not another agent’s turn on the same question', async () => {
    const held = gate();
    let running = 0;
    anaTurn = async () => {
      running += 1;
      await chats.send(ana, { to: BO_DM, message: 'PRIVATE_BODY' });
      await held.promise;
    };
    boTurn = async () => {
      running += 1;
      await held.promise;
    };
    harness.service.post(build, { authorId: harness.human, text: '@ana @bo who has this?' });
    await settleUntil(() => running === 2, 'Ana and Bo are both running');
    held.release();
    await harness.service.triggersIdle();

    const boId = harness.authors.resolveAgent(bo.agentPath, 'Bo').id;
    expect(declines().map((entry) => entry.body.subjectAuthorId)).toEqual([boId]);
  });

  it('counts a send made outside the turn’s own async chain', async () => {
    const held = gate();
    let running = false;
    anaTurn = async () => {
      running = true;
      await held.promise;
    };
    harness.service.post(build, { authorId: harness.human, text: '@ana answer privately' });
    await settleUntil(() => running, 'Ana is running');
    // Issued from the test's own chain, as a tool call over the runtime listener is.
    expect(await sendToBoSeat()).toMatchObject({ status: 'queued' });
    held.release();
    await harness.service.triggersIdle();
    await inbox.idle();

    expect(declines()).toEqual([]);
  });

  it('is not answered by the same agent’s other seat, or by the seat it wrote to', async () => {
    const held = gate();
    let running = false;
    let replied: ChatSendReceipt | undefined;
    anaTurn = async () => {
      running = true;
      await held.promise;
    };
    boTurn = async () => {
      // Bo's private aside sends its own accepted message while Ana's room turn is held.
      replied = await chats.send(bo, { to: BO_DM, message: 'PRIVATE_REPLY' });
    };
    harness.service.post(build, { authorId: harness.human, text: '@ana stay quiet' });
    await settleUntil(() => running, 'Ana is running');
    // Ana's Ops seat holds no turn, so this send answers nothing; it only wakes Bo.
    expect(await chats.send(anaInOps, { to: bo.sessionId, message: 'PRIVATE_BODY' })).toMatchObject(
      {
        status: 'queued',
      }
    );
    await settleUntil(() => replied !== undefined, 'Bo sent from its private aside');
    held.release();
    await harness.service.triggersIdle();
    await inbox.idle();

    expect(declines()).toHaveLength(1);
    expect(JSON.stringify(harness.store.listEntries(build, { limit: 100 }))).not.toContain(
      'PRIVATE_REPLY'
    );
  });
});
