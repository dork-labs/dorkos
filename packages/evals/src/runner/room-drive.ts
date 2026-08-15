/**
 * The ROOM drive loop: commit posts into a channel as a person and collect what
 * the room does about them.
 *
 * `drive.ts` drives one session — `POST /api/sessions/:id/messages` and the
 * durable per-session stream. A room is the other half of the product and it
 * has neither: a post goes to `POST /api/rooms/:id/entries` (trigger-only, 202,
 * exactly like a session message), and everything that follows — who was
 * triggered, what they said, whether the room said anything on their behalf —
 * arrives on `GET /api/rooms/:id/events` as `entry`, `signal` and `reaction`
 * frames. This module is that missing primitive (the first of the two harness
 * gaps `specs/engaged-response-gate/01-ideation.md` §13.2 names).
 *
 * ## Why the collection stops on QUIET rather than on a terminal frame
 *
 * A session turn ends with `turn_end`, which is what `drive.ts` waits for. **A
 * room has no such frame and cannot have one**: a post may trigger no agent at
 * all (which is a result, not a hang), several agents at once, or one agent that
 * answers half a second later because the collect window gathered a burst first.
 * So a room drive is bounded two ways instead:
 *
 * - `settleWhen` — an optional predicate over the frames so far, for a case that
 *   knows exactly what it is waiting for (a reply from this agent, a notice);
 * - the QUIET WINDOW — once frames stop arriving for `quietMs`, the room is
 *   taken to have finished reacting. This is what makes "nobody answered" a
 *   measurable outcome in bounded time instead of a timeout.
 *
 * Both sit under a hard `timeoutMs`, and every exit path destroys the `/events`
 * connection — the same guarantee `drive.ts` makes.
 *
 * ## Subscribe-first, for the same reason as a session
 *
 * The stream is opened and its cold `snapshot` awaited BEFORE any post, so a
 * fast room (test-mode answers in ~30ms) cannot complete in the gap and leave
 * the collector holding an empty log.
 *
 * ## Every post is the operator's
 *
 * `resolveCaller` (`routes/room-caller.ts`) resolves an un-headered request to
 * whoever owns the install, and an agent posts as itself only by presenting a
 * minted identity token. The harness holds no such token, so **every post this
 * module makes is the person at the keyboard** — which is the right voice for a
 * room eval (the trigger under test is what a person said), and which is why a
 * case that wants two human voices cannot have them: this install has one.
 *
 * @module evals/runner/room-drive
 */
import http from 'node:http';
import { parseFrames, type SseFrame } from '@dorkos/test-utils/sse-test-helpers';
import type { RoomFacts, RoomMemberFacts } from '../types.js';

/** Default hard ceiling (ms) on one room drive. */
const DEFAULT_ROOM_TIMEOUT_MS = 60_000;

/** Default quiet window (ms): no frame for this long ends the collection. */
const DEFAULT_QUIET_MS = 2_500;

/** Default wait (ms) for the cold `snapshot` before the subscribe gate fails. */
const DEFAULT_READY_TIMEOUT_MS = 15_000;

/** A room request that did not do what the room API promises. */
export class RoomDriveError extends Error {
  /**
   * Construct a room drive error carrying a stable machine code.
   *
   * @param message - Human-readable cause.
   * @param code - Stable machine code.
   * @param status - The HTTP status the call returned, when relevant.
   * @param options - Standard error options (e.g. `cause`).
   */
  constructor(
    message: string,
    readonly code: 'ROOM_REQUEST_FAILED' | 'POST_REJECTED' | 'STREAM_ERROR',
    readonly status?: number,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'RoomDriveError';
  }
}

