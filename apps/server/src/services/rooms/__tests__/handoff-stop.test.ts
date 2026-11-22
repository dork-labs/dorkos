import type { RoomHarness } from './room-test-harness.js';
/**
 * A hand-off can always be read by its id (DOR-3778). On 2026-11-03 a room chat holding a background
 * shell refused every hand-off turn as busy for up to an hour, and the sender could see nothing:
 * `handedOff: true`, then silence. Driven through the real registry, service and dispatcher, like
 * `room-handoff.test.ts`; only the turn runner stands in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RoomWithRoster } from '@dorkos/shared/room-schemas';
import type { CapabilityRegistry } from '../../core/capabilities/index.js';
import type { AgentIdentity } from '../../core/agent-identity/index.js';
import type { RoomService } from '../room-service.js';
import type { RoomStore } from '../room-store.js';
import type { ScriptedTurnRunner } from './room-test-harness.js';

const identityOf = (name: string): AgentIdentity => ({
  agentPath: `/agents/${name}`,
  displayName: name,
  createdAt: new Date().toISOString(),
});

interface PostResult {
  posted: boolean;
  handoffId?: string;
  reason?: string;
}

interface HandoffStatus {
  status: 'pending' | 'posted' | 'declined' | 'unknown';
  waiting?: string;
  waitEndsAt?: string;
  reason?: string;
  entryId?: string;
}

describe('owned handoff shutdown', () => {
  let temporaryHome: string;
  let closeDatabase: (() => void) | undefined;
  let service: RoomService;
  let store: RoomStore;
  let registry: CapabilityRegistry;
  let durableHarness: RoomHarness;
  let room: RoomWithRoster;
  let bo: string;
  let releaseFirst: () => void;
  let entered: string[];
  let firstGate: Promise<void>;
  let setRoomService: (typeof import('../index.js'))['setRoomService'];
  let stopAgentMessageServices: (typeof import('../../../startup/stop-agent-messages.js'))['stopAgentMessageServices'];
  let resetPermissionGate:
    | (typeof import('../../core/capabilities/permission-enforcement.js'))['resetPermissionGate']
    | undefined;
  let clearSeatRoutes: (() => void) | undefined;
  let ownedService: RoomService | undefined;
  let setupPromise: Promise<void> | undefined;
  let closing = false;
  let timersStarted = false;

  async function invoke(id: string, input: Record<string, unknown>, sessionId: string, as = 'bo') {
    if (id === 'rooms.post') {
      const { recordFixturePublicSource } = await import('./durable-handoff-fixture.js');
      await recordFixturePublicSource(
        durableHarness,
        sessionId,
        `/agents/${as}`,
        input.roomId as string
      );
    }
    return registry.invoke(id, input, {
      identity: identityOf(as),
      sessionId,
      retryChannel: 'mcp-argument',
    });
  }
  async function handOff(text: string): Promise<string> {
    const result = (await invoke(
      'rooms.post',
      { roomId: room.id, text },
      'bo-other-chat'
    )) as PostResult;
    expect(result.handoffId).toEqual(expect.any(String));
    return result.handoffId!;
  }
  function statusOf(id: string, as = 'bo'): Promise<HandoffStatus> {
    return invoke(
      'rooms.handoff_status',
      { handoffId: id },
      `${as}-other-chat`,
      as
    ) as Promise<HandoffStatus>;
  }
  async function reached(predicate: () => boolean, description: string): Promise<void> {
    // Flush bounded asynchronous dispatch work without moving the admission clock.
    for (let i = 0; i < 2000; i++) {
      if (predicate()) return;
      await Promise.resolve();
    }
    throw new Error(`Dispatch did not reach: ${description}`);
  }
  beforeEach(() => {
    closing = false;
    timersStarted = false;
    ownedService = undefined;
    closeDatabase = undefined;
    clearSeatRoutes = undefined;
    resetPermissionGate = undefined;
    setupPromise = undefined;
    entered = [];
    // Own the real runner release before any cold import can time out.
    firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    vi.resetModules();
    temporaryHome = mkdtempSync(join(tmpdir(), 'handoff-clock-'));
    vi.stubEnv('DORK_HOME', temporaryHome);
    setupPromise = (async () => {
      // Keep the original serial app-import order: these roots share cyclic schema
      // dependencies that must finish evaluating before the next root is requested.
      const permission = await import('../../core/capabilities/permission-enforcement.js');
      resetPermissionGate = permission.resetPermissionGate;
      if (closing) return;
      const { composeRegistry } = await import('../../core/capabilities/index.js');
      if (closing) return;
      const { roomsDomain } = await import('../room-capabilities.js');
      if (closing) return;
      const { resetFreshnessForTests } = await import('../messages/room-freshness.js');
      if (closing) return;
      const { agentLookupFor, createRoomHarness, roomVoice } =
        await import('./room-test-harness.js');
      if (closing) return;
      const { mockInterruptReceipt } = await import('@dorkos/test-utils');
      if (closing) return;
      const roomModule = await import('../index.js');
      if (closing) return;
      const messaging = await import('../../../startup/stop-agent-messages.js');
      if (closing) return;
      const seatRoutes = await import('../../session/chat-messages/chat-message-current.js');
      clearSeatRoutes = () => {
        try {
          seatRoutes.setRoomSeatReports(undefined);
        } finally {
          seatRoutes.disposeRoomSeatMessages();
        }
      };
      // Vitest timing out a hook does not cancel its promise. A late import must
      // never resume setup after teardown has started.
      if (closing) return;
      // The harness already loaded this factory. Keep it after the original nine roots.
      const { createTestDb } = await import('@dorkos/test-utils/db');
      if (closing) return;
      setRoomService = roomModule.setRoomService;
      stopAgentMessageServices = messaging.stopAgentMessageServices;
      const agents = agentLookupFor({
        '/agents/bo': { name: 'bo', displayName: 'Bo', responseMode: 'mention-only' },
        '/agents/cy': { name: 'cy', displayName: 'Cy', responseMode: 'mention-only' },
      });
      // Inject the supported permission sources; do not replace registry or room policy modules.
      permission.initPermissionGate({
        readConfig: () => ({ preset: 'trusted', defaults: { areas: {}, actions: {} } }),
        readAgentPermissions: async () => undefined,
      });
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      timersStarted = true;
      vi.setSystemTime(new Date('2026-11-16T12:00:00.000Z'));
      resetFreshnessForTests();
      const runner: ScriptedTurnRunner = {
        turns: [],
        interrupted: [],
        ...roomVoice(),
        interrupt: () => Promise.resolve(mockInterruptReceipt('not-running')),
        async run(request) {
          const sessionId = request.sessionId ?? 'bo-seat';
          request.onSessionBound(sessionId);
          if (!request.prompt.includes('BEGIN HANDED-OFF DRAFT')) return { sessionId, text: null };
          entered.push(request.prompt);
          if (entered.length === 1) await firstGate;
          await invoke(
            'rooms.post',
            { roomId: room.id, text: `seat answer ${entered.length}`, confirm: true },
            sessionId
          );
          return { sessionId, text: null };
        },
      };
      // Register DB ownership before a later harness constructor or registration can fail.
      const db = createTestDb();
      closeDatabase = () => db.$client.close();
      const harness = createRoomHarness({ db, agents, runner, operatorName: () => 'Casey' });
      ownedService = harness.service;
      durableHarness = harness;
      service = harness.service;
      service.handoffs.initializeDurable(() => {});
      ({ service, store } = harness);
      registry = composeRegistry([roomsDomain], {
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        roomDeps: { rooms: service },
      });
      room = service.createRoom(
        { kind: 'channel', title: 'clock', members: [], agentPaths: ['/agents/bo', '/agents/cy'] },
        harness.human
      );
      bo = harness.authors.resolveAgent('/agents/bo', 'Bo').id;
      store.bindRoomSession(room.id, bo, 'bo-seat', new Date().toISOString());
      service.post(room.id, { authorId: harness.human, text: 'morning' });
    })();
    return setupPromise;
  });
  afterEach(async () => {
    closing = true;
    const errors: unknown[] = [];
    const clean = (action: () => void) => {
      try {
        action();
      } catch (error) {
        errors.push(error);
      }
    };
    try {
      // setupPromise owns the single active import and its late continuation. Keep the
      // profile until it settles; closing prevents the next serial import from starting.
      // A setup rejection is already reported by beforeEach, not hidden as a cleanup failure.
      await setupPromise?.catch(() => undefined);
      clean(() => releaseFirst?.());
      clean(() => ownedService?.dispose());
      if (timersStarted) {
        try {
          await vi.advanceTimersByTimeAsync(0);
        } catch (error) {
          errors.push(error);
        }
      }
      const drains = await Promise.allSettled([
        Promise.resolve().then(() => ownedService?.triggersIdle()),
        Promise.resolve().then(() => ownedService?.handoffs.idle()),
      ]);
      for (const result of drains) {
        if (result.status === 'rejected') errors.push(result.reason);
      }
    } finally {
      // One cleanup error cannot skip another owned resource. No await separates
      // closing SQLite from discarding its singleton/listener generation.
      clean(() => clearSeatRoutes?.());
      clean(() => resetPermissionGate?.());
      clean(() => vi.useRealTimers());
      clean(() => vi.restoreAllMocks());
      clean(() => closeDatabase?.());
      clean(() => vi.resetModules());
      clean(() => vi.unstubAllEnvs());
      clean(() => {
        if (temporaryHome) rmSync(temporaryHome, { recursive: true, force: true });
      });
    }
    if (errors.length > 0) throw new AggregateError(errors, 'Handoff fixture cleanup failed');
  });

  it('preserves durable queued drafts on process stop without cancelling a model turn that already started', async () => {
    const active = await handOff('active model');
    await reached(() => entered.length === 1, 'actual model turn');
    const queued = await handOff('queued draft');
    setRoomService(service);
    stopAgentMessageServices();
    expect((await statusOf(queued)).status).toBe('pending');
    expect((await statusOf(active)).status).toBe('pending');
    expect(service.activeTurn(room.id, bo)).toBeDefined();
    const rejected = (await invoke(
      'rooms.post',
      { roomId: room.id, text: 'after stop' },
      'bo-other-chat'
    )) as PostResult;
    expect(rejected.handoffId).toBeUndefined();
    releaseFirst();
    await service.handoffs.idle();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(entered).toHaveLength(1);
    expect((await statusOf(queued)).status).toBe('declined');
    expect((await statusOf(active)).status).toBe('posted');
  });
});
