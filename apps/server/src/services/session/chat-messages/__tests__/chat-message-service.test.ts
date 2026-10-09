/**
 * `chat_send`, `chat_stop` and the lifecycle that follows a sent message
 * (spec `spin-off-chats` §1-§3), below the capability boundary.
 *
 * The chat-message store and the dispatcher's queue are real SQLite: batching,
 * interrupt and stop are rules about the rows in that queue, and a fake would
 * be asserting them against itself. The launch path (`dispatchSessionMessage`)
 * is a stand-in that writes the queue row a busy chat would get, so what the
 * service does to that row afterwards is what is under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { chatMessageFenceNonces } from '@dorkos/shared/chat-messages';
import type { TurnPermissionLevel } from '@dorkos/shared/agent-runtime';

vi.mock('../../../audit/audit-trail.js', () => ({ recordAudit: vi.fn() }));
// One seam on the real dispatcher module: whether a queue row is being read
// into a turn this tick, which only a real launch can make true.
vi.mock('../../message-dispatcher.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../message-dispatcher.js')>();
  return { ...actual, isQueuedMessageLaunching: vi.fn(() => false) };
});

import { recordAudit } from '../../../audit/audit-trail.js';
import { isQueuedMessageLaunching, type DispatchLifecycleEvent } from '../../message-dispatcher.js';
import { MessageQueueStore, setMessageQueueStore } from '../../message-queue-store.js';
import type {
  DispatchSessionMessageOpts,
  DispatchSessionMessageResult,
} from '../../launch/launch-session.js';
import type { SessionFacts } from '../../../extensions/agent-send/agent-send-defaults.js';
import { ChatMessageStore } from '../chat-message-store.js';
import {
  CHAT_BATCH_WINDOW_MS,
  ChatMessageError,
  ChatMessageService,
  type ChatMessageServiceDeps,
} from '../chat-message-service.js';

const ANA = { sessionId: 'chat-a', agentPath: '/agents/ana' };
const PERSON = 'window-a';

const TIGHT: TurnPermissionLevel = { asks: 'always', reach: 'edit' };
const MIDDLE: TurnPermissionLevel = { asks: 'when-risky', reach: 'workspace' };
const LOOSE: TurnPermissionLevel = { asks: 'never', reach: 'everything' };

let store: ChatMessageStore;
let queue: MessageQueueStore;
let service: ChatMessageService;
let sessions: Map<string, SessionFacts>;
let busy: Set<string>;
let levels: Map<string, TurnPermissionLevel>;
let dispatched: DispatchSessionMessageOpts[];
let dispatchImpl: (opts: DispatchSessionMessageOpts) => Promise<DispatchSessionMessageResult>;
let interruptTurn: ReturnType<typeof vi.fn<(sessionId: string) => Promise<boolean>>>;
let emitActivity: ReturnType<typeof vi.fn<(sessionId: string) => void>>;
let lifecycle: ((event: DispatchLifecycleEvent) => void) | undefined;
let nonceCounter: number;
let openedCounter: number;

const agents = [
  { id: 'agent-ana', name: 'ana', displayName: 'Ana', projectPath: '/agents/ana' },
  { id: 'agent-bo', name: 'bo', displayName: 'Bo', projectPath: '/agents/bo' },
];

const mesh = {
  get: (id: string) => agents.find((a) => a.id === id),
  getProjectPath: (id: string) => agents.find((a) => a.id === id)?.projectPath,
  listWithPaths: () => agents,
};

/** A chat another chat may write into. */
function chat(id: string, facts: Partial<SessionFacts> = {}): void {
  sessions.set(id, {
    bound: true,
    launchOrigin: 'interactive',
    agentPath: '/agents/bo',
    startedByExtension: null,
    roomBound: false,
    ...facts,
  });
}

/**
 * What the launch path answers: an idle chat runs at once; a busy one gets a
 * queue row under the id it was handed, at the tail, as the dispatcher writes it.
 */
