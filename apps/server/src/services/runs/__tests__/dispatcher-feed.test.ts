/**
 * Dispatcher feed cases (spec `turns-survive-restarts` §8): the run record
 * over the real dispatcher, checked write by write against the transition
 * table, F1 to F6 and F9 (their kill halves land with recovery, T15), plus the
 * queue-row removals that cancel their runs.
 *
 * Real dispatcher, projector, SQLite queue and run record, the runtime
 * registry (so the real pause backstop wraps the runtime) and the pause
 * service; only the runtime underneath is a double. Every case also checks
 * that the one-live-run index never fired: every status change the store made
 * is kept in `trail`, and a hit would be logged as an error.
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
  listQueuedMessages,
  noteTurnBoundary,
  onDispatchLifecycle,
  resetMessageDispatcher,
  setQueuedChatCeilingResolver,
  type DispatchLifecycleEvent,
} from '../../session/message-dispatcher.js';
import { inFlight, setQueuedChatJoiner } from '../../session/message-dispatcher/state.js';
import { rearmChatQueues } from '../../session/message-dispatcher/queue-upkeep.js';
import { subscribeRuntimeTurns } from '../../session/runtime-turns/runtime-turn.js';
import { chatClientId } from '../../session/chat-messages/chat-client-id.js';
import { cancelQueuedMessage, clearQueuedMessages } from '../../session/queued-message-edits.js';
import { MessageQueueStore, setMessageQueueStore } from '../../session/message-queue-store.js';
import { disposeProjector, getOrCreateProjector } from '../../session/session-state-projector.js';
import { logger } from '../../../lib/logger.js';
import {
  installRunRecord,
  markRunsShutdown,
  recordStopReceipt,
  recordStopRequest,
  uninstallRunRecord,
} from '../index.js';
import { RunStore, RUN_LEASE_MS, type TurnRun } from '../run-store.js';
import { retireDeadRuns } from '../run-facts-sink.js';

/** A made-up agent, the one being paused. */
const BETA = { id: '01BETAAGENTULID00000000000', home: '/demo/agents/beta' } as const;
const PERSON: AuditActor = { accountId: 'install:demo', kind: 'person', name: 'Owner' };
const EPOCH = '01BOOTEPOCHDEMO00000000000';

let db: Db;
let queue: MessageQueueStore;
let inner: FakeAgentRuntime;
let pauses: AgentPauseService;
let runs: RunStore;
let sessionId: string;
/** Every status change the run store made, in order: `<runId>: <from>→<to>`. */
let trail: string[];
let errors: { mock: { calls: unknown[][] } };
let releaseLongTurn: (() => void) | undefined;

/** The turn every queued fixture waits behind: it works until released. */
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

/** A gate a scenario waits on, and its key. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** Let every pending microtask and timer-0 callback run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** One run's own status changes, as `from→to`. */
function moves(run: TurnRun | string): string[] {
  const id = typeof run === 'string' ? run : run.id;
  return trail.filter((line) => line.startsWith(`${id}: `)).map((line) => line.split(': ')[1]!);
}

/** The run that waits (or waited) on a queue row. */
function runOfRow(rowId: string): TurnRun {
  const run = runs.findByQueueMessage(rowId);
  expect(run).toBeDefined();
  return run!;
}

/** Send a message through the real dispatcher. */
function send(clientId: string, content: string, extra: Record<string, unknown> = {}) {
  return dispatchMessage({
    origin: { kind: 'interactive' },
    sessionId,
    clientId,
    content,
    projector: getOrCreateProjector(sessionId, BETA.home),
    runtime: runtimeRegistry.get(inner.type),
    cwd: BETA.home,
    ...extra,
  });
}

/** The server's rearm sweep, as the health tick and a resume run it. */
function rearm(): Promise<number> {
  return rearmChatQueues({
    resume: (id) =>
      resumeChatQueue(
        id,
        BETA.home,
        undefined,
        {
          resolveWithRoom: async (request) => ({ cwd: request.cwd ?? BETA.home, rung: 'explicit' }),
        },
        { registeredAgentPaths: () => [BETA.home] }
      ),
  });
}

