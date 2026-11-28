/**
 * The Tier A restart harness (spec `turns-survive-restarts` §8): the run
 * record, its outbox, recovery and the launch gate over the real dispatcher,
 * launch path, projector, SQLite queue and notification pipeline. Only the
 * runtime underneath is a double (`FakeAgentRuntime`), and the clock the
 * record reads is injected.
 *
 * A boot that dies is a run record built over the same database under its
 * own epoch ({@link deadBoot}), which writes the record through its legal
 * moves only, as that boot's dispatcher would have. "Kill" drops every
 * in-memory object without any shutdown path and moves the clock past every
 * lease ({@link kill}); {@link boot} is the next process, which recovers
 * (§7.3) before its worker runs, as `after-listen.ts` orders it.
 */
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, vi } from 'vitest';
import { agents, sessionMetadata, type Db } from '@dorkos/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { createTestDb } from '@dorkos/test-utils/db';
import type { StreamEvent } from '@dorkos/shared/types';
import type { TurnOrigin } from '@dorkos/shared/turn-port';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import {
  clearTestHomes,
  registerTestHomes,
} from '../../core/agent-identity/__tests__/agent-home-fixture.js';
import {
  resetMessageDispatcher,
  setQueuedChatCeilingResolver,
} from '../../session/message-dispatcher.js';
import { onDispatchLifecycle } from '../../session/message-dispatcher/state.js';
import { reportLostChatMessage } from '../../session/chat-messages/chat-message-current.js';
import {
  getMessageQueueStore,
  MessageQueueStore,
  setMessageQueueStore,
} from '../../session/message-queue-store.js';
import { disposeProjector } from '../../session/session-state-projector.js';
import { createComputerTurnPort } from '../../session/turn-port/computer-turn-port.js';
import type { DispatchLifecycleEvent } from '../../session/message-dispatcher/types.js';
import { NotificationStore } from '../../notifications/notification-store.js';
import {
  NotificationService,
  setNotificationService,
} from '../../notifications/notification-service.js';
import { logger } from '../../../lib/logger.js';
import { initBoundary } from '../../../lib/boundary.js';
import {
  createRunRecord,
  getRunRecord,
  installRunRecord,
  recoverRuns,
  uninstallRunRecord,
  type RunRecord,
} from '../index.js';
import { RUN_LEASE_MS, type RunStore, type TurnRun } from '../run-store.js';
import { EFFECT_LEASE_MS } from '../effects/worker.js';
import type { BootFacts, RunRecoveryDeps } from '../recovery/run-recovery.js';

/**
 * A made-up agent, and a real folder for its home: a person's turn checks its
 * folder against the boundary, which resolves it on disk.
 */
export const AGENT = {
  id: '01KPRTAGENTVXD000000000000',
  home: realpathSync(mkdtempSync(join(tmpdir(), 'restart-porter-'))),
} as const;

/** The boot that dies, and the ones after it. */
export const DEAD_EPOCH = '01BOOTDEADAAAAAAAAAAAAAAAA';

/** One harness's state, reset before every case. */
export interface Harness {
  db: Db;
  now: number;
  sessionId: string;
  inner: FakeAgentRuntime;
  /** What each turn the runtime ran was given: what the agent really read. */
  answered: string[];
  /** The two restart capabilities the runtime declares (§7.2). */
  declares: { continuesInterruptedTurn: boolean; wakesForLostBackgroundWork: boolean };
  /** Every dispatch lifecycle event, as a sender's own path hears it. */
  lifecycle: DispatchLifecycleEvent[];
  /** Mini app starts whose words were let go (`WordSource.forget`). */
  forgotten: string[];
  /** When false, nothing is handed over: the computer face is not wired. */
  computerWired: boolean;
  /** How many boots have run, for their epochs. */
  boots: number;
  record: RunRecord | undefined;
  errors: { mock: { calls: unknown[][] } };
}

/** The current case's harness. */
export const h = {} as Harness;

