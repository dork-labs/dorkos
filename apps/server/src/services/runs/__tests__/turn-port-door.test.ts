/**
 * The turn port's door (spec `turns-survive-restarts` §3, §6.2, §8 F7; T5,
 * DOR-5157): the space face, admission, the `start_turn` handler and the
 * computer face, over the real launch path, dispatcher, projector, SQLite
 * queue and run record. Only the runtime underneath is a double, and the
 * clock the record and outbox read is injected so the worker's passes can be
 * driven one at a time.
 *
 * Every case also checks the four rules of §4.7: no write the record refused,
 * and the one-live-run index never fired.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agents, sessionMessageQueue, sessionMetadata, eq, type Db } from '@dorkos/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { createTestDb } from '@dorkos/test-utils/db';
import type { StreamEvent } from '@dorkos/shared/types';
import type { StartTurnInput } from '@dorkos/shared/turn-port';

import { runtimeRegistry } from '../../core/runtime-registry.js';
import { setAgentHomeRegistry } from '../../core/agent-identity/agent-home.js';
import {
  dispatchMessage,
  resetMessageDispatcher,
  setQueuedChatCeilingResolver,
} from '../../session/message-dispatcher.js';
import { inFlight, pending } from '../../session/message-dispatcher/state.js';
import { schedulePump } from '../../session/message-dispatcher/pump.js';
import { MessageQueueStore, setMessageQueueStore } from '../../session/message-queue-store.js';
import { disposeProjector, getOrCreateProjector } from '../../session/session-state-projector.js';
import {
  dispatchSessionMessage,
  type DispatchSessionMessageOpts,
  type SessionLaunchRefusal,
} from '../../session/launch/launch-session.js';
import { createComputerTurnPort } from '../../session/turn-port/computer-turn-port.js';
import {
  isAgentLaunchCapFull,
  turnFacts,
  type ComputerTurnPort,
} from '../../session/turn-port/index.js';
import { holdRun, releaseRun } from '../../session/turn-port/facts.js';
import { agentLaunchMaxLive } from '../../session/launch/launch-cap.js';
import { logger } from '../../../lib/logger.js';
import {
  getRunRecord,
  installRunRecord,
  TurnStartRefusedError,
  uninstallRunRecord,
  type RunRecord,
} from '../index.js';
import { RUN_LEASE_MS, type TurnRun } from '../run-store.js';
import { EFFECT_LEASE_MS } from '../effects/worker.js';
import { admit as admitReal, type AdmissionVerdict } from '../admission.js';

/** A made-up agent and its home. */
const AGENT = { id: '01KPRTAGENTVXD000000000000', home: '/demo/agents/porter' } as const;
const EPOCH = '01BOOTEPOCHPORT00000000000';
const LATER_EPOCH = '01BOOTEPOCHPORT00000000001';

let db: Db;
let inner: FakeAgentRuntime;
let record: RunRecord;
let sessionId: string;
let clock: number;
let trail: string[];
let errors: { mock: { calls: unknown[][] } };
let releaseLongTurn: (() => void) | undefined;
/** What each turn the runtime ran was given: what the agent really read. */
let answered: string[];
/** Every hand-over the computer face was asked for, by run id. */
let handed: string[];
/** When set, admission answers this instead of reading its sources. */
let forcedVerdict: AdmissionVerdict | undefined;
let paused = false;
let machineFull = false;
/** When set, admission reads the real launch cap rather than the switch above. */
let realCap = false;
/** When set, the launch path waits on it before it goes on. */
let launchGate: Promise<void> | undefined;
/** The computer face the current boot installed. */
let computer: ComputerTurnPort;
/** When set, the launch path answers this refusal. */
let refuseWith: SessionLaunchRefusal['refused'] | undefined;
/** When set, the launch path throws. */
let launchThrows = false;
const sources = new Map<string, string>();

/** A person's turn that works until released. */
const longTurn = async function* (content: string): AsyncGenerator<StreamEvent> {
  answered.push(content);
  yield { type: 'text_delta', data: { text: 'working' } };
  await new Promise<void>((resolve) => {
    releaseLongTurn = resolve;
  });
  yield { type: 'done', data: {} };
};

/** A turn that answers at once. */
const quick = async function* (content: string): AsyncGenerator<StreamEvent> {
  answered.push(content);
  yield { type: 'text_delta', data: { text: 'reply' } };
  yield { type: 'done', data: {} };
};

