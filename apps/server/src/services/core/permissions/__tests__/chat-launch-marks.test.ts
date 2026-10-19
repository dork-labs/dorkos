/**
 * The durable reading of a chat's launch (DOR-3106/3107) against a real database: what is
 * marked or from outside stays capped, and unknown raises.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { Db } from '@dorkos/db';
import { createTestDb } from '@dorkos/test-utils/db';

import { chatLaunchMarks } from '../chat-launch-marks.js';

const NOW = '2026-10-19T12:00:00.000Z';
const LEVEL = { asks: 'never', reach: 'everything' };

let db: Db;
beforeEach(() => {
  db = createTestDb();
  signIns = 0;
});

/** One chat row. */
function chat(id: string, origin: string | null, createdAt = NOW) {
  db.run(sql`INSERT INTO session_metadata (session_id, runtime, launch_origin, created_at)
    VALUES (${id}, 'claude-code', ${origin}, ${createdAt})`);
}

let signIns = 0;
/** A sign-in on a route, live from `from` to `to` (ISO times). */
function signIn(route: string | null, from: string, to: string) {
  signIns += 1;
  if (signIns === 1) {
    db.run(sql`INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
      VALUES ('u', 'u', 'u@example.com', 1, 0, 0)`);
  }
  db.run(sql`INSERT INTO session (id, expires_at, token, created_at, updated_at, route, user_id)
    VALUES (${`s-${signIns}`}, ${Date.parse(to)}, ${`t-${signIns}`}, ${Date.parse(from)},
      ${Date.parse(from)}, ${route}, 'u')`);
}

/** The Wi-Fi hold column a later migration adds (DOR-3037), for a database that lacks it. */
function addHeldColumn() {
  const columns = db.all<{ name: string }>(sql`PRAGMA table_info(room_entries)`);
  if (!columns.some((c) => c.name === 'held_to_default')) {
    db.run(sql`ALTER TABLE room_entries ADD COLUMN held_to_default integer DEFAULT false NOT NULL`);
  }
}

/** The first message to a chat, from another. */
function opener(to: string, from: string, ceiling: unknown, kind = 'message') {
  db.run(sql`INSERT INTO chat_messages (id, to_session_id, from_session_id, from_agent_path,
    from_agent_name, kind, text, delivery, status, ceiling_json, created_at, updated_at)
    VALUES (${`m-${to}`}, ${to}, ${from}, '/a', 'a', ${kind}, 'hi', 'queue', 'delivered',
      ${JSON.stringify(ceiling)}, ${NOW}, ${NOW})`);
}

/** A chat another chat started with `session_start`. */
function startedBy(id: string, by: string | null, kind = 'chat') {
  db.run(sql`INSERT INTO session_started_by (session_id, kind, started_by_session_id, created_at)
    VALUES (${id}, ${kind}, ${by}, ${NOW})`);
}

/** A room, a seat for a chat in it, and an author. */
function room(roomId: string, sessionId: string) {
  db.run(sql`INSERT INTO rooms (id, kind, title, created_at, last_activity_at)
    VALUES (${roomId}, 'channel', 'r', ${NOW}, ${NOW})`);
  db.run(sql`INSERT INTO room_sessions (room_id, author_id, session_id, created_at)
    VALUES (${roomId}, 'agent-1', ${sessionId}, ${NOW})`);
}

/** An author with a natural key. */
function author(id: string, naturalKey: string) {
  db.run(sql`INSERT INTO authors (id, kind, natural_key, display_name, created_at)
    VALUES (${id}, 'human', ${naturalKey}, 'x', ${NOW})`);
}

let seq = 0;
/** A post in a room, with its kept marks. */
function post(roomId: string, authorId: string, turnMarks: string | null) {
  seq += 1;
  db.run(sql`INSERT INTO room_entries (room_id, seq, id, author_id, kind, body, cascade_root,
    created_at, turn_marks)
    VALUES (${roomId}, ${seq}, ${`e-${seq}`}, ${authorId}, 'post', 'b', ${`e-${seq}`}, ${NOW},
      ${turnMarks})`);
  return `e-${seq}`;
}

