/**
 * `api.rooms` on the server (DOR-3017): a mini app's page reads and replies in
 * room threads as the signed-in person, under `/api/extensions/:id/rooms`.
 *
 * | Route                                                | What                      | Bar        |
 * | ---------------------------------------------------- | ------------------------- | ---------- |
 * | `GET  /:id/rooms`                                    | rooms it may use          | no agent   |
 * | `GET  /:id/rooms/:roomId/threads/:entryId`           | one thread                | no agent   |
 * | `GET  /:id/rooms/:roomId/unread?threads=a,b`         | unread count per thread   | no agent   |
 * | `GET  /:id/rooms/:roomId/threads/:entryId/events`    | new replies, live (SSE)   | no agent   |
 * | `POST /:id/rooms/:roomId/threads/:entryId/replies`   | reply as the person       | room write |
 * | `PUT  /:id/rooms/:roomId/threads/:entryId/read`      | mark read                 | room write |
 * | `GET  /:id/room-access`                              | rooms the person picked   | no agent   |
 * | `PUT  /:id/room-access`                              | pick the rooms            | person bar, not Wi-Fi |
 *
 * **`:id` is the calling mini app**, filled by the client host. Every `rooms`
 * route also needs the mini app turned on, asking for rooms in its manifest
 * (`capabilities.rooms`), and the room picked for it. Reads
 * refuse a caller that presents an agent identity; the two writes run the
 * stricter room-write bar (`extensions-rooms-bar.ts`). Who the person is comes
 * from `resolveCaller`, the same answer every room route gets, and never from a
 * request body.
 *
 * Every reply, and every refused one, is in the audit trail with the mini app
 * named. That name is the `:id` the request carried: a mini app's page code
 * runs in the person's window and could send another id, so the room choice
 * bounds a well-behaved mini app and is not a sandbox (see
 * `extensions-rooms-bar.ts`).
 *
 * @module routes/extensions-rooms
 */
import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import type { ExtensionStatus, RoomAccessErrorCode } from '@dorkos/extension-api';
import { getRoomService, type AuthorRecord } from '../services/rooms/index.js';
import { getReadCursorService } from '../services/core/read-cursor-service.js';
import { presentsAgentIdentity } from '../middleware/agent-identity.js';
import { recordAudit } from '../services/audit/audit-trail.js';
import type { ExtensionManager } from '../services/extensions/extension-manager.js';
import {
  ExtensionRoomError,
  ExtensionRoomThreads,
  UNREAD_THREADS_MAX,
} from '../services/extensions/rooms/extension-room-threads.js';
import {
  allowedRoomIds,
  isRoomAllowed,
  ROOM_ACCESS_MAX,
  setAllowedRooms,
} from '../services/extensions/rooms/extension-room-access.js';
import { SseStreamSink } from '../services/core/streams/durable-stream-sink.js';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { readJsonBody } from '../http/request-body.js';
import { readQuery } from '../http/request-query.js';
import { streamToNodeResponse } from '../http/raw-node-stream.js';
import { logger } from '../lib/logger.js';
import { resolveCaller } from './room-caller.js';
import { ROOM_WRITE_REFUSAL_MESSAGE, refuseRoomWrite } from './extensions-rooms-bar.js';
import { refusedNotAPerson, type PersonBarCopy } from './extensions-person-bar.js';

/** The statuses of a mini app that is turned on. */
const TURNED_ON: ReadonlySet<ExtensionStatus> = new Set(['enabled', 'compiled', 'active']);

/** The HTTP status for each refusal. */
const STATUS_FOR: Record<RoomAccessErrorCode, ContentfulStatusCode> = {
  room_not_allowed: 403,
  not_found: 404,
  person_required: 403,
  extension_off: 409,
  invalid_input: 400,
  unavailable: 503,
};

/** What a mini app that never asked for rooms is told. */
const NO_ROOMS_DECLARED =
  'This mini app does not ask for rooms. Add "capabilities": { "rooms": true } to its manifest.';

/** Whether a mini app's manifest asks for rooms (`capabilities.rooms`). */
function asksForRooms(record: { manifest: { capabilities?: { rooms?: boolean } } }): boolean {
  return record.manifest.capabilities?.rooms === true;
}

/** Longest reply, in characters. Mirrors `ROOM_THREAD_REPLY_MAX_CHARS`. */
const REPLY_MAX_CHARS = 20_000;

const ReplyBodySchema = z.object({ text: z.string().trim().min(1).max(REPLY_MAX_CHARS) }).strict();

const RoomAccessBodySchema = z
  .object({ roomIds: z.array(z.string().min(1)).max(ROOM_ACCESS_MAX) })
  .strict();