/** Let every pending microtask and timer-0 callback run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** One run's own status changes, as `from→to`. */
function moves(runId: string): string[] {
  return trail.filter((line) => line.startsWith(`${runId}: `)).map((line) => line.split(': ')[1]!);
}

/** Whether the record ever complained (§4.7 rules i and ii). */
function recordComplained(): boolean {
  return errors.mock.calls.some((call) => {
    const message = String(call[0]);
    return message.includes('[runs]') || message.includes('the run record refused');
  });
}

/** The run's `start_turn` effect. */
function startEffect(runId: string) {
  return record.effects.listForRun(runId).find((effect) => effect.kind === 'start_turn')!;
}

/** One worker pass, as a wake runs it, and everything it set going. */
async function pass(): Promise<void> {
  await record.worker.runOnce();
  await settle();
}

/**
 * A test caller whose words stay at their source, through the space face: DorkOS
 * carrying on in a chat (`resume`), as a wake will from T7. No production
 * caller sends such a run through the port in T5.
 */
function startFromApp(content: string, extra: Partial<StartTurnInput> = {}) {
  return record.port.start({
    sessionId,
    agentId: AGENT.id,
    cwd: AGENT.home,
    content,
    origin: { kind: 'resume' },
    tier: 'owner',
    ...extra,
  });
}

/** A person's message, straight to the dispatcher, holding the chat until released. */
async function personWorking(): Promise<void> {
  inner.withScenarios([longTurn, quick, quick, quick]);
  await dispatchMessage({
    origin: { kind: 'interactive' },
    sessionId,
    clientId: 'person-window',
    content: 'the person is working',
    projector: getOrCreateProjector(sessionId, AGENT.home),
    runtime: runtimeRegistry.get(inner.type),
    cwd: AGENT.home,
  });
  await vi.waitFor(() => expect(inner.isTurnOpen(sessionId)).toBe(true));
}

/** The launch path, real unless a case asks it to refuse. */
async function launchPath(opts: DispatchSessionMessageOpts) {
  handed.push(opts.runId ?? '?');
  if (launchGate) await launchGate;
  if (launchThrows) throw new Error('The launch path broke, for the demo');
  if (refuseWith) return { refused: refuseWith, message: 'Refused for the demo.' } as const;
  return dispatchSessionMessage(opts);
}

/** The computer face over the real launch path, Mesh answering for the one agent. */
function computerFace(): ComputerTurnPort {
  return createComputerTurnPort({
    meshCore: () => ({
      getProjectPath: (id: string) => (id === AGENT.id ? AGENT.home : undefined),
      listWithPaths: () => [{ id: AGENT.id, name: 'porter', projectPath: AGENT.home }] as never,
    }),
    roomSessionPlace: () => undefined,
    dispatch: launchPath,
  });
}

/** Build the run record as a boot does, over the same database. */
function boot(epoch: string): RunRecord {
  computer = computerFace();
  installRunRecord(db, {
    epoch,
    now: () => clock,
    computer: () => computer,
    agentHome: () => (id) => (id === AGENT.id ? AGENT.home : undefined),
    admission: {
      admission: {
        pausedAgent: () => (paused ? { name: 'Porter' } : undefined),
        machineFull: () => (realCap ? isAgentLaunchCapFull() : machineFull),
      },
      admit: (run, start, deps) => {
        if (forcedVerdict) return forcedVerdict;
        return admitReal(run, start, deps);
      },
    },
  });
  const built = getRunRecord()!;
  built.port.registerSource('demo-send', { read: (id) => sources.get(id) });
  const move = built.store.move.bind(built.store);
  vi.spyOn(built.store, 'move').mockImplementation((run, to, patch) => {
    const moved = move(run, to, patch);
    trail.push(`${run.id}: ${run.status}→${to}`);
    return moved;
  });
  return built;
}