async function defaultDispatch(
  opts: DispatchSessionMessageOpts
): Promise<DispatchSessionMessageResult> {
  const sessionId = opts.sessionId;
  const messageId = opts.messageId ?? 'unset';
  const steer = opts.request.disposition === 'steer';
  if (busy.has(sessionId) && !steer) {
    queue.enqueue({
      id: messageId,
      sessionId,
      content: opts.request.content,
      clientId: opts.clientId,
    });
    return {
      accepted: true,
      queued: true,
      queuePosition: queue.list(sessionId).length,
      outcome: { messageId, requested: 'queue', applied: 'queue' },
    } as DispatchSessionMessageResult;
  }
  return {
    accepted: true,
    queued: false,
    queuePosition: steer ? 0 : 1,
    outcome: {
      messageId,
      requested: steer ? 'steer' : 'queue',
      applied: steer ? 'steer' : 'queue',
    },
  } as DispatchSessionMessageResult;
}

function build(overrides: Partial<ChatMessageServiceDeps> = {}): ChatMessageService {
  return new ChatMessageService({
    store,
    meshCore: () => mesh as never,
    describeSession: async (id) =>
      sessions.get(id) ?? {
        bound: false,
        launchOrigin: null,
        agentPath: null,
        startedByExtension: null,
        roomBound: false,
      },
    chatTitle: async (id) => (id === ANA.sessionId ? 'Planning' : `Title of ${id}`),
    sessionCwd: async (id) => `/work/${id}`,
    isBusy: async (id) => busy.has(id),
    dispatch: async (opts) => {
      dispatched.push(opts);
      return dispatchImpl(opts);
    },
    interruptTurn,
    turnLevelOf: (id) => levels.get(id),
    emitActivity,
    onLifecycle: (listener) => {
      lifecycle = listener;
      return () => {
        lifecycle = undefined;
      };
    },
    nonce: () => (nonceCounter++).toString(16).padStart(8, '0'),
    ...overrides,
  });
}

/** The chat messages Ana's chat sent, oldest first. */
function sentByAna() {
  return store.listSentFrom(ANA.sessionId);
}

async function refusal(promise: Promise<unknown>): Promise<ChatMessageError> {
  const err = await promise.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ChatMessageError);
  return err as ChatMessageError;
}

beforeEach(() => {
  const db = createTestDb();
  store = new ChatMessageStore(db);
  queue = new MessageQueueStore(db);
  setMessageQueueStore(queue);
  sessions = new Map();
  busy = new Set();
  levels = new Map();
  dispatched = [];
  dispatchImpl = defaultDispatch;
  interruptTurn = vi.fn(async () => true);
  emitActivity = vi.fn();
  lifecycle = undefined;
  nonceCounter = 0xa0;
  openedCounter = 0;
  vi.mocked(isQueuedMessageLaunching).mockReturnValue(false);
  vi.mocked(recordAudit).mockClear();
  chat(ANA.sessionId, { agentPath: ANA.agentPath });
  service = build();
});

afterEach(() => {
  service.stop();
  setMessageQueueStore(undefined);
});

describe('send — to an idle chat', () => {
  it('dispatches as a chat message under the sender’s lock identity and the row’s queue id', async () => {
    chat('chat-b');
    const receipt = await service.send(ANA, { to: 'chat-b', message: '  Please review PR 12.  ' });

    expect(dispatched).toHaveLength(1);
    const [opts] = dispatched;
    const [row] = sentByAna();
    expect(opts!.origin).toEqual({ kind: 'chat-message' });
    expect(opts!.sessionId).toBe('chat-b');
    expect(opts!.clientId).toBe('chat:chat-a');
    expect(opts!.messageId).toBe(row!.queueMessageId);
    expect(opts!.request.cwd).toBe('/work/chat-b');
    expect(opts!.request.disposition).toBeUndefined();
    // The receiving agent reads the fence, and its nonce is the one recorded.
    expect(chatMessageFenceNonces(opts!.request.content)).toEqual([row!.nonce]);
    expect(opts!.request.content).toContain('Please review PR 12.');
    expect(opts!.request.content).toContain('From: Ana (agent agent-ana)');
    expect(opts!.countsTowardLaunchCap).toBe(true);

    expect(row).toMatchObject({
      toSessionId: 'chat-b',
      fromAgentName: 'Ana',
      fromAgentId: 'agent-ana',
      fromChatTitle: 'Planning',
      text: 'Please review PR 12.',
      status: 'working',
    });
    expect(receipt).toEqual({ messageId: row!.id, chatId: 'chat-b', status: 'working' });
    expect(emitActivity).toHaveBeenCalledWith('chat-a');
    expect(emitActivity).toHaveBeenCalledWith('chat-b');
  });

  it('records the sender’s level as the ceiling the queued row launches under', async () => {
    chat('chat-b');
    levels.set(ANA.sessionId, MIDDLE);
    await service.send(ANA, { to: 'chat-b', message: 'hi' });
    expect(service.ceilingForQueuedMessage(sentByAna()[0]!.queueMessageId!)).toEqual(MIDDLE);
  });

  it('keeps the trimmed summary', async () => {
    chat('chat-b');
    await service.send(ANA, { to: 'chat-b', message: 'hi', summary: '  Build check  ' });
    expect(sentByAna()[0]!.summary).toBe('Build check');
  });
});

