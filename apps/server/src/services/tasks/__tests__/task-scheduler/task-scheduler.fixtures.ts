/**
 * Shared setup for the TaskSchedulerService tests in this folder: the mock
 * runtimes, the turn shapes, the store harness and the relay stand-in.
 */
import { expect, vi, type Mock } from 'vitest';
import { runtimeRegistry } from '../../../core/runtime-registry.js';
import path from 'node:path';
import { mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { initBoundary } from '../../../../lib/boundary.js';
import { TaskSchedulerService } from '../../task-scheduler-service.js';
import type { SchedulerRuntimes, RelayRuntimePredicate } from '../../task-scheduler-service.js';
import { RELAY_DISPATCH_OK } from '../../../relay/task-dispatch/readiness.js';
import type { RelayCore } from '@dorkos/relay';
import { TaskStore } from '../../task-store.js';
import type { CreateTaskStoreInput } from '../../task-store.js';
import { isTerminalRunStatus } from '../../lifecycle/run-statuses.js';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import type { StreamEvent, TaskRun } from '@dorkos/shared/types';
import type { MeshCore } from '@dorkos/mesh';
import { writeManifest } from '@dorkos/shared/manifest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { turnsOn, type RuntimeDouble } from '../support/runtime-task-turns.js';

/** A bare mock agent manager whose turns end at once with no events. */
function createMockAgentManager(): RuntimeDouble {
  return {
    ensureSession: vi.fn(),
    sendMessage: vi.fn().mockImplementation(async function* () {
      // Default: no events (immediate completion)
    }),
    interruptQuery: vi.fn().mockResolvedValue(true),
    // The bare mock never remaps, so a sticky run persists the key it was given.
    // The sticky tests that care about the SDK's id remap use RemapFakeAgent below.
    getInternalSessionId: vi.fn(() => undefined),
    // Nobody else is writing to these sessions, so the write-lock is always free.
    acquireLock: vi.fn(() => true),
    releaseLock: vi.fn(),
  } as unknown as RuntimeDouble;
}

/**
 * A scheduler agent-manager that MODELS the Claude Code SDK's session-id remap
 * (DOR-1571), so a test can cross the real resume-by-id seam a bare `vi.fn()`
 * cannot.
 *
 * The runtime mints (or, on a genuine resume, keeps) its OWN session id on the
 * first turn and writes the transcript on disk under THAT id — never the key
 * passed to `ensureSession`. Resume finds a session only when its key names a
 * transcript that exists. This fake reproduces exactly that: `sendMessage` mints
 * a fresh SDK id and records a transcript for it, unless the caller asked to
 * resume a key that already has one — in which case it keeps that id and marks
 * the turn as having loaded history. `getInternalSessionId` reports the id the
 * turn actually ran under. {@link evict} drops the in-memory sessions while the
 * transcripts survive, modelling idle-reap or a restart — the exact condition
 * under which the old synthetic-id approach silently lost all context.
 */
export class RemapFakeAgent {
  /** Live session key → the SDK id its last turn ran under. */
  private live = new Map<string, string>();
  /** SDK ids that have a transcript on disk (survive {@link evict}). */
  readonly transcripts = new Set<string>();
  private counter = 0;
  private pendingHasStarted = new Map<string, boolean>();
  /** One record per turn, newest last. */
  readonly turns: Array<{
    key: string;
    hasStarted: boolean;
    resumedFrom: string | null;
    loadedHistory: boolean;
    ranAs: string;
  }> = [];

  ensureSession(sessionId: string, opts: { hasStarted?: boolean }): void {
    if (!this.live.has(sessionId)) this.live.set(sessionId, sessionId);
    this.pendingHasStarted.set(sessionId, opts.hasStarted ?? false);
  }

  async *sendMessage(sessionId: string): AsyncGenerator<StreamEvent> {
    const hasStarted = this.pendingHasStarted.get(sessionId) ?? false;
    // Resume succeeds ONLY if the key names a transcript that exists on disk.
    const resuming = hasStarted && this.transcripts.has(sessionId);
    let ranAs: string;
    if (resuming) {
      // Claude Code continues the same session file — the id is kept.
      ranAs = sessionId;
    } else {
      // Fresh session: the SDK mints its own id and writes a new transcript.
      ranAs = `sdk-${++this.counter}`;
      this.transcripts.add(ranAs);
    }
    // The real runtime moves the durable runtime/owner binding with its SDK id.
    await runtimeRegistry.rekeySessionSettings(sessionId, ranAs);
    this.live.set(sessionId, ranAs);
    this.turns.push({
      key: sessionId,
      hasStarted,
      resumedFrom: resuming ? sessionId : null,
      loadedHistory: resuming,
      ranAs,
    });
    // No events → immediate completion.
  }

  getInternalSessionId(sessionId: string): string | undefined {
    return this.live.get(sessionId);
  }

  /** Nobody else writes to these sessions, so the write-lock is always free. */
  acquireLock: Mock<() => boolean> = vi.fn(() => true);

  releaseLock: Mock<() => void> = vi.fn();

  interruptQuery: Mock<() => Promise<boolean>> = vi.fn().mockResolvedValue(true);

  /** Idle-reap / restart: forget in-memory sessions; transcripts persist on disk. */
  evict(): void {
    this.live.clear();
    this.pendingHasStarted.clear();
  }
}

/**
 * A turn that emits one event and then parks forever — the shape of a run
 * blocked on a tool-approval prompt nobody will answer. It yields no further
 * events, so anything that only runs inside the consumer's loop body never runs
 * again.
 *
 * `parked` resolves once the consumer has asked for the event that will never
 * come. Tests must await it before stopping the run: an abort that lands while
 * the first event is still in flight is caught by the loop body and proves
 * nothing about a genuinely parked turn.
 */
export function parkedTurn(): {
  impl: () => AsyncGenerator<StreamEvent>;
  parked: Promise<void>;
} {
  let signalParked!: () => void;
  const parked = new Promise<void>((resolve) => {
    signalParked = resolve;
  });
  const impl = async function* (): AsyncGenerator<StreamEvent> {
    yield { type: 'text_delta', data: { text: 'starting' } };
    signalParked();
    // Never settles: the run is waiting on a person who never arrives.
    await new Promise(() => {});
  };
  return { impl, parked };
}

/** A promise a test resolves when preparation may continue or the run has ended. */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * A turn that ends normally, but whose LAST event lands in the same instant
 * something stops the run.
 *
 * This is the one window where "did a stop end this run?" and "is the signal
 * aborted?" give different answers, and it is not reachable with a plain
 * generator — the abort has to be queued between the final `next()` resolving
 * and the consumer's continuation running. A hand-rolled iterator is the only
 * way to put it exactly there, so the race is deterministic instead of a
 * coin-flip that reproduces once a fortnight.
 *
 * @param stopAtEnd - Called as the stream ends; queued so it lands after the
 *   final `next()` has already resolved `done`.
 */
export function turnThatEndsAsItIsStopped(stopAtEnd: () => void): AsyncGenerator<StreamEvent> {
  let calls = 0;
  const iterator: AsyncIterator<StreamEvent> = {
    next(): Promise<IteratorResult<StreamEvent>> {
      calls++;
      if (calls === 1) {
        return Promise.resolve({
          done: false,
          value: { type: 'text_delta', data: { text: 'ok' } },
        });
      }
      queueMicrotask(stopAtEnd);
      return Promise.resolve({ done: true, value: undefined });
    },
  };
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    ...iterator,
  } as AsyncGenerator<StreamEvent>;
}