beforeEach(() => {
  db = createTestDb();
  clock = Date.now();
  trail = [];
  answered = [];
  handed = [];
  forcedVerdict = undefined;
  paused = false;
  machineFull = false;
  realCap = false;
  launchGate = undefined;
  refuseWith = undefined;
  launchThrows = false;
  sources.clear();
  const now = new Date().toISOString();
  db.insert(agents)
    .values({
      id: AGENT.id,
      name: 'porter',
      displayName: 'Porter',
      runtime: 'claude-code',
      projectPath: AGENT.home,
      registeredAt: now,
      updatedAt: now,
    })
    .run();
  setAgentHomeRegistry({
    isRegisteredHome: (dir) => dir === AGENT.home,
    listRegisteredHomes: () => [AGENT.home],
    managedWorkspaceOwner: () => null,
    roomsDir: null,
  });
  setMessageQueueStore(new MessageQueueStore(db));
  errors = vi.spyOn(logger, 'error');
  inner = new FakeAgentRuntime('port-demo').withScenarios([quick, quick, quick]);
  inner.getInternalSessionId.mockReturnValue(undefined);
  runtimeRegistry.setDb(db);
  runtimeRegistry.register(inner);
  runtimeRegistry.setDefault(inner.type);
  sessionId = crypto.randomUUID();
  db.insert(sessionMetadata)
    .values({ sessionId, runtime: inner.type, agentPath: AGENT.home, createdAt: now })
    .onConflictDoNothing()
    .run();
  setQueuedChatCeilingResolver(() => 'runtime-default');
  record = boot(EPOCH);
});

afterEach(async () => {
  releaseLongTurn?.();
  releaseLongTurn = undefined;
  await vi.waitFor(() => expect(inner.isTurnOpen(sessionId)).toBe(false));
  await settle();
  expect(recordComplained()).toBe(false);
  setQueuedChatCeilingResolver(undefined);
  resetMessageDispatcher();
  uninstallRunRecord();
  setMessageQueueStore(undefined);
  disposeProjector(sessionId);
  setAgentHomeRegistry(undefined);
  vi.restoreAllMocks();
});

describe('the space face', () => {
  it('saves the run and its start_turn in one write and answers at acceptance', async () => {
    const answer = startFromApp('from the app: tally the votes');
    expect(answer).toMatchObject({ status: 'queued', queuePosition: 1 });
    const run = record.store.get(answer.runId)!;
    expect(run).toMatchObject({
      status: 'queued',
      agentId: AGENT.id,
      origin: { kind: 'resume' },
    });
    expect(startEffect(run.id)).toMatchObject({
      key: `start:${run.id}:1`,
      state: 'pending',
      delivery: 'repeatable',
    });
    // Nothing reached the runtime yet: the answer came before any hand-over.
    expect(answered).toEqual([]);
    await pass();
    expect(answered).toEqual(['from the app: tally the votes']);
    expect(record.store.get(run.id)).toMatchObject({ status: 'ended', ending: 'completed' });
    expect(moves(run.id)).toEqual([
      'queued→starting',
      'starting→started',
      'started→running',
      'running→ended',
    ]);
    // Transition 7 settled the effect in its own write.
    expect(startEffect(run.id).state).toBe('done');
  });

  it('hands a mini app’s message to a busy chat at once, as a queue row under its own id', async () => {
    // Purpose: fails if a composer's words were held back as chat_busy, or queued under another id.
    await personWorking();
    const messageId = '01KMXNXAPPMSGXYZ000000000A';
    const answer = record.port.start(
      {
        sessionId,
        agentId: AGENT.id,
        cwd: AGENT.home,
        content: 'from the app: when you can',
        origin: { kind: 'extension-message' },
        tier: 'owner',
      },
      { runId: messageId }
    );
    expect(answer.runId).toBe(messageId);
    await pass();
    expect(handed).toEqual([messageId]);
    expect(record.store.get(messageId)).toMatchObject({
      status: 'queued',
      waitReason: null,
      queueMessageId: messageId,
    });
    expect(
      db
        .select()
        .from(sessionMessageQueue)
        .all()
        .map((row) => row.id)
    ).toEqual([messageId]);
    expect(startEffect(messageId).state).toBe('leased');
    releaseLongTurn?.();
    await vi.waitFor(() => expect(record.store.get(messageId)?.status).toMatch(/ended|settled/u));
    expect(startEffect(messageId).state).toBe('done');
  });

  it('refuses a mini app’s send or start to a paused agent at start(), with today’s words, saving nothing', () => {
    // Purpose: fails if a paused agent's mini app message were kept to run later.
    paused = true;
    for (const kind of ['extension-message', 'extension-start'] as const) {
      expect(() => startFromApp('from the app: are you there?', { origin: { kind } })).toThrow(
        expect.objectContaining({ reason: 'agent_paused', message: 'Porter is paused.' })
      );
    }
    expect(record.store.listForChat(sessionId)).toEqual([]);
  });

  it('refuses at start() what it can judge itself, and saves nothing', () => {
    // Purpose: fails if a start past the cap or for an unknown agent is saved, or refused silently.
    expect(() => startFromApp('x'.repeat(200_001))).toThrow(TurnStartRefusedError);
    expect(() => startFromApp('x'.repeat(200_001))).toThrow(/under 200,000 characters/u);
    expect(() => startFromApp('hello', { agentId: '01NXBXDYKKZD00000000000000' })).toThrow(
      expect.objectContaining({ reason: 'invalid_agent_path' })
    );
    expect(record.store.listForChat(sessionId)).toEqual([]);
  });

  it('gives each waiting run its place, and hands them over in that order', async () => {
    await personWorking();
    const first = startFromApp('first');
    const second = startFromApp('second');
    expect([first.queuePosition, second.queuePosition]).toEqual([1, 2]);
    await pass();
    releaseLongTurn?.();
    await vi.waitFor(() => expect(inner.isTurnOpen(sessionId)).toBe(false));
    await settle();
    for (let i = 0; i < 4 && answered.length < 3; i++) await pass();
    expect(answered).toEqual(['the person is working', 'first', 'second']);
  });
});