describe('chatLaunchMarks', () => {
  it('reads every outside origin as outside, and an own origin with nothing kept as unknown', () => {
    const marked = chatLaunchMarks(db);
    for (const origin of ['relay-binding', 'outside-sender', 'connector-event', 'agent-dm']) {
      expect(marked('x', origin), origin).toBe(true);
    }
    for (const origin of [null, 'interactive', 'heartbeat', 'chat-message']) {
      expect(marked('x', origin), String(origin)).toBe(false);
    }
  });

  it('a chat a message opened: marked only when the opener was marked or sent from outside', () => {
    chat('own-sender', 'interactive');
    chat('tg-sender', 'relay-binding');
    opener('unknown', 'own-sender', 'runtime-default');
    opener('list', 'own-sender', [LEVEL, 'runtime-default']);
    opener('marked-list', 'own-sender', [{ ...LEVEL, outsider: true }, 'runtime-default']);
    opener('level', 'own-sender', LEVEL);
    opener('outsider', 'own-sender', { ...LEVEL, outsider: true });
    opener('teammate', 'own-sender', { ...LEVEL, teammate: [{ roomId: 'r', authorId: 'a' }] });
    opener('from-telegram', 'tg-sender', 'runtime-default');
    const marked = chatLaunchMarks(db);

    expect(marked('unknown', 'chat-message')).toBe(false);
    expect(marked('list', 'chat-message')).toBe(false);
    expect(marked('marked-list', 'chat-message')).toBe(true);
    expect(marked('level', 'chat-message')).toBe(false);
    expect(marked('no-opener', 'chat-message')).toBe(false);
    expect(marked('outsider', 'chat-message')).toBe(true);
    expect(marked('teammate', 'chat-message')).toBe(true);
    expect(marked('from-telegram', 'chat-message')).toBe(true);
  });

  it('an agent launch: outside unless a chat of our own started it unmarked', () => {
    chat('own-starter', 'interactive');
    chat('tg-starter', 'relay-binding');
    startedBy('ok', 'own-starter');
    opener('ok', 'own-starter', LEVEL, 'start');
    startedBy('marked', 'own-starter');
    opener('marked', 'own-starter', { ...LEVEL, outsider: true }, 'start');
    startedBy('from-telegram', 'tg-starter');
    startedBy('extension', null, 'extension');
    const marked = chatLaunchMarks(db);

    expect(marked('ok', 'agent-launch')).toBe(false);
    expect(marked('marked', 'agent-launch')).toBe(true);
    expect(marked('from-telegram', 'agent-launch')).toBe(true);
    expect(marked('extension', 'agent-launch')).toBe(true);
    // No starting chat: the external /mcp server or HTTP, unverified.
    expect(marked('mcp', 'agent-launch')).toBe(true);
  });

  it('a room chat: raised only in a room of our own with no marked or outside post', () => {
    author('me', 'user:local');
    author('tg', 'platform:telegram:42');
    room('clean', 'clean-chat');
    post('clean', 'me', null);
    post('clean', 'me', '{}');
    room('marked', 'marked-chat');
    post('marked', 'me', JSON.stringify({ outsider: true }));
    room('stranger', 'stranger-chat');
    post('stranger', 'tg', null);
    room('no-author', 'no-author-chat');
    post('no-author', 'ghost', null);
    room('bridged', 'bridged-chat');
    db.run(sql`INSERT INTO room_bridges (room_id, adapter_id, chat_id, platform_chat_type,
      binding_id, deliver_notices, created_at)
      VALUES ('bridged', 'tg', 'c', 'group', 'b', 1, ${NOW})`);
    room('space', 'space-chat');
    db.run(sql`INSERT INTO community_room_mirrors (local_room_id, community_ref, remote_room_id,
      owner_author_id, state, authorized_at)
      VALUES ('space', 'c', 'r', 'o', 'active', ${NOW})`);
    const marked = chatLaunchMarks(db, true);

    expect(marked('clean-chat', 'room')).toBe(false);
    expect(marked('marked-chat', 'room')).toBe(true);
    expect(marked('stranger-chat', 'room')).toBe(true);
    expect(marked('no-author-chat', 'room')).toBe(true);
    expect(marked('bridged-chat', 'room')).toBe(true);
    expect(marked('space-chat', 'room')).toBe(true);
    // No seat: the room cannot be checked, so it is not raised.
    expect(marked('seatless', 'room')).toBe(true);
  });

  it('a room chat in a room holding a post held to the default (a Wi-Fi sign-in’s) stays', () => {
    addHeldColumn();
    author('me', 'user:local');
    room('wifi', 'wifi-chat');
    post('wifi', 'me', null);
    const held = post('wifi', 'me', null);
    db.run(sql`UPDATE room_entries SET held_to_default = 1 WHERE id = ${held}`);
    room('local', 'local-chat');
    post('local', 'me', null);
    const marked = chatLaunchMarks(db, true);

    expect(marked('wifi-chat', 'room')).toBe(true);
    expect(marked('local-chat', 'room')).toBe(false);
  });

  it('a room chat still raises on a database without the hold column', () => {
    const columns = db.all<{ name: string }>(sql`PRAGMA table_info(room_entries)`);
    if (columns.some((c) => c.name === 'held_to_default')) {
      db.run(sql`ALTER TABLE room_entries DROP COLUMN held_to_default`);
    }
    author('me', 'user:local');
    room('clean', 'clean-chat');
    post('clean', 'me', null);

    expect(chatLaunchMarks(db)('clean-chat', 'room')).toBe(false);
  });

  it('a chat a Wi-Fi-held turn opened stays: the sender level carries the outsider mark', () => {
    chat('wifi-sender', 'interactive');
    // What a turn held to 'runtime-default' records (`marksOfCeiling`), and a message stores.
    opener('by-message', 'wifi-sender', { asks: 'always', reach: 'everything', outsider: true });
    startedBy('by-start', 'wifi-sender');
    opener(
      'by-start',
      'wifi-sender',
      { asks: 'always', reach: 'everything', outsider: true },
      'start'
    );
    const marked = chatLaunchMarks(db);

    expect(marked('by-message', 'chat-message')).toBe(true);
    expect(marked('by-start', 'agent-launch')).toBe(true);
  });

  it('a chat a person opened during a live Wi-Fi sign-in stays, and so do the chats it opens', () => {
    signIn('wifi', '2026-10-19T11:00:00.000Z', '2026-10-19T13:00:00.000Z');
    chat('during', 'interactive');
    chat('during-legacy', null);
    opener('child', 'during', 'runtime-default');
    const marked = chatLaunchMarks(db);

    expect(marked('during', 'interactive')).toBe(true);
    expect(marked('during-legacy', null)).toBe(true);
    expect(marked('child', 'chat-message')).toBe(true);
  });

  it('a chat a person opened outside any Wi-Fi sign-in’s life still rises', () => {
    signIn('wifi', '2026-10-19T08:00:00.000Z', '2026-10-19T09:00:00.000Z');
    signIn('wifi', '2026-10-19T14:00:00.000Z', '2026-10-19T15:00:00.000Z');
    chat('between', 'interactive');
    const marked = chatLaunchMarks(db);

    expect(marked('between', 'interactive')).toBe(false);
  });

  it('a chat made with only local, tunnel, network or older sign-ins live still rises', () => {
    for (const route of ['local', 'tunnel', 'network', null]) {
      signIn(route, '2026-10-19T11:00:00.000Z', '2026-10-19T13:00:00.000Z');
    }
    chat('not-wifi', 'interactive');
    const marked = chatLaunchMarks(db);

    expect(marked('not-wifi', 'interactive')).toBe(false);
    expect(marked('no-row', 'interactive')).toBe(false);
  });
});