/** Whether the record ever logged the one-live-run index firing. */
function indexFired(): boolean {
  return errors.mock.calls.some((call) => String(call[0]).includes('[runs]'));
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
  runs = installRunRecord(db, { epoch: EPOCH });
  trail = [];
  const move = runs.move.bind(runs);
  vi.spyOn(runs, 'move').mockImplementation((run, to, patch) => {
    const moved = move(run, to, patch);
    trail.push(`${run.id}: ${run.status}→${to}`);
    return moved;
  });
  errors = vi.spyOn(logger, 'error');
  inner = new FakeAgentRuntime('feed-demo').withScenarios([longTurn, quick, quick]);
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
    .values({ sessionId, runtime: inner.type, agentPath: BETA.home, createdAt: now })
    .onConflictDoNothing()
    .run();
  setQueuedChatCeilingResolver(() => 'runtime-default');
  resetChatQueueResumeWarnings();
});

afterEach(async () => {
  releaseLongTurn?.();
  releaseLongTurn = undefined;
  await vi.waitFor(() => expect(inner.isTurnOpen(sessionId)).toBe(false));
  await settle();
  // Rule (ii) of §4.7, for every case: the one-live-run index never fired.
  expect(indexFired()).toBe(false);
  setQueuedChatCeilingResolver(undefined);
  setQueuedChatJoiner(undefined);
  resetMessageDispatcher();
  uninstallRunRecord();
  setMessageQueueStore(undefined);
  disposeProjector(sessionId);
  resetChatQueueResumeWarnings();
  resetAgentPause();
  setAgentHomeRegistry(undefined);
  vi.restoreAllMocks();
});