describe('send — to a busy chat', () => {
  it('answers queued with the place in line, and adds no launch', async () => {
    chat('chat-b');
    busy.add('chat-b');
    queue.enqueue({ sessionId: 'chat-b', content: 'person words', clientId: PERSON });

    const receipt = await service.send(ANA, { to: 'chat-b', message: 'hi' });

    expect(receipt).toMatchObject({ status: 'queued', position: 2 });
    expect(dispatched[0]!.countsTowardLaunchCap).toBe(false);
    expect(sentByAna()[0]!.status).toBe('queued');
  });
});

describe('send — refusals', () => {
  it('refuses the caller’s own chat', async () => {
    expect((await refusal(service.send(ANA, { to: 'chat-a', message: 'hi' }))).code).toBe('SELF');
    expect(dispatched).toEqual([]);
  });

  it('refuses a chat this server never bound', async () => {
    expect((await refusal(service.send(ANA, { to: 'nowhere', message: 'hi' }))).code).toBe(
      'NOT_FOUND'
    );
    expect(sentByAna()).toEqual([]);
  });

  it.each([
    ['a room’s conversation', { roomBound: true }],
    ['a room origin', { launchOrigin: 'room' }],
    ['an unknown (null) origin', { launchOrigin: null }],
    ['a bridged relay binding', { launchOrigin: 'relay-binding' }],
    ['a schedule', { launchOrigin: 'schedule' }],
  ] as const)('refuses %s as NOT_ALLOWED', async (_label, facts) => {
    chat('chat-b', facts);
    expect((await refusal(service.send(ANA, { to: 'chat-b', message: 'hi' }))).code).toBe(
      'NOT_ALLOWED'
    );
    expect(dispatched).toEqual([]);
    expect(sentByAna()).toEqual([]);
  });

  it('accepts every sendable origin a person-side chat can have', async () => {
    for (const origin of ['agent-launch', 'chat-message', 'extension-start', 'account-handoff']) {
      chat(`chat-${origin}`, { launchOrigin: origin });
      await expect(
        service.send(ANA, { to: `chat-${origin}`, message: 'hi' })
      ).resolves.toMatchObject({ chatId: `chat-${origin}` });
    }
  });

  it('refuses an empty message', async () => {
    chat('chat-b');
    expect((await refusal(service.send(ANA, { to: 'chat-b', message: '   ' }))).code).toBe(
      'INVALID_INPUT'
    );
    expect(dispatched).toEqual([]);
  });

  it('removes the row when the launch path refuses, so no stamp names a send that never happened', async () => {
    chat('chat-b');
    dispatchImpl = async () =>
      ({
        refused: 'DESK_NOT_OWN',
        message: 'That desk is not yours.',
      }) as DispatchSessionMessageResult;

    const err = await refusal(service.send(ANA, { to: 'chat-b', message: 'hi' }));

    expect(err.code).toBe('NOT_ALLOWED');
    expect(err.message).toBe('That desk is not yours.');
    expect(dispatched).toHaveLength(1);
    expect(sentByAna()).toEqual([]);
  });

  it('answers a full launch cap as UNAVAILABLE and removes the row', async () => {
    chat('chat-b');
    dispatchImpl = async () =>
      ({
        refused: 'LAUNCH_CAP_FULL',
        message: 'Too many running.',
      }) as DispatchSessionMessageResult;
    expect((await refusal(service.send(ANA, { to: 'chat-b', message: 'hi' }))).code).toBe(
      'UNAVAILABLE'
    );
    expect(sentByAna()).toEqual([]);
  });
});

