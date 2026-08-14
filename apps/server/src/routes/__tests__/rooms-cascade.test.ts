/**
 * Cascade and budget behaviour measured THROUGH THE ROUTE.
 *
 * Every other cascade test calls `RoomService.post(roomId, { authorId })`
 * directly — after `resolveCaller` has already decided what kind of author this
 * is. That left the one seam an attacker uses as the one seam untested, and a
 * complete guard bypass lived behind it: with no `X-DorkOS-Agent` header, and
 * `auth.enabled` off by default, `resolveCaller` returns the LOCAL HUMAN. A
 * program on this machine drops one header and is the operator — 30 posts, 30
 * fresh cascade roots, 60 turns, max depth 0, every entry attributed to "You".
 *
 * These tests exist to pin what a HEADERLESS post is stamped with, so the next
 * change to caller resolution is measured here rather than reasoned about. They
 * assert the honest position, not a comfortable one: the cascade guard is
 * defeated by this move, and the turn budget is what holds.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { createTestDb } from '@dorkos/test-utils/db';
import { agents, type Db } from '@dorkos/db';
import { USER_CONFIG_DEFAULTS } from '@dorkos/shared/config-schema';
import type { RoomEntry } from '@dorkos/shared/room-schemas';

vi.mock('../../lib/boundary.js', () => ({
  validateBoundary: vi.fn(async (p: string) => p),
  validateBoundaryOrDorkHome: vi.fn(async (p: string) => p),
  getBoundary: vi.fn(() => '/mock/home'),
  initBoundary: vi.fn().mockResolvedValue('/mock/home'),
  isWithinBoundary: vi.fn().mockResolvedValue(true),
  BoundaryError: class BoundaryError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = 'BoundaryError';
      this.code = code;
    }
  },
}));

let fakeRuntime: FakeAgentRuntime;

vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getDefault: vi.fn(() => fakeRuntime),
    get: vi.fn(() => fakeRuntime),
    getAllCapabilities: vi.fn(() => ({})),
    getDefaultType: vi.fn(() => 'fake'),
    resolveForSession: vi.fn(async () => fakeRuntime),
    getSessionRuntimeType: vi.fn(async () => 'fake'),
    persistSessionRuntime: vi.fn(async () => {}),
    getSessionSettings: vi.fn(async () => null),
    has: vi.fn(() => true),
    listRuntimes: vi.fn(() => [fakeRuntime]),
  },
  RuntimeNotRegisteredError: class RuntimeNotRegisteredError extends Error {},
}));

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    // The shipped defaults for `rooms`, with ONE value moved: the collect window
    // (RP8) is zeroed. A room gathers a burst for half a second before it
    // answers, so thirty sequential posts would otherwise spend fifteen seconds
    // waiting out timers to measure something that has nothing to do with them.
    // Zero is the same gathering path, without the wait —
    // `room-collect.test.ts` is where the window's LENGTH is measured.
    // Everything else falls through to `null`, which is what the readers'
    // degrade-to-defaults path already handles.
    get: vi.fn((key: string) =>
      key === 'rooms' ? { ...USER_CONFIG_DEFAULTS.rooms, collectDebounceMs: 0 } : null
    ),
    set: vi.fn(),
  },
}));

import { createApp, finalizeApp } from '../../app.js';
import {
  createRoomSubsystem,
  getRoomService,
  setRoomService,
  RoomTurnBudget,
} from '../../services/rooms/index.js';
import { scriptedRunner } from '../../services/rooms/__tests__/room-test-harness.js';
import {
  initAgentIdentityService,
  resetAgentIdentityService,
} from '../../services/core/agent-identity/agent-identity-service.js';

const app = createApp();
finalizeApp(app);

const ANA_PATH = '/agents/ana';

/** Register an agent so `POST /:id/members` can resolve it by directory. */
function registerAna(db: Db): void {
  const now = new Date().toISOString();
  db.insert(agents)
    .values({
      id: 'ULID_ANA',
      name: 'ana',
      displayName: 'Ana',
      runtime: 'claude-code',
      projectPath: ANA_PATH,
      behaviorJson: '{"responseMode":"always"}',
      registeredAt: now,
      updatedAt: now,
    })
    .run();
}