describe('a pause cut (F1, F2, F3)', () => {
  /** Set while the cut turn waits at its first model request. */
  let atModelRequest: (() => void) | undefined;
  /** Which words each scenario answered: what the agent really read. */
  let answered: string[];

  const answers = async function* (content: string): AsyncGenerator<StreamEvent> {
    answered.push(content);
    yield { type: 'text_delta', data: { text: 'reply' } };
    yield { type: 'done', data: {} };
  };

  /** A queued turn that shows `shown`, then waits until interrupted. */
  const cutAfter = (shown: StreamEvent[]) =>
    async function* (content: string): AsyncGenerator<StreamEvent> {
      for (const event of shown) yield event;
      await new Promise<void>((resolve) => {
        atModelRequest = resolve;
      });
      yield { type: 'text_delta', data: { text: 'too late' } };
      answered.push(content);
      yield { type: 'done', data: {} };
    };

  /** What a real turn shows before its first model request (QA W5): none of it is the agent acting. */
  const LAUNCH_EVENTS = [
    { type: 'system_status', data: { message: 'Starting.' } },
    { type: 'session_status', data: { sessionId: 'x', model: 'claude-made-up' } },
  ] as unknown as StreamEvent[];

  beforeEach(() => {
    answered = [];
    atModelRequest = undefined;
    inner.interruptQuery.mockImplementation(async () => {
      releaseLongTurn?.();
      atModelRequest?.();
      return { outcome: 'acked', runtime: inner.type };
    });
  });

  /**
   * The agent runs a turn while another chat's message waits; the turn ends,
   * the message's turn starts and stops at `shown`, and the agent is paused.
   */
  async function startThenPause(shown: StreamEvent[], events: DispatchLifecycleEvent[]) {
    inner.withScenarios([longTurn, cutAfter(shown), answers, answers]);
    const stop = onDispatchLifecycle((event) => events.push(event));
    await send('person-window', 'start the census');
    await vi.waitFor(() => expect(inner.isTurnOpen(sessionId)).toBe(true));
    await send(chatClientId('chat-alpha'), 'from A: add the totals');
    const [row] = listQueuedMessages(sessionId);
    const run = runOfRow(row!.id);
    expect(run.status).toBe('queued');
    releaseLongTurn?.();
    await vi.waitFor(() => expect(atModelRequest).toBeDefined(), { timeout: 2000 });
    const midTurn = { run: runs.get(run.id)!, row: queue.get(row!.id) };
    await pauses.pause(BETA.id, PERSON, 'demo pause');
    await vi.waitFor(() => expect(inner.isTurnOpen(sessionId)).toBe(false));
    await settle();
    stop();
    return { rowId: row!.id, runId: run.id, midTurn };
  }

  /** Lift the pause and let the held row run again. */
  async function resume(): Promise<void> {
    pauses.onResumed(() => void rearm());
    pauses.resume(BETA.id, PERSON);
    await vi.waitFor(() => expect(answered).toEqual(['from A: add the totals']), { timeout: 2000 });
    await settle();
  }

  /** A run a cut put back: every field §4.7 names cleared, held as paused. */
  function expectPutBack(run: TurnRun | undefined): void {
    expect(run).toMatchObject({
      status: 'queued',
      waitReason: 'paused',
      startedAt: null,
      deliveredAt: null,
      runtimeTurnRef: null,
      turnBindingId: null,
      ownerEpoch: null,
      leaseUntil: null,
      waitingOnPerson: false,
      ending: null,
      endedAt: null,
    });
    expect(run!.endingDetail.stopRequests ?? []).toEqual([]);
  }

  it('F1: cut after turn_start and before the first event: 14, row kept in its place, re-run under a fresh id', async () => {
    const events: DispatchLifecycleEvent[] = [];
    const { rowId, runId, midTurn } = await startThenPause([], events);

    // Mid-turn: started, its row kept out of line.
    expect(midTurn.run.status).toBe('started');
    expect(midTurn.row?.inTurn).toBe(true);
    // Cut: back in line, held, and never ended.
    expectPutBack(runs.get(runId));
    expect(moves(runId)).toEqual(['queued→starting', 'starting→started', 'started→queued']);
    expect(listQueuedMessages(sessionId).map((row) => row.id)).toEqual([rowId]);
    expect(events.filter((e) => e.messageId === rowId).map((e) => e.phase)).toEqual([
      'started',
      'held',
    ]);

    await resume();
    const sent = inner.sendMessage.mock.calls.filter(
      (call) => call[1] === 'from A: add the totals'
    );
    expect(sent).toHaveLength(2);
    expect(sent[1]![2]?.messageId).not.toBe(sent[0]![2]?.messageId);
    // The same run, the same row id, started again by an ordinary launch (4).
    expect(runs.get(runId)).toMatchObject({ status: 'ended', ending: 'completed' });
    expect(moves(runId).slice(3)).toEqual([
      'queued→queued',
      'queued→starting',
      'starting→started',
      'started→running',
      'running→ended',
    ]);
    expect(queue.get(rowId)).toBeUndefined();
  });

  it('F2: cut after the runtime’s first event: 15, the row re-inserted with its own id', async () => {
    const { rowId, runId, midTurn } = await startThenPause(LAUNCH_EVENTS, []);

    // Delivered: the runtime has the words, so the row is gone.
    expect(midTurn.run.status).toBe('running');
    expect(midTurn.row).toBeUndefined();
    expectPutBack(runs.get(runId));
    expect(moves(runId)).toEqual([
      'queued→starting',
      'starting→started',
      'started→running',
      'running→queued',
    ]);
    expect(queue.get(rowId)).toMatchObject({ id: rowId, inTurn: false });
    expect(listQueuedMessages(sessionId).map((row) => row.id)).toEqual([rowId]);

    await resume();
    expect(runs.get(runId)).toMatchObject({ status: 'ended', ending: 'completed' });
  });

  it('F3: a pause between the launch and turn_start: started first, then 14 with the row kept', async () => {
    await pauses.pause(BETA.id, PERSON);
    // The launch's own check runs a beat before the pause is in force; the
    // pause backstop at the runtime seam still refuses the turn it opens.
    const real = pauses.pausedAgentOfSession.bind(pauses);
    vi.spyOn(pauses, 'pausedAgentOfSession')
      .mockImplementationOnce(() => undefined)
      .mockImplementation(real);
    await send(chatClientId('chat-alpha'), 'from A: mid-launch');
    await settle();

    const [row] = listQueuedMessages(sessionId);
    expect(row?.content).toBe('from A: mid-launch');
    const run = runOfRow(row!.id);
    expectPutBack(run);
    // `started` was written before the pause check found the pause.
    expect(moves(run)).toEqual(['queued→starting', 'starting→started', 'started→queued']);
    expect(queue.get(row!.id)?.inTurn).toBe(false);
  });

  it('F3: the same pause lifted in time: the turn runs, its row kept past delivery and deleted at settle', async () => {
    const turn = gate();
    inner.withScenarios([
      async function* (content: string): AsyncGenerator<StreamEvent> {
        yield { type: 'text_delta', data: { text: 'working' } };
        await turn.wait;
        answered.push(content);
        yield { type: 'done', data: {} };
      },
    ]);
    // No pause is in force; the check at `turn_start` alone reads one, as a
    // pause landing then and lifted before the runtime's seam would.
    let planChecks = 0;
    vi.spyOn(pauses, 'pausedAgentOfSession').mockImplementation((_id, _cwd, opts) => {
      const fromPlan = opts !== undefined && !('messageId' in opts);
      if (fromPlan) planChecks += 1;
      return fromPlan && planChecks === 2 ? { id: BETA.id, name: 'beta' } : undefined;
    });
    await send(chatClientId('chat-alpha'), 'from A: lifted in time');
    await vi.waitFor(() => expect(inner.isTurnOpen(sessionId)).toBe(true));
    await vi.waitFor(() =>
      expect(trail.some((line) => line.endsWith('started→running'))).toBe(true)
    );
    const run = runs.listForChat(sessionId)[0]!;
    const rowId = run.queueMessageId!;
    const midTurn = { run: runs.get(run.id), inTurn: queue.get(rowId)?.inTurn };
    turn.open();
    await vi.waitFor(() => expect(answered).toEqual(['from A: lifted in time']));
    await settle();

    // Delivered while the pause's check stood: the row stayed.
    expect(midTurn).toMatchObject({ run: { status: 'running' }, inTurn: true });
    expect(runs.get(run.id)).toMatchObject({ status: 'ended', ending: 'completed' });
    expect(moves(run)).toEqual([
      'queued→starting',
      'starting→started',
      'started→running',
      'running→ended',
    ]);
    expect(queue.get(rowId)).toBeUndefined();
  });
});