describe('send — to an agent id', () => {
  /** Opening an agent's DM chat: the new chat becomes bound in the agent's home. */
  function opensChats(): void {
    dispatchImpl = async (opts) => {
      // A chat already bound is simply sent to; only a new id opens one.
      if (sessions.has(opts.sessionId)) return defaultDispatch(opts);
      const canonical = `opened-${++openedCounter}`;
      chat(canonical, { agentPath: opts.request.agentPath ?? null, launchOrigin: 'chat-message' });
      const result = await defaultDispatch(opts);
      return { ...result, canonicalId: canonical } as DispatchSessionMessageResult;
    };
  }

  it('opens a DM chat in the agent’s home, keeps it, and reuses it on the next send', async () => {
    opensChats();

    const first = await service.send(ANA, { to: 'agent-bo', message: 'first' });

    expect(dispatched[0]!.request.agentPath).toBe('/agents/bo');
    expect(dispatched[0]!.request.cwd).toBeUndefined();
    expect(dispatched[0]!.sessionId).not.toBe('agent-bo');
    expect(first.chatId).toBe('opened-1');
    expect(store.dmChat('/agents/ana', 'agent-bo')).toBe('opened-1');
    expect(sentByAna()[0]!.toSessionId).toBe('opened-1');

    const second = await service.send(ANA, { to: 'agent-bo', message: 'second' });

    expect(dispatched[1]!.sessionId).toBe('opened-1');
    expect(second.chatId).toBe('opened-1');
    expect(openedCounter).toBe(1);
  });

  it('opens a new DM chat when the kept one moved into a room', async () => {
    opensChats();
    await service.send(ANA, { to: 'agent-bo', message: 'first' });
    chat('opened-1', { agentPath: '/agents/bo', roomBound: true });

    const second = await service.send(ANA, { to: 'agent-bo', message: 'second' });

    expect(second.chatId).toBe('opened-2');
    expect(store.dmChat('/agents/ana', 'agent-bo')).toBe('opened-2');
  });

  it('opens ONE chat when two first messages race', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    opensChats();
    const inner = dispatchImpl;
    dispatchImpl = async (opts) => {
      await held;
      return inner(opts);
    };

    const a = service.send(ANA, { to: 'agent-bo', message: 'one' });
    const b = service.send(ANA, { to: 'agent-bo', message: 'two' });
    // Let both reach as far as they can before the first launch answers.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    release();
    const [ra, rb] = await Promise.all([a, b]);

    expect(openedCounter).toBe(1);
    expect(ra.chatId).toBe('opened-1');
    expect(rb.chatId).toBe('opened-1');
    expect(dispatched.map((d) => d.sessionId)[1]).toBe('opened-1');
  });
});