describe('F7: a run without a row while a live turn holds its chat', () => {
  it('waits as chat_busy, keeps its place, and starts once the live run ends', async () => {
    await personWorking();
    const { runId } = startFromApp('from the app: summarise');
    await pass();
    expect(record.store.get(runId)).toMatchObject({ status: 'queued', waitReason: 'chat_busy' });
    expect(startEffect(runId)).toMatchObject({ state: 'pending' });
    expect(answered).toEqual(['the person is working']);

    // The live run's end wakes it: no backoff left to wait out.
    releaseLongTurn?.();
    await vi.waitFor(() => expect(inner.isTurnOpen(sessionId)).toBe(false));
    await settle();
    expect(startEffect(runId).availableAt).toBeLessThanOrEqual(clock);
    await pass();
    expect(answered).toEqual(['the person is working', 'from the app: summarise']);
    expect(record.store.get(runId)).toMatchObject({ status: 'ended', ending: 'completed' });
    // One turn for it: the runtime saw its words once.
    expect(answered.filter((words) => words === 'from the app: summarise')).toHaveLength(1);
  });

  it('is refused chat_busy at the door as a live turn starts, retried with backoff, attempts not counted', async () => {
    await personWorking();
    // Admission saw a free chat; the chat turned busy before the hand-over.
    forcedVerdict = { go: true };
    const { runId } = startFromApp('from the app: late');
    const waits: number[] = [];
    for (let i = 0; i < 10; i++) {
      await pass();
      const effect = startEffect(runId);
      expect(effect.state).toBe('pending');
      waits.push(effect.availableAt - clock);
      clock = effect.availableAt;
    }
    // The §6.1 steps, then every ten minutes; never dropped after eight tries.
    expect(waits).toEqual([
      1_000, 5_000, 30_000, 120_000, 600_000, 600_000, 600_000, 600_000, 600_000, 600_000,
    ]);
    expect(record.store.get(runId)).toMatchObject({ status: 'queued', waitReason: 'chat_busy' });
    expect(moves(runId)).toEqual(['queued→queued']);
    expect(answered).toEqual(['the person is working']);

    forcedVerdict = undefined;
    releaseLongTurn?.();
    await vi.waitFor(() => expect(inner.isTurnOpen(sessionId)).toBe(false));
    await settle();
    await pass();
    expect(record.store.get(runId)).toMatchObject({ status: 'ended', ending: 'completed' });
  });

  it('is cancelled as expired past its notAfter, and its watcher hears once', async () => {
    await personWorking();
    const heard: TurnRun[] = [];
    record.port.watch((run) => heard.push(run));
    const { runId } = startFromApp('from the app: only today', { notAfter: clock + 60_000 });
    await pass();
    expect(record.store.get(runId)?.waitReason).toBe('chat_busy');
    clock += 61_000;
    await pass();
    expect(record.store.get(runId)).toMatchObject({
      status: 'cancelled',
      endingDetail: { cancelledBecause: 'expired' },
    });
    expect(startEffect(runId).state).toBe('expired');
    expect(heard.filter((run) => run.status === 'cancelled')).toHaveLength(1);
    releaseLongTurn?.();
    await vi.waitFor(() => expect(inner.isTurnOpen(sessionId)).toBe(false));
    await settle();
    await pass();
    expect(answered).toEqual(['the person is working']);
  });

  it('is not chat_busy behind a summary holding the chat: it waits in the dispatcher and starts after', async () => {
    // A `/compact` holds the dispatcher's slot with no run behind it.
    const runtime = runtimeRegistry.get(inner.type);
    const sessionKey = sessionId;
    inFlight.set(sessionKey, {
      clientId: 'summary',
      token: Symbol('summary'),
      startedAt: Date.now(),
      sawTurnStart: false,
    });
    const { runId } = startFromApp('from the app: after the summary');
    await pass();
    expect(handed).toEqual([runId]);
    expect(record.store.get(runId)).toMatchObject({ status: 'queued', waitReason: null });
    // Waiting in the dispatcher, with no queue row: its effect stays leased.
    expect(pending.has(runId)).toBe(true);
    expect(db.select().from(sessionMessageQueue).all()).toEqual([]);
    expect(startEffect(runId).state).toBe('leased');
    // A second hand-over while it waits there is the same run: already held.
    expect(
      await computerFace().start(requestFor(runId, 'from the app: after the summary'))
    ).toEqual({ refused: 'already_held' });
    inFlight.delete(sessionKey);
    schedulePump(sessionKey);
    void runtime;
    await vi.waitFor(() => expect(record.store.get(runId)?.status).toBe('ended'));
    expect(startEffect(runId).state).toBe('done');
  });
});