describe('a drain join (F4)', () => {
  it('the head is starting, then started; the rows it folds are superseded with their rows', async () => {
    setQueuedChatJoiner(() => {});
    inner.withScenarios([longTurn, quick]);
    await send('person-window', 'the running turn');
    await vi.waitFor(() => expect(inner.isTurnOpen(sessionId)).toBe(true));
    for (const [chat, words] of [
      ['chat-a', 'from A'],
      ['chat-b', 'from B'],
      ['chat-c', 'from C'],
    ] as const) {
      await send(chatClientId(chat), words);
    }
    const rows = listQueuedMessages(sessionId).map((row) => row.id);
    const [head, ...folded] = rows.map(runOfRow);
    releaseLongTurn?.();
    await vi.waitFor(() => expect(runs.get(head!.id)?.status).toBe('ended'));

    expect(inner.sendMessage.mock.calls.at(-1)?.[1]).toBe('from A\n\nfrom B\n\nfrom C');
    expect(moves(head!)).toEqual([
      'queued→starting',
      'starting→started',
      'started→running',
      'running→ended',
    ]);
    for (const run of folded) {
      expect(moves(run!)).toEqual(['queued→superseded']);
      expect(queue.get(run!.queueMessageId!)).toBeUndefined();
    }
    // Folded after the head was already launching, never before.
    const headStarting = trail.indexOf(`${head!.id}: queued→starting`);
    for (const run of folded) {
      expect(trail.indexOf(`${run!.id}: queued→superseded`)).toBeGreaterThan(headStarting);
    }
  });
});