describe('send — batching', () => {
  it('appends to an agent-sent row waiting at the tail, so both run as one turn', async () => {
    chat('chat-b');
    busy.add('chat-b');
    levels.set(ANA.sessionId, TIGHT);
    const first = await service.send(ANA, { to: 'chat-b', message: 'first words' });
    const tail = queue.list('chat-b').at(-1)!;
    expect(dispatched).toHaveLength(1);

    const second = await service.send(ANA, { to: 'chat-b', message: 'second words' });

    expect(dispatched).toHaveLength(1);
    expect(second).toMatchObject({ status: 'queued', position: 1, chatId: 'chat-b' });
    const rows = queue.list('chat-b');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toContain('first words');
    expect(rows[0]!.content).toContain('second words');
    // Two fences, each its own nonce, each its own record, one queue row.
    const sent = store.listByQueueMessage(tail.id);
    expect(sent.map((r) => r.id)).toEqual([first.messageId, second.messageId]);
    expect(chatMessageFenceNonces(rows[0]!.content)).toEqual(sent.map((r) => r.nonce));
    // A batched turn is held to every sender's bound.
    expect(service.ceilingForQueuedMessage(tail.id)).toEqual([TIGHT, TIGHT]);
  });

  it('batches another chat’s message behind a third chat’s row too', async () => {
    chat('chat-b');
    busy.add('chat-b');
    queue.enqueue({ id: 'q-c', sessionId: 'chat-b', content: 'from C', clientId: 'chat:chat-c' });

    await service.send(ANA, { to: 'chat-b', message: 'from A' });

    expect(dispatched).toEqual([]);
    expect(queue.get('q-c')!.content).toMatch(/^from C\n\n/);
    expect(sentByAna()[0]!.queueMessageId).toBe('q-c');
  });

  it('does not batch behind a person’s row', async () => {
    chat('chat-b');
    busy.add('chat-b');
    queue.enqueue({ id: 'q-p', sessionId: 'chat-b', content: 'person', clientId: PERSON });

    await service.send(ANA, { to: 'chat-b', message: 'from A' });

    expect(dispatched).toHaveLength(1);
    expect(queue.get('q-p')!.content).toBe('person');
    expect(queue.list('chat-b')).toHaveLength(2);
  });

  it('does not batch behind an agent row older than the window', async () => {
    chat('chat-b');
    busy.add('chat-b');
    queue.enqueue({ id: 'q-c', sessionId: 'chat-b', content: 'from C', clientId: 'chat:chat-c' });
    service.stop();
    service = build({ now: () => Date.now() + CHAT_BATCH_WINDOW_MS + 60_000 });

    await service.send(ANA, { to: 'chat-b', message: 'from A' });

    expect(dispatched).toHaveLength(1);
    expect(queue.get('q-c')!.content).toBe('from C');
  });

  it('does not batch into a row being read into a turn right now', async () => {
    chat('chat-b');
    busy.add('chat-b');
    queue.enqueue({ id: 'q-c', sessionId: 'chat-b', content: 'from C', clientId: 'chat:chat-c' });
    vi.mocked(isQueuedMessageLaunching).mockImplementation((id) => id === 'q-c');

    await service.send(ANA, { to: 'chat-b', message: 'from A' });

    expect(dispatched).toHaveLength(1);
    expect(queue.get('q-c')!.content).toBe('from C');
  });

  it('does not batch an idle chat’s message (it starts a turn at once)', async () => {
    chat('chat-b');
    queue.enqueue({ id: 'q-c', sessionId: 'chat-b', content: 'from C', clientId: 'chat:chat-c' });
    await service.send(ANA, { to: 'chat-b', message: 'from A' });
    expect(dispatched).toHaveLength(1);
  });
});

describe('send — steer', () => {
  beforeEach(() => {
    chat('chat-b');
    busy.add('chat-b');
  });

  it('joins the running turn when that turn runs no looser than the sender', async () => {
    levels.set(ANA.sessionId, MIDDLE);
    levels.set('chat-b', TIGHT);

    const receipt = await service.send(ANA, { to: 'chat-b', message: 'hi', delivery: 'steer' });

    expect(dispatched[0]!.request.disposition).toBe('steer');
    expect(receipt.status).toBe('steered');
    expect(receipt.note).toBeUndefined();
    // A steer has no queue row of its own.
    expect(sentByAna()[0]!.queueMessageId).toBeNull();
  });

  it('waits in the queue, with a note, when the running turn is looser than the sender', async () => {
    levels.set(ANA.sessionId, MIDDLE);
    levels.set('chat-b', LOOSE);

    const receipt = await service.send(ANA, { to: 'chat-b', message: 'hi', delivery: 'steer' });

    expect(dispatched[0]!.request.disposition).toBeUndefined();
    expect(receipt.status).toBe('queued');
    expect(receipt.note).toMatch(/waits in the queue/);
  });

  it.each([
    ['the sender', 'chat-a'],
    ['the receiver', 'chat-b'],
  ])('never steers when %s has no known level', async (_label, unknown) => {
    levels.set(ANA.sessionId, MIDDLE);
    levels.set('chat-b', TIGHT);
    levels.delete(unknown);

    const receipt = await service.send(ANA, { to: 'chat-b', message: 'hi', delivery: 'steer' });

    expect(dispatched[0]!.request.disposition).toBeUndefined();
    expect(receipt.note).toBeDefined();
  });
});