/** What the person bar says when it refuses a room-access change. */
const ROOM_ACCESS_BAR: PersonBarCopy = {
  error: 'Only a person can choose which rooms a mini app uses.',
  code: 'room_access_person_required',
  subject: 'which rooms a mini app uses',
  crossSite: (origin) =>
    `Nothing changed. This request came from ${origin}, which is not DorkOS. ` +
    `Only a person using DorkOS can choose which rooms a mini app uses.`,
  agent: 'Nothing changed. Only a person can choose which rooms a mini app uses.',
};

const threads = new ExtensionRoomThreads({
  rooms: getRoomService,
  cursors: getReadCursorService,
});

/** A refusal, answered. */
function refuse(c: Context<ApiEnv>, code: RoomAccessErrorCode, message: string): Response {
  return c.json({ error: message, code }, STATUS_FOR[code]);
}

/**
 * Mount the `api.rooms` routes and the room-access setting on the extensions router.
 *
 * @param router - The extensions router.
 * @param extensionManager - For the mini app's name and whether it is on.
 * @param safeExtId - The id pattern the parent router validates against.
 */
export function registerExtensionRoomRoutes(
  router: Hono<ApiEnv>,
  extensionManager: ExtensionManager,
  safeExtId: RegExp
): void {
  /**
   * The person and the mini app, or the refusal. Agents are refused here for
   * every route: a mini app's rooms are the person's, and an agent reads and
   * posts as itself through the room routes.
   */
  const callerFor = (
    c: Context<ApiEnv>
  ): { viewer: AuthorRecord; extensionId: string; extensionName: string } | Response => {
    const extensionId = c.req.param('id') ?? '';
    if (!safeExtId.test(extensionId)) return c.json({ error: 'Invalid extension ID' }, 400);
    const facts = honoRequestFacts(c);
    if (presentsAgentIdentity(facts)) {
      return refuse(c, 'person_required', 'Only the person can use a mini app’s rooms.');
    }
    const record = extensionManager.get(extensionId);
    if (!record) return refuse(c, 'not_found', `No mini app named ${extensionId}.`);
    if (!TURNED_ON.has(record.status)) {
      return refuse(
        c,
        'extension_off',
        `Turn on ${record.manifest.name} in Settings → Extensions first.`
      );
    }
    if (!asksForRooms(record)) return refuse(c, 'room_not_allowed', NO_ROOMS_DECLARED);
    let viewer: AuthorRecord;
    try {
      viewer = resolveCaller(facts);
    } catch {
      return refuse(c, 'person_required', 'Only the person can use a mini app’s rooms.');
    }
    if (viewer.kind !== 'human') {
      return refuse(c, 'person_required', 'Only the person can use a mini app’s rooms.');
    }
    return { viewer, extensionId, extensionName: record.manifest.name };
  };

  /** Run one call, answering an {@link ExtensionRoomError} as its refusal. */
  const answer = (c: Context<ApiEnv>, run: () => Response): Response => {
    try {
      return run();
    } catch (err) {
      if (err instanceof ExtensionRoomError) return refuse(c, err.code, err.message);
      logger.error('[Extensions] A mini app room call failed', err);
      return refuse(c, 'unavailable', 'DorkOS could not do that. Try again.');
    }
  };

  router.get('/:id/rooms', (c) => {
    const caller = callerFor(c);
    if (caller instanceof Response) return caller;
    return answer(c, () => c.json({ rooms: threads.listRooms(caller.extensionId, caller.viewer) }));
  });

  router.get('/:id/rooms/:roomId/threads/:entryId', (c) => {
    const caller = callerFor(c);
    if (caller instanceof Response) return caller;
    return answer(c, () =>
      c.json(
        threads.readThread(
          caller.extensionId,
          caller.viewer,
          c.req.param('roomId'),
          c.req.param('entryId')
        )
      )
    );
  });

  router.get('/:id/rooms/:roomId/unread', (c) => {
    const caller = callerFor(c);
    if (caller instanceof Response) return caller;
    const raw = readQuery(c).threads;
    const ids = (Array.isArray(raw) ? raw.join(',') : (raw ?? ''))
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0);
    if (ids.length > UNREAD_THREADS_MAX) {
      return refuse(c, 'invalid_input', `Ask about at most ${UNREAD_THREADS_MAX} threads at once.`);
    }
    return answer(c, () =>
      c.json({
        counts: threads.unreadCounts(caller.extensionId, caller.viewer, c.req.param('roomId'), ids),
      })
    );
  });

  router.post('/:id/rooms/:roomId/threads/:entryId/replies', (c) => {
    const roomId = c.req.param('roomId');
    const entryId = c.req.param('entryId');
    // The bar runs first, so a refused attempt is recorded whoever made it,
    // an agent included, before anything about the caller is resolved.
    /** Record a reply refused before it reached the room, when the mini app is known. */
    const auditRefused = (why: string) => {
      const extensionId = c.req.param('id');
      const record = safeExtId.test(extensionId) ? extensionManager.get(extensionId) : undefined;
      if (!record) return;
      const who = { extensionId, extensionName: record.manifest.name };
      auditReply(who, roomId, entryId, 'refused', why);
    };
    const refusal = refuseRoomWrite(honoRequestFacts(c));
    if (refusal) {
      auditRefused(refusal);
      return refuse(c, 'person_required', ROOM_WRITE_REFUSAL_MESSAGE[refusal]);
    }
    const caller = callerFor(c);
    if (caller instanceof Response) {
      auditRefused('caller');
      return caller;
    }
    const body = ReplyBodySchema.safeParse(readJsonBody(c, { emptyAs: {} }));
    if (!body.success) {
      auditRefused('invalid_input');
      return refuse(
        c,
        'invalid_input',
        `Write a reply of 1 to ${REPLY_MAX_CHARS.toLocaleString('en-US')} characters.`
      );
    }
    try {
      const reply = threads.reply(
        caller.extensionId,
        caller.viewer,
        roomId,
        entryId,
        body.data.text
      );
      auditReply(caller, roomId, reply.id, 'ok');
      return c.json(reply, 201);
    } catch (err) {
      if (err instanceof ExtensionRoomError) {
        auditReply(caller, roomId, entryId, 'refused', err.code);
        return refuse(c, err.code, err.message);
      }
      logger.error('[Extensions] A mini app reply failed', err);
      auditReply(caller, roomId, entryId, 'failed');
      return refuse(c, 'unavailable', 'The reply was not posted. Try again.');
    }
  });

  router.put('/:id/rooms/:roomId/threads/:entryId/read', (c) => {
    const caller = callerFor(c);
    if (caller instanceof Response) return caller;
    const refusal = refuseRoomWrite(honoRequestFacts(c));
    if (refusal) {
      return refuse(
        c,
        'person_required',
        ROOM_WRITE_REFUSAL_MESSAGE[refusal].replace('Nothing was posted.', 'Nothing changed.')
      );
    }
    return answer(c, () => {
      threads.markRead(
        caller.extensionId,
        caller.viewer,
        c.req.param('roomId'),
        c.req.param('entryId')
      );
      return c.body(null, 204);
    });
  });

  router.get('/:id/rooms/:roomId/threads/:entryId/events', (c) => {
    const caller = callerFor(c);
    if (caller instanceof Response) return caller;
    const roomId = c.req.param('roomId');
    const entryId = c.req.param('entryId');
    try {
      threads.requireThread(caller.extensionId, caller.viewer, roomId, entryId);
    } catch (err) {
      if (err instanceof ExtensionRoomError) return refuse(c, err.code, err.message);
      throw err;
    }
    const resume = Number(
      c.req.header('last-event-id') ?? (readQuery(c).after as string | undefined) ?? NaN
    );
    const stillOn = () => {
      const record = extensionManager.get(caller.extensionId);
      return record !== undefined && TURNED_ON.has(record.status) && asksForRooms(record);
    };
    return streamToNodeResponse(c, (res) =>
      streamThread(new SseStreamSink(res), { ...caller, stillOn }, roomId, entryId, resume)
    );
  });

  router.get('/:id/room-access', (c) => {
    const id = c.req.param('id');
    if (!safeExtId.test(id)) return c.json({ error: 'Invalid extension ID' }, 400);
    // Withheld from agents, as the leaf is in `config_get`: the ids can name
    // private rooms an agent is not in.
    if (presentsAgentIdentity(honoRequestFacts(c))) {
      return refuse(c, 'person_required', 'Only the person can see which rooms a mini app uses.');
    }
    if (!extensionManager.get(id)) return c.json({ error: `No mini app named ${id}.` }, 404);
    return c.json({ roomIds: allowedRoomIds(id) });
  });

  router.put('/:id/room-access', (c) => {
    const id = c.req.param('id');
    if (!safeExtId.test(id)) return c.json({ error: 'Invalid extension ID' }, 400);
    // A standing grant outlives the request, and from Wi-Fi a person's yes is
    // never a standing one (DOR-2969). Read from the listener's own mark, the
    // signal the Wi-Fi level reads too.
    if (honoRequestFacts(c).ingress === 'wifi') {
      return c.json(
        { error: 'Choose a mini app’s rooms at this computer.', code: 'NOT_FROM_WIFI' },
        403
      );
    }
    const refused = refusedNotAPerson(c, ROOM_ACCESS_BAR);
    if (refused) return refused;
    const record = extensionManager.get(id);
    if (!record) return c.json({ error: `No mini app named ${id}.` }, 404);
    if (!asksForRooms(record)) return refuse(c, 'invalid_input', NO_ROOMS_DECLARED);
    const body = RoomAccessBodySchema.safeParse(readJsonBody(c, { emptyAs: {} }));
    if (!body.success) {
      return c.json(
        { error: `Pick at most ${ROOM_ACCESS_MAX} rooms.`, code: 'invalid_input' },
        400
      );
    }
    // Only rooms the person is in: a mini app reads with the person's own
    // membership, so a room they cannot read would grant nothing but noise.
    const viewer = resolveCaller(honoRequestFacts(c));
    const service = getRoomService();
    const unknown = body.data.roomIds.filter((roomId) => {
      try {
        service.requireMembership(roomId, viewer.id);
        return false;
      } catch {
        return true;
      }
    });
    if (unknown.length > 0) {
      return c.json({ error: 'Pick only rooms you are in.', code: 'invalid_input' }, 400);
    }
    // Recorded in the audit trail as a settings change by `setAllowedRooms`.
    const roomIds = setAllowedRooms(id, body.data.roomIds);
    return c.json({ roomIds });
  });
}

