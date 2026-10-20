/**
 * Room HTTP API (spec `rooms` §4) — thin handlers over the RoomService.
 *
 * Two conventions worth knowing before reading:
 *
 * - **Posting is trigger-only.** `POST /:id/entries` returns 202 and the
 *   entry's identity; the entry itself reaches every reader over
 *   `GET /:id/events`, exactly as `POST /api/sessions/:id/messages` does
 *   (ADR-0264). The poster is a reader too, so it gets its own entry back on
 *   the stream and has one delivery path rather than two.
 * - **The caller is resolved to an author, never trusted from the body.** An
 *   agent presenting a VALID `X-DorkOS-Agent` posts as itself; a caller
 *   presenting one this machine cannot verify is refused 401 outright; anyone
 *   else posts as this install's owner. `resolveCaller` owns that decision and
 *   all of it — every handler here just asks {@link roomRoute} for the caller,
 *   and a route added below inherits the refusal without asking for it.
 *
 * The attachments (`room-attachments.ts`), a room's own files
 * (`room-files.ts`), the canvas (`room-canvas.ts`) and following
 * (`room-follow.ts`) are their own groups, mounted at the bottom.
 *
 * @module routes/rooms
 */
import { pipeline, Readable } from 'node:stream';
import { Hono } from 'hono';
import {
  ROOM_EXPORT_CONTENT_TYPE,
  roomExportFilename,
  type RoomExportHeader,
} from '@dorkos/shared/room-export-schemas';
import {
  AddRoomMemberRequestSchema,
  CreateRoomRequestSchema,
  ListRoomEntriesQuerySchema,
  ListRoomsQuerySchema,
  ListThreadsQuerySchema,
  PostThreadReplyRequestSchema,
  PostToRoomRequestSchema,
  SetAuthorHandleRequestSchema,
  ToggleReactionRequestSchema,
  UpdateMembershipRequestSchema,
  UpdateRoomRequestSchema,
  type PostToRoomResponse,
} from '@dorkos/shared/room-schemas';
import {
  getRoomService,
  RoomError,
  toAuthorRef,
  type PostedEntry,
} from '../services/rooms/index.js';
import { listRoomsAcrossCommunities } from '../services/communities/index.js';
import type { ApiEnv } from '../http/api-chain.js';
import { streamToNodeResponse } from '../http/raw-node-stream.js';
import { readJsonBody } from '../http/request-body.js';
import { readQuery } from '../http/request-query.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { wifiTurnBound } from '../services/core/auth/sessions/wifi-turn-ceiling.js';
import { isFromWifi, NOT_FROM_WIFI } from '../services/core/auth/sessions/wifi-level.js';
import { renameAuthorHandle } from '../services/rooms/handles/rename-author-handle.js';
import { logger } from '../lib/logger.js';
import { roomEventsHandler } from './room-events-handler.js';
import roomAttachmentRoutes from './room-attachments.js';
import roomFileRoutes from './room-files.js';
import roomCanvasRoutes from './room-canvas.js';
import roomFollowRoutes from './room-follow.js';
import roomReseatRoutes from './room-reseat.js';
import { parseOrRefuse, roomRoute } from './room-route.js';

const router = new Hono<ApiEnv>();

/**
 * GET / — rooms visible to the caller, each with their unread count, plus every
 * community that could not contribute to the list.
 *
 * `rooms` is this machine's own rooms and is unchanged by the community
 * registry: the port is single-identity and this list is per-caller, so an
 * agent's view has to come from the room service that knows who is asking.
 * `warnings` is the other communities' half — empty on every install today.
 * {@link listRoomsAcrossCommunities} argues the split in full.
 */
router.get('/', (c) => {
  const query = parseOrRefuse(c, ListRoomsQuerySchema, readQuery(c));
  if (query instanceof Response) return query;
  return roomRoute(c, 'GET /', async (caller) =>
    c.json(
      await listRoomsAcrossCommunities({
        service: getRoomService(),
        callerAuthorId: caller().id,
        query,
      })
    )
  );
});

