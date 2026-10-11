/**
 * A room turn's session is read by whoever the ROOM says (spec `audit-trail`
 * §3.4): a person's DM with an agent and a bridged chat-app chat are private, a
 * team channel and a DM between agents are readable by their agent members.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { authors, roomBridges, roomMembers, roomSessions, rooms, type Db } from '@dorkos/db';
import { resolveRoomSessionVisibility } from '../room-session-visibility.js';

const AT = '2026-10-10T10:00:00.000Z';

/** An agent's account id from its home: here, its natural key, marked. */
const ACCOUNT = (home: string) => `acct:${home}`;

let db: Db;

function author(id: string, kind: 'human' | 'agent'): void {
  db.insert(authors)
    .values({ id, kind, naturalKey: `key-${id}`, displayName: id, createdAt: AT })
    .run();
}

function room(id: string, kind: 'dm' | 'channel', members: string[], session: string): void {
  db.insert(rooms)
    .values({
      id,
      kind,
      title: id,
      slug: kind === 'channel' ? id : null,
      createdAt: AT,
      lastActivityAt: AT,
    })
    .run();
  for (const authorId of members) {
    db.insert(roomMembers)
      .values({ roomId: id, authorId, responseMode: 'always', joinedAt: AT })
      .run();
  }
  db.insert(roomSessions)
    .values({ roomId: id, authorId: 'ana', sessionId: session, createdAt: AT })
    .run();
}

function bridge(roomId: string): void {
  db.insert(roomBridges)
    .values({
      roomId,
      adapterId: 'telegram-1',
      chatId: `chat-${roomId}`,
      platformChatType: 'private',
      bindingId: 'binding-1',
      deliverNotices: true,
      createdAt: AT,
    })
    .run();
}

beforeEach(() => {
  db = createTestDb();
  author('person', 'human');
  author('ana', 'agent');
  author('bo', 'agent');
});

describe('resolveRoomSessionVisibility', () => {
  it('keeps a DM between a person and an agent private', () => {
    room('dm-person', 'dm', ['person', 'ana'], 's-dm');
    expect(resolveRoomSessionVisibility(db, ['s-dm'], ACCOUNT).get('s-dm')).toBe('participants');
  });

  it('keeps a chat bridged from a chat app private, DM or channel', () => {
    room('tg-dm', 'dm', ['ana'], 's-tg-dm');
    bridge('tg-dm');
    room('tg-group', 'channel', ['ana'], 's-tg-group');
    bridge('tg-group');
    expect(
      Object.fromEntries(resolveRoomSessionVisibility(db, ['s-tg-dm', 's-tg-group'], ACCOUNT))
    ).toEqual({
      's-tg-dm': 'participants',
      's-tg-group': 'participants',
    });
  });

  it('opens a team channel, even with a person in it, and a DM between agents, to their agent members only', () => {
    room('general', 'channel', ['person', 'ana', 'bo'], 's-general');
    room('dm-agents', 'dm', ['ana', 'bo'], 's-agents');
    expect(
      Object.fromEntries(resolveRoomSessionVisibility(db, ['s-general', 's-agents'], ACCOUNT))
    ).toEqual({
      's-general': { members: ['acct:key-ana', 'acct:key-bo'] },
      's-agents': { members: ['acct:key-ana', 'acct:key-bo'] },
    });
  });

  it('answers nothing for a session no room binds', () => {
    expect(resolveRoomSessionVisibility(db, ['loose'], ACCOUNT).size).toBe(0);
    expect(resolveRoomSessionVisibility(db, [], ACCOUNT).size).toBe(0);
  });
});