describe('/api/rooms — what a headerless caller gets', () => {
  let db: Db;
  let runner: ReturnType<typeof scriptedRunner>;
  let perRoomCap = 1_000;
  let globalCap = 100_000;

  /** Register a second agent, so a room can hold two of them. */
  function registerBo(database: Db): void {
    const now = new Date().toISOString();
    database
      .insert(agents)
      .values({
        id: 'ULID_BO',
        name: 'bo',
        displayName: 'Bo',
        runtime: 'claude-code',
        projectPath: '/agents/bo',
        behaviorJson: '{"responseMode":"always"}',
        registeredAt: now,
        updatedAt: now,
      })
      .run();
  }

  /** Wire the subsystem with a scripted runner and pinned budgets. */
  function wire(perRoom: number, global = 100_000): void {
    runner = scriptedRunner(() => null);
    perRoomCap = perRoom;
    globalCap = global;
    setRoomService(
      createRoomSubsystem({
        db,
        turns: runner,
        // Read through the mutable locals, so a test can raise a cap mid-run the
        // way Settings does rather than rebuilding the service.
        budget: new RoomTurnBudget({
          db,
          limits: { perRoom: () => perRoomCap, global: () => globalCap },
        }),
      }).service
    );
  }

  /** Let the live budget spend again, so the notice re-arms on the next exhaustion. */
  function wireBudgetTo(_roomId: string): void {
    perRoomCap = 3;
  }

  /** A two-agent room where both answer everything, built headerless throughout. */
  async function loudRoom(): Promise<string> {
    const created = await request(app)
      .post('/api/rooms')
      .send({ kind: 'channel', title: 'Backend', agentPaths: ['/agents/ana', '/agents/bo'] });
    expect(created.status).toBe(201);
    for (const member of created.body.members) {
      if (member.author.kind !== 'agent') continue;
      const patched = await request(app)
        .patch(`/api/rooms/${created.body.id}/members/${member.authorId}`)
        .send({ responseMode: 'always' });
      expect(patched.status).toBe(200);
    }
    return created.body.id;
  }

  /** Post headerless and wait for whatever it set off. */
  async function post(roomId: string, text: string): Promise<void> {
    const res = await request(app).post(`/api/rooms/${roomId}/entries`).send({ text });
    expect(res.status).toBe(202);
    await getRoomService().triggersIdle();
  }

  /** The room's whole log, as the wire returns it. */
  async function entries(roomId: string): Promise<RoomEntry[]> {
    const res = await request(app).get(`/api/rooms/${roomId}/entries?limit=200`);
    return res.body.entries as RoomEntry[];
  }

  beforeEach(() => {
    fakeRuntime = new FakeAgentRuntime();
    vi.clearAllMocks();
    resetAgentIdentityService();
    db = createTestDb();
    registerAna(db);
    registerBo(db);
    wire(1_000);
  });

  afterEach(() => {
    resetAgentIdentityService();
  });

  it('stamps a headerless post as the local human, which is the whole exposure', async () => {
    const roomId = await loudRoom();
    await post(roomId, 'hello');

    const [first] = await entries(roomId);
    const human = getRoomService().authorRegistry.localHuman().id;
    // Not a bug being asserted as correct — a fact being pinned. With login off
    // there is nothing left to tell a local program from the person, so this is
    // what `resolveCaller` must return, and the budget below is what makes it
    // survivable.
    expect(first.authorId).toBe(human);
    expect(first.cascadeDepth).toBe(0);
  });

  it('lets a headerless caller through every operator-only gate', async () => {
    // Documenting the DOR-505 residual at the surface it actually reaches, so
    // that turning login ON has a test that changes behaviour to point at.
    const created = await request(app)
      .post('/api/rooms')
      .send({ kind: 'channel', title: 'Two agents', agentPaths: ['/agents/ana', '/agents/bo'] });
    expect(created.status).toBe(201);

    const agentMember = created.body.members.find(
      (m: { author: { kind: string } }) => m.author.kind === 'agent'
    );
    const patched = await request(app)
      .patch(`/api/rooms/${created.body.id}/members/${agentMember.authorId}`)
      .send({ responseMode: 'always' });
    expect(patched.status).toBe(200);
  });

  it('does not let a headerless caller outspend the room budget', async () => {
    // The attack, run end to end: 30 headerless posts into a two-agent `always`
    // room. Before the budget this was 60 turns and no refusal of any kind.
    wire(4);
    const roomId = await loudRoom();
    for (let i = 0; i < 30; i++) await post(roomId, `spam ${i}`);

    expect(runner.turns).toHaveLength(4);
    const notices = (await entries(roomId)).filter((e) => e.kind === 'notice');
    expect(notices).toHaveLength(1);
    expect(notices[0].body.notice).toBe('budget_reached');
  });

  it('keeps the budget per room, so one flooded room does not silence another', async () => {
    wire(2);
    const flooded = await loudRoom();
    for (let i = 0; i < 10; i++) await post(flooded, `spam ${i}`);
    expect(runner.turns).toHaveLength(2);

    const quiet = await request(app)
      .post('/api/rooms')
      .send({ kind: 'dm', title: 'Ana', agentPaths: ['/agents/ana'] });
    await post(quiet.body.id, 'are you there?');
    // Two from the flooded room's cap plus exactly one from the DM's single
    // agent. `toBeGreaterThan(2)` would also pass if the DM ran five turns,
    // which is the failure this test exists to notice.
    expect(runner.turns).toHaveLength(3);
  });

  it('mints ONE session when two posts land before the first reply', async () => {
    // Every other route test here is sequential — post, settle, post — which is
    // exactly why this survived. Fired without awaiting, both dispatches used to
    // read a null binding, both mint a UUID, and the second lose the
    // INSERT-OR-IGNORE race: a real session with its own projector and
    // `session_metadata` row, bound to nothing, whose reply was produced from an
    // empty context. Silently. Two messages in a row is the ordinary way there.
    const roomId = await loudRoom();

    await Promise.all([
      request(app).post(`/api/rooms/${roomId}/entries`).send({ text: 'first' }),
      request(app).post(`/api/rooms/${roomId}/entries`).send({ text: 'second' }),
    ]);
    await getRoomService().triggersIdle();

    const perAgent = new Map<string, Set<string>>();
    for (const turn of runner.turns) {
      const seen = perAgent.get(turn.authorId) ?? new Set<string>();
      seen.add(turn.sessionId ?? 'null');
      perAgent.set(turn.authorId, seen);
    }
    expect(perAgent.size).toBeGreaterThan(0);
    for (const [, sessions] of perAgent) {
      expect(sessions.size).toBe(1);
      expect(sessions.has('null')).toBe(false);
    }
  });

  it('bounds the wallet even though rooms are free', async () => {
    // The per-room cap alone is not a spend bound: a caller multiplies it by
    // creating rooms. 2/room across 8 channels bought 16 turns before the
    // global cap existed.
    wire(2, 5);
    for (let i = 0; i < 8; i++) {
      const room = await request(app)
        .post('/api/rooms')
        .send({
          kind: 'channel',
          title: `Room ${i}`,
          agentPaths: ['/agents/ana', '/agents/bo'],
        });
      for (const member of room.body.members) {
        if (member.author.kind !== 'agent') continue;
        await request(app)
          .patch(`/api/rooms/${room.body.id}/members/${member.authorId}`)
          .send({ responseMode: 'always' });
      }
      await post(room.body.id, 'go');
    }
    expect(runner.turns).toHaveLength(5);
  });

  it('spends the channel budget on its threads, because a thread is not a room', async () => {
    // Threads used to be the cheapest lever there was: each one was a room, so
    // each came with a fresh per-room window. `turn-budget.ts` measured it —
    // "five threads off one parent bought 12" — and the global cap was the only
    // thing that stopped it.
    //
    // Under ADR 260728-022013 a thread reply is an entry in the channel, so the
    // PER-ROOM cap alone now bounds the channel and everything threaded inside
    // it. The global cap is deliberately generous here so it cannot be what
    // holds: on the old shape this same script reports 12, not 2.
    wire(2, 100_000);
    const parent = await loudRoom();

    // FIVE distinct roots, so this really is five threads rather than one thread
    // with five replies — which is the shape the 12 was measured against, and
    // the shape `turn-budget.ts` cites this test for.
    const roots: string[] = [];
    for (let i = 0; i < 5; i++) {
      const seed = await request(app)
        .post(`/api/rooms/${parent}/entries`)
        .send({ text: `seed ${i}` });
      expect(seed.status).toBe(202);
      roots.push(seed.body.entryId as string);
      await getRoomService().triggersIdle();
    }
    // Two agents, cap of two: the first seed spends the room's whole window and
    // the other four get nothing. Everything below is measured from there.
    expect(runner.turns).toHaveLength(2);

    for (const rootEntryId of roots) {
      const reply = await request(app)
        .post(`/api/rooms/${parent}/threads`)
        .send({ rootEntryId, text: 'go' });
      expect(reply.status).toBe(202);
      await getRoomService().triggersIdle();
    }

    // Still two. Five threads bought nothing, and no second room was minted to
    // buy it in.
    expect(runner.turns).toHaveLength(2);
    const rooms = await request(app).get('/api/rooms');
    expect(rooms.body.rooms.map((r: { id: string }) => r.id)).toEqual([parent]);
  });

  it('speaks again the next time a room runs dry, rather than once ever', async () => {
    // The budget notice used to key on the room and never be cleared, so a room
    // told once was never told again — silent refusal, which is the state the
    // notice exists to prevent.
    wire(1, 100);
    const roomId = await loudRoom();
    await post(roomId, 'one');
    await post(roomId, 'two');
    const first = (await entries(roomId)).filter((e) => e.kind === 'notice');
    expect(first).toHaveLength(1);

    // Raise the per-room cap so the room can spend again, which re-arms it,
    // then exhaust it a second time.
    wireBudgetTo(roomId);
    await post(roomId, 'three');
    await post(roomId, 'four');
    const second = (await entries(roomId)).filter((e) => e.kind === 'notice');
    expect(second.length).toBeGreaterThan(first.length);
  });

  it('still answers a normal message once the budget is generous', async () => {
    // The bound must not be a way to make rooms useless.
    const roomId = await loudRoom();
    await post(roomId, 'what do you two think?');
    expect(runner.turns).toHaveLength(2);
    expect((await entries(roomId)).filter((e) => e.kind === 'notice')).toEqual([]);
  });
});