/**
 * POST / — open a channel or a DM.
 *
 * **201 when a room was created, 200 when one already existed.** A DM is
 * idempotent on its member set, so this can answer with a conversation that has
 * been running for weeks — and nothing in the body would say so. `created` is
 * stripped here rather than serialized, so the response stays exactly
 * `RoomWithRosterSchema` and the distinction rides the status line, where an
 * upsert's does.
 */
router.post('/', (c) => {
  const body = parseOrRefuse(c, CreateRoomRequestSchema, readJsonBody(c));
  if (body instanceof Response) return body;
  return roomRoute(c, 'POST /', (caller) => {
    const { created, ...room } = getRoomService().createRoom(body, caller().id);
    return c.json(room, created ? 201 : 200);
  });
});

/**
 * GET /threads — every thread the caller takes part in, across every room,
 * newest activity first.
 *
 * **Declared before `GET /:id`, and it has to be.** Routes match in
 * declaration order, so a `/:id` above this one would answer `/threads` with a
 * 404 for a room called "threads". A literal segment goes above its parameter.
 *
 * The only cross-room read in this file. A thread is a relation between entries
 * inside one room (ADR 260728-022013), so every other thread route is scoped to
 * `/:id` — this one exists because a sidebar cannot ask a question of a room it
 * has not been told about yet.
 */
router.get('/threads', (c) => {
  const query = parseOrRefuse(c, ListThreadsQuerySchema, readQuery(c));
  if (query instanceof Response) return query;
  return roomRoute(c, 'GET /threads', (caller) =>
    c.json({ threads: getRoomService().listThreads(caller().id, query.limit) })
  );
});

/** GET /:id — one room with its roster. 404s unless the caller is a member. */
router.get('/:id', (c) =>
  roomRoute(c, 'GET /:id', (caller) => {
    const room = getRoomService().getRoom(c.req.param('id'), caller().id);
    if (!room) return c.json({ error: 'No such room', code: 'ROOM_NOT_FOUND' }, 404);
    return c.json(room);
  })
);

/**
 * PATCH /:id — title, topic, archive, this room's four automatic-reply limits,
 * and — on a bridged room — the `deliverNotices` override (chats-as-channels
 * spec §6.2). `NOT_A_BRIDGED_ROOM` (409) when `deliverNotices` is sent for a
 * room with no bridge.
 *
 * **This whole route is operator-only** (DOR-608): anyone but the person who
 * owns this install is refused 403 `OPERATOR_ONLY`, and an unverifiable agent
 * token is refused 401 by `resolveCaller` before this handler runs. Not merely
 * person-only — a second human author (an invited member, a cached remote one)
 * is refused too, for the reason `RoomService.seesEveryRoom` gives. An agent's
 * surface for a room's name and topic is the `update_room` capability verb,
 * which takes its own field refusals and cannot archive anything; `archived`
 * and the four limit fields are reachable from here and nowhere else.
 *
 * The gate lives in `RoomService.updateRoom` rather than in this handler, one
 * line after the visibility check, so a caller probing a room it cannot see
 * gets the same 404 reading it would. Sending a limit field as `null` clears
 * the room's override; omitting it leaves whatever is stored alone.
 */
router.patch('/:id', (c) => {
  const body = parseOrRefuse(c, UpdateRoomRequestSchema, readJsonBody(c));
  if (body instanceof Response) return body;
  return roomRoute(c, 'PATCH /:id', (caller) =>
    c.json(getRoomService().updateRoom(c.req.param('id'), caller().id, body))
  );
});