describe('one writer per chat (F5)', () => {
  it('every launch path re-parks behind a running run its slot does not show, and starts once it settles', async () => {
    await send('person-window', 'a quiet long turn');
    await vi.waitFor(() => expect(inner.isTurnOpen(sessionId)).toBe(true));
    const [first] = runs.listForChat(sessionId);
    await vi.waitFor(() => expect(runs.get(first!.id)?.status).toBe('running'));
    // The running turn's slot is gone, as it is once its write-lock expired
    // under a quiet turn, or for a runtime's own turn: only the record knows.
    inFlight.clear();

    // The direct launch, with a short wait bound so the wait-bound launch fires too.
    await send('other-window', 'behind it', { queueWaitMs: 30 });
    const second = runs.listForChat(sessionId)[1]!;
    await new Promise((resolve) => setTimeout(resolve, 80));
    // The pump launch.
    noteTurnBoundary(sessionId);
    await settle();
    expect(inner.sendMessage).toHaveBeenCalledTimes(1);
    expect(runs.get(second.id)?.status).toBe('queued');
    expect(moves(second)).toEqual([]);

    releaseLongTurn?.();
    await vi.waitFor(() => expect(runs.get(second.id)?.status).toBe('ended'));
    expect(inner.sendMessage).toHaveBeenCalledTimes(2);
    // It began only after the turn ahead of it ended.
    expect(trail.indexOf(`${second.id}: queued→starting`)).toBeGreaterThan(
      trail.indexOf(`${first!.id}: running→ended`)
    );
  });

  it('a runtime’s own turn puts a starting run back in line; that run writes 4 and 7 together at its own turn_start', async () => {
    const unsubscribe = subscribeRuntimeTurns(inner);
    const prepared = gate();
    const own = gate();
    inner.withScenarios([quick]);
    // The launch is under way and has not reached `turn_start`: it is `starting`.
    const accepted = send('person-window', 'my message', {
      prepareLaunch: async () => {
        await prepared.wait;
        return {};
      },
    });
    await vi.waitFor(() => expect(runs.listForChat(sessionId)[0]?.status).toBe('starting'));
    const mine = runs.listForChat(sessionId)[0]!;

    inner.emitRuntimeTurn(
      sessionId,
      (async function* (): AsyncGenerator<StreamEvent> {
        yield { type: 'text_delta', data: { text: 'a helper finished' } };
        await own.wait;
        yield { type: 'done', data: {} };
      })()
    );
    await vi.waitFor(() => expect(runs.listForChat(sessionId)).toHaveLength(2));
    const theirs = runs.listForChat(sessionId)[1]!;
    expect(theirs).toMatchObject({ status: 'running', openedBy: 'runtime' });
    expect(runs.get(mine.id)?.status).toBe('queued');

    own.open();
    await vi.waitFor(() => expect(runs.get(theirs.id)?.status).toBe('ended'));
    prepared.open();
    await accepted;
    await vi.waitFor(() => expect(runs.get(mine.id)?.status).toBe('ended'));
    unsubscribe?.();

    expect(moves(mine)).toEqual([
      'queued→starting',
      'starting→queued',
      'queued→starting',
      'starting→started',
      'started→running',
      'running→ended',
    ]);
    expect(moves(theirs)).toEqual(['running→ended']);
  });

  it('a launch from the same client while another is starting stays queued, then writes 4 and 7 together', async () => {
    // The write-lock as `session-lock.ts` keeps it: one holder at a time.
    let holder: symbol | undefined;
    inner.acquireLock.mockImplementation((_id, _client, _res, token) => {
      if (holder !== undefined) return false;
      holder = token ?? Symbol('lock');
      return true;
    });
    inner.releaseLock.mockImplementation((_id, _client, token) => {
      if (token === holder) holder = undefined;
    });
    const prepared = gate();
    inner.withScenarios([quick, quick]);
    // Something without a run holds the chat's slot (a summary, say), so the
    // first message parks, and its wait bound launches it with no slot.
    inFlight.set(sessionId, {
      clientId: 'summary',
      token: Symbol('summary'),
      startedAt: Date.now(),
      sawTurnStart: false,
    });
    await send('person-window', 'first', {
      queueWaitMs: 20,
      prepareLaunch: async () => {
        await prepared.wait;
        return {};
      },
    });
    const first = runs.listForChat(sessionId)[0]!;
    await vi.waitFor(() => expect(runs.get(first.id)?.status).toBe('starting'));
    await send('person-window', 'second');
    const second = runs.listForChat(sessionId)[1]!;
    // The slot comes free and the pump launches the second while the first
    // is still starting: it goes on, and waits behind the first in its own
    // client's line, still `queued`.
    inFlight.delete(sessionId);
    noteTurnBoundary(sessionId);
    await settle();
    expect(runs.get(second.id)?.status).toBe('queued');
    expect(moves(second)).toEqual([]);

    prepared.open();
    await vi.waitFor(() => expect(runs.get(second.id)?.status).toBe('ended'));
    expect(runs.get(first.id)?.status).toBe('ended');
    expect(moves(second)).toEqual([
      'queued→starting',
      'starting→started',
      'started→running',
      'running→ended',
    ]);
    // 4 and 7 together, at the second's own turn_start, after the first ended.
    const begun = trail.indexOf(`${second.id}: queued→starting`);
    expect(begun).toBeGreaterThan(trail.indexOf(`${first.id}: running→ended`));
    expect(trail[begun + 1]).toBe(`${second.id}: starting→started`);
    expect(inner.sendMessage.mock.calls.map((call) => call[1])).toEqual(['first', 'second']);
  });
});

