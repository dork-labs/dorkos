/**
 * A room seat that moved twice, on a migrated database: River's seat in Team sat on `old-seat`,
 * moved to `middle-seat`, then on to `seat-now`. Each old session is still a real chat a person
 * can reopen. Shared by the report-routing checks of DOR-3753.
 */
import {
  agents,
  authors,
  eq,
  roomMembers,
  roomSeatMoves,
  roomSessions,
  rooms,
  sessionMetadata,
  sessionStartedBy,
  type Db,
} from '@dorkos/db';
import { createTestDb } from '@dorkos/test-utils/db';
import { ChatMessageStore } from '../../../session/chat-messages/chat-message-store.js';
import { ChatMessageService } from '../../../session/chat-messages/chat-message-service.js';
import type {
  DispatchSessionMessageOpts,
  DispatchSessionMessageResult,
} from '../../../session/launch/launch-session.js';
import { RoomSessionLedger } from '../../session-bindings/room-session-ledger.js';
import { turnsOver } from '../../../session/chat-messages/__tests__/chat-turns.fixture.js';

export const PATH = '/agents/river';
export const JOINED = '2026-11-20T11:00:00.000Z';
export const FIRST_MOVE = Date.parse('2026-11-20T12:00:00.000Z');
export const SECOND_MOVE = Date.parse('2026-11-20T13:00:00.000Z');
export const NOW = Date.parse('2026-11-20T14:00:00.000Z');
export const iso = (ms: number) => new Date(ms).toISOString();

/** The seat as a saved report records it. */
export const SEAT = {
  roomId: 'team',
  authorId: 'river-author',
  joinedAt: JOINED,
  agentPath: PATH,
};

/** A fresh database holding the moved seat. */
export function seedMovedSeat(): Db {
  const db = createTestDb();
  db.insert(agents)
    .values({
      id: 'river',
      name: 'river',
      runtime: 'claude-code',
      projectPath: PATH,
      registeredAt: JOINED,
      updatedAt: JOINED,
    })
    .run();
  for (const sessionId of ['child', 'old-seat', 'middle-seat', 'seat-now'])
    db.insert(sessionMetadata)
      .values({
        sessionId,
        runtime: 'claude-code',
        agentPath: PATH,
        launchOrigin: sessionId === 'child' ? 'agent-launch' : 'room',
        createdAt: JOINED,
      })
      .run();
  db.insert(authors)
    .values({
      id: 'river-author',
      kind: 'agent',
      naturalKey: PATH,
      displayName: 'River',
      mintedForManifestId: 'river',
      createdAt: JOINED,
    })
    .run();
  db.insert(rooms)
    .values({
      id: 'team',
      kind: 'channel',
      slug: 'team',
      title: 'Team',
      createdAt: JOINED,
      lastActivityAt: JOINED,
    })
    .run();
  db.insert(roomMembers)
    .values({
      roomId: 'team',
      authorId: 'river-author',
      responseMode: 'mention-only',
      joinedAt: JOINED,
    })
    .run();
  db.insert(roomSessions)
    .values({ roomId: 'team', authorId: 'river-author', sessionId: 'seat-now', createdAt: JOINED })
    .run();
  db.insert(roomSeatMoves)
    .values([
      { fromSessionId: 'old-seat', roomId: 'team', authorId: 'river-author', movedAt: FIRST_MOVE },
      {
        fromSessionId: 'middle-seat',
        roomId: 'team',
        authorId: 'river-author',
        movedAt: SECOND_MOVE,
      },
    ])
    .run();
  return db;
}

/**
 * Record `child` as a spin-off `parent` started at `startedAt`.
 *
 * @param db - The database.
 * @param parent - The chat that started it.
 * @param startedAt - When it started (epoch ms).
 */
export function startChild(db: Db, parent: string, startedAt: number): void {
  db.delete(sessionStartedBy).run();
  db.insert(sessionStartedBy)
    .values({
      sessionId: 'child',
      kind: 'chat',
      startedBySessionId: parent,
      reportBack: true,
      createdAt: iso(startedAt),
    })
    .run();
}

/**
 * The real chat-message service over `db`, with only its edges standing in: what DorkOS knows
 * about a chat is read from the same rows production reads (`session_metadata` and the room
 * binding), and the launch records each message and runs it at once.
 *
 * @param db - The database.
 * @param edges - `roomsWired` false: the rooms link is not wired yet. `launchFull`: while it
 *   answers true, every launch is refused for a full launch cap.
 */
export function chatServiceOn(
  db: Db,
  edges: { roomsWired?: boolean; launchFull?: () => boolean } = {}
): {
  service: ChatMessageService;
  dispatched: DispatchSessionMessageOpts[];
} {
  const dispatched: DispatchSessionMessageOpts[] = [];
  const ledger = new RoomSessionLedger(db);
  const service = new ChatMessageService({
    store: new ChatMessageStore(db),
    meshCore: () => ({
      get: () => undefined,
      getProjectPath: () => undefined,
      listWithPaths: () => [],
    }),
    describeSession: async (sessionId) => {
      const row = db
        .select()
        .from(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, sessionId))
        .get();
      return {
        bound: row !== undefined,
        launchOrigin: row?.launchOrigin ?? null,
        agentPath: row?.agentPath ?? null,
        startedByExtension: null,
        roomBound: edges.roomsWired !== false && ledger.bindingForSession(sessionId) !== undefined,
        roomsWired: edges.roomsWired !== false,
      };
    },
    chatTitle: async () => null,
    sessionCwd: async () => undefined,
    isBusy: async () => false,
    turns: turnsOver(async (opts): Promise<DispatchSessionMessageResult> => {
      if (edges.launchFull?.()) return { refused: 'LAUNCH_CAP_FULL', message: 'Launch cap full.' };
      dispatched.push(opts);
      const messageId = opts.messageId ?? 'unset';
      return {
        accepted: true,
        queued: false,
        queuePosition: 1,
        outcome: { messageId, requested: 'queue', applied: 'queue' },
      } as DispatchSessionMessageResult;
    }),
    steerInto: async () => false,
    canonicalId: async (sessionId) => sessionId,
    interruptTurn: async () => false,
    turnLevelOf: () => undefined,
    emitActivity: () => {},
    onLifecycle: () => () => {},
  });
  return { service, dispatched };
}