/** JSON request helper: throws a {@link RoomDriveError} on any non-2xx. */
async function roomFetch<T>(
  baseUrl: string,
  path: string,
  init: { method: string; body?: unknown }
): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: init.method,
    headers: { 'Content-Type': 'application/json' },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  if (!res.ok && res.status !== 202) {
    throw new RoomDriveError(
      `${init.method} ${path} returned ${res.status}: ${text.slice(0, 300)}`,
      'ROOM_REQUEST_FAILED',
      res.status
    );
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

/** The room-shaped roster row the API answers with. */
interface RosterRow {
  authorId: string;
  responseMode: string;
  author?: { kind?: string; handle?: string | null };
}

/** The room-with-roster body `POST /api/rooms` answers with. */
interface RoomWithRoster {
  id: string;
  members: RosterRow[];
}

/**
 * Open a channel with the operator plus the named agent directories, and read
 * its roster back as {@link RoomFacts}.
 *
 * The agents must already be REGISTERED — a room resolves an agent through the
 * mesh cache keyed on its directory, so a manifest written on disk after the
 * server booted is invisible here. Seed them into `<DORK_HOME>/agents/<slug>/`
 * before the boot and both tiers find them (the in-process harness reconciles
 * at boot, the real server does the same in `start()`).
 *
 * @param opts.baseUrl - The running harness server.
 * @param opts.title - The channel's title.
 * @param opts.slug - The channel's `#name`.
 * @param opts.agents - Agent directories keyed by the slug the case uses.
 * @returns The room and its resolved roster.
 */
export async function createRoomWithAgents(opts: {
  baseUrl: string;
  title: string;
  slug: string;
  agents: Record<string, string>;
}): Promise<RoomFacts> {
  const paths = Object.values(opts.agents);
  const room = await roomFetch<RoomWithRoster>(opts.baseUrl, '/api/rooms', {
    method: 'POST',
    body: { kind: 'channel', title: opts.title, slug: opts.slug, agentPaths: paths },
  });

  const members: Record<string, RoomMemberFacts> = {};
  for (const row of room.members) {
    members[row.authorId] = {
      authorId: row.authorId,
      handle: row.author?.handle ?? null,
      kind: row.author?.kind ?? 'unknown',
      responseMode: row.responseMode,
    };
  }
  const operator = room.members.find((m) => m.author?.kind === 'human');
  if (!operator) {
    throw new RoomDriveError(
      'the created room has no human member, so nothing can post into it',
      'ROOM_REQUEST_FAILED'
    );
  }

  // Roster order follows the `agentPaths` order the room was created with, so
  // the Nth agent member is the Nth seeded slug. Matching on order rather than
  // on handle is deliberate: a handle is minted from the manifest name and can
  // be suffixed on a collision, and a case must not have to predict that.
  const agentRows = room.members.filter((m) => m.author?.kind === 'agent');
  const agents: Record<string, string> = {};
  Object.keys(opts.agents).forEach((slug, index) => {
    const row = agentRows[index];
    if (row) agents[slug] = row.authorId;
  });

  return {
    roomId: room.id,
    members,
    agents,
    operatorAuthorId: operator.authorId,
    notes: {},
  };
}

/**
 * Set one member's response mode in this room (`PATCH /:id/members/:authorId`).
 *
 * A channel seats every agent as `engaged` by default, so a case that is about
 * a quieter mode has to say so — and saying it through the real route is what
 * keeps the eval about the product rather than about a fixture.
 *
 * @param opts.baseUrl - The running harness server.
 * @param opts.roomId - The room.
 * @param opts.authorId - The member being changed.
 * @param opts.responseMode - The mode to set.
 */
export async function setResponseMode(opts: {
  baseUrl: string;
  roomId: string;
  authorId: string;
  responseMode: string;
}): Promise<void> {
  await roomFetch(opts.baseUrl, `/api/rooms/${opts.roomId}/members/${opts.authorId}`, {
    method: 'PATCH',
    body: { responseMode: opts.responseMode },
  });
}

/** What one committed post reports back. */
export interface PostedEntry {
  /** The committed entry's id. */
  entryId: string;
  /** Its room sequence number. */
  seq: number;
}

/**
 * Post into a room as the operator. Trigger-only: the 202 carries the entry's
 * identity and the entry itself reaches the stream.
 *
 * @param opts.baseUrl - The running harness server.
 * @param opts.roomId - The room to post into.
 * @param opts.text - The message, `@handle` mentions included.
 * @returns The committed entry's id and seq.
 */
export async function postToRoom(opts: {
  baseUrl: string;
  roomId: string;
  text: string;
}): Promise<PostedEntry> {
  const body = await roomFetch<{ accepted?: boolean; entryId?: string; seq?: number }>(
    opts.baseUrl,
    `/api/rooms/${opts.roomId}/entries`,
    { method: 'POST', body: { text: opts.text } }
  );
  if (!body?.entryId) {
    throw new RoomDriveError('the room accepted a post but named no entry', 'POST_REJECTED');
  }
  return { entryId: body.entryId, seq: body.seq ?? 0 };
}

/**
 * Reply inside a thread hanging off an entry in this room
 * (`POST /:id/threads`).
 *
 * A thread is a relation between entries, not a room of its own
 * (ADR 260728-022013), so there is nothing to create first — this one call
 * writes the first reply and every later one.
 *
 * @param opts.baseUrl - The running harness server.
 * @param opts.roomId - The room the thread lives in.
 * @param opts.rootEntryId - The entry at the head of the thread.
 * @param opts.text - The reply, `@handle` mentions included.
 * @returns The committed reply's id and seq.
 */
export async function postThreadReply(opts: {
  baseUrl: string;
  roomId: string;
  rootEntryId: string;
  text: string;
}): Promise<PostedEntry> {
  const body = await roomFetch<{ entryId?: string; seq?: number }>(
    opts.baseUrl,
    `/api/rooms/${opts.roomId}/threads`,
    { method: 'POST', body: { rootEntryId: opts.rootEntryId, text: opts.text } }
  );
  if (!body?.entryId) {
    throw new RoomDriveError(
      'the room accepted a thread reply but named no entry',
      'POST_REJECTED'
    );
  }
  return { entryId: body.entryId, seq: body.seq ?? 0 };
}

/**
 * Put one emoji on an entry as the operator
 * (`POST /:id/entries/:entryId/reactions`).
 *
 * Sent as `{ on: true }` rather than as a bare toggle, so the call names the
 * state it wants and is safe to repeat — the same advice the route gives its
 * client half.
 *
 * @param opts.baseUrl - The running harness server.
 * @param opts.roomId - The room.
 * @param opts.entryId - The entry being reacted to.
 * @param opts.emoji - The emoji to put on it.
 */
export async function reactToEntry(opts: {
  baseUrl: string;
  roomId: string;
  entryId: string;
  emoji: string;
}): Promise<void> {
  await roomFetch(opts.baseUrl, `/api/rooms/${opts.roomId}/entries/${opts.entryId}/reactions`, {
    method: 'POST',
    body: { emoji: opts.emoji, on: true },
  });
}

/**
 * Upload one file into a room and return its attachment id, ready to be named
 * by the message that carries it (`POST /:id/attachments`).
 *
 * Two-step by the room's own design: the bytes go up first and the message
 * names them by id, which is what keeps every stored field server-derived.
 *
 * @param opts.baseUrl - The running harness server.
 * @param opts.roomId - The room to upload into.
 * @param opts.name - The file name a person would see.
 * @param opts.contents - The file's text.
 * @returns The stored attachment's id.
 */
export async function uploadRoomAttachment(opts: {
  baseUrl: string;
  roomId: string;
  name: string;
  contents: string;
}): Promise<string> {
  const form = new FormData();
  form.append('files', new Blob([opts.contents], { type: 'text/plain' }), opts.name);
  const res = await fetch(`${opts.baseUrl}/api/rooms/${opts.roomId}/attachments`, {
    method: 'POST',
    body: form,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new RoomDriveError(
      `uploading "${opts.name}" returned ${res.status}: ${text.slice(0, 300)}`,
      'ROOM_REQUEST_FAILED',
      res.status
    );
  }
  const body = JSON.parse(text) as { attachments?: Array<{ id?: string }> };
  const id = body.attachments?.[0]?.id;
  if (!id) {
    throw new RoomDriveError('the room stored the file but named no attachment', 'POST_REJECTED');
  }
  return id;
}

/**
 * Post into a room naming files already uploaded to it.
 *
 * @param opts.baseUrl - The running harness server.
 * @param opts.roomId - The room to post into.
 * @param opts.text - The message.
 * @param opts.attachmentIds - Ids from {@link uploadRoomAttachment}.
 * @returns The committed entry's id and seq.
 */
export async function postWithAttachments(opts: {
  baseUrl: string;
  roomId: string;
  text: string;
  attachmentIds: string[];
}): Promise<PostedEntry> {
  const body = await roomFetch<{ entryId?: string; seq?: number }>(
    opts.baseUrl,
    `/api/rooms/${opts.roomId}/entries`,
    { method: 'POST', body: { text: opts.text, attachmentIds: opts.attachmentIds } }
  );
  if (!body?.entryId) {
    throw new RoomDriveError('the room accepted a post but named no entry', 'POST_REJECTED');
  }
  return { entryId: body.entryId, seq: body.seq ?? 0 };
}

/**
 * Stop every agent turn running in a room (`POST /:id/halt`).
 *
 * @param opts.baseUrl - The running harness server.
 * @param opts.roomId - The room to stop.
 * @returns How many in-flight turns the room interrupted.
 */
export async function haltRoom(opts: { baseUrl: string; roomId: string }): Promise<number> {
  const body = await roomFetch<{ stopped?: number }>(
    opts.baseUrl,
    `/api/rooms/${opts.roomId}/halt`,
    { method: 'POST' }
  );
  return body?.stopped ?? 0;
}

/** A signal frame's identity, for the quiet check below. */
interface QuietSignalData {
  signal?: string;
  authorId?: string;
  entryId?: string;
  state?: string;
}

/**
 * What "the room has gone quiet" is measured on: everything the room has SAID,
 * with repeats of what it already said folded away.
 *
 * Two things repeat on a live room stream forever and neither is news, so a
 * quiet window measured on bytes — or even on frames — can never close in their
 * presence:
 *
 * - the SSE sink writes a `: keepalive` comment every few seconds, which is not
 *   a frame at all but is bytes on the socket;
 * - a held claim RE-STATES its working indicator every ten seconds
 *   (`PRESENCE_REPUBLISH_MS`), so an agent that is genuinely working produces an
 *   identical signal frame indefinitely.
 *
 * Measured, not theorised: a case whose quiet window was twenty seconds waited
 * out its entire four-minute ceiling and reported a timeout for a room that had
 * finished answering in the first ten seconds. So the signature counts committed
 * entries and DISTINCT `(agent, trigger, state)` indicators — the things a room
 * only ever says once.
 *
 * @param frames - The frames collected so far.
 * @returns A string that changes only when the room says something new.
 */
function quietSignature(frames: SseFrame[]): string {
  let entries = 0;
  const signals = new Set<string>();
  for (const frame of frames) {
    if (frame.event === 'entry') {
      entries += 1;
      continue;
    }
    if (frame.event !== 'signal') continue;
    const data = frame.data as QuietSignalData;
    signals.add(
      `${data.signal ?? ''}:${data.authorId ?? ''}:${data.entryId ?? ''}:${data.state ?? ''}`
    );
  }
  return `${entries}/${signals.size}`;
}

/** Options for {@link openRoomStream}. */
export interface OpenRoomStreamOptions {
  /** The running harness server. */
  baseUrl: string;
  /** The room to subscribe to. */
  roomId: string;
  /** Hard ceiling on the whole collection. Default 60000. */
  timeoutMs?: number;
  /** Subscribe-gate timeout for the cold snapshot. Default 15000. */
  readyTimeoutMs?: number;
}

/** A live room stream: a ready gate, the frames so far, and a teardown. */
export interface RoomStream {
  /** Resolves once the cold `snapshot` has arrived — safe to post after this. */
  ready: Promise<void>;
  /** Every frame collected so far, re-parsed from the raw buffer. */
  frames: () => SseFrame[];
  /**
   * Resolve once `settleWhen` holds, or once the room has said nothing NEW for
   * `quietMs`, whichever comes first. Rejects only on a stream error or the
   * hard timeout — "nobody answered" is a normal, quiet resolution.
   *
   * @param opts.settleWhen - Stop as soon as this holds over the frames so far.
   * @param opts.quietMs - Idle window that ends the collection. Default 2500.
   */
  settle: (opts?: {
    settleWhen?: (frames: SseFrame[]) => boolean;
    quietMs?: number;
  }) => Promise<SseFrame[]>;
  /** Destroy the connection. Idempotent. */
  close: () => void;
}

/**
 * Subscribe to a room's durable stream and collect frames into a buffer the
 * caller drains with {@link RoomStream.settle}.
 *
 * Kept open ACROSS posts on purpose: a burst case posts three messages into one
 * subscription and then asks how many turns the room ran, which a
 * connect-per-post collector could not answer.
 *
 * @param opts - See {@link OpenRoomStreamOptions}.
 * @returns The live {@link RoomStream}.
 */
export function openRoomStream(opts: OpenRoomStreamOptions): RoomStream {
  const url = new URL(opts.baseUrl);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_ROOM_TIMEOUT_MS;
  const readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;

  let raw = '';
  let closed = false;
  let failure: Error | undefined;

  let signalReady!: () => void;
  let failReady!: (err: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    signalReady = resolve;
    failReady = reject;
  });
  let readySettled = false;
  const markReady = (): void => {
    if (readySettled) return;
    readySettled = true;
    clearTimeout(readyTimer);
    signalReady();
  };

  const req = http.request(
    {
      host: url.hostname,
      port: Number(url.port),
      path: `/api/rooms/${opts.roomId}/events`,
      method: 'GET',
    },
    (res) => {
      if (res.statusCode !== 200) {
        fail(
          new RoomDriveError(
            `room /events returned ${res.statusCode}`,
            'STREAM_ERROR',
            res.statusCode
          )
        );
        return;
      }
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        raw += chunk;
        if (raw.includes('event: snapshot')) markReady();
      });
    }
  );

  /** Record a fatal stream error and tear the connection down. */
  function fail(err: Error): void {
    if (failure) return;
    failure = err;
    if (!readySettled) {
      readySettled = true;
      clearTimeout(readyTimer);
      failReady(err);
    }
    close();
  }

  /** Destroy the connection. Idempotent. */
  function close(): void {
    if (closed) return;
    closed = true;
    clearTimeout(readyTimer);
    req.destroy();
  }

  req.on('error', (err: unknown) => {
    fail(
      new RoomDriveError(
        `room /events stream error: ${err instanceof Error ? err.message : String(err)}`,
        'STREAM_ERROR',
        undefined,
        { cause: err }
      )
    );
  });

  const readyTimer = setTimeout(
    () =>
      fail(
        new RoomDriveError(
          `Timed out after ${readyTimeoutMs}ms waiting for the room /events snapshot`,
          'STREAM_ERROR'
        )
      ),
    readyTimeoutMs
  );

  req.end();

  const frames = (): SseFrame[] => parseFrames(raw);

  const settle = async (settleOpts?: {
    settleWhen?: (frames: SseFrame[]) => boolean;
    quietMs?: number;
  }): Promise<SseFrame[]> => {
    const quietMs = settleOpts?.quietMs ?? DEFAULT_QUIET_MS;
    const deadline = Date.now() + timeoutMs;
    // Restarted here rather than carried from the last frame, so a `settle()`
    // called after a long-running step gives the room its full quiet window.
    let lastChangeAt = Date.now();
    let previous = quietSignature(frames());
    for (;;) {
      if (failure) throw failure;
      const collected = frames();
      if (settleOpts?.settleWhen?.(collected)) return collected;
      const current = quietSignature(collected);
      if (current !== previous) {
        previous = current;
        lastChangeAt = Date.now();
      }
      if (Date.now() - lastChangeAt >= quietMs) return collected;
      if (Date.now() > deadline) {
        throw new RoomDriveError(
          `the room did not settle within ${timeoutMs}ms (last new event ${Date.now() - lastChangeAt}ms ago)`,
          'STREAM_ERROR',
          undefined
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  return { ready, frames, settle, close };
}

/**
 * Wait until a predicate holds over a live room stream, without ending the
 * collection — the halt case's lever, which has to press Stop WHILE a turn is
 * running rather than after it.
 *
 * @param stream - The live room stream.
 * @param predicate - What must become true.
 * @param opts.timeoutMs - How long to wait. Default 15000.
 * @throws {RoomDriveError} When the predicate never holds.
 */
export async function waitForRoomFrames(
  stream: RoomStream,
  predicate: (frames: SseFrame[]) => boolean,
  opts: { timeoutMs?: number } = {}
): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
  for (;;) {
    if (predicate(stream.frames())) return;
    if (Date.now() > deadline) {
      throw new RoomDriveError('the room never reached the awaited state', 'STREAM_ERROR');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Select the deterministic turn scenario the `test-mode` runtime answers with
 * (`POST /api/test/scenario`), so a structural case can decide whether an agent
 * turn finishes at once or keeps working until it is stopped.
 *
 * Only reachable on the in-process tier, which boots with `DORKOS_TEST_RUNTIME`
 * set. It is a no-op returning `false` anywhere else — a credentialed case
 * neither needs it nor should silently depend on it.
 *
 * @param opts.baseUrl - The running harness server.
 * @param opts.scenario - The scenario name (`simple-text`, `long-turn`, …).
 * @returns True when the server accepted the selection.
 */
export async function selectTestScenario(opts: {
  baseUrl: string;
  scenario: string;
}): Promise<boolean> {
  const res = await fetch(`${opts.baseUrl}/api/test/scenario`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: opts.scenario }),
  });
  return res.status === 200;
}

/**
 * End every running `long-turn` at its next heartbeat
 * (`POST /api/test/finish-turn`), so a halt case leaves no three-minute turn
 * ticking inside the harness process after its assertions are made.
 *
 * @param opts.baseUrl - The running harness server.
 */
export async function finishTestTurns(opts: { baseUrl: string }): Promise<void> {
  await fetch(`${opts.baseUrl}/api/test/finish-turn`, { method: 'POST' });
}

/**
 * Put the test-mode runtime back to its shipped default (`POST /api/test/reset`).
 *
 * **A case that selects a scenario owes this**, because the scenario store is a
 * MODULE singleton and the in-process tier boots every eval inside one runner
 * process: a scenario one case chose is still chosen for the next one, whose
 * server is a different server entirely. Measured — after the halt case picked
 * `long-turn`, every later case in the same run got that scenario's text instead
 * of the echo they were written against, which changes what a reader of
 * `results.json` is looking at without changing anything they can see.
 *
 * @param opts.baseUrl - The running harness server.
 */
export async function resetTestMode(opts: { baseUrl: string }): Promise<void> {
  await fetch(`${opts.baseUrl}/api/test/reset`, { method: 'POST' });
}
