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
import {
  initPermissionGate,
  resetPermissionGate,
} from '../../core/capabilities/permission-enforcement.js';
import type { RoomWithRoster } from '@dorkos/shared/room-schemas';
import { mockInterruptReceipt } from '@dorkos/test-utils';
import { composeRegistry, type CapabilityRegistry } from '../../core/capabilities/index.js';
import type { AgentIdentity } from '../../core/agent-identity/index.js';
import { roomsDomain } from '../room-capabilities.js';
import { resetFreshnessForTests } from '../messages/room-freshness.js';
import type { RoomService } from '../room-service.js';
import type { RoomStore } from '../room-store.js';
import {
  agentLookupFor,
  createRoomHarness,
  roomVoice,
  type ScriptedTurnRunner,
} from './room-test-harness.js';

const agents = agentLookupFor({
  '/agents/bo': { name: 'bo', displayName: 'Bo', responseMode: 'mention-only' },
  '/agents/cy': { name: 'cy', displayName: 'Cy', responseMode: 'mention-only' },
});

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

describe('runtime busy at original admission deadline', () => {
  let temporaryHome: string;
  let closeDatabase: () => void;
  let service: RoomService;
  let store: RoomStore;
  let registry: CapabilityRegistry;
  let durableHarness: RoomHarness;
  let room: RoomWithRoster;
  let bo: string;
  let releaseFirst: () => void;
  let entered: string[];
  let firstGate: Promise<void>;
  let busyDeadline: number | undefined;

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
  beforeEach(() => {
    temporaryHome = mkdtempSync(join(tmpdir(), 'handoff-clock-'));
    vi.stubEnv('DORK_HOME', temporaryHome);
    // Inject the supported permission sources; do not replace registry or room policy modules.
    initPermissionGate({
      readConfig: () => ({ preset: 'trusted', defaults: { areas: {}, actions: {} } }),
      readAgentPermissions: async () => undefined,
    });
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date('2026-11-16T12:00:00.000Z'));
    resetFreshnessForTests();
    entered = [];
    busyDeadline = undefined;
    firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
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
        if (busyDeadline !== undefined) {
          vi.setSystemTime(busyDeadline);
          return { sessionId, text: null, unanswered: 'busy' as const };
        }
        if (entered.length === 1) await firstGate;
        await invoke(
          'rooms.post',
          { roomId: room.id, text: `seat answer ${entered.length}`, confirm: true },
          sessionId
        );
        return { sessionId, text: null };
      },
    };
    const harness = createRoomHarness({ agents, runner, operatorName: () => 'Casey' });
    durableHarness = harness;
    service = harness.service;
    service.handoffs.initializeDurable(() => {});
    ({ service, store } = harness);
    closeDatabase = () => harness.db.$client.close();
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
  });
  afterEach(async () => {
    // Also releases the active model when an intended RED aborts before its normal release.
    releaseFirst();
    try {
      await vi.advanceTimersByTimeAsync(0);
      await service.triggersIdle();
      await service.handoffs.idle();
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
      resetPermissionGate();
      vi.unstubAllEnvs();
      closeDatabase?.();
      if (temporaryHome) rmSync(temporaryHome, { recursive: true, force: true });
    }
  });

  it('uses deadline refusal when the runtime reports busy at the original deadline', async () => {
    busyDeadline = Date.now() + 60 * 60_000;
    const id = await handOff('runtime still holds background work');
    await service.handoffs.idle();
    const result = await statusOf(id);
    expect(result.status).toBe('declined');
    expect(result.reason).toContain('waited too long to start');
    expect(result.reason).not.toContain('hour');
    expect(entered).toHaveLength(1);
    expect(
      store.listEntries(room.id, { limit: 20 }).filter((entry) => entry.authorId === bo)
    ).toHaveLength(0);
  });
});