/**
 * A run's session id is a freshly minted UUID (`resolveRunSession`), never the
 * run's own ULID — this is what a test matches it against instead of a
 * hardcoded identity.
 */
export const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * `vi.waitFor`, polling every 5 ms instead of the default 50 ms.
 *
 * Every wait in this file is for a run the scheduler settles on its own a
 * few ticks later; at 50 ms the poll, not the scheduler, set how long each
 * one took. Same timeout (default 1 s, or the caller's), same assertion.
 */
export function waitFor<T>(
  callback: () => T | Promise<T>,
  options: { timeout?: number } = {}
): Promise<T> {
  return vi.waitFor(callback, { interval: 5, ...options });
}

/** Build a minimal CreateTaskStoreInput with defaults for required fields. */
export function taskInput(
  overrides: Partial<CreateTaskStoreInput> & { name: string }
): CreateTaskStoreInput {
  return {
    description: overrides.prompt ?? 'test',
    prompt: 'test',
    filePath: `/tmp/tasks/${overrides.name.toLowerCase().replace(/\s+/g, '-')}/SKILL.md`,
    ...overrides,
  };
}

export const DEFAULT_CONFIG = {
  maxConcurrentRuns: 1,
  retentionCount: 100,
  mayFire: true,
  firingReason: 'test',
};

/**
 * An on-time fire of an hourly (`0 * * * *`) task: 2023-11-14T22:00:00Z, an
 * exact hour boundary. `dispatch` resolves every fire to the occurrence it
 * stands for and skips one that is too late (DOR-2718), so a case about
 * something else fires on an occurrence rather than at an arbitrary instant.
 */
export const ON_TIME_HOURLY = new Date(1_699_999_200_000);

/** Create a minimal MeshCore mock with getProjectPath. */
export function createMockMeshCore(pathMap: Record<string, string | undefined> = {}): MeshCore {
  return {
    getProjectPath: vi.fn((agentId: string) => pathMap[agentId]),
  } as unknown as MeshCore;
}

/** The scheduler's private cron-fire chokepoint, with an optional tick. */
export type Dispatchable = {
  dispatch(t: ReturnType<TaskStore['createTask']>, when?: Date | null): Promise<void>;
};

/** A leader lock that always leads. */
export const LEADER_LOCK = {
  tryAcquire: () => true,
  heartbeat: () => {},
  release: () => {},
  isLeaderNow: true,
};

/** A leader lock that never leads. */
export const FOLLOWER_LOCK = {
  tryAcquire: () => false,
  heartbeat: () => {},
  release: () => {},
  isLeaderNow: false,
};

/**
 * A fresh database, store and mock agent for one test.
 *
 * The agent-cwd chain (`services/workspace/resolve-session-cwd.ts`) refuses a
 * directory outside `DORKOS_BOUNDARY`, and these tests' agent paths are
 * absolute stand-ins. A boundary of `/` states what they assume: every path is
 * in bounds, so a case fails for its own reason.
 *
 * @param boundary - The boundary root to initialise.
 */
export async function freshHarness(boundary = '/'): Promise<{
  db: Db;
  store: TaskStore;
  mockAgent: RuntimeDouble;
}> {
  const db = createTestDb();
  runtimeRegistry.setDb(db);
  const store = new TaskStore(db);
  const mockAgent = createMockAgentManager();
  await initBoundary(boundary);
  return { db, store, mockAgent };
}

/** A relay stand-in: only `publish`, which the scheduler calls. */
export type MockRelay = { publish: ReturnType<typeof vi.fn> };

/**
 * A relay whose publish lands on one receiver unless a test says otherwise.
 *
 * @param messageId - The id each publish answers with.
 */
export function relayStub(messageId = 'msg-1'): MockRelay {
  return { publish: vi.fn().mockResolvedValue({ messageId, deliveredTo: 1 }) };
}

/**
 * Runtimes, a scheduler over them and a wait-for-the-end helper, for the
 * per-task runtime cases (DOR-1615).
 *
 * @param store - The store the scheduler reads and writes.
 */
export function runtimeHarness(store: TaskStore) {
  const managers: Record<string, RuntimeDouble> = {};

  /**
   * A registry stand-in with one manager per registered runtime. Each manager is
   * its own mock, which is the point: "the run went to the right backend" is
   * only checkable when the wrong backend would have been a different object.
   *
   * @param registered - The runtime types that are turned on, first is default.
   */
  function runtimesWith(registered: string[]): SchedulerRuntimes {
    for (const type of registered) managers[type] ??= createMockAgentManager();
    return {
      has: (type) => registered.includes(type),
      getDefaultType: () => registered[0]!,
      // Deliberately empty: a capability profile is not what decides
      // availability, and leaving it out keeps these cases about routing.
      getAllCapabilities: () => ({}),
      get: (type) => managers[type]!,
    };
  }

  /**
   * A scheduler over a given set of runtimes.
   *
   * @param registered - The runtime types that are turned on.
   * @param relay - A relay to enable the bus path, or null for direct-only.
   * @param relayHoldsRuntime - Which runtimes the relay holds; omitted pins
   *   the v1 default (claude-code on the bus, everything else direct).
   */
  function scheduler(
    registered: string[],
    relay: RelayCore | null = null,
    relayHoldsRuntime?: RelayRuntimePredicate
  ): TaskSchedulerService {
    return new TaskSchedulerService({
      store,
      runtimes: runtimesWith(registered),
      turns: turnsOn(runtimesWith(registered)),
      config: { ...DEFAULT_CONFIG },
      relay,
      ...(relayHoldsRuntime ? { relayHoldsRuntime } : {}),
    });
  }

  /**
   * Fire a manual run and wait for its terminal row: the dispatch resolves an
   * execution before it routes, so the row is the only honest signal.
   *
   * @param service - The scheduler under test.
   * @param taskId - The task to fire.
   */
  async function runToCompletion(service: TaskSchedulerService, taskId: string): Promise<TaskRun> {
    const run = await service.triggerManualRun(taskId);
    await waitFor(() => expect(isTerminalRunStatus(store.getRun(run!.id)!.status)).toBe(true));
    return store.getRun(run!.id)!;
  }

  return { managers, runtimesWith, scheduler, runToCompletion };
}

/** What {@link runtimeHarness} hands a test. */
export type RuntimeHarness = ReturnType<typeof runtimeHarness>;

/**
 * Write an agent whose manifest names a runtime (codex) and a model, under a
 * chosen workspace binding, and return its directory.
 *
 * @param workspace - The binding the manifest declares.
 */
export async function writeAgentHome(workspace: AgentManifest['workspace']): Promise<string> {
  const dir = path.join(
    await realpath(tmpdir()),
    `sched-agent-${Math.random().toString(36).slice(2)}`
  );
  await mkdir(dir, { recursive: true });
  await writeManifest(dir, {
    workspace,
    id: 'scheduler-fixture',
    name: 'scheduler-fixture',
    description: '',
    runtime: 'codex',
    model: 'gpt-5.5',
    capabilities: [],
    behavior: { responseMode: 'always' },
    registeredAt: new Date().toISOString(),
    registeredBy: 'test',
    personaEnabled: true,
    mcpServers: [],
  } as AgentManifest);
  return dir;
}

/** A mesh that resolves every agent id to one directory. */
export function meshAt(dir: string): MeshCore {
  return { getProjectPath: () => dir } as unknown as MeshCore;
}

/** A relay that can serve every runtime asked of it. */
export const HOLDS_EVERYTHING: RelayRuntimePredicate = () => RELAY_DISPATCH_OK;

/**
 * A relay that can serve exactly these runtimes and refuses the rest by name.
 *
 * @param types - The runtimes on the bus.
 */
export function holdsOnly(...types: string[]): RelayRuntimePredicate {
  return (runtimeType) =>
    types.includes(runtimeType)
      ? RELAY_DISPATCH_OK
      : { deliverable: false, reason: 'runtime-not-on-bus' };
}
