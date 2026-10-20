/**
 * A chat turn started from Wi-Fi runs at the runtime's default at most
 * (DOR-3037): a message, a widget's action, a queued message after a restart
 * or after somebody on Wi-Fi rewords it, and a chat's mode only goes down.
 *
 * Driven over the real chat routes, the real dispatcher and a real SQLite
 * queue, against a runtime double whose `sendMessage` options are what the
 * runtime would hold the turn to.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import { FakeAgentRuntime } from '@dorkos/test-utils';

vi.mock('../../lib/boundary.js', () => ({
  validateBoundary: vi.fn(async (p: string) => p),
  validateBoundaryOrDorkHome: vi.fn(async (p: string) => p),
  getBoundary: vi.fn(() => '/mock/home'),
  initBoundary: vi.fn().mockResolvedValue('/mock/home'),
  isWithinBoundary: vi.fn().mockResolvedValue(true),
  boundaryRefusal: vi.fn(async () => undefined),
  BoundaryError: class BoundaryError extends Error {
    code = 'OUTSIDE';
  },
}));

let fakeRuntime: FakeAgentRuntime;
const storedMode = vi.hoisted(() => ({ value: null as string | null }));

vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    computerRuntimeForAgentPath: () => undefined,
    getNativeSessionCwd: vi.fn(() => null),
    getDefault: vi.fn(() => fakeRuntime),
    get: vi.fn(() => fakeRuntime),
    getAllCapabilities: vi.fn(() => ({})),
    getDefaultType: vi.fn(() => 'fake'),
    resolveForSession: vi.fn(async () => fakeRuntime),
    resolveForSessionWithOwnership: vi.fn(async () => ({ runtime: fakeRuntime, bound: true })),
    getSessionRuntimeType: vi.fn(async () => 'fake'),
    persistSessionRuntime: vi.fn(async () => {}),
    getSessionSettings: vi.fn(async () =>
      storedMode.value ? { permissionMode: storedMode.value } : null
    ),
    has: vi.fn(() => true),
  },
  RuntimeNotRegisteredError: class RuntimeNotRegisteredError extends Error {},
}));
vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));
vi.mock('@dorkos/shared/manifest', () => ({ readManifest: vi.fn(async () => null) }));

import request from '@dorkos/test-utils/supertest';
import { createTestDb } from '@dorkos/test-utils/db';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { markIngress } from '../../services/core/remote/ingress-mark.js';
import { createSessionRoutes } from '../sessions.js';
import { disposeProjector } from '../../services/session/session-state-projector.js';
import {
  MessageQueueStore,
  setMessageQueueStore,
} from '../../services/session/message-queue-store.js';
import { resetMessageDispatcher } from '../../services/session/message-dispatcher.js';
import {
  initSessionVisibility,
  resetSessionVisibility,
} from '../../services/audit/session-visibility.js';
import {
  clampClaudeMode,
  resolveModeDecision,
} from '../../services/runtimes/claude-code/turn-permission.js';
import { NOT_FROM_WIFI } from '../../services/core/auth/sessions/wifi-level.js';
import { WIFI_RAISE_REFUSAL } from '../../services/core/auth/sessions/wifi-raise-guard.js';

const SESSION_ID = '00000000-0000-4000-8000-0000000000e1';
const target = swappableServer();
let store: MessageQueueStore;

/** The chat routes, reached from Wi-Fi when the request says so. */
function app() {
  return target.mount(
    honoGroupListener(
      { path: '/api/sessions', routes: createSessionRoutes() },
      {
        before: async (c, next) => {
          if (c.req.header('x-test-via') === 'wifi') markIngress(c.env.incoming, 'wifi');
          c.set('user', { userId: 'owner', credential: 'cookie' });
          await next();
        },
      }
    )
  );
}

/** The options the runtime was handed for the turn that ran `content`. */
function optsFor(content: string) {
  return fakeRuntime.sendMessage.mock.calls.find((call) => call[1] === content)?.[2];
}

/** One turn that ends at once. */
async function* doneTurn(): AsyncGenerator<StreamEvent> {
  yield { type: 'done', data: {} } as StreamEvent;
}

beforeEach(() => {
  store = new MessageQueueStore(createTestDb());
  setMessageQueueStore(store);
  fakeRuntime = new FakeAgentRuntime();
  vi.clearAllMocks();
  storedMode.value = null;
  fakeRuntime.acquireLock.mockReturnValue(true);
  fakeRuntime.isLocked.mockReturnValue(false);
  fakeRuntime.getLockInfo.mockReturnValue(null);
  fakeRuntime.hasSession.mockReturnValue(true);
  fakeRuntime.getInternalSessionId.mockReturnValue(SESSION_ID);
  fakeRuntime.updateSession.mockResolvedValue({ updated: true } as never);
  fakeRuntime.getSession.mockResolvedValue(null);
  initSessionVisibility((ids) => new Map(ids.map((id) => [id, 'space'] as const)));
});

afterEach(() => {
  resetMessageDispatcher();
  setMessageQueueStore(undefined);
  disposeProjector(SESSION_ID);
  resetSessionVisibility();
});

