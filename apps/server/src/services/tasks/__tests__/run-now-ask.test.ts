/**
 * "Run now" raises an approval a person can actually answer.
 *
 * The bug this pins, found by browser verification: clicking **Run now** on a
 * schedule whose prompt needed a tool the agent had to ask about produced an
 * approval card that appeared NOWHERE — not on Tasks, not in the header tray,
 * not in Pulse, not in `GET /api/sessions/pending-interactions` — and then the
 * run died two minutes later saying "No receiver for the scheduled run", for a
 * run somebody had clicked with their own hand.
 *
 * Two independent faults produced that, and this file pins both plus the
 * scheduled-run behaviour neither may disturb:
 *
 * 1. **The run's turn was projected nowhere.** A run consumed the runtime's
 *    stream privately, so no `SessionStateProjector` existed for its session and
 *    the card reached none of the surfaces asks are read from.
 * 2. **The run rode the message bus.** A relay dispatch awaits the whole turn
 *    inside a 120-second delivery deadline, so a card left standing while a
 *    person read it timed the delivery out, came back `deliveredTo: 0`, and
 *    failed the run as though nothing had received it.
 *
 * @module services/tasks/__tests__/run-now-ask
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import type { StreamEvent } from '@dorkos/shared/types';
import type { RelayCore } from '@dorkos/relay';
import {
  singleRuntimeSource,
  TaskSchedulerService,
  type SchedulerAgentManager,
} from '../task-scheduler-service.js';
import { RELAY_DISPATCH_OK } from '../../relay/task-dispatch/readiness.js';
import { TASK_RUN_CLIENT_ID } from '../session/run-projection.js';
import { TaskStore } from '../task-store.js';
import {
  disposeProjector,
  getOrCreateProjector,
  listPendingInteractionsAcrossSessions,
  peekProjector,
  setSessionEventStore,
} from '../../session/session-state-projector.js';
import type { SessionEventStore } from '../../session/session-event-store.js';

vi.mock('../../relay/relay-state.js', () => ({ isRelayEnabled: vi.fn(() => true) }));

const CONFIG = {
  maxConcurrentRuns: 2,
  retentionCount: 100,
  timezone: null,
  mayFire: true,
  firingReason: 'test',
};

/** What every session route's `parseSessionId` will accept. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A promise a test resolves by hand, standing in for the person's answer. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Move a double's methods onto a PROTOTYPE, the way a real runtime's are.
 *
 * Every runtime is a class instance, so `{ ...runtime }` copies none of its
 * methods — and a port built by spreading one works perfectly against an
 * object-literal double and dies on the real thing with "… is not a function".
 * That shipped here once and was caught by running the app rather than by this
 * file. Reaching a method still returns the same `vi.fn`, so spies and
 * `mockImplementation` behave exactly as before; only the spread stops working.
 */
function onAPrototype<T extends object>(impl: T): T {
  const proto: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(impl)) {
    if (typeof value === 'function') proto[key] = value;
  }
  return Object.create(proto) as T;
}

/** The approval card the runtime pushes when a tool needs a person. */
function approvalEvent(toolCallId: string): StreamEvent {
  return {
    type: 'approval_required',
    data: {
      toolCallId,
      toolName: 'Bash',
      input: JSON.stringify({ command: 'chmod 640 /tmp/x' }),
      timeoutMs: 600_000,
      startedAt: Date.now(),
      hasSuggestions: false,
    },
  } as unknown as StreamEvent;
}