describe('a stop request (F6)', () => {
  it('is on the run before its receipt; an unconfirmed stop whose turn then finishes ends completed', async () => {
    const turn = gate();
    inner.withScenarios([
      async function* (): AsyncGenerator<StreamEvent> {
        yield { type: 'text_delta', data: { text: 'working' } };
        await turn.wait;
        yield { type: 'done', data: {} };
      },
    ]);
    await send('person-window', 'a long job');
    const [run] = runs.listForChat(sessionId);
    await vi.waitFor(() => expect(runs.get(run!.id)?.status).toBe('running'));

    const stopped = recordStopRequest(sessionId, { via: 'stop' });
    expect(stopped).toBe(run!.id);
    // Written when asked, before any answer.
    expect(runs.get(run!.id)?.endingDetail.stopRequests).toEqual([
      { at: expect.any(String), via: 'stop' },
    ]);
    recordStopReceipt(stopped, { outcome: 'unconfirmed' });
    turn.open();
    await vi.waitFor(() => expect(runs.get(run!.id)?.status).toBe('ended'));

    expect(runs.get(run!.id)).toMatchObject({
      ending: 'completed',
      endingDetail: { stopRequests: [{ via: 'stop', outcome: 'unconfirmed' }] },
    });
  });
});

describe('the ending at turn_end, the status at settle (F9)', () => {
  /** A turn whose `turn_end` is out while its stream stays open, draining background work. */
  function drainingTurn(drain: Promise<void>) {
    return async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'text_delta', data: { text: 'done talking' } };
      yield { type: 'done', data: {} };
      await drain;
    };
  }

  it('records the ending at turn_end while the status stays running, and moves it at settle', async () => {
    const drain = gate();
    inner.withScenarios([drainingTurn(drain.wait)]);
    await send('person-window', 'start the build');
    const [run] = runs.listForChat(sessionId);
    await vi.waitFor(() => expect(runs.get(run!.id)?.ending).toBe('completed'));
    expect(runs.get(run!.id)?.status).toBe('running');

    drain.open();
    await vi.waitFor(() => expect(runs.get(run!.id)?.status).toBe('ended'));
    expect(runs.get(run!.id)?.ending).toBe('completed');
    expect(moves(run!)).toEqual([
      'queued→starting',
      'starting→started',
      'started→running',
      'running→ended',
    ]);
  });

  it('a kill in that window, seen by a later boot once the lease ran out, ends it with that ending', async () => {
    const drain = gate();
    inner.withScenarios([drainingTurn(drain.wait)]);
    await send('person-window', 'start the build');
    const [run] = runs.listForChat(sessionId);
    await vi.waitFor(() => expect(runs.get(run!.id)?.ending).toBe('completed'));

    // The later boot's view (the lazy half of recovery this step owns; the
    // boot pass is T15): never `process_died` for a turn that had finished.
    const later = new RunStore(db, {
      epoch: '01LATERBOOT000000000000000',
      now: () => Date.now() + RUN_LEASE_MS + 1,
    });
    retireDeadRuns(later, sessionId);
    expect(later.get(run!.id)).toMatchObject({ status: 'ended', ending: 'completed' });

    // The settle that would have come writes nothing on a run already ended.
    drain.open();
    await vi.waitFor(() => expect(inner.isTurnOpen(sessionId)).toBe(false));
    await settle();
    expect(runs.get(run!.id)).toMatchObject({ status: 'ended', ending: 'completed' });
  });
});