/**
 * GET /:id/sessions — which session each of this room's agents answers in.
 *
 * The mapping `specs/room-presence` §15 deliberately kept off the presence
 * signal, "waiting for a design that checks the caller's right to it". This is
 * that design, and it is two sentences long:
 *
 * - **A room you cannot see answers 404**, exactly as `GET /:id` does, so this
 *   route discloses nothing about a room that reading it would not.
 * - **Only a person may ask.** A caller that presented `X-DorkOS-Agent` is
 *   refused 403 (`PEOPLE_ONLY`). An agent enumerating its room-mates' sessions
 *   is arbitration this domain has declined; a person asking "where is that work
 *   running" is the reason the route exists.
 *
 * **A header that did not resolve is refused too — by `resolveCaller`, before
 * this handler runs.** DOR-1357 closed that hole here alone, by asking the wider
 * `presentsAgentIdentity` question in this route instead of `caller.kind`.
 * DOR-1361 moved the same question into `resolveCaller`, where every room route
 * gets it, so an unverifiable token answers 401 `AGENT_IDENTITY_UNVERIFIED`
 * before any room is looked up and this gate is back to the simple question it
 * was always asking: is the caller a person. The two spellings would be
 * indistinguishable from here now, and the simple one is the one that can still
 * fail on its own — deleting it turns the resolved-agent case red, which is what
 * a gate is for.
 *
 * **Visibility is checked first, and the order is deliberate.** `POST
 * /:id/attachments` asks the other way round, for a reason that does not apply
 * here — it refuses an agent before a byte of the upload is read. With the person gate
 * first, an agent probing a room it is not in learns 403 (this room exists) or
 * 404 (it does not) from the SAME request a person gets 404 for, which is a
 * difference in answers where there should be none. Visibility first collapses
 * both to 404 and leaves 403 for the one case that is honestly about the
 * caller: a member that is not a person.
 *
 * The body is ids and nothing else — no session content, no cwd, no status. It
 * is the minimum that makes a link, and the narrowness is the security claim.
 *
 * Declared beside `GET /:id` and BELOW it, which is safe: `/:id` matches a
 * single segment, so `/:id/sessions` cannot be swallowed by it and no existing
 * route needed reordering.
 */
router.get('/:id/sessions', (c) =>
  roomRoute(c, 'GET /:id/sessions', (caller) => {
    const viewer = caller();
    // Throws `ROOM_NOT_FOUND` for a room this caller may not see, whoever they
    // are — see the note above on why that comes first.
    const bindings = getRoomService().listRoomSessions(c.req.param('id'), viewer.id);
    if (viewer.kind !== 'human') {
      // A 403 rather than a 404: the visibility check above already passed for
      // whoever this resolved to, so there is nothing left to hide, and telling
      // an agent "this is not yours to read" is more useful than pretending the
      // route does not exist.
      throw new RoomError('PEOPLE_ONLY', "Only a person can see where a room's work runs.");
    }
    return c.json({ bindings });
  })
);

/**
 * GET /:id/entries — a page of history, oldest-first, and the thread roots it
 * points at from outside itself.
 *
 * The second half is what keeps a thread a thread across the page boundary
 * (DOR-690): a reply whose root has scrolled out of the window is a flat row
 * with nothing marking it as an answer, and a client cannot tell otherwise
 * without the root. `listEntryPage` says why the page carries them rather than
 * the reader fetching them back.
 */
router.get('/:id/entries', (c) => {
  const query = parseOrRefuse(c, ListRoomEntriesQuerySchema, readQuery(c));
  if (query instanceof Response) return query;
  return roomRoute(c, 'GET /:id/entries', (caller) =>
    c.json(getRoomService().listEntryPage(c.req.param('id'), caller().id, query))
  );
});