/** Stops hearing the dispatcher's lifecycle. */
let stopListening: (() => void) | undefined;

/** A turn that answers at once. */
export async function* quick(content: string): AsyncGenerator<StreamEvent> {
  h.answered.push(content);
  yield { type: 'text_delta', data: { text: 'reply' } };
  yield { type: 'done', data: {} };
}

/** Let every pending microtask and timer-0 callback run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Build a fresh harness: one agent, one chat, an empty database. */
export async function setUpHarness(): Promise<void> {
  // A person's turn checks its folder against the boundary, as a server's does.
  await initBoundary(realpathSync(tmpdir()));
  h.db = createTestDb();
  h.now = Date.now();
  h.answered = [];
  h.lifecycle = [];
  h.forgotten = [];
  h.computerWired = true;
  h.boots = 0;
  h.record = undefined;
  h.declares = { continuesInterruptedTurn: true, wakesForLostBackgroundWork: false };
  const at = new Date().toISOString();
  h.db
    .insert(agents)
    .values({
      id: AGENT.id,
      name: 'porter',
      displayName: 'Porter',
      runtime: 'claude-code',
      projectPath: AGENT.home,
      registeredAt: at,
      updatedAt: at,
    })
    .run();
  registerTestHomes([AGENT.home]);
  setMessageQueueStore(new MessageQueueStore(h.db));
  setNotificationService(new NotificationService(new NotificationStore(h.db)));
  h.errors = vi.spyOn(logger, 'error');
  h.inner = new FakeAgentRuntime('restart-demo').withScenarios([quick, quick, quick, quick]);
  h.inner.getInternalSessionId.mockReturnValue(undefined);
  const base = h.inner.getCapabilities();
  h.inner.getCapabilities.mockImplementation(() => ({ ...base, ...h.declares }));
  runtimeRegistry.setDb(h.db);
  runtimeRegistry.register(h.inner);
  runtimeRegistry.setDefault(h.inner.type);
  h.sessionId = crypto.randomUUID();
  h.db
    .insert(sessionMetadata)
    .values({ sessionId: h.sessionId, runtime: h.inner.type, agentPath: AGENT.home, createdAt: at })
    .onConflictDoNothing()
    .run();
  setQueuedChatCeilingResolver(() => 'runtime-default');
  stopListening = onDispatchLifecycle((event) => h.lifecycle.push(event));
}

/** Tear the harness down; every case also proves the record never complained (§4.7). */
export async function tearDownHarness(opts: { complained?: boolean } = {}): Promise<void> {
  await settle();
  if (!opts.complained) expect(recordComplained()).toBe(false);
  stopListening?.();
  setQueuedChatCeilingResolver(undefined);
  resetMessageDispatcher();
  uninstallRunRecord();
  setMessageQueueStore(undefined);
  setNotificationService(null);
  disposeProjector(h.sessionId);
  clearTestHomes();
  vi.restoreAllMocks();
}

/** Whether the record ever complained (§4.7 rules i and ii). */
export function recordComplained(): boolean {
  return h.errors.mock.calls.some((call) => {
    const message = String(call[0]);
    return message.includes('[runs]') || message.includes('the run record refused');
  });
}

/** The boot that will die: a run record writing through legal moves, holding its runs. */
export function deadBoot(epoch = DEAD_EPOCH): RunRecord {
  return createRunRecord(h.db, { epoch, now: () => h.now, ownerHolds: () => true });
}

/** The process dies: no shutdown path runs, and every lease runs out. */
export function kill(): void {
  resetMessageDispatcher();
  uninstallRunRecord();
  disposeProjector(h.sessionId);
  h.now += Math.max(RUN_LEASE_MS, EFFECT_LEASE_MS) + 1;
}

/**
 * The next process: the run record over the same database, the computer face
 * over the real launch path, then recovery (§7.3), before any worker pass.
 *
 * @param facts - What this boot found beside the record.
 * @param opts.recover - False to leave recovery to the launch gate and the worker.
 * @param opts.recovery - What recovery reads, beside the runtimes' own declarations.
 */
