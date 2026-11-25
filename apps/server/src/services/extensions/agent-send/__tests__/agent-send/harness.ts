/**
 * `ctx.agent.send` end to end below the extension boundary (DOR-2683, DOR-5232):
 * the agent-send seam driving the REAL turn port (space face, admission, the
 * `start_turn` effect and its worker, the computer face) and the REAL
 * dispatcher over real SQLite, with a fake runtime standing in for the agent.
 *
 * The launch path under the computer face (`dispatchSessionMessage`: runtime
 * binding, workspaces, the cap counter) is replaced by a thin stand-in that
 * hands the run straight to `dispatchMessage`, and admission reads the launch
 * cap off a switch, so every rule these cases pin (a busy chat makes the
 * message wait, the run carries the receipt's words) is the port's and the
 * dispatcher's own behaviour, not a mock's.
 *
 * This module holds that setup for the agent-send suites.
 */
import { afterEach, beforeEach, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { Db } from '@dorkos/db';
import type { StreamEvent } from '@dorkos/shared/types';
import type { AgentDeliveryEvent } from '@dorkos/extension-api/server';

// The neutral context bag is assembled off the real filesystem (git status);
// these cases care about delivery, not context.
vi.mock('../../../../session/context-assembler.js', () => ({
  assembleAdditionalContext: vi.fn(async () => []),
}));

import {
  dispatchMessage,
  isTurnInFlight,
  resetMessageDispatcher,
} from '../../../../session/message-dispatcher.js';
import {
  MessageQueueStore,
  setMessageQueueStore,
} from '../../../../session/message-queue-store.js';

import {
  disposeProjector,
  getOrCreateProjector,
} from '../../../../session/session-state-projector.js';
import type {
  DispatchSessionMessageOpts,
  DispatchSessionMessageResult,
} from '../../../../session/launch/launch-session.js';
import { createComputerTurnPort } from '../../../../session/turn-port/computer-turn-port.js';
import {
  getRunRecord,
  installRunRecord,
  startRunEffects,
  uninstallRunRecord,
} from '../../../../runs/index.js';
import { AgentSendStore } from '../../agent-send-store.js';
import { AgentSendService, type SessionFacts } from '../../agent-send.js';

export const EXT = 'flow-dashboard';
export const PERSON = 'window-a';

/** What each test runs against, rebuilt before every test. */
export const h = {
  db: undefined as unknown as Db,
  queue: undefined as unknown as MessageQueueStore,
  store: undefined as unknown as AgentSendStore,
  runtime: undefined as unknown as FakeAgentRuntime,
  service: undefined as unknown as AgentSendService,
  session: '',
  counter: 0,
  gates: [] as Array<() => void>,
  projectors: [] as string[],
  events: [] as AgentDeliveryEvent[],
  dispatched: [] as DispatchSessionMessageOpts[],
  /** Every launch slot under `runtimes.maxAgentChats` taken: admission makes messages wait. */
  capFull: false,
  /** The extension's own start limits refuse a new kept chat: the message is held. */
  limitFull: false,
  /** Set to refuse the next launch at the door, as the real launch path can. */
  refuse: undefined as DispatchSessionMessageResult | undefined,
  sessions: new Map<string, SessionFacts>(),
  agents: new Map<string, string>(),
  reserved: [] as string[],
};

export function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  h.gates.push(open);
  return { wait, open };
}

/** A turn that streams a token, parks on `hold`, then ends cleanly. */
export function heldTurn(hold: Promise<void>) {
  return async function* (): AsyncGenerator<StreamEvent> {
    yield { type: 'text_delta', data: { text: 'working' } } as StreamEvent;
    await hold;
    yield { type: 'done', data: {} } as StreamEvent;
  };
}

/** A turn that ends at once. */
export function quickTurn() {
  return async function* (): AsyncGenerator<StreamEvent> {
    yield { type: 'done', data: {} } as StreamEvent;
  };
}