/**
 * GET /:id/export — this room's whole history as a JSONL file (DOR-1225).
 *
 * **A GET, not a POST that writes a path**, and the alternative is worth naming
 * because it is the one somebody will suggest. A room export exists to be
 * portable, and the thing that already lives on the operator's own machine — the
 * `dorkos` CLI — is what should decide where a file lands. A POST taking a
 * destination would give any HTTP caller a filesystem write through the app,
 * which is a capability no room route has and none should grow for a read. So
 * this route stays what it is: a read, gated exactly as every other room read,
 * answering bytes. `dorkos room export` writes them down.
 *
 * **Streamed, one line at a time.** A room's log is never trimmed, so the body
 * is piped from the service's generator rather than assembled first — and the
 * header line is pulled BEFORE any HTTP header is set, because a generator's
 * body does not run until its first `next()` and that is where a refusal
 * surfaces. Pulling it here is what keeps a non-member's answer a clean 404
 * instead of a truncated download.
 *
 * `Content-Disposition: attachment` plus `nosniff` for the same reason the
 * attachment route carries them: this is a file of other people's words, and
 * nothing about it should ever render as a document on the app's own origin.
 */
router.get('/:id/export', (c) =>
  roomRoute(c, 'GET /:id/export', (caller) => {
    const lines = getRoomService().exportRoom(c.req.param('id'), caller().id);
    const first = lines.next();
    // Checked rather than cast. The generator's contract is that its first line
    // is the header, and this route depends on it for the filename — so a future
    // change that stops honouring it has to fail here, loudly and before a byte
    // is sent, rather than serve a file named after `undefined`.
    if (first.done || first.value.type !== 'room-export') {
      throw new Error('room export did not begin with its header');
    }
    const header: RoomExportHeader = first.value;

    return streamToNodeResponse(c, (res) => {
      res.setHeader('Content-Type', `${ROOM_EXPORT_CONTENT_TYPE}; charset=utf-8`);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${roomExportFilename(header.room, header.exportedAt)}"`
      );
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store');

      const body = Readable.from(
        (function* serialize() {
          yield `${JSON.stringify(header)}\n`;
          for (const line of lines) yield `${JSON.stringify(line)}\n`;
        })()
      );
      // `pipeline` rather than `pipe`, because the reader here is a generator
      // over a live database cursor: a client that closes the tab mid-download
      // must tear the source down with it, and `pipe` would leave it producing
      // pages nobody is reading.
      return new Promise<void>((resolve) => {
        pipeline(body, res, (streamErr) => {
          // Headers are already out, so there is no status left to send. The
          // truncated file is the message, and the missing trailing `summary`
          // line is how a reader tells it apart from a whole one.
          if (streamErr) logger.error('[rooms] export stream failed', { err: streamErr });
          resolve();
        });
      });
    });
  })
);

/**
 * The 202 body for a write: the entry's identity, plus who the write reached.
 *
 * Shared by both posting routes, because a thread reply asks a room exactly what
 * a top-level message asks it. `triggered` and `skipped` are omitted — not
 * emptied — when dispatch threw, which is the one case where nothing knows who
 * the message reached; `PostToRoomResponse` reads an absent field as "this source
 * cannot say" precisely so that case is not reported as "nobody".
 *
 * @param entry - The committed entry, as `RoomService.post` handed it back.
 * @returns The response body, exactly `PostToRoomResponseSchema`.
 */
function accepted(entry: PostedEntry): PostToRoomResponse {
  return {
    accepted: true,
    entryId: entry.id,
    seq: entry.seq,
    ...(entry.dispatch
      ? { triggered: entry.dispatch.triggered, skipped: entry.dispatch.skipped }
      : {}),
  };
}

/**
 * POST /:id/entries — post. Trigger-only: 202 with the entry's identity, while
 * the entry itself rides the SSE stream to every reader including this one. The
 * body also says who it reached — see {@link accepted}.
 */
router.post('/:id/entries', (c) => {
  const body = parseOrRefuse(c, PostToRoomRequestSchema, readJsonBody(c));
  if (body instanceof Response) return body;
  return roomRoute(c, 'POST /:id/entries', (caller) => {
    const entry = getRoomService().post(
      c.req.param('id'),
      {
        authorId: caller().id,
        text: body.text,
        sessionId: body.sessionId,
        attachmentIds: body.attachmentIds,
      },
      caller().kind === 'agent',
      wifiTurnBound(honoRequestFacts(c))
    );
    return c.json(accepted(entry), 202);
  });
});