describe('every queue-row deletion cancels its run in the same transaction (§4.7, transition 5)', () => {
  it('a person’s Remove, Stop’s clear, and the sweep of a vanished chat', async () => {
    inner.withScenarios([longTurn, quick]);
    await send('person-window', 'the running turn');
    await vi.waitFor(() => expect(inner.isTurnOpen(sessionId)).toBe(true));
    for (const words of ['one', 'two', 'three']) await send('person-window', words);
    const [one, two, three] = listQueuedMessages(sessionId).map((row) => row.id);

    expect(cancelQueuedMessage(sessionId, one!)?.id).toBe(one);
    expect(runOfRow(one!)).toMatchObject({
      status: 'cancelled',
      endingDetail: { cancelledBecause: 'removed' },
    });

    expect(clearQueuedMessages(sessionId).map((row) => row.id)).toEqual([two, three]);
    for (const id of [two!, three!]) expect(runOfRow(id).status).toBe('cancelled');

    await send('person-window', 'four');
    const [four] = listQueuedMessages(sessionId).map((row) => row.id);
    queue.deleteForSessions([sessionId]);
    expect(runOfRow(four!)).toMatchObject({
      status: 'cancelled',
      endingDetail: { cancelledBecause: 'session_gone' },
    });
  });

  it('Stop cannot hand back a row its turn already started with', async () => {
    const turn = gate();
    inner.withScenarios([
      // Ends without a word: the runtime never showed it read anything.
      async function* (): AsyncGenerator<StreamEvent> {
        await turn.wait;
        yield* [];
      },
    ]);
    // Not awaited: a turn that has not spoken answers its caller only after a timeout.
    void send('person-window', 'already sent');
    await vi.waitFor(() => expect(runs.listForChat(sessionId)).toHaveLength(1));
    const [run] = runs.listForChat(sessionId);
    await vi.waitFor(() => expect(runs.get(run!.id)?.status).toBe('started'));
    expect(queue.get(run!.queueMessageId!)?.inTurn).toBe(true);

    expect(clearQueuedMessages(sessionId)).toEqual([]);
    expect(cancelQueuedMessage(sessionId, run!.queueMessageId!)).toBeUndefined();
    expect(runs.get(run!.id)?.status).toBe('started');
    turn.open();
    await vi.waitFor(() => expect(runs.get(run!.id)?.status).toBe('ended'));
    // Ended before the runtime said a word: nobody knows if it read them.
    expect(runs.get(run!.id)?.endingDetail.delivery).toBe('unknown');
    expect(queue.get(run!.queueMessageId!)).toBeUndefined();
  });
});

