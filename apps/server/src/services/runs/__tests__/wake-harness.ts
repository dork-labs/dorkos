/**
 * A boot of the run record for wake tests (spec `turns-survive-restarts` §6.3,
 * T7): the space face, the outbox's worker and the computer face over the real
 * launch path, dispatcher, projector and SQLite queue. The runtime underneath is
 * a `FakeAgentRuntime`, and the record's clock is injected so a test can let
 * every lease run out. `kill()` drops every in-memory object without a
 * shutdown path, as a dead process does; `boot()` builds the next process on
 * the same database.
 */
import { expect, vi } from 'vitest';
import { sessionMetadata, type Db } from '@dorkos/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { createTestDb } from '@dorkos/test-utils/db';
import type { StreamEvent } from '@dorkos/shared/types';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import {
  clearTestHomes,
  registerTestHomes,
} from '../../core/agent-identity/__tests__/agent-home-fixture.js';
import {
  resetMessageDispatcher,
  setQueuedChatCeilingResolver,
} from '../../session/message-dispatcher.js';
import { MessageQueueStore, setMessageQueueStore } from '../../session/message-queue-store.js';
import { disposeProjector } from '../../session/session-state-projector.js';
import {
  dispatchSessionMessage,
  type DispatchSessionMessageOpts,
} from '../../session/launch/launch-session.js';
import { createComputerTurnPort } from '../../session/turn-port/computer-turn-port.js';
import { getRunRecord, installRunRecord, uninstallRunRecord, type RunRecord } from '../index.js';
import { RUN_LEASE_MS } from '../run-store.js';
import { EFFECT_LEASE_MS } from '../effects/worker.js';

/** A turn that answers at once, noting what the agent read. */
export function quickTurn(answered: string[]) {
  return async function* (content: string): AsyncGenerator<StreamEvent> {
    answered.push(content);
    yield { type: 'text_delta', data: { text: 'reply' } };
    yield { type: 'done', data: {} };
  };
}

/** Let every pending microtask and timer-0 callback run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** What a wake test holds. */
export interface WakeHarness {
  readonly db: Db;
  readonly runtime: FakeAgentRuntime;
  readonly sessionId: string;
  readonly home: string;
  /** What each turn the runtime ran was given: what the agent really read. */
  readonly answered: string[];
  /** The record this process built. */
  record(): RunRecord;
  /** The injected clock, epoch ms. */
  now(): number;
  /** Move the clock on. */
  advance(ms: number): void;
  /**
   * When set, every hand-over to the launch path waits on it: a process can
   * die with a run handed over and no `turn_start` yet.
   */
  holdLaunches(gate: Promise<void> | undefined): void;
  /** One worker pass at the current clock, and everything it set going. */
  pass(): Promise<void>;
  /** Die: every in-memory object dropped, no shutdown path, every lease left to run out. */
  kill(): void;
  /** The next process, on the same database, once every lease of the last has run out. */
  boot(epoch: string): RunRecord;
  /** Tidy up after a test. */
  dispose(): Promise<void>;
}

/**
 * Build the harness and its first boot.
 *
 * @param opts.db - The database, when the test owns one (an approval's store on it too).
 * @param opts.epoch - The first boot's epoch.
 */
export function wakeHarness(opts: { db?: Db; epoch: string }): WakeHarness {
  const db = opts.db ?? createTestDb();
  const home = '/demo/agents/waker';
  const sessionId = crypto.randomUUID();
  const answered: string[] = [];
  let clock = Date.now();
  let gate: Promise<void> | undefined;
  const runtime = new FakeAgentRuntime('wake-demo').withScenarios(
    Array.from({ length: 6 }, () => quickTurn(answered))
  );
  runtime.getInternalSessionId.mockReturnValue(undefined);
  registerTestHomes([home]);
  setMessageQueueStore(new MessageQueueStore(db));
  runtimeRegistry.setDb(db);
  runtimeRegistry.register(runtime);
  runtimeRegistry.setDefault(runtime.type);
  setQueuedChatCeilingResolver(() => 'runtime-default');
  db.insert(sessionMetadata)
    .values({
      sessionId,
      runtime: runtime.type,
      agentPath: home,
      createdAt: new Date().toISOString(),
    })
    .onConflictDoNothing()
    .run();
  const launchPath = async (launch: DispatchSessionMessageOpts) => {
    if (gate) await gate;
    return dispatchSessionMessage(launch);
  };
  const boot = (epoch: string): RunRecord => {
    const computer = createComputerTurnPort({
      meshCore: () => undefined,
      roomSessionPlace: () => undefined,
      dispatch: launchPath,
    });
    installRunRecord(db, { epoch, now: () => clock, computer: () => computer });
    return getRunRecord()!;
  };
  boot(opts.epoch);
  return {
    db,
    runtime,
    sessionId,
    home,
    answered,
    record: () => getRunRecord()!,
    now: () => clock,
    advance: (ms) => {
      clock += ms;
    },
    holdLaunches: (next) => {
      gate = next;
    },
    async pass() {
      await getRunRecord()!.worker.runOnce();
      await settle();
    },
    kill() {
      resetMessageDispatcher();
      uninstallRunRecord();
      gate = undefined;
    },
    boot(epoch) {
      clock += Math.max(RUN_LEASE_MS, EFFECT_LEASE_MS) + 1;
      return boot(epoch);
    },
    async dispose() {
      await vi.waitFor(() => expect(runtime.isTurnOpen(sessionId)).toBe(false));
      await settle();
      setQueuedChatCeilingResolver(undefined);
      resetMessageDispatcher();
      uninstallRunRecord();
      setMessageQueueStore(undefined);
      disposeProjector(sessionId);
      clearTestHomes();
    },
  };
}