/**
 * POST /:id/entries/:entryId/reactions — put one emoji on an entry, or take it
 * back.
 *
 * **POST rather than PUT, and the verb is the honest one.** The default body is
 * a toggle, and a toggle is not idempotent: sending it twice is not sending it
 * once, which is what PUT promises. `PUT /api/read-cursors/room/:id` IS
 * idempotent — it sets a cursor to a value — and the two must not be spelled
 * alike. What IS idempotent here whatever the body says is the KEY:
 * `(you, this entry, this emoji)` holds at most one reaction however many times
 * anyone asks.
 *
 * 202 for the same reason posting is 202: the entry's new reaction set reaches
 * every reader — this one included — over `GET /:id/events`, so there is one
 * delivery path rather than two. The body carries only what the caller cannot
 * derive from its own click.
 *
 * **Two notes for the client half (B3), because getting either wrong is a bug a
 * person would see.** First: **do not retry a bare toggle.** A timeout does not
 * tell you whether the write landed, and re-sending the flip undoes it — send
 * `{ on: true | false }` instead, which names the state and is safe to repeat.
 * Second: **the stream is authoritative, not this response.** Draw the pill
 * optimistically by all means, but reconcile against the `reaction` frame rather
 * than against `reacted` here: somebody else may have reacted between your click
 * and your answer, and the frame carries the entry's whole set while this body
 * only says what YOUR click did.
 */
router.post('/:id/entries/:entryId/reactions', (c) => {
  const body = parseOrRefuse(c, ToggleReactionRequestSchema, readJsonBody(c));
  if (body instanceof Response) return body;
  return roomRoute(c, 'POST /:id/entries/:entryId/reactions', (caller) => {
    const entryId = c.req.param('entryId');
    const { reacted, frequents } = getRoomService().toggleReaction(
      c.req.param('id'),
      entryId,
      caller().id,
      body.emoji,
      body.on
    );
    return c.json({ accepted: true, entryId, emoji: body.emoji, reacted, frequents }, 202);
  });
});

/** POST /:id/members — add a member by author id or agent directory. */
router.post('/:id/members', (c) => {
  const body = parseOrRefuse(c, AddRoomMemberRequestSchema, readJsonBody(c));
  if (body instanceof Response) return body;
  return roomRoute(c, 'POST /:id/members', (caller) =>
    c.json(getRoomService().addMember(c.req.param('id'), caller().id, body), 201)
  );
});

/** PATCH /:id/members/:authorId — change a member's response mode. */
router.patch('/:id/members/:authorId', (c) => {
  const body = parseOrRefuse(c, UpdateMembershipRequestSchema, readJsonBody(c));
  if (body instanceof Response) return body;
  return roomRoute(c, 'PATCH /:id/members/:authorId', (caller) =>
    c.json(
      getRoomService().updateMembership(
        c.req.param('id'),
        caller().id,
        c.req.param('authorId'),
        body.responseMode
      )
    )
  );
});

/**
 * PATCH /authors/:authorId/handle — set or clear an author's address.
 *
 * **Human-initiated only, and that is an invariant rather than a convention.**
 * Any caller presenting `X-DorkOS-Agent` is refused here — 403 when the token
 * resolves to a live agent, 401 from `resolveCaller` when it does not — there is
 * no MCP tool for it, and no capability exposes it. That is the instrument
 * chosen over a rate limit: an agent that could rename itself in a loop would
 * grow the tombstone table a row at a time forever, and removing the mechanism
 * beats tuning a throttle around it.
 *
 * **The 401 half is DOR-1361, and until it landed this paragraph was not true.**
 * `resolveCaller` used to read an unverifiable token as "no agent presented", so
 * an agent whose token had been revoked or had expired resolved to the install
 * owner and renamed as the person — in a loop, at whatever rate it liked, which
 * is precisely the mechanism this route claims not to have.
 *
 * **A person may rename an agent, but only at this computer** (DOR-3156): from
 * Wi-Fi an agent's handle is refused like the rest of its setup, while a
 * person's own stays open. A rename of an agent writes one quiet line in each
 * room it is in (`renameAuthorHandle`).
 *
 * Declared before `/:id/…` would be a problem? No — `/authors` cannot be
 * mistaken for a room id, because a room id is a ULID and this path has a second
 * segment matched literally.
 */