describe('a message sent from Wi-Fi', () => {
  it('holds the turn to the runtime default, so a Full autonomy agent asks before Bash', async () => {
    fakeRuntime.withScenarios([doneTurn]);
    const res = await request(app())
      .post(`/api/sessions/${SESSION_ID}/messages`)
      .set('x-test-via', 'wifi')
      .send({ content: 'clean up the build folder' });
    expect(res.status).toBe(202);

    const ceiling = optsFor('clean up the build folder')?.permissionCeiling;
    expect(ceiling).toBe('runtime-default');
    // What Claude Code does with that ceiling on an agent set to Full
    // autonomy: the turn runs at Default, and a shell call raises a card.
    const mode = clampClaudeMode('bypassPermissions', ceiling!);
    expect(mode).toBe('default');
    expect(resolveModeDecision(mode as 'default')).toBe('ask');
  });

  it('leaves a message sent at this computer at the agent’s own level', async () => {
    fakeRuntime.withScenarios([doneTurn]);
    const res = await request(app())
      .post(`/api/sessions/${SESSION_ID}/messages`)
      .send({ content: 'clean up the build folder' });
    expect(res.status).toBe(202);
    expect(optsFor('clean up the build folder')?.permissionCeiling).toBeUndefined();
  });

  it('holds a widget action from Wi-Fi to the runtime default', async () => {
    fakeRuntime.withScenarios([doneTurn]);
    const res = await request(app())
      .post(`/api/sessions/${SESSION_ID}/ui-action`)
      .set('x-test-via', 'wifi')
      .send({ actionId: 'approve', label: 'Approve' });
    expect(res.status).toBe(202);
    const call = fakeRuntime.sendMessage.mock.calls.at(-1);
    expect(call?.[2]?.permissionCeiling).toBe('runtime-default');
  });
});

describe('a queued message', () => {
  it('keeps the hold after a restart, read from its row', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    fakeRuntime.withScenarios([
      async function* () {
        yield { type: 'text_delta', data: { text: 'working' } } as StreamEvent;
        await gate;
        yield { type: 'done', data: {} } as StreamEvent;
      },
      doneTurn,
      doneTurn,
    ]);
    await request(app())
      .post(`/api/sessions/${SESSION_ID}/messages`)
      .send({ content: 'the turn ahead' });
    // A row a previous process accepted from Wi-Fi: nothing in memory carries it.
    store.enqueue({
      sessionId: SESSION_ID,
      content: 'sent from the phone before the restart',
      clientId: 'phone',
      heldToDefault: true,
    });
    // Any dispatch adopts it; this one is from this computer.
    await request(app())
      .post(`/api/sessions/${SESSION_ID}/messages`)
      .send({ content: 'typed here after the restart' });
    release();
    await vi.waitFor(() => expect(optsFor('typed here after the restart')).toBeDefined());

    expect(optsFor('sent from the phone before the restart')?.permissionCeiling).toBe(
      'runtime-default'
    );
    expect(optsFor('typed here after the restart')?.permissionCeiling).toBeUndefined();
  });

  it('is held once somebody on Wi-Fi rewords it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    fakeRuntime.withScenarios([
      async function* () {
        yield { type: 'text_delta', data: { text: 'working' } } as StreamEvent;
        await gate;
        yield { type: 'done', data: {} } as StreamEvent;
      },
      doneTurn,
    ]);
    await request(app())
      .post(`/api/sessions/${SESSION_ID}/messages`)
      .send({ content: 'the turn ahead' });
    const queued = await request(app())
      .post(`/api/sessions/${SESSION_ID}/messages`)
      .send({ content: 'typed at this computer' });
    const edited = await request(app())
      .patch(`/api/sessions/${SESSION_ID}/queue/${queued.body.messageId}`)
      .set('x-test-via', 'wifi')
      .send({ content: 'reworded from the phone' });
    expect(edited.status).toBe(200);
    expect(store.get(queued.body.messageId)?.heldToDefault).toBe(true);
    release();
    await vi.waitFor(() => expect(optsFor('reworded from the phone')).toBeDefined());
    expect(optsFor('reworded from the phone')?.permissionCeiling).toBe('runtime-default');
  });
});

describe("a chat's permission mode from Wi-Fi", () => {
  it('refuses a raise and changes nothing', async () => {
    storedMode.value = 'default';
    const res = await request(app())
      .patch(`/api/sessions/${SESSION_ID}`)
      .set('x-test-via', 'wifi')
      .send({ permissionMode: 'bypassPermissions' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: WIFI_RAISE_REFUSAL, code: NOT_FROM_WIFI });
    expect(fakeRuntime.updateSession).not.toHaveBeenCalled();
  });

  it('takes a lower mode from Wi-Fi, and a raise at this computer', async () => {
    storedMode.value = 'bypassPermissions';
    const lower = await request(app())
      .patch(`/api/sessions/${SESSION_ID}`)
      .set('x-test-via', 'wifi')
      .send({ permissionMode: 'plan' });
    expect(lower.status).toBe(200);
    storedMode.value = 'default';
    const raise = await request(app())
      .patch(`/api/sessions/${SESSION_ID}`)
      .send({ permissionMode: 'bypassPermissions' });
    expect(raise.status).toBe(200);
  });
});