describe('what this step adds to the map (§4.7, F10 to F12)', () => {
  it('F10: a live run another boot left, its lease run out, does not hold its chat', async () => {
    // A boot that died mid-turn: its run still reads `running`, owned by an
    // epoch that is gone, its lease long past.
    const gone = new RunStore(db, { epoch: '01DEADBOOT0000000000000000', now: () => 0 });
    const dead = gone.create({
      chatKey: sessionId,
      status: 'running',
      openedBy: 'caller',
      origin: null,
    });
    inner.withScenarios([quick]);

    await send('person-window', 'after the crash');
    const mine = runs.listForChat(sessionId).find((run) => run.id !== dead.id)!;
    await vi.waitFor(() => expect(runs.get(mine.id)?.status).toBe('ended'));

    expect(runs.get(dead.id)).toMatchObject({ status: 'ended', ending: 'process_died' });
    expect(moves(mine)[0]).toBe('queued→starting');
    expect(trail.indexOf(`${dead.id}: running→ended`)).toBeLessThan(
      trail.indexOf(`${mine.id}: queued→starting`)
    );
  });

  it('F11: a refusing caller’s direct launch that meets a running run is refused, and its run cancelled', async () => {
    await send('person-window', 'a quiet long turn');
    const [first] = runs.listForChat(sessionId);
    await vi.waitFor(() => expect(runs.get(first!.id)?.status).toBe('running'));
    inFlight.clear();

    const result = await send('ui-action-window', 'a widget click', { whenBusy: 'refuse' });

    expect(result.accepted).toBe(false);
    const second = runs.listForChat(sessionId)[1]!;
    expect(second).toMatchObject({
      status: 'cancelled',
      endingDetail: { cancelledBecause: 'refused_busy' },
    });
    expect(inner.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('F12: a graceful shutdown ends a running turn `shutdown`, and one already past turn_end keeps its ending', async () => {
    const drain = gate();
    inner.withScenarios([
      longTurn,
      async function* (): AsyncGenerator<StreamEvent> {
        yield { type: 'text_delta', data: { text: 'done talking' } };
        yield { type: 'done', data: {} };
        await drain.wait;
      },
    ]);
    await send('person-window', 'still working');
    const [working] = runs.listForChat(sessionId);
    await vi.waitFor(() => expect(runs.get(working!.id)?.status).toBe('running'));
    // Let the turn reach its wait, so the release below finds it.
    await settle();
    const otherChat = crypto.randomUUID();
    const draining = runs.create({
      chatKey: otherChat,
      status: 'running',
      openedBy: 'caller',
      origin: null,
    });
    runs.annotate(draining.id, { ending: 'completed' });

    expect(markRunsShutdown()).toBe(2);

    expect(runs.get(working!.id)).toMatchObject({ status: 'ended', ending: 'shutdown' });
    expect(runs.get(draining.id)).toMatchObject({ status: 'ended', ending: 'completed' });
    // The turn's own settle, after, writes nothing on a run already ended.
    releaseLongTurn?.();
    await vi.waitFor(() => expect(inner.isTurnOpen(sessionId)).toBe(false));
    await settle();
    expect(runs.get(working!.id)?.ending).toBe('shutdown');
    drain.open();
  });

  it('a chat’s runs move with its queue rows when the chat gains its canonical id', async () => {
    inner.withScenarios([longTurn]);
    await send('person-window', 'the running turn');
    await vi.waitFor(() => expect(inner.isTurnOpen(sessionId)).toBe(true));
    await send('person-window', 'waiting behind it');
    const before = runs.listForChat(sessionId).map((run) => run.id);
    const canonical = crypto.randomUUID();

    queue.rekeySession(sessionId, canonical);

    expect(runs.listForChat(sessionId)).toEqual([]);
    expect(runs.listForChat(canonical).map((run) => run.id)).toEqual(before);
    expect(listQueuedMessages(canonical)).toHaveLength(1);
    // Put back, so the turn and its queue settle under the id the test holds.
    queue.rekeySession(canonical, sessionId);
  });
});