/** What a person on Wi-Fi reads when they try to rename an agent. */
const WIFI_AGENT_HANDLE_REFUSAL = "Change an agent's handle at this computer.";

router.patch('/authors/:authorId/handle', (c) => {
  const body = parseOrRefuse(c, SetAuthorHandleRequestSchema, readJsonBody(c));
  if (body instanceof Response) return body;
  return roomRoute(c, 'PATCH /authors/:authorId/handle', (caller) => {
    if (caller().kind !== 'human') {
      throw new RoomError('OPERATOR_ONLY', 'Only a person can change a handle.');
    }
    const service = getRoomService();
    const authorId = c.req.param('authorId');
    const target = service.authorRegistry.getById(authorId);
    if (target && target.kind !== 'human' && isFromWifi(honoRequestFacts(c))) {
      return c.json({ error: WIFI_AGENT_HANDLE_REFUSAL, code: NOT_FROM_WIFI }, 403);
    }
    return c.json(toAuthorRef(renameAuthorHandle(service, caller().id, authorId, body.handle)));
  });
});

/** DELETE /:id/members/:authorId — remove a member. */
router.delete('/:id/members/:authorId', (c) =>
  roomRoute(c, 'DELETE /:id/members/:authorId', (caller) => {
    getRoomService().removeMember(c.req.param('id'), caller().id, c.req.param('authorId'));
    return c.body(null, 204);
  })
);

/*
 * There is deliberately no `PUT /:id/read-cursor` here. A read cursor is not a
 * room concept — the same table answers for rooms, agent sessions and the inbox
 * — so the one write path is `PUT /api/read-cursors/room/:id`, which delegates
 * into `RoomService.setReadCursor` for exactly the checks this route would have
 * made (team-room-home spec §D4, ADR 260808-140956). The room-shaped URL that
 * stood here through the migration is gone now that every client writes through
 * the generic one: a second URL onto one implementation is still a second thing
 * to keep true.
 *
 * It is not missed by AGENTS either, which is the objection worth answering.
 * What an agent has been shown is `room_members.last_read_seq`, and that is
 * advanced by the ambient participation loop as entries are actually delivered
 * to it — never by the agent asking. The route removed here was the one way an
 * agent could have claimed to have read entries it was never handed, so its
 * removal closes that door rather than taking a capability away.
 */

/**
 * POST /:id/threads — reply inside a thread off an entry in this room.
 *
 * Entry-level, not room-level: a thread is a relation between entries
 * (ADR 260728-022013), so there is nothing to create before replying and this
 * one route writes the first reply and every later one. Trigger-only and 202 for
 * the same reason `POST /:id/entries` is — the reply rides the room's own SSE
 * stream to every reader, this caller included.
 *
 * It stays a separate route rather than an optional field on `/:id/entries` so
 * that writing into a thread is a deliberate act with a required target, never
 * an omitted parameter.
 */
router.post('/:id/threads', (c) => {
  const body = parseOrRefuse(c, PostThreadReplyRequestSchema, readJsonBody(c));
  if (body instanceof Response) return body;
  return roomRoute(c, 'POST /:id/threads', (caller) => {
    const entry = getRoomService().post(
      c.req.param('id'),
      {
        authorId: caller().id,
        text: body.text,
        sessionId: body.sessionId,
        replyTo: body.rootEntryId,
        attachmentIds: body.attachmentIds,
      },
      caller().kind === 'agent',
      wifiTurnBound(honoRequestFacts(c))
    );
    return c.json(accepted(entry), 202);
  });
});

