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

describe('original handoff admission clock', () => {
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

  it('publishes the original admission deadline for every accepted queued draft', async () => {
    const acceptedAt = Date.now();
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(await handOff(`draft-${i}`));
    for (const id of ids) {
      expect(await statusOf(id)).toMatchObject({
        status: 'pending',
        waitEndsAt: new Date(acceptedAt + 60 * 60_000).toISOString(),
      });
    }
  });

  it('expires the fifth waiting draft while the first model turn still owns the seat', async () => {
    await handOff('first-held');
    await reached(() => entered.length === 1, 'first runner held');
    const active = service.activeTurn(room.id, bo);
    expect(active).toBeDefined();
    const waiting = [];
    for (let i = 2; i <= 5; i++) waiting.push(await handOff(`waiting-${i}`));
    await vi.advanceTimersByTimeAsync(60 * 60_000 - 1);
    expect((await statusOf(waiting[3])).status).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    for (const id of waiting) expect((await statusOf(id)).status).toBe('declined');
    expect(entered).toHaveLength(1);
    expect(service.activeTurn(room.id, bo)).toEqual(active);
    expect(
      store.listEntries(room.id, { limit: 20 }).filter((entry) => entry.authorId === bo)
    ).toHaveLength(0);
  });

  it('preserves staggered acceptance deadlines instead of restarting them on promotion', async () => {
    await handOff('held');
    await reached(() => entered.length === 1, 'held turn');
    await vi.advanceTimersByTimeAsync(30_000);
    const nextAt = Date.now();
    const next = await handOff('next');
    await vi.advanceTimersByTimeAsync(30_000);
    const lastAt = Date.now();
    const last = await handOff('last');
    expect(await statusOf(next)).toMatchObject({
      status: 'pending',
      waitEndsAt: new Date(nextAt + 60 * 60_000).toISOString(),
    });
    expect(await statusOf(last)).toMatchObject({
      status: 'pending',
      waitEndsAt: new Date(lastAt + 60 * 60_000).toISOString(),
    });
    await vi.advanceTimersByTimeAsync(nextAt + 60 * 60_000 - Date.now());
    expect((await statusOf(next)).status).toBe('declined');
    expect((await statusOf(last)).status).toBe('pending');
    releaseFirst();
    await service.handoffs.idle();
    expect(entered).toHaveLength(2);
    expect(entered[1]).toContain('last');
    expect((await statusOf(last)).status).toBe('posted');
  });

  it('does not start an expired draft when the seat releases at its exact deadline', async () => {
    await handOff('held');
    await reached(() => entered.length === 1, 'held turn');
    const deadline = Date.now() + 60 * 60_000;
    const next = await handOff('must-not-run');
    // Move wall time without firing the independent expiry timer: promotion must refuse too.
    vi.setSystemTime(deadline);
    releaseFirst();
    await service.handoffs.idle();
    expect((await statusOf(next)).status).toBe('declined');
    expect(entered).toHaveLength(1);
  });

  it('runs the next unexpired draft in FIFO order after an early release', async () => {
    await handOff('fifo-first');
    await reached(() => entered.length === 1, 'held turn');
    const second = await handOff('fifo-second');
    const third = await handOff('fifo-third');
    await vi.advanceTimersByTimeAsync(60_000);
    releaseFirst();
    await service.handoffs.idle();
    expect(entered).toHaveLength(3);
    expect(entered[1]).toContain('fifo-second');
    expect(entered[2]).toContain('fifo-third');
    const entries = store.listEntries(room.id, { limit: 20 });
    for (const id of [second, third]) {
      const status = await statusOf(id);
      expect(status.status).toBe('posted');
      expect(entries.find((entry) => entry.id === status.entryId)?.authorId).toBe(bo);
    }
  });

  it('keeps a deadline decline terminal after late releases and isolates its status by author', async () => {
    await handOff('held');
    await reached(() => entered.length === 1, 'held turn');
    const expired = await handOff('expired');
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    const terminal = await statusOf(expired);
    expect(terminal.status).toBe('declined');
    expect((await statusOf(expired, 'cy')).status).toBe('unknown');
    releaseFirst();
    await service.handoffs.idle();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await statusOf(expired)).toEqual(terminal);
    expect(entered).toHaveLength(1);
  });
});