describe('a "Run now" ask reaches the person waiting for it', () => {
  let db: Db;
  let store: TaskStore;
  /** Session ids handed to `ensureSession`, so a test can clean them up. */
  let sessions: string[];
  let ensureOpts: Array<Record<string, unknown>>;
  /** Sessions opened with nobody watching, which raise no cards at all. */
  let unattendedSessions: Set<string>;
  /** Who holds each session's write-lock, modelling the real one. */
  let locks: Map<string, string>;
  /** Session key → the id the runtime renamed it to, once it has. */
  let renames: Map<string, string>;
  /** Released by the test to let the parked turn finish. */
  let answered: ReturnType<typeof deferred>;
  let agent: SchedulerAgentManager;

  beforeEach(() => {
    db = createTestDb();
    store = new TaskStore(db);
    sessions = [];
    ensureOpts = [];
    unattendedSessions = new Set();
    locks = new Map();
    renames = new Map();
    answered = deferred();
    agent = onAPrototype({
      ensureSession: vi.fn((sessionId: string, opts: Record<string, unknown>) => {
        sessions.push(sessionId);
        ensureOpts.push(opts);
        if (opts.unattended === true) unattendedSessions.add(sessionId);
      }),
      // One card, then silence until the test answers — exactly the shape of a
      // turn parked on a person. A session opened `unattended` raises no card at
      // all, which is what the runtime itself does (#1818): the fake has to obey
      // that or the scheduled case here would test a shape production cannot
      // produce.
      sendMessage: vi.fn(async function* (sessionId: string): AsyncGenerator<StreamEvent> {
        if (unattendedSessions.has(sessionId)) return;
        yield approvalEvent('tool-1');
        await answered.promise;
        yield { type: 'text_delta', data: { text: 'done' } } as unknown as StreamEvent;
      }),
      interruptQuery: vi.fn().mockResolvedValue({ outcome: 'not-running' }),
      // Undefined until a test renames a session, which is what a runtime that
      // never renames its own answers.
      getInternalSessionId: vi.fn((sessionId: string) => renames.get(sessionId)),
      // A real lock, not a rubber stamp: the whole question this file asks about
      // a sticky session is what happens when somebody else holds it.
      acquireLock: vi.fn((sessionId: string, clientId: string) => {
        const held = locks.get(sessionId);
        if (held !== undefined && held !== clientId) return false;
        locks.set(sessionId, clientId);
        return true;
      }),
      releaseLock: vi.fn((sessionId: string, clientId: string) => {
        if (locks.get(sessionId) === clientId) locks.delete(sessionId);
      }),
    }) as unknown as SchedulerAgentManager;
  });

  afterEach(() => {
    answered.resolve();
    setSessionEventStore(undefined);
    for (const id of [...sessions, ...renames.values()]) disposeProjector(id);
    vi.clearAllMocks();
  });

  /** A task whose prompt will need a tool the agent has to ask about. */
  function askingTask() {
    return store.createTask({
      name: 'Tighten a file',
      description: 'Tighten a file',
      prompt: 'Run `chmod 640 /tmp/x`',
      filePath: '/tmp/tasks/tighten-a-file/SKILL.md',
      cron: '0 3 * * *',
      permissionMode: 'default',
    });
  }

  it('lists the ask fleet-wide, on a session id the app can open', async () => {
    const task = askingTask();
    const service = new TaskSchedulerService(store, agent, CONFIG);

    const run = await service.triggerManualRun(task.id);
    await vi.waitFor(() => expect(listPendingInteractionsAcrossSessions()).toHaveLength(1));

    const [pending] = listPendingInteractionsAcrossSessions();
    // The exact row `GET /api/sessions/pending-interactions` serves, which is
    // what the header tray, Pulse and the Home triage header all read.
    expect(pending!.interaction.id).toBe('tool-1');
    // The directory the turn actually ran in. The list SKIPS a session with none
    // stamped on it, so this being right is load-bearing rather than cosmetic.
    expect(pending!.cwd).toBe(ensureOpts[0]!.cwd);
    expect(pending!.cwd).toBeTruthy();
    // A UUID, not the run's ULID: every session route validates one, so this is
    // the difference between a card the person can answer and a 400.
    expect(pending!.sessionId).toMatch(UUID);
    expect(pending!.sessionId).toBe(sessions[0]);

    // And the run row names that session while the run is still going, so the
    // run history offers the link at the moment it is needed rather than after.
    expect(store.getRun(run!.id)!.sessionId).toBe(pending!.sessionId);
    expect(store.getRun(run!.id)!.status).toBe('running');

    // Answer it exactly as `POST /api/sessions/:id/approve` does: the runtime
    // resolves the interaction on the session's LIVE projector. That there is
    // one to find, under the id the list above published, is the whole fix.
    getOrCreateProjector(pending!.sessionId).resolveInteraction('tool-1', 'approved');
    expect(listPendingInteractionsAcrossSessions()).toHaveLength(0);

    // And the run then finishes, on its own record.
    answered.resolve();
    await vi.waitFor(() => expect(store.getRun(run!.id)!.status).toBe('completed'));

    await service.stop();
  });

  it('keeps a run somebody clicked off the bus, and still puts a scheduled one on it', async () => {
    // The discriminating pair, and the mutation this file is really guarding:
    // hand a manual run to the relay and its whole turn is awaited inside a
    // 120-second delivery deadline, in a process that holds none of the session
    // surfaces — so the card above cannot exist AND the run fails as "nothing
    // received it" while the person is still reading. The trigger is the only
    // thing that differs between these two dispatches: the bus below says yes to
    // everything, so a rule that stopped reading the trigger would send both.
    const publish = vi.fn().mockResolvedValue({ messageId: 'm1', deliveredTo: 1 });
    const task = askingTask();
    const service = new TaskSchedulerService({
      store,
      runtimes: singleRuntimeSource(agent),
      config: CONFIG,
      relay: { publish } as unknown as RelayCore,
      relayHoldsRuntime: () => RELAY_DISPATCH_OK,
    });

    await service.triggerManualRun(task.id);
    await vi.waitFor(() => expect(agent.sendMessage).toHaveBeenCalledOnce());
    expect(publish).not.toHaveBeenCalled();

    await (service as unknown as { dispatch(t: typeof task, when: Date): Promise<void> }).dispatch(
      task,
      new Date(1_700_000_000_000)
    );
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());

    await service.stop();
  });

  it('still refuses a SCHEDULED run its asks, and shows nobody a card', async () => {
    // The other half of the promise the task form makes. A fire the clock
    // started has nobody in front of it, so its asks are refused where they are
    // raised (#1818) — and it needs no session surface, because there is nobody
    // to surface anything to.
    const task = askingTask();
    const service = new TaskSchedulerService(store, agent, CONFIG);

    await (service as unknown as { dispatch(t: typeof task, when: Date): Promise<void> }).dispatch(
      task,
      new Date(1_700_000_000_000)
    );
    await vi.waitFor(() => expect(agent.ensureSession).toHaveBeenCalledOnce());

    expect(ensureOpts[0]).toMatchObject({ unattended: true });
    expect(listPendingInteractionsAcrossSessions()).toHaveLength(0);

    await service.stop();
  });

  it('follows the runtime when it renames the session mid-turn', async () => {
    // The claude-code SDK mints its own id on the first turn and renames the
    // session to it. Everything a turn holds is keyed by session id, so a rename
    // nothing follows leaves the run row naming an id with NO projector behind
    // it, the durable rows stranded under the id nobody will ask for again, and
    // the write-lock held under a third. A person's turn has always followed it;
    // this pins that a run does the same, through the same helper.
    const CANON = '11111111-2222-4333-8444-555555555555';
    const rekeySession = vi.fn();
    // The three methods a `record`-mode projector actually reaches for, plus the
    // one this test is about.
    setSessionEventStore({
      rekeySession,
      maxSeq: () => 0,
      readAll: () => [],
      appendTurn: () => {},
    } as unknown as SessionEventStore);

    // A turn that renames itself only after its FIRST event, which is what makes
    // the rekey a per-event retry rather than a single read: the SDK's init is
    // not guaranteed to have landed by the first yield. It then parks, so the
    // assertions below judge a turn that is still RUNNING — the move has to have
    // happened by then, not at teardown, because the whole point is that a
    // person looking at this session mid-run finds it.
    vi.mocked(agent.sendMessage).mockImplementation(async function* (sessionId: string) {
      yield { type: 'text_delta', data: { text: 'one' } } as unknown as StreamEvent;
      renames.set(sessionId, CANON);
      yield { type: 'text_delta', data: { text: 'two' } } as unknown as StreamEvent;
      await answered.promise;
    });

    const task = askingTask();
    const service = new TaskSchedulerService(store, agent, CONFIG);
    const run = await service.triggerManualRun(task.id);
    await vi.waitFor(() => expect(peekProjector(CANON)).toBeDefined());
    expect(store.getRun(run!.id)!.status).toBe('running');

    answered.resolve();
    await vi.waitFor(() => expect(store.getRun(run!.id)!.status).toBe('completed'));

    const requested = sessions[0]!;
    // The row names the canonical id — and that id has the live projector, so
    // the run-history link opens a real conversation rather than an empty one.
    expect(store.getRun(run!.id)!.sessionId).toBe(CANON);
    expect(peekProjector(CANON)).toBeDefined();
    // Not two projectors: the requested id resolves to the very same instance.
    expect(peekProjector(requested)).toBe(peekProjector(CANON));
    // The durable rows moved with it.
    expect(rekeySession).toHaveBeenCalledWith(requested, CANON);
    // And so did the write-lock: released under the id it ended on, and no lock
    // left standing anywhere.
    expect(agent.releaseLock).toHaveBeenCalledWith(CANON, TASK_RUN_CLIENT_ID, expect.anything());
    expect(locks.size).toBe(0);

    await service.stop();
  });

  it('waits for the person to finish before writing to a session they are in', async () => {
    // A sticky task resumes ONE session across every fire, so a "Run now" can
    // land on the exact session somebody is typing in. Two `feedProjector`
    // streams on one projector is the hazard: whichever finishes first retires
    // the other's live subagents. The run takes the session write-lock, which is
    // the only seam that serializes across clients, so it waits its turn.
    const task = store.createTask({
      name: 'Sticky asker',
      description: 'Sticky asker',
      prompt: 'do the thing',
      filePath: '/tmp/tasks/sticky-asker/SKILL.md',
      cron: '0 3 * * *',
      sticky: true,
      permissionMode: 'default',
    });
    // The session this task's next fire will resume, with a person mid-turn on
    // it: their window holds the lock.
    const shared = '99999999-8888-4777-8666-555555555555';
    store.createRun(task.id, 'scheduled');
    const previous = store.listRuns({ taskId: task.id })[0]!;
    store.updateRun(previous.id, {
      status: 'completed',
      finishedAt: new Date().toISOString(),
      durationMs: 1,
      sessionId: shared,
    });
    locks.set(shared, 'somebodys-browser-tab');

    const service = new TaskSchedulerService(store, agent, CONFIG);
    const run = await service.triggerManualRun(task.id);

    // It resolved the shared session and asked for the lock, and then stopped:
    // no turn opened, so nothing is writing to the projector the person's turn
    // owns.
    await vi.waitFor(() => expect(agent.acquireLock).toHaveBeenCalled());
    expect(agent.ensureSession).not.toHaveBeenCalled();
    expect(agent.sendMessage).not.toHaveBeenCalled();
    expect(store.getRun(run!.id)!.status).toBe('running');

    // The person's turn ends and the run takes it from there.
    locks.delete(shared);
    await vi.waitFor(() => expect(agent.sendMessage).toHaveBeenCalledOnce(), { timeout: 5000 });
    expect(vi.mocked(agent.sendMessage).mock.calls[0]![0]).toBe(shared);

    answered.resolve();
    await vi.waitFor(() => expect(store.getRun(run!.id)!.status).toBe('completed'));

    await service.stop();
  });

  it('takes the card away when the run is halted before anyone answers', async () => {
    // A pending ask deliberately OUTLIVES its own turn — that is the parked case,
    // and it is why `turn_end` does not clear one. But a run somebody stopped is
    // not parked, it is over: nobody is coming back to that card, and left alone
    // it stands in every fleet-wide ask surface for the four-hour park ceiling,
    // pointing at a turn that no longer exists.
    const task = askingTask();
    const service = new TaskSchedulerService(store, agent, CONFIG);
    const run = await service.triggerManualRun(task.id);
    await vi.waitFor(() => expect(listPendingInteractionsAcrossSessions()).toHaveLength(1));

    await expect(service.cancelRun(run!.id)).resolves.toEqual({ state: 'stopping' });
    await vi.waitFor(() => expect(store.getRun(run!.id)!.status).toBe('cancelled'));

    await vi.waitFor(() => expect(listPendingInteractionsAcrossSessions()).toHaveLength(0));

    await service.stop();
  });

  it('leaves a "Run now" answerable — it is never told nobody is there', async () => {
    const task = askingTask();
    const service = new TaskSchedulerService(store, agent, CONFIG);

    await service.triggerManualRun(task.id);
    await vi.waitFor(() => expect(agent.ensureSession).toHaveBeenCalledOnce());

    expect(ensureOpts[0]).toMatchObject({ unattended: false });

    await service.stop();
  });
});
