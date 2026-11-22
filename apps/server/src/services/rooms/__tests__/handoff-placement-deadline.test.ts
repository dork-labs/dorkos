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
import { eq, sessionMetadata, roomTurnSpend } from '@dorkos/db';
import { RoomRepoStore } from '../repo/room-repo-store.js';
import { RoomWorktreeManager } from '../repo/room-worktree-manager.js';
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

describe('handoff deadline after awaited placement', () => {
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
  let placementEntered: boolean;
  let releasePlacement: () => void;
  let spendCount: () => number;

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
    placementEntered = false;
    let placement: RoomWorktreeManager | null = null;
    let release!: () => void;
    const placementGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    releasePlacement = release;
    class HeldPlacement extends RoomWorktreeManager {
      override async ensureWorktree(...args: Parameters<RoomWorktreeManager['ensureWorktree']>) {
        placementEntered = true;
        await placementGate;
        // Exercise the real ordinary non-project fallback after the controlled IO wait.
        return super.ensureWorktree(...args);
      }
    }
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
        if (entered.length === 1) await firstGate;
        await invoke(
          'rooms.post',
          { roomId: room.id, text: `seat answer ${entered.length}`, confirm: true },
          sessionId
        );
        return { sessionId, text: null };
      },
    };
    const harness = createRoomHarness({
      agents,
      runner,
      operatorName: () => 'Casey',
      worktrees: () => placement,
    });
    durableHarness = harness;
    service = harness.service;
    service.handoffs.initializeDurable(() => {});
    placement = new HeldPlacement({
      store: new RoomRepoStore(harness.db, temporaryHome),
      hasRepo: () => false,
      listStrandedWorktrees: async () => [],
      reapAfterDays: () => 14,
      busyAgentPaths: () => harness.service.listBusyAgentPaths(),
    });
    spendCount = () => harness.db.select().from(roomTurnSpend).all().length;
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
    releasePlacement();
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

  it('keeps a not-yet-started handoff queued at shutdown without model or budget effects', async () => {
    const id = await handOff('cancel during placement');
    await reached(() => placementEntered, 'held placement');
    service.dispose();
    expect(await statusOf(id)).toMatchObject({ status: 'pending', waiting: 'queued' });
    releaseFirst();
    releasePlacement();
    await service.handoffs.idle();
    expect(entered).toHaveLength(0);
    expect(spendCount()).toBe(0);
    expect(await statusOf(id)).toMatchObject({ status: 'pending', waiting: 'queued' });
  });
  it('refuses an original deadline reached during placement without budget or model effects', async () => {
    const acceptedAt = Date.now();
    const id = await handOff('expired during placement');
    await reached(() => placementEntered, 'real placement boundary entered');
    expect(entered).toHaveLength(0);
    expect(spendCount()).toBe(0);
    // No timer callback is needed; the actual final admission boundary owns this veto.
    vi.setSystemTime(acceptedAt + 60 * 60_000);
    releaseFirst();
    releasePlacement();
    await service.handoffs.idle();
    expect((await statusOf(id)).status).toBe('declined');
    expect(entered).toHaveLength(0);
    expect(spendCount()).toBe(0);
    expect(
      store.listEntries(room.id, { limit: 20 }).filter((entry) => entry.authorId === bo)
    ).toHaveLength(0);
  });

  it('refuses a changed source epoch after placement without a model or budget effect', async () => {
    const id = await handOff('source replaced during placement');
    await reached(() => placementEntered, 'held placement');
    durableHarness.db
      .update(sessionMetadata)
      .set({ createdAt: new Date(Date.now() + 1).toISOString() })
      .where(eq(sessionMetadata.sessionId, 'bo-other-chat'))
      .run();
    releaseFirst();
    releasePlacement();
    await service.handoffs.idle();
    expect((await statusOf(id)).status).toBe('declined');
    expect(entered).toHaveLength(0);
    expect(spendCount()).toBe(0);
  });

  it('admits an unexpired placement exactly once through the same real claim and budget', async () => {
    const acceptedAt = Date.now();
    const id = await handOff('unexpired placement');
    await reached(() => placementEntered, 'real placement boundary entered');
    expect(spendCount()).toBe(0);
    vi.setSystemTime(acceptedAt + 119_999);
    releaseFirst();
    releasePlacement();
    await service.handoffs.idle();
    expect((await statusOf(id)).status).toBe('posted');
    expect(entered).toHaveLength(1);
    expect(spendCount()).toBe(1);
  });
});