/**
 * POST /:id/halt — stop every agent turn running in this room.
 *
 * **The whole point of this route is that it is a route.** Stopping a room is a
 * control action that reaches the runtimes; it is never inferred from a message,
 * in this phase or any later one (room-participation spec §10.4). A person who
 * types "stop" into the composer has sent a message, and the agents answer it
 * like any other — which is exactly why the button has to exist.
 *
 * Takes no body: there is nothing to say, only a thing to do. An empty POST
 * reads as no body at all, so asking for one would refuse every honest caller.
 */
router.post('/:id/halt', (c) =>
  roomRoute(c, 'POST /:id/halt', async (caller) => {
    const stopped = await getRoomService().haltRoom(c.req.param('id'), caller().id);
    return c.json({ stopped });
  })
);

/**
 * POST /:id/halt/:authorId — stop one agent's turn in this room.
 *
 * A sibling of `POST /:id/halt` rather than a field on it, and the difference is
 * the failure mode. That route takes no body on purpose (an empty POST reads
 * as no body at all), and an optional `authorId` in one would fail OPEN: a client that forgot to send it would stop the whole room. A
 * path segment cannot be forgotten. `PATCH` and `DELETE /:id/members/:authorId`
 * are the precedent for an author-scoped room sub-path.
 *
 * Same gate as the room-wide stop: only a person, and only in a room they can
 * see. Allowed on an archived room for the same reason.
 */
router.post('/:id/halt/:authorId', (c) =>
  roomRoute(c, 'POST /:id/halt/:authorId', async (caller) => {
    const stopped = await getRoomService().haltAgent(
      c.req.param('id'),
      c.req.param('authorId'),
      caller().id
    );
    return c.json({ stopped });
  })
);

/**
 * POST /:id/holds/:authorId/promote — ask for this room to be answered first.
 *
 * The one control a person has over a message that is waiting on an agent busy
 * in another conversation. It REORDERS: the blocking turn is untouched, nothing
 * is interrupted, and the promoted message still waits for the agent to be free.
 * Gated exactly as `POST /:id/halt` is, because it is the same kind of act — a
 * person steering their own room — and for the same reason only a person may
 * call it.
 *
 * `{ promoted: false }` is a normal answer, not an error: it means there was
 * nothing waiting, which is what a button left over from a wait that already
 * ended looks like. Takes no body.
 */
router.post('/:id/holds/:authorId/promote', (c) =>
  roomRoute(c, 'POST /:id/holds/:authorId/promote', (caller) => {
    const promoted = getRoomService().promoteHold(
      c.req.param('id'),
      c.req.param('authorId'),
      caller().id
    );
    return c.json({ promoted });
  })
);

/**
 * GET /:id/events — the durable room stream (snapshot → replay → live).
 *
 * The same path is also served over a WebSocket (`room-events-socket.ts`),
 * which is what the app connects to; this SSE route stays as the public
 * integration contract. Both share their sequencing — see
 * `services/rooms/room-stream-delivery.ts`.
 */
router.get('/:id/events', roomEventsHandler);

/**
 * The room's other surfaces, each its own group: the attachments, the room's
 * own files, the shared canvas and following.
 *
 * The canvas and following are mounted under `/:id/...`, so `:id` is the room
 * in every handler there. They are registered LAST, after `/:id/events` and
 * every other `/:id/...` route, so no earlier pattern can swallow one of
 * their paths.
 */
router.route('/', roomAttachmentRoutes);
router.route('/', roomFileRoutes);
router.route('/:id/canvas', roomCanvasRoutes);
router.route('/:id/follow', roomFollowRoutes);
router.route('/:id/members/:authorId', roomReseatRoutes);

export default router;