describe('send — interrupt', () => {
  it('moves the message to the head of the queue, THEN stops the running turn', async () => {
    chat('chat-b');
    busy.add('chat-b');
    queue.enqueue({ id: 'q-p', sessionId: 'chat-b', content: 'person', clientId: PERSON });
    let headWhenStopped: string | undefined;
    interruptTurn.mockImplementation(async (id) => {
      headWhenStopped = queue.list(id)[0]?.id;
      return true;
    });

    const receipt = await service.send(ANA, {
      to: 'chat-b',
      message: 'stop and do this',
      delivery: 'interrupt',
    });

    const mine = sentByAna()[0]!.queueMessageId!;
    expect(queue.list('chat-b').map((r) => r.id)).toEqual([mine, 'q-p']);
    expect(interruptTurn).toHaveBeenCalledWith('chat-b');
    expect(headWhenStopped).toBe(mine);
    expect(receipt).toMatchObject({ status: 'queued', position: 1 });
    expect(receipt.note).toBeUndefined();
  });

  it('says so when nothing was running', async () => {
    chat('chat-b');
    busy.add('chat-b');
    interruptTurn.mockResolvedValue(false);
    const receipt = await service.send(ANA, { to: 'chat-b', message: 'x', delivery: 'interrupt' });
    expect(receipt.note).toMatch(/Nothing was running/);
  });
});

describe('send — replies', () => {
  /** A message chat B sent chat A. */
  function fromB(id: string, status: 'working' | 'delivered' = 'working', to = ANA.sessionId) {
    store.insert({
      id,
      toSessionId: to,
      fromSessionId: 'chat-b',
      fromAgentPath: '/agents/bo',
      fromAgentId: 'agent-bo',
      fromAgentName: 'Bo',
      fromChatTitle: null,
      kind: 'message',
      text: 'question',
      summary: null,
      nonce: id.padEnd(8, '0').slice(0, 8),
      delivery: 'queue',
      status,
      queueMessageId: null,
      ceilingJson: '"runtime-default"',
      replyToId: null,
    });
  }

  beforeEach(() => chat('chat-b'));

  it('marks the named message replied and threads the answer to it', async () => {
    fromB('aaaa1111');
    fromB('bbbb2222');

    await service.send(ANA, { to: 'chat-b', message: 'answer', replyTo: 'aaaa1111' });

    expect(store.get('aaaa1111')!.status).toBe('replied');
    expect(store.get('bbbb2222')!.status).toBe('working');
    expect(sentByAna()[0]!.replyToId).toBe('aaaa1111');
    expect(emitActivity).toHaveBeenCalledWith('chat-b');
  });

  it('refuses a replyTo that was not sent to the caller, and sends nothing', async () => {
    fromB('cccc3333', 'working', 'chat-z');
    const err = await refusal(
      service.send(ANA, { to: 'chat-b', message: 'answer', replyTo: 'cccc3333' })
    );
    expect(err.code).toBe('NOT_FOUND');
    expect(dispatched).toEqual([]);
    expect(store.get('cccc3333')!.status).toBe('working');
  });

  it('threads to the newest unanswered message from the target when no replyTo is given', async () => {
    fromB('aaaa1111', 'delivered');
    fromB('bbbb2222', 'delivered');

    await service.send(ANA, { to: 'chat-b', message: 'answer' });

    expect(sentByAna()[0]!.replyToId).toBe('bbbb2222');
    expect(store.get('bbbb2222')!.status).toBe('replied');
    expect(store.get('aaaa1111')!.status).toBe('delivered');
  });
});

