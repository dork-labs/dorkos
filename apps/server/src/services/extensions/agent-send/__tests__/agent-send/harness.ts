/**
 * `ctx.agent.send` end to end below the extension boundary (DOR-2683): the
 * agent-send seam driving the REAL dispatcher over a real SQLite queue, with a
 * fake runtime standing in for the agent.
 *
 * The launch path above the dispatcher (`dispatchSessionMessage`: runtime
 * binding, workspaces, the cap counter) is replaced by a thin stand-in that
 * hands the message straight to `dispatchMessage`, so every rule these cases
 * pin — a busy chat holds, the receipt and the turn share one id — is the
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
  adoptQueuedMessages,
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
  capFull: false,
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
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
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

/** When set, every dispatch waits on it first: a send or retry caught mid-flight. */
export const dispatchHooks = {
  dispatchGate: undefined as Promise<void> | undefined,
  /** The canonical id the next dispatch reports, when a case wants one that differs. */
  canonicalFor: undefined as ((sessionId: string) => string) | undefined,
};

/** The launch path, reduced to the dispatcher, with the cap as a switch. */
export async function fakeDispatch(
  opts: DispatchSessionMessageOpts
): Promise<DispatchSessionMessageResult> {
  h.dispatched.push(opts);
  if (dispatchHooks.dispatchGate) await dispatchHooks.dispatchGate;
  if (opts.countsTowardLaunchCap && h.capFull) {
    return { refused: 'LAUNCH_CAP_FULL', message: 'Too many spin-off chats are running.' };
  }
  // A new chat is bound by its first dispatch, as the real launch path does.
  if (!h.sessions.has(opts.sessionId)) {
    h.sessions.set(
      opts.sessionId,
      chat({ launchOrigin: opts.origin.kind, agentPath: opts.request.agentPath ?? null })
    );
  }
  const result = await dispatchMessage({
    origin: { kind: 'interactive' },
    sessionId: opts.sessionId,
    clientId: opts.clientId,
    content: opts.request.content,
    ...(opts.messageId !== undefined ? { messageId: opts.messageId } : {}),
    projector: projectorFor(opts.sessionId),
    runtime: h.runtime,
    ...(opts.onSettled ? { onSettled: opts.onSettled } : {}),
  });
  return dispatchHooks.canonicalFor
    ? { ...result, canonicalId: dispatchHooks.canonicalFor(opts.sessionId) }
    : result;
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
    isBusy: async (id) => isTurnInFlight(id, h.runtime),
    dispatch: fakeDispatch,
    reserveChat: (_ext, id) => {
      h.reserved.push(id);
      return { ok: true, reservation: { settle() {}, cancel() {}, rekey() {} } };
    },
    resumeQueue: async (id, cwd) => {
      adoptQueuedMessages({
        sessionId: id,
        projector: projectorFor(id),
        runtime: h.runtime,
        ...(cwd ? { cwd } : {}),
      });
    },
    nonce: () => 'abcd1234',
    ...overrides,
  });
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
  dispatchHooks.canonicalFor = undefined;
  dispatchHooks.dispatchGate = undefined;
  h.agents = new Map();
  h.sessions = new Map([[h.session, chat()]]);
  h.db = createTestDb();
  h.queue = new MessageQueueStore(h.db);
  setMessageQueueStore(h.queue);
  h.store = new AgentSendStore(h.db);
  h.runtime = new FakeAgentRuntime();
  h.runtime.getInternalSessionId.mockReturnValue(undefined);
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
  setMessageQueueStore(undefined);
  for (const id of h.projectors) disposeProjector(id);
  vi.restoreAllMocks();
});