describe('a deadline while the dispatcher holds the run', () => {
  it('withdraws it past its notAfter and cancels it as expired; it never launches after', async () => {
    const sessionKey = sessionId;
    inFlight.set(sessionKey, {
      clientId: 'summary',
      token: Symbol('summary'),
      startedAt: Date.now(),
      sawTurnStart: false,
    });
    const { runId } = startFromApp('from the app: not late', { notAfter: clock + 60_000 });
    await pass();
    expect(pending.has(runId)).toBe(true);
    clock += 61_000;
    await pass();
    expect(pending.has(runId)).toBe(false);
    expect(record.store.get(runId)).toMatchObject({
      status: 'cancelled',
      endingDetail: { cancelledBecause: 'expired' },
    });
    expect(startEffect(runId).state).toBe('expired');
    inFlight.delete(sessionKey);
    schedulePump(sessionKey);
    await settle();
    expect(answered).toEqual([]);
  });
});

describe('a hand-over that keeps failing', () => {
  it('retries with the worker’s backoff, then cancels the run as start_failed', async () => {
    launchThrows = true;
    const { runId } = startFromApp('from the app: never handed over');
    for (let i = 0; i < 8; i++) {
      clock = Math.max(clock, startEffect(runId).availableAt);
      await pass();
    }
    expect(handed).toHaveLength(8);
    expect(record.store.get(runId)).toMatchObject({
      status: 'cancelled',
      endingDetail: { cancelledBecause: 'start_failed' },
    });
    expect(startEffect(runId).state).toBe('done');
  });
});

/** The request the handler would build for a run, to call the computer face directly. */
function requestFor(runId: string, content: string) {
  return {
    runId,
    attempt: 1,
    sessionId,
    agentId: AGENT.id,
    cwd: AGENT.home,
    content,
    origin: { kind: 'resume' as const },
    wireOrigin: 'chat' as const,
    tier: 'owner' as const,
  };
}