describe('the lifecycle of a sent message', () => {
  async function queuedPair(): Promise<{ queueId: string; ids: string[] }> {
    chat('chat-b');
    busy.add('chat-b');
    const a = await service.send(ANA, { to: 'chat-b', message: 'one' });
    const b = await service.send(ANA, { to: 'chat-b', message: 'two' });
    const queueId = store.get(a.messageId)!.queueMessageId!;
    expect(store.get(b.messageId)!.queueMessageId).toBe(queueId);
    return { queueId, ids: [a.messageId, b.messageId] };
  }

  it('started → working, then settled ok → delivered, for every row in the batch', async () => {
    const { queueId, ids } = await queuedPair();
    lifecycle!({ phase: 'started', messageId: queueId, sessionId: 'chat-b' });
    expect(ids.map((id) => store.get(id)!.status)).toEqual(['working', 'working']);

    lifecycle!({ phase: 'settled', messageId: queueId, sessionId: 'chat-b', outcome: 'ok' });
    expect(ids.map((id) => store.get(id)!.status)).toEqual(['delivered', 'delivered']);
  });

  it('settled failed → failed, with a reason', async () => {
    const { queueId, ids } = await queuedPair();
    lifecycle!({ phase: 'started', messageId: queueId, sessionId: 'chat-b' });
    lifecycle!({ phase: 'settled', messageId: queueId, sessionId: 'chat-b', outcome: 'failed' });
    for (const id of ids) {
      expect(store.get(id)).toMatchObject({ status: 'failed', failureReason: expect.any(String) });
    }
  });

  it('dropped → failed, saying why', async () => {
    const { queueId, ids } = await queuedPair();
    lifecycle!({ phase: 'dropped', messageId: queueId, reason: 'session_gone' });
    for (const id of ids) {
      expect(store.get(id)).toMatchObject({
        status: 'failed',
        failureReason: 'The chat it was waiting in no longer exists.',
      });
    }
  });

  it('ignores a queue id no chat message rides on', async () => {
    const { ids } = await queuedPair();
    lifecycle!({ phase: 'settled', messageId: 'someone-else', sessionId: 'chat-b', outcome: 'ok' });
    expect(ids.map((id) => store.get(id)!.status)).toEqual(['queued', 'queued']);
  });

  it('stops listening when the service stops', () => {
    expect(lifecycle).toBeDefined();
    service.stop();
    expect(lifecycle).toBeUndefined();
  });
});

describe('ceilingForQueuedMessage', () => {
  function row(id: string, queueMessageId: string, ceilingJson: string): void {
    store.insert({
      id,
      toSessionId: 'chat-b',
      fromSessionId: 'chat-x',
      fromAgentPath: '/agents/x',
      fromAgentId: null,
      fromAgentName: 'X',
      fromChatTitle: null,
      kind: 'message',
      text: 'x',
      summary: null,
      nonce: null,
      delivery: 'queue',
      status: 'queued',
      queueMessageId,
      ceilingJson,
      replyToId: null,
    });
  }

  it('is the one bound for one row, and the list for several', () => {
    row('r1', 'q1', JSON.stringify(TIGHT));
    expect(service.ceilingForQueuedMessage('q1')).toEqual(TIGHT);
    row('r2', 'q1', JSON.stringify(LOOSE));
    expect(service.ceilingForQueuedMessage('q1')).toEqual([TIGHT, LOOSE]);
  });

  it('is the runtime default for no rows, and for a ceiling it cannot read', () => {
    expect(service.ceilingForQueuedMessage('nothing')).toBe('runtime-default');
    row('r1', 'q-bad', 'not json');
    expect(service.ceilingForQueuedMessage('q-bad')).toBe('runtime-default');
    row('r2', 'q-shape', JSON.stringify({ asks: 1 }));
    expect(service.ceilingForQueuedMessage('q-shape')).toBe('runtime-default');
  });
});