/**
 * Record one reply, or a refused one. The actor is the person (the request's
 * own audit scope); the target is the mini app it came through, so a search
 * for what one mini app did finds every reply it posted, in the room named as
 * the target's container. The reply's entry id rides as the change.
 */
function auditReply(
  caller: { extensionId: string; extensionName: string },
  roomId: string,
  entryId: string,
  outcome: 'ok' | 'refused' | 'failed',
  why?: string
): void {
  recordAudit({
    action: 'extension.room_reply',
    operation: 'create',
    outcome,
    target: {
      type: 'extension',
      id: caller.extensionId,
      name: caller.extensionName,
      containerId: roomId,
    },
    change: [{ field: outcome === 'ok' ? 'replyEntryId' : 'threadRootEntryId', after: entryId }],
    summary:
      outcome === 'ok'
        ? `Replied in a room thread through ${caller.extensionName}`
        : `A reply through ${caller.extensionName} was not posted`,
    ...(why ? { error: why } : {}),
  });
}

/**
 * Stream a thread's new replies until the reader leaves or the person takes
 * the room away from the mini app. Subscribes before replaying, so nothing
 * written between the two is lost; the seq watermark drops the overlap.
 */
async function streamThread(
  sink: SseStreamSink,
  caller: { viewer: AuthorRecord; extensionId: string; stillOn: () => boolean },
  roomId: string,
  rootEntryId: string,
  resumeAfter: number
): Promise<void> {
  const service = getRoomService();
  sink.flushHeaders();
  const iterator = service.stream.subscribe(roomId, sink.signal)[Symbol.asyncIterator]();
  let highestSent = Number.isFinite(resumeAfter) ? resumeAfter : service.maxSeq(roomId);
  /** Send one entry when it is a reply in this thread; false once access is gone. */
  const send = async (entry: Parameters<ExtensionRoomThreads['liveReply']>[0]) => {
    if (entry.seq <= highestSent) return true;
    highestSent = entry.seq;
    const view = threads.liveReply(entry, rootEntryId, caller.viewer.id);
    if (!view) return true;
    // Checked again per reply, not just at connect: a room taken away from the
    // mini app, or one the person left, ends the stream before it says more.
    try {
      threads.requireThread(caller.extensionId, caller.viewer, roomId, rootEntryId);
    } catch {
      return false;
    }
    await sink.send({ event: 'reply', id: String(entry.seq), data: view });
    return true;
  };
  try {
    if (Number.isFinite(resumeAfter)) {
      for (const entry of service.entriesAfter(roomId, resumeAfter)) {
        if (sink.closed || !(await send(entry))) return;
      }
    }
    while (!sink.closed) {
      const next = await iterator.next();
      if (next.done) break;
      // Taken away, or the mini app turned off: stop rather than keep reading,
      // even between replies.
      if (!isRoomAllowed(caller.extensionId, roomId) || !caller.stillOn()) break;
      if (next.value.type !== 'entry') continue;
      if (!(await send(next.value.entry))) break;
    }
  } finally {
    await iterator.return?.();
    sink.end();
  }
}
