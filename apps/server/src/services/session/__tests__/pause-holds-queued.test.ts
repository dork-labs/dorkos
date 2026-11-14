/**
 * DOR-4327: pausing an agent holds the messages queued for it. It used to end
 * the agent's turn, hand the next queued message to a turn the pause refused,
 * delete its row at that turn's start, and never run it.
 *
 * Real dispatcher, projector, SQLite queue, runtime registry (so the real pause
 * backstop wraps the runtime), pause service and boot-rearm path; only the
 * runtime underneath is a double.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agents, sessionMetadata, type Db } from '@dorkos/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { createTestDb } from '@dorkos/test-utils/db';
import type { AuditActor } from '@dorkos/shared/audit-schemas';
import type { StreamEvent } from '@dorkos/shared/types';

import { runtimeRegistry } from '../../core/runtime-registry.js';
import { setAgentHomeRegistry } from '../../core/agent-identity/agent-home.js';
import {
  resetChatQueueResumeWarnings,
  resumeChatQueue,
} from '../../extensions/agent-send/agent-send-defaults.js';
import {
  AgentPauseService,
  initAgentPause,
  resetAgentPause,
} from '../../mesh/pause/agent-pause.js';
import {
  dispatchMessage,
  isQueuedMessageArmed,
  listQueuedMessages,
  resetMessageDispatcher,
  setQueuedChatCeilingResolver,
} from '../message-dispatcher.js';
import { rearmChatQueues } from '../message-dispatcher/queue-upkeep.js';
import { chatClientId } from '../chat-messages/chat-client-id.js';
import { MessageQueueStore, setMessageQueueStore } from '../message-queue-store.js';
import { disposeProjector, getOrCreateProjector } from '../session-state-projector.js';

/** A made-up agent B, the one being paused. */
const BETA = { id: '01BETAAGENTULID00000000000', home: '/demo/agents/beta' } as const;
const PERSON: AuditActor = { accountId: 'install:demo', kind: 'person', name: 'Owner' };

let db: Db;
let queue: MessageQueueStore;
let inner: FakeAgentRuntime;
let pauses: AgentPauseService;
let sessionId: string;
let releaseLongTurn: (() => void) | undefined;

/** B's running turn: it works until something interrupts it. */
const longTurn = async function* (): AsyncGenerator<StreamEvent> {
  yield { type: 'text_delta', data: { text: 'working' } };
  await new Promise<void>((resolve) => {
    releaseLongTurn = resolve;
  });
  yield { type: 'done', data: {} };
};

const quick = async function* (): AsyncGenerator<StreamEvent> {
  yield { type: 'text_delta', data: { text: 'reply' } };
  yield { type: 'done', data: {} };
};

/** Let every pending microtask and timer-0 callback run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** The words the agent's runtime was actually asked to run, in order. */
function ran(): string[] {
  return inner.sendMessage.mock.calls.map((call) => call[1]);
}

/** The server's rearm sweep, as the health tick and a resume run it. */
function rearm(registered: string[] = [BETA.home]): Promise<number> {
  return rearmChatQueues({
    resume: (id) =>
      resumeChatQueue(
        id,
        BETA.home,
        undefined,
        {
          resolveWithRoom: async (request) => ({ cwd: request.cwd ?? BETA.home, rung: 'explicit' }),
        },
        { registeredAgentPaths: () => registered }
      ),
  });
}

/** Agent A's chat queues a message for B while B's turn runs, then B is paused. */
async function queueThenPause(): Promise<string> {
  const runtime = runtimeRegistry.get(inner.type);
  const projector = getOrCreateProjector(sessionId, BETA.home);
  await dispatchMessage({
    sessionId,
    clientId: 'person-window',
    content: 'start the census',
    projector,
    runtime,
    cwd: BETA.home,
  });
  await vi.waitFor(() => expect(inner.isTurnOpen(sessionId)).toBe(true));
  await dispatchMessage({
    sessionId,
    clientId: chatClientId('chat-alpha'),
    content: 'from A: add the totals',
    projector,
    runtime,
    cwd: BETA.home,
  });
  const [row] = listQueuedMessages(sessionId);
  expect(row?.content).toBe('from A: add the totals');
  await pauses.pause(BETA.id, PERSON, 'demo pause');
  await vi.waitFor(() => expect(inner.isTurnOpen(sessionId)).toBe(false));
  await settle();
  return row!.id;
}

beforeEach(() => {
  db = createTestDb();
  const now = new Date().toISOString();
  db.insert(agents)
    .values({
      id: BETA.id,
      name: 'beta',
      displayName: 'Beta',
      runtime: 'claude-code',
      projectPath: BETA.home,
      registeredAt: now,
      updatedAt: now,
    })
    .run();
  setAgentHomeRegistry({
    isRegisteredHome: (dir) => dir === BETA.home,
    listRegisteredHomes: () => [BETA.home],
    managedWorkspaceOwner: () => null,
    roomsDir: null,
  });
  pauses = new AgentPauseService({ db, runtimes: () => runtimeRegistry.listRuntimes() });
  initAgentPause(pauses);
  queue = new MessageQueueStore(db);
  setMessageQueueStore(queue);
  inner = new FakeAgentRuntime('pause-holds').withScenarios([longTurn, quick, quick]);
  inner.getInternalSessionId.mockReturnValue(undefined);
  inner.interruptQuery.mockImplementation(async () => {
    releaseLongTurn?.();
    return { outcome: 'acked', runtime: inner.type };
  });
  runtimeRegistry.setDb(db);
  runtimeRegistry.register(inner);
  runtimeRegistry.setDefault(inner.type);
  sessionId = crypto.randomUUID();
  db.insert(sessionMetadata)
    .values({
      sessionId,
      runtime: inner.type,
      agentPath: BETA.home,
      createdAt: now,
    })
    .onConflictDoNothing()
    .run();
  setQueuedChatCeilingResolver(() => 'runtime-default');
  resetChatQueueResumeWarnings();
});