describe('the start_turn rules (§6.2)', () => {
  it('a rowless run back in line returns its start_turn to pending; a starting one goes 8 first', async () => {
    const { runId } = startFromApp('from the app: back again');
    const feed = turnFacts()!.dispatcher;
    // Leased as a hand-over is, then the launch begins and starts no turn.
    record.effects.leaseNext(EPOCH, EFFECT_LEASE_MS);
    expect(feed.launchBegins(runId)).toEqual({ kind: 'starting' });
    feed.handBack(runId);
    expect(record.store.get(runId)?.status).toBe('queued');
    expect(startEffect(runId)).toMatchObject({ state: 'pending', availableAt: clock + 1_000 });
    // T2's dead-run rule, extended: its words are with the space side, not
    // the dispatcher, so the next read of the chat never cancels it start_lost.
    record.store.liveRunOf(sessionId);
    expect(record.store.get(runId)?.status).toBe('queued');
    // Still queued, handed back again: pending, never two effects.
    record.effects.leaseNext(EPOCH, EFFECT_LEASE_MS);
    clock += 1_000;
    feed.handBack(runId);
    expect(startEffect(runId).state).toBe('pending');
    expect(record.effects.listForRun(runId)).toHaveLength(1);
    expect(moves(runId)).toEqual(['queued→starting', 'starting→queued']);
  });

  it('transitions 5, 6, 7 and 9 settle the effect in their own write', async () => {
    const feed = turnFacts()!.dispatcher;
    const cancelled = startFromApp('five').runId;
    feed.cancel(cancelled, 'removed');
    expect(startEffect(cancelled).state).toBe('done');

    const nine = startFromApp('nine').runId;
    feed.launchBegins(nine);
    feed.cancel(nine, 'transient');
    expect(moves(nine)).toEqual(['queued→starting', 'starting→cancelled']);
    expect(startEffect(nine).state).toBe('done');

    const six = startFromApp('six').runId;
    turnFacts()!.report({ kind: 'accepted', runId: nine, joinedRunId: six });
    expect(record.store.get(six)?.status).toBe('superseded');
    expect(startEffect(six).state).toBe('done');

    // A handler that finds its run already final writes nothing more.
    await pass();
    expect(handed).toEqual([]);
    const seven = startFromApp('seven').runId;
    await pass();
    expect(moves(seven)).toContain('starting→started');
    expect(startEffect(seven).state).toBe('done');
  });

  it('never hands a run over twice: its queue row present it waits; its row gone it is cancelled', async () => {
    // Another chat's message through the port: its words wait in the composer, as a row.
    const person = record.port.start({
      sessionId,
      cwd: AGENT.home,
      content: 'a chat, through the port',
      origin: { kind: 'chat-message' },
      tier: 'owner',
    });
    await personWorking();
    await pass();
    expect(handed).toEqual([person.runId]);
    const run = record.store.get(person.runId)!;
    expect(run.queueMessageId).toBe(person.runId);
    expect(startEffect(run.id).state).toBe('leased');

    // A restart: the lease runs out, the next boot takes the effect back and
    // finds the row present, so it hands nothing over again.
    resetMessageDispatcher();
    uninstallRunRecord();
    clock += Math.max(RUN_LEASE_MS, EFFECT_LEASE_MS) + 1;
    record = boot(LATER_EPOCH);
    await pass();
    expect(handed).toEqual([person.runId]);
    expect(startEffect(run.id).state).toBe('leased');

    // Its row gone without its run (an older build): cancelled, never handed over.
    db.delete(sessionMessageQueue).where(eq(sessionMessageQueue.id, run.id)).run();
    clock += Math.max(RUN_LEASE_MS, EFFECT_LEASE_MS) + 1;
    uninstallRunRecord();
    record = boot(EPOCH);
    await pass();
    expect(record.store.get(run.id)).toMatchObject({
      status: 'cancelled',
      endingDetail: { cancelledBecause: 'removed' },
    });
    expect(handed).toEqual([person.runId]);
  });
});

describe('across a restart (T2’s dead-run rule, extended)', () => {
  it('a port-started run waiting at its source is still there after a restart, and starts', async () => {
    await personWorking();
    sources.set('row-1', 'from the app: survive this');
    const { runId } = startFromApp('from the app: survive this', { sourceRef: 'demo-send:row-1' });
    await pass();
    expect(record.store.get(runId)?.waitReason).toBe('chat_busy');

    // The process dies: nothing shuts down, every lease runs out.
    releaseLongTurn?.();
    await vi.waitFor(() => expect(inner.isTurnOpen(sessionId)).toBe(false));
    await settle();
    resetMessageDispatcher();
    uninstallRunRecord();
    answered = [];
    clock += Math.max(RUN_LEASE_MS, EFFECT_LEASE_MS) + 1;
    record = boot(LATER_EPOCH);
    // Every live-run read retires what a dead boot left; this run is not one of them.
    expect(record.store.liveRunOf(sessionId)).toBeUndefined();
    expect(record.store.get(runId)?.status).toBe('queued');

    for (let i = 0; i < 3 && answered.length === 0; i++) {
      clock = Math.max(clock, startEffect(runId).availableAt);
      await pass();
    }
    expect(answered).toEqual(['from the app: survive this']);
    expect(record.store.get(runId)).toMatchObject({ status: 'ended', ending: 'completed' });
  });

  it('a port-started run whose words were only in memory is cancelled start_lost, once', async () => {
    await personWorking();
    const { runId } = startFromApp('from the app: gone with the process');
    await pass();
    releaseLongTurn?.();
    await vi.waitFor(() => expect(inner.isTurnOpen(sessionId)).toBe(false));
    await settle();
    resetMessageDispatcher();
    uninstallRunRecord();
    clock += Math.max(RUN_LEASE_MS, EFFECT_LEASE_MS) + 1;
    record = boot(LATER_EPOCH);
    clock = Math.max(clock, startEffect(runId).availableAt);
    await pass();
    expect(record.store.get(runId)).toMatchObject({
      status: 'cancelled',
      endingDetail: { cancelledBecause: 'start_lost' },
    });
    expect(startEffect(runId).state).toBe('done');
  });
});

