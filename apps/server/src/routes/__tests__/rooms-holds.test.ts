/**
 * Two rooms, one agent, measured THROUGH THE ROUTES.
 *
 * The unit suite (`services/rooms/__tests__/room-hold-elsewhere.test.ts`) pins
 * what the dispatcher does. This pins what a person on the other end of HTTP
 * actually gets, which is a different question and the one that was wrong: the
 * old behaviour answered `202` and then wrote a room entry asking them to send
 * the message again. Everything here goes over the wire — the post, the log, the
 * live stream, and the control that reorders a wait — so nothing in between can
 * be right in a unit test and wrong in the product.
 *
 * The scenario is the bug report: ask an agent something in room A, ask it
 * something else in room B while it is still working, and expect room B to keep
 * the question and answer it rather than hand it back.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { openSseStream, type SseFrame } from '@dorkos/test-utils';
import { createTestDb } from '@dorkos/test-utils/db';
import { agents, type Db } from '@dorkos/db';
import { USER_CONFIG_DEFAULTS } from '@dorkos/shared/config-schema';
import type { RoomEntry, RoomEvent } from '@dorkos/shared/room-schemas';

vi.mock('../../lib/boundary.js', () => ({
  validateBoundary: vi.fn(async (p: string) => p),
  validateBoundaryOrDorkHome: vi.fn(async (p: string) => p),
  getBoundary: vi.fn(() => '/mock/home'),
  initBoundary: vi.fn().mockResolvedValue('/mock/home'),
  isWithinBoundary: vi.fn().mockResolvedValue(true),
  BoundaryError: class BoundaryError extends Error {},
}));

vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getDefault: vi.fn(),
    get: vi.fn(),
    getAllCapabilities: vi.fn(() => ({})),
    getDefaultType: vi.fn(() => 'fake'),
    has: vi.fn(() => true),
    listRuntimes: vi.fn(() => []),
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
    // The shipped `rooms` defaults with the gathering window zeroed, for the
    // reason `rooms-cascade.test.ts` gives: the window's LENGTH is measured in
    // `room-collect.test.ts`, and waiting it out here would only prove a timer
    // works.
    get: vi.fn((key: string) =>
      key === 'rooms' ? { ...USER_CONFIG_DEFAULTS.rooms, collectDebounceMs: 0 } : null
    ),
    set: vi.fn(),
  },
}));

import { createApp, finalizeApp } from '../../app.js';
import { createRoomSubsystem, getRoomService, setRoomService } from '../../services/rooms/index.js';
import type { RoomTurnRequest, RoomTurnResult } from '../../services/rooms/room-trigger.js';

const app = createApp();
finalizeApp(app);

/** Register the one agent both rooms share — one directory, one checkout. */
function registerAna(db: Db): void {
  const now = new Date().toISOString();
  db.insert(agents)
    .values({
      id: 'ULID_ANA',
      name: 'ana',
      displayName: 'Ana',
      runtime: 'claude-code',
      projectPath: '/agents/ana',
      behaviorJson: '{"responseMode":"always"}',
      registeredAt: now,
      updatedAt: now,
    })
    .run();
}