afterEach(async () => {
  releaseLongTurn?.();
  releaseLongTurn = undefined;
  await vi.waitFor(() => expect(inner.isTurnOpen(sessionId)).toBe(false));
  setQueuedChatCeilingResolver(undefined);
  resetMessageDispatcher();
  setMessageQueueStore(undefined);
  disposeProjector(sessionId);
  resetChatQueueResumeWarnings();
  resetAgentPause();
  setAgentHomeRegistry(undefined);
  vi.restoreAllMocks();
});

describe('pausing an agent holds its queued messages (DOR-4327)', () => {
  it('keeps the queued message when the pause ends the turn ahead of it', async () => {
    const rowId = await queueThenPause();

    // The row survives, and the paused agent never ran it.
    expect(listQueuedMessages(sessionId).map((row) => row.id)).toEqual([rowId]);
    expect(ran()).toEqual(['start the census']);
    // Nothing in this process is about to run it: the resume does that.
    expect(isQueuedMessageArmed(rowId)).toBe(false);
  });

  it('keeps holding it across health-tick sweeps while the agent stays paused', async () => {
    const rowId = await queueThenPause();

    await rearm();
    await rearm();
    await settle();

    expect(listQueuedMessages(sessionId).map((row) => row.id)).toEqual([rowId]);
    expect(ran()).toEqual(['start the census']);
  });

  it('runs it exactly once after the pause is lifted, however often the sweep runs', async () => {
    await queueThenPause();
    // As the server wires it: lifting a pause runs the rearm at once.
    pauses.onResumed(() => void rearm());

    pauses.resume(BETA.id, PERSON);
    await vi.waitFor(() => expect(ran()).toHaveLength(2), { timeout: 2000 });
    await rearm();
    await rearm();
    await vi.waitFor(() => expect(listQueuedMessages(sessionId)).toEqual([]), { timeout: 2000 });
    await settle();

    expect(ran()).toEqual(['start the census', 'from A: add the totals']);
  });

  it('a second resume does not run it twice', async () => {
    await queueThenPause();

    pauses.resume(BETA.id, PERSON);
    await rearm();
    await vi.waitFor(() => expect(listQueuedMessages(sessionId)).toEqual([]), { timeout: 2000 });
    expect(pauses.resume(BETA.id, PERSON).changed).toBe(false);
    await rearm();
    await settle();

    expect(ran()).toEqual(['start the census', 'from A: add the totals']);
  });

  it('holds a message sent to an agent that is already paused and idle', async () => {
    await pauses.pause(BETA.id, PERSON);
    await dispatchMessage({
      sessionId,
      clientId: chatClientId('chat-alpha'),
      content: 'from A: are you there?',
      projector: getOrCreateProjector(sessionId, BETA.home),
      runtime: runtimeRegistry.get(inner.type),
      cwd: BETA.home,
    });
    await settle();

    expect(listQueuedMessages(sessionId).map((row) => row.content)).toEqual([
      'from A: are you there?',
    ]);
    expect(ran()).toEqual([]);
  });

  it('holds it when the pause lands while its launch is under way', async () => {
    await pauses.pause(BETA.id, PERSON);
    // The launch's own check runs a beat before the pause is in force; the
    // pause backstop at the runtime seam still refuses the turn it opens.
    const real = pauses.pausedAgentOfSession.bind(pauses);
    vi.spyOn(pauses, 'pausedAgentOfSession')
      .mockImplementationOnce(() => undefined)
      .mockImplementation(real);
    await dispatchMessage({
      sessionId,
      clientId: chatClientId('chat-alpha'),
      content: 'from A: mid-launch',
      projector: getOrCreateProjector(sessionId, BETA.home),
      runtime: runtimeRegistry.get(inner.type),
      cwd: BETA.home,
    });
    await settle();

    const [row] = listQueuedMessages(sessionId);
    expect(row?.content).toBe('from A: mid-launch');
    expect(ran()).toEqual([]);
    expect(isQueuedMessageArmed(row!.id)).toBe(false);

    pauses.resume(BETA.id, PERSON);
    await rearm();
    await vi.waitFor(() => expect(listQueuedMessages(sessionId)).toEqual([]), { timeout: 2000 });
    expect(ran()).toEqual(['from A: mid-launch']);
  });

  it('keeps it held when the agent is unregistered while paused', async () => {
    const rowId = await queueThenPause();

    // Unregistering drops the pause with the agent (agent-pause `forget`).
    pauses.forget(BETA.id);
    await rearm([]);
    await rearm([]);
    await settle();

    expect(listQueuedMessages(sessionId).map((row) => row.id)).toEqual([rowId]);
    expect(ran()).toEqual(['start the census']);
  });
});