describe('admission (§3.5)', () => {
  it('holds a mini app’s run while the agent is paused, and lets it go when the pause lifts', async () => {
    paused = true;
    const { runId } = startFromApp('from the app: when you are back');
    await pass();
    expect(record.store.get(runId)).toMatchObject({ status: 'queued', waitReason: 'paused' });
    paused = false;
    clock = startEffect(runId).availableAt;
    await pass();
    expect(record.store.get(runId)?.status).toBe('ended');
  });

  it('holds it while the machine is full, instead of refusing it', async () => {
    machineFull = true;
    const { runId } = startFromApp('from the app: when there is room');
    await pass();
    expect(record.store.get(runId)).toMatchObject({ status: 'queued', waitReason: 'machine_full' });
    expect(handed).toEqual([]);
    machineFull = false;
    clock = startEffect(runId).availableAt;
    await pass();
    expect(record.store.get(runId)?.status).toBe('ended');
  });
});

describe('the door’s refusals (§3.1)', () => {
  it.each([
    ['INVALID_AGENT_PATH', 'invalid_agent_path'],
    ['UNKNOWN_RUNTIME', 'unknown_runtime'],
    ['ROOM_SESSION_MOVED', 'room_session_moved'],
    ['DESK_NOT_OWN', 'desk_not_own'],
    ['ACCOUNT_NOT_ALLOWED', 'account_not_allowed'],
    ['AGENT_PAUSED', 'agent_paused'],
  ] as const)('%s cancels the run from queued as %s, never as an ending', async (code, reason) => {
    refuseWith = code;
    const { runId } = startFromApp('refused at the door');
    await pass();
    expect(record.store.get(runId)).toMatchObject({
      status: 'cancelled',
      ending: null,
      endingDetail: { cancelledBecause: reason },
    });
    expect(moves(runId)).toEqual(['queued→cancelled']);
    expect(startEffect(runId).state).toBe('done');
    expect(answered).toEqual([]);
  });

  it('refuses a run for an agent Mesh no longer knows, before the launch path', async () => {
    const { runId } = startFromApp('for a gone agent');
    // Mesh lost the agent between the start and the hand-over.
    uninstallRunRecord();
    installRunRecord(db, {
      epoch: EPOCH,
      now: () => clock,
      computer: () =>
        createComputerTurnPort({
          meshCore: () => ({ getProjectPath: () => undefined, listWithPaths: () => [] }),
          roomSessionPlace: () => undefined,
          dispatch: launchPath,
        }),
    });
    record = getRunRecord()!;
    record.port.start({
      sessionId,
      cwd: AGENT.home,
      content: 'held in memory for the second boot',
      origin: { kind: 'resume' },
      tier: 'owner',
    });
    await pass();
    // The first run's words were in the first boot's memory: lost, honestly.
    expect(record.store.get(runId)?.endingDetail.cancelledBecause).toBe('start_lost');
    const agentRun = record.port.start({
      sessionId,
      agentId: AGENT.id,
      cwd: AGENT.home,
      content: 'for a gone agent, again',
      origin: { kind: 'resume' },
      tier: 'owner',
    });
    await pass();
    expect(record.store.get(agentRun.runId)).toMatchObject({
      status: 'cancelled',
      endingDetail: { cancelledBecause: 'invalid_agent_path' },
    });
    expect(handed).not.toContain(agentRun.runId);
  });
});