export function boot(
  facts: BootFacts = {},
  opts: { recover?: boolean; recovery?: Pick<RunRecoveryDeps, 'settledElsewhere'> } = {}
): RunRecord {
  h.boots += 1;
  installRunRecord(h.db, {
    epoch: `01BOOTNEXT${String(h.boots).padStart(16, '0')}`,
    now: () => h.now,
    computer: () => (h.computerWired ? computerFace() : undefined),
    agentHome: () => (id) => (id === AGENT.id ? AGENT.home : undefined),
    admission: { admission: { pausedAgent: () => undefined, machineFull: () => false } },
    // As startup passes it: each runtime's own declaration, read per runtime.
    recovery: {
      capabilitiesOf: (type) =>
        runtimeRegistry.has(type) ? runtimeRegistry.get(type).getCapabilities() : undefined,
      cwdOf: () => AGENT.home,
      reportLost: reportLostChatMessage,
      ...opts.recovery,
    },
  });
  const record = getRunRecord()!;
  record.port.registerSource('demo-start', {
    read: () => 'from the app: sort the inbox',
    app: () => ({ extensionId: 'flow', name: 'Flow' }),
    forget: (id) => h.forgotten.push(id),
  });
  if (opts.recover !== false) recoverRuns(facts);
  h.record = record;
  return record;
}

/** One worker pass, as a wake runs it, and everything it set going. */
export async function pass(): Promise<void> {
  await h.record!.worker.runOnce();
  await settle();
}

/** The computer face over the real launch path, Mesh answering for the one agent. */
function computerFace() {
  return createComputerTurnPort({
    meshCore: () => ({
      getProjectPath: (id: string) => (id === AGENT.id ? AGENT.home : undefined),
      listWithPaths: () => [{ id: AGENT.id, name: 'porter', projectPath: AGENT.home }] as never,
    }),
    roomSessionPlace: () => undefined,
  });
}

/** What a dead run is made with. */
export interface DeadRunInput {
  origin?: TurnOrigin | null;
  /** Its words wait in a queue row (a composer's), kept `in_turn` once it started. */
  row?: string;
  /** Where the words wait when not in a row. */
  sourceRef?: string;
  chatKey?: string;
}

/**
 * A run the dying boot started: `started`, its words handed to the runtime and
 * not yet read. A composer's words stay in their row, out of line (`in_turn`).
 *
 * @param store - The dying boot's store.
 * @param input - Its origin, and where its words wait.
 */
export function startedRun(store: RunStore, input: DeadRunInput = {}): TurnRun {
  const chatKey = input.chatKey ?? h.sessionId;
  let queueMessageId: string | undefined;
  if (input.row !== undefined) {
    queueMessageId = getMessageQueueStore()!.enqueue({
      sessionId: chatKey,
      content: input.row,
      clientId: 'person-window',
    }).id;
  }
  let run = store.create({
    chatKey,
    status: 'queued',
    openedBy: 'caller',
    origin: input.origin === undefined ? { kind: 'interactive' } : input.origin,
    agentId: AGENT.id,
    ...(queueMessageId !== undefined ? { queueMessageId } : {}),
    ...(input.sourceRef !== undefined ? { sourceRef: input.sourceRef } : {}),
  });
  run = store.move(run, 'starting', store.lease());
  run = store.move(run, 'started', {
    runtime: h.inner.type,
    runtimeTurnRef: 3,
    startedAt: store.stamp(),
    ...store.lease(),
  });
  if (queueMessageId !== undefined) getMessageQueueStore()!.markInTurn(queueMessageId);
  return run;
}

/**
 * A run the dying boot had running: the runtime read its words (its row went).
 *
 * @param store - The dying boot's store.
 * @param input - Its origin and chat.
 */
export function runningRun(store: RunStore, input: DeadRunInput = {}): TurnRun {
  const run = startedRun(store, { ...input, row: undefined });
  return store.move(run, 'running', { deliveredAt: store.stamp() });
}