export async function settle(): Promise<void> {
  // The outbox's worker wakes on a timer, then the hand-over and the turn
  // each take a few ticks of their own.
  for (let round = 0; round < 4; round++) {
    for (let i = 0; i < 8; i++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export function projectorFor(id: string) {
  if (!h.projectors.includes(id)) h.projectors.push(id);
  return getOrCreateProjector(id);
}

/** What DorkOS knows about a bound chat, with the parts a case does not care about filled in. */
export function chat(facts: Partial<SessionFacts> = {}): SessionFacts {
  return {
    bound: true,
    launchOrigin: 'interactive',
    agentPath: null,
    startedByExtension: null,
    roomBound: false,
    ...facts,
  };
}

/** The launch path under the computer face, reduced to the dispatcher. */
export async function fakeLaunch(
  opts: DispatchSessionMessageOpts
): Promise<DispatchSessionMessageResult> {
  h.dispatched.push(opts);
  if (h.refuse) return h.refuse;
  // A new chat is bound by its first launch, as the real launch path does.
  if (!h.sessions.has(opts.sessionId)) {
    h.sessions.set(
      opts.sessionId,
      chat({ launchOrigin: opts.origin.kind, agentPath: opts.request.agentPath ?? null })
    );
  }
  return dispatchMessage({
    origin: opts.origin,
    sessionId: opts.sessionId,
    clientId: opts.clientId,
    content: opts.request.content,
    ...(opts.messageId !== undefined ? { messageId: opts.messageId } : {}),
    ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
    ...(opts.wordsAtSource ? { wordsAtSource: true as const } : {}),
    projector: projectorFor(opts.sessionId),
    runtime: h.runtime,
  });
}

/** The run of a message, by the message id its receipt carried. */
export function runOfMessage(messageId: string) {
  return getRunRecord()!
    .port.list(h.store.get(messageId)?.sessionId ?? h.session)
    .find((run) => run.sourceRef === `extension-send:${messageId}`);
}

/** Install the run record, its worker and the computer face, as a boot does. */
export function bootTurnPort(opts: { epoch?: string; now?: () => number } = {}): void {
  const computer = createComputerTurnPort({
    meshCore: () => ({
      getProjectPath: (id: string) => h.agents.get(id),
      listWithPaths: () =>
        [...h.agents].map(([id, projectPath]) => ({ id, name: id, projectPath })) as never,
    }),
    roomSessionPlace: () => undefined,
    dispatch: fakeLaunch,
  });
  installRunRecord(h.db, {
    epoch: opts.epoch ?? '01BOOTEPOCHAGENTSEND000000',
    ...(opts.now ? { now: opts.now } : {}),
    computer: () => computer,
    admission: { admission: { isPaused: () => false, machineFull: () => h.capFull } },
  });
  startRunEffects();
}

/** A person's own turn, holding the chat until `hold` opens. */
export async function personTurn(hold: Promise<void>, extra: Record<string, unknown> = {}) {
  h.runtime.withScenarios([heldTurn(hold), quickTurn(), quickTurn()]);
  await dispatchMessage({
    origin: { kind: 'interactive' },
    sessionId: h.session,
    clientId: PERSON,
    content: 'the person is working',
    projector: projectorFor(h.session),
    runtime: h.runtime,
    ...extra,
  });
  await settle();
}

export function build(overrides: Partial<ConstructorParameters<typeof AgentSendService>[0]> = {}) {
  return new AgentSendService({
    store: h.store,
    extensionName: () => 'Flow Dashboard',
    meshCore: () => ({
      get: ((id: string) => (h.agents.has(id) ? { id } : undefined)) as never,
      getProjectPath: (id: string) => h.agents.get(id),
      listWithPaths: () =>
        [...h.agents].map(([id, projectPath]) => ({ id, name: id, projectPath })),
    }),
    describeSession: async (id) => h.sessions.get(id) ?? chat({ bound: false, launchOrigin: null }),
    sessionCwd: async () => '/work/project',
    reserveChat: (_ext, id) => {
      if (h.limitFull) return { ok: false, message: 'Flow Dashboard started a lot of chats.' };
      h.reserved.push(id);
      return { ok: true, reservation: { settle() {}, cancel() {}, rekey() {} } };
    },
    port: () => getRunRecord()?.port,
    nonce: () => 'abcd1234',
    ...overrides,
  });
}

/** Whether a chat has a turn in flight, as the dispatcher sees it. */
export function busy(sessionId: string): boolean {
  return isTurnInFlight(sessionId, h.runtime);
}

beforeEach(async () => {
  h.counter += 1;
  h.session = `00000000-0000-4000-8000-${String(h.counter).padStart(12, '0')}`;
  h.gates = [];
  h.projectors = [];
  h.events = [];
  h.dispatched = [];
  h.reserved = [];
  h.capFull = false;
  h.limitFull = false;
  h.refuse = undefined;
  h.agents = new Map();
  h.sessions = new Map([[h.session, chat()]]);
  h.db = createTestDb();
  h.queue = new MessageQueueStore(h.db);
  setMessageQueueStore(h.queue);
  h.store = new AgentSendStore(h.db);
  h.runtime = new FakeAgentRuntime();
  h.runtime.getInternalSessionId.mockReturnValue(undefined);
  bootTurnPort();
  h.service = build();
  await h.service.start();
  h.service.subscribe(EXT, (event) => h.events.push(event));
});

afterEach(async () => {
  vi.useRealTimers();
  h.service.stop();
  for (const open of h.gates) open();
  await settle();
  resetMessageDispatcher();
  uninstallRunRecord();
  setMessageQueueStore(undefined);
  for (const id of h.projectors) disposeProjector(id);
  vi.restoreAllMocks();
});