describe('what the review found (T5)', () => {
  it('lets go of the launch slot when a refused launch hands its run back (the real cap)', async () => {
    // Purpose: fails if each hand-back leaked one slot of `runtimes.maxAgentChats`.
    realCap = true;
    inner.acquireLock.mockReturnValue(false);
    const { runId } = startFromApp('from the app: try again');
    for (let i = 0; i < agentLaunchMaxLive() + 2; i++) {
      clock = Math.max(clock, startEffect(runId).availableAt);
      await pass();
    }
    expect(handed.length).toBeGreaterThan(agentLaunchMaxLive());
    expect(isAgentLaunchCapFull()).toBe(false);
    expect(record.store.get(runId)?.waitReason).not.toBe('machine_full');
    inner.acquireLock.mockReturnValue(true);
    clock = Math.max(clock, startEffect(runId).availableAt);
    await pass();
    expect(record.store.get(runId)?.status).toMatch(/ended|settled/u);
  });

  it('counts only throws toward giving up: many waits, then one throw, is not the end', async () => {
    await personWorking();
    forcedVerdict = { go: true };
    const { runId } = startFromApp('from the app: patient');
    for (let i = 0; i < 9; i++) {
      await pass();
      clock = startEffect(runId).availableAt;
    }
    forcedVerdict = undefined;
    releaseLongTurn?.();
    await vi.waitFor(() => expect(inner.isTurnOpen(sessionId)).toBe(false));
    await settle();
    launchThrows = true;
    clock = Math.max(clock, startEffect(runId).availableAt);
    await pass();
    expect(record.store.get(runId)?.status).toBe('queued');
    expect(startEffect(runId)).toMatchObject({ state: 'pending', outcome: { failures: 1 } });
    // A throw's backoff is its own: another run ending does not cut it short.
    const before = startEffect(runId).availableAt;
    record.effects.wakeAllStarts();
    expect(startEffect(runId).availableAt).toBe(before);
    launchThrows = false;
    clock = before;
    await pass();
    expect(record.store.get(runId)?.status).toMatch(/ended|settled/u);
  });

  it('holds a hand-over still inside the launch path, and drops a launch whose run already ended', async () => {
    let open!: () => void;
    launchGate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const { runId } = startFromApp('from the app: on its way');
    const handing = record.worker.runOnce();
    await vi.waitFor(() => expect(handed).toEqual([runId]));
    // Its deadline cannot take it back now: the launch path has it.
    expect(computer.holds(runId)).toBe(true);
    expect(computer.withdraw(runId)).toBe(false);
    open();
    await handing;
    await settle();
    expect(record.store.get(runId)?.status).toMatch(/ended|settled/u);

    const cancelled = startFromApp('from the app: too late').runId;
    record.starts.cancel(cancelled, 'expired');
    expect(turnFacts()!.dispatcher.launchBegins(cancelled)).toEqual({ kind: 'gone' });
  });

  it('hands over again, in the same process, a run whose dispatcher plan was lost', async () => {
    inFlight.set(sessionId, {
      clientId: 'summary',
      token: Symbol('summary'),
      startedAt: Date.now(),
      sawTurnStart: false,
    });
    const { runId } = startFromApp('from the app: found again');
    await pass();
    expect(pending.has(runId)).toBe(true);
    // The plan goes with no word to the record (a reset, a bug).
    pending.delete(runId);
    await pass();
    expect(handed).toEqual([runId, runId]);
    expect(pending.has(runId)).toBe(true);
    inFlight.delete(sessionId);
    schedulePump(sessionId);
    await vi.waitFor(() => expect(record.store.get(runId)?.status).toMatch(/ended|settled/u));
  });

  it('saves a fresh start_turn for a run without a row that a pause put back in line', () => {
    const { runId } = startFromApp('from the app: cut short');
    const facts = turnFacts()!;
    holdRun(runId);
    facts.dispatcher.launchBegins(runId);
    facts.report({
      kind: 'started',
      runId,
      sessionId,
      openedBy: 'caller',
      runtime: inner.type,
      runtimeTurnRef: 1,
    });
    facts.dispatcher.pauseCut(runId);
    releaseRun(runId);
    const starts = record.effects.listForRun(runId).filter((e) => e.kind === 'start_turn');
    expect(starts.map((e) => e.state)).toEqual(['done', 'pending']);
    expect(starts[1]?.key).toBe(`start:${runId}:1:2`);
    // Its words stay with the space side until the runtime has them.
    expect(record.port.wordsOf(record.store.get(runId)!)).toBe('from the app: cut short');
  });
});