describe('stopChat', () => {
  beforeEach(() => chat('chat-b'));

  it('refuses the caller’s own chat', async () => {
    expect((await refusal(service.stopChat(ANA, { chat: 'chat-a' }))).code).toBe('SELF');
    expect(interruptTurn).not.toHaveBeenCalled();
  });

  it('refuses a chat it may not write into', async () => {
    chat('room-chat', { roomBound: true });
    expect((await refusal(service.stopChat(ANA, { chat: 'room-chat' }))).code).toBe('NOT_ALLOWED');
    expect(interruptTurn).not.toHaveBeenCalled();
  });

  it('drops only other chats’ queued messages, stops the turn, and records who did it', async () => {
    queue.enqueue({ id: 'q-person', sessionId: 'chat-b', content: 'person', clientId: PERSON });
    queue.enqueue({ id: 'q-chat', sessionId: 'chat-b', content: 'agent', clientId: 'chat:chat-c' });
    store.insert({
      id: 'from-c',
      toSessionId: 'chat-b',
      fromSessionId: 'chat-c',
      fromAgentPath: '/agents/cy',
      fromAgentId: null,
      fromAgentName: 'Cy',
      fromChatTitle: null,
      kind: 'message',
      text: 'agent',
      summary: null,
      nonce: 'cccccccc',
      delivery: 'queue',
      status: 'queued',
      queueMessageId: 'q-chat',
      ceilingJson: '"runtime-default"',
      replyToId: null,
    });

    const result = await service.stopChat(ANA, { chat: 'chat-b', reason: '  wrong branch  ' });

    expect(result).toMatchObject({ stopped: true, chatId: 'chat-b', droppedMessages: 1 });
    expect(queue.list('chat-b').map((r) => r.id)).toEqual(['q-person']);
    expect(store.get('from-c')).toMatchObject({
      status: 'failed',
      failureReason: 'Stopped by Ana · Planning before it ran.',
    });
    expect(emitActivity).toHaveBeenCalledWith('chat-c');
    expect(interruptTurn).toHaveBeenCalledWith('chat-b');

    const stops = store.listStopsOf('chat-b');
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({ kind: 'stop', fromSessionId: 'chat-a', text: 'wrong branch' });

    const activity = await service.activityOf('chat-b');
    expect(activity.stops).toEqual([
      {
        id: stops[0]!.id,
        by: { chatId: 'chat-a', chatTitle: 'Planning', agentId: 'agent-ana', agentName: 'Ana' },
        reason: 'wrong branch',
        at: stops[0]!.createdAt,
      },
    ]);

    expect(recordAudit).toHaveBeenCalledTimes(1);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'chat.stopped',
        outcome: 'ok',
        reason: 'wrong branch',
        target: expect.objectContaining({ type: 'session', id: 'chat-b', name: 'Title of chat-b' }),
        summary: 'Stopped by Ana · Planning: wrong branch',
      })
    );
  });

  it('records a stop of an idle chat as failed, and does not show it as a "Stopped by" line', async () => {
    interruptTurn.mockResolvedValue(false);
    const result = await service.stopChat(ANA, { chat: 'chat-b' });
    expect(result.stopped).toBe(false);
    expect(store.listStopsOf('chat-b')[0]!.status).toBe('failed');
    expect((await service.activityOf('chat-b')).stops).toEqual([]);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed' }));
  });
});

describe('beginStart / settleStart', () => {
  it('records a start with the sender stamp and settles it under the started chat’s id', async () => {
    levels.set(ANA.sessionId, TIGHT);
    const begun = await service.beginStart(ANA, 'new-chat', '  Build the thing.  ', 'q-start');

    const row = store.get(begun.id)!;
    expect(row).toMatchObject({
      kind: 'start',
      toSessionId: 'new-chat',
      queueMessageId: 'q-start',
      text: 'Build the thing.',
      status: 'queued',
    });
    expect(chatMessageFenceNonces(begun.content)).toEqual([row.nonce]);
    expect(begun.content).toContain('Kind: first message');
    expect(service.ceilingForQueuedMessage('q-start')).toEqual(TIGHT);

    service.settleStart(begun.id, 'canonical-chat');
    expect(store.get(begun.id)).toMatchObject({ toSessionId: 'canonical-chat', status: 'working' });
    expect(emitActivity).toHaveBeenCalledWith('chat-a');
  });

  it('removes a start that never started', async () => {
    const begun = await service.beginStart(ANA, 'new-chat', 'Go.', 'q-start');
    service.settleStart(begun.id, null);
    expect(store.get(begun.id)).toBeUndefined();
  });
});