describe('two rooms, one agent, over HTTP', () => {
  let db: Db;
  /** Every turn the dispatcher asked for, and the lever that finishes it. */
  let turns: Array<{ roomId: string; prompt: string; finish: (text: string) => void }>;

  /**
   * A runner that holds every turn open.
   *
   * The whole state under test only exists while a turn is running: a turn that
   * answered would take and release its claim inside one `await`, and the room
   * that was waiting behind it would never have waited.
   */
  function holdingRunner() {
    return {
      turns: [] as never[],
      interrupted: [] as never[],
      interrupt: () => Promise.resolve(),
      run(req: RoomTurnRequest): Promise<RoomTurnResult> {
        return new Promise<RoomTurnResult>((resolve) => {
          turns.push({
            roomId: req.room.id,
            prompt: req.prompt,
            finish: (text) => resolve({ sessionId: req.sessionId ?? 'session-1', text }),
          });
        });
      },
    };
  }

  /** Open a channel with Ana in it, answering whatever names her. */
  async function channel(title: string): Promise<string> {
    const created = await request(app)
      .post('/api/rooms')
      .send({ kind: 'channel', title, agentPaths: ['/agents/ana'] });
    expect(created.status).toBe(201);
    for (const member of created.body.members) {
      if (member.author.kind !== 'agent') continue;
      await request(app)
        .patch(`/api/rooms/${created.body.id}/members/${member.authorId}`)
        .send({ responseMode: 'mention-only' });
    }
    return created.body.id as string;
  }

  /** Ana's author id in one room. */
  async function anaIn(roomId: string): Promise<string> {
    const res = await request(app).get(`/api/rooms/${roomId}`);
    const member = res.body.members.find(
      (row: { author: { kind: string } }) => row.author.kind === 'agent'
    );
    return member.authorId as string;
  }

  /** One room's whole log, as the wire returns it. */
  async function entries(roomId: string): Promise<RoomEntry[]> {
    const res = await request(app).get(`/api/rooms/${roomId}/entries?limit=200`);
    return res.body.entries as RoomEntry[];
  }

  /** Let several macrotasks pass, so a notice that WAS coming would have landed. */
  async function quiet(): Promise<void> {
    for (let tick = 0; tick < 6; tick += 1) await new Promise((r) => setTimeout(r, 0));
  }

  /** Start the app on an ephemeral port for one test. */
  async function listen(): Promise<{ port: number; close: () => void }> {
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    return { port: (server.address() as AddressInfo).port, close: () => server.close() };
  }

  /** Every presence signal a stream's frames carry, in order. */
  function signalsOf(frames: SseFrame[]): Array<Extract<RoomEvent, { type: 'signal' }>> {
    return frames
      .filter((frame) => frame.event === 'signal')
      .map((frame) => frame.data as Extract<RoomEvent, { type: 'signal' }>);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    db = createTestDb();
    turns = [];
    registerAna(db);
    setRoomService(createRoomSubsystem({ db, turns: holdingRunner() }).service);
  });

  it('keeps the question, says so on the live stream, and answers it where it was asked', async () => {
    const a = await channel('Backend');
    const b = await channel('Deploys');
    const ana = await anaIn(b);
    const server = await listen();

    try {
      // Ana takes a turn in room A and stays in it.
      const started = await request(app)
        .post(`/api/rooms/${a}/entries`)
        .send({ text: '@ana can you take the staging rollout?' });
      expect(started.status).toBe(202);
      await quiet();
      expect(turns).toHaveLength(1);

      // Room B's stream is open BEFORE the second question, because a signal is
      // ephemeral and never replays: a reader who connects afterwards is told
      // nothing, which is the contract and not a gap.
      const stream = openSseStream(server.port, `/api/rooms/${b}/events`, {
        until: (frames) => signalsOf(frames).some((event) => event.state === 'held'),
      });
      await stream.ready;

      const asked = await request(app)
        .post(`/api/rooms/${b}/entries`)
        .send({ text: '@ana and the styles?' });
      expect(asked.status).toBe(202);

      const frames = await stream.frames;
      const waiting = signalsOf(frames).find((event) => event.state === 'held');
      expect(waiting?.authorId).toBe(ana);
      // The id of the room in the way, and nothing else about it — no title, no
      // topic, no text. The reader resolves the name themselves.
      expect(waiting?.heldBehind).toEqual({ roomId: a, othersWaiting: false });

      // **And nothing durable was written.** This is the whole regression: the
      // old behaviour answered 202 and then put a line in this room asking the
      // person to send the message again.
      expect((await entries(b)).filter((entry) => entry.kind === 'notice')).toEqual([]);

      // Room A's turn finishes, and room B's question becomes a turn IN ROOM B.
      turns[0]!.finish('rollout is queued');
      await quiet();
      expect(turns).toHaveLength(2);
      expect(turns[1]!.roomId).toBe(b);
      expect(turns[1]!.prompt).toBe('@ana and the styles?');

      turns[1]!.finish('styles are fine');
      await getRoomService().triggersIdle();

      const log = await entries(b);
      const answer = log.find((entry) => entry.kind === 'post' && entry.authorId === ana);
      expect(answer?.body.text).toContain('styles are fine');
      // …and it says which message it answers, which is what makes a late answer
      // followable in a room that posts in arrival order.
      const question = log.find((entry) => entry.body.text === '@ana and the styles?');
      expect(answer?.body.answersEntryId).toBe(question?.id);
      expect(log.filter((entry) => entry.kind === 'notice')).toEqual([]);
    } finally {
      server.close();
    }
  });

  it('takes an ask-me-first, and answers false once there is nothing waiting', async () => {
    const a = await channel('Backend');
    const b = await channel('Deploys');
    const ana = await anaIn(b);

    await request(app)
      .post(`/api/rooms/${a}/entries`)
      .send({ text: '@ana can you take the staging rollout?' });
    await quiet();
    await request(app).post(`/api/rooms/${b}/entries`).send({ text: '@ana and the styles?' });
    await quiet();

    const asked = await request(app).post(`/api/rooms/${b}/holds/${ana}/promote`).send();
    expect(asked.status).toBe(200);
    expect(asked.body).toEqual({ promoted: true });
    // It REORDERS: the turn in the way is untouched and no second turn started.
    expect(turns).toHaveLength(1);

    turns[0]!.finish('rollout is queued');
    await quiet();
    turns[1]!.finish('styles are fine');
    await getRoomService().triggersIdle();

    // Nothing is waiting now, and saying so is a normal answer rather than an
    // error: this is what a button left over from a wait that already ended does.
    const stale = await request(app).post(`/api/rooms/${b}/holds/${ana}/promote`).send();
    expect(stale.status).toBe(200);
    expect(stale.body).toEqual({ promoted: false });
  });

  it('answers a room this caller cannot see exactly as it answers one that does not exist', async () => {
    const b = await channel('Deploys');
    const ana = await anaIn(b);
    const missing = await request(app).post(`/api/rooms/nope/holds/${ana}/promote`).send();
    expect(missing.status).toBe(404);
  });
});
