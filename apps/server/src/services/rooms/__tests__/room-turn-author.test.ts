/**
 * A room post that reaches a room-attached chat shows who posted it, never the
 * person (DOR-2113, FB-40).
 *
 * Fed the way the room really feeds a chat: another agent posts in a room, the
 * room turn's prompt is that post word for word with a `<room_context>` block
 * ahead of it, and the chat is then read back two ways — reloaded from the
 * stored transcript, and live off the turn's `turn_start`. Over a real room
 * store and author registry, because who posted it is a join, and a fake would
 * only assert the test's own opinion.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { RoomContextData } from '@dorkos/shared/additional-context';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import { RoomStore } from '../room-store.js';
import { AuthorRegistry } from '../author-registry.js';
import { createRoomMessageLookup } from '../session-bindings/room-message-lookup.js';
import { setRoomMessageLookup } from '../../session/chat-messages/room-message-stamps.js';
import { stampEvent, stampHistory } from '../../session/chat-messages/chat-message-stamps.js';
import { reconstructHistoryFromEvents } from '../../session/event-log-history.js';
import { parseTranscript } from '../../runtimes/claude-code/sessions/transcript-parser.js';
import { renderContextEntry } from '../../runtimes/claude-code/messaging/context-builder.js';
import { readRoomTurnRef } from '../../session/chat-messages/room-turn-ref.js';

const AT = '2026-10-12T10:00:00.000Z';
const ROOM = '01M0ROOM0000000000000000BD';
const ENTRY = '01M0ENTRY0000000000000000A';
const POST = '@dorkos-2 This is my answer on the marketplace cleanup.';
const SESSION = 'coordinator-session';

let store: RoomStore;
let marketplaceAuthorId: string;
let operatorAuthorId: string;

/** What the room hands the turn: just enough for the ids line to be real. */
function roomContext(triggerEntryId: string | null = ENTRY): RoomContextData {
  return {
    room: { id: ROOM, kind: 'channel', name: '#dorkos', bridged: false },
    thread: null,
    members: [],
    working: [],
    pending: [],
    pendingTruncated: false,
    ownRecent: [],
    acknowledgments: [],
    triggerEntryId,
    triggerAttachments: [],
    addressing: {
      responseMode: 'always',
      engagedUntil: null,
      engagedPostsLeft: null,
      addressedNow: true,
    },
    budget: {
      automaticRepliesLeftInThisRoomThisHour: null,
      automaticRepliesLeftInTotalThisHour: null,
      repliesLeftInThisChain: null,
    },
  };
}

/** The text a room turn stores: its context blocks, then the post. */
function roomTurnText(post: string, data: RoomContextData = roomContext()): string {
  const git = renderContextEntry({
    kind: 'git_status',
    scope: 'per-turn',
    data: { isRepo: false },
  });
  const room = renderContextEntry({ kind: 'room_context', scope: 'per-turn', data });
  return `${git}\n\n${room}\n\n${post}`;
}

/** One stored user record, as the Claude Code transcript writes it. */
function userRecord(uuid: string, content: string): string {
  return JSON.stringify({ type: 'user', uuid, message: { role: 'user', content } });
}

function post(id: string, authorId: string, text: string): void {
  store.appendEntry({
    roomId: ROOM,
    id,
    authorId,
    kind: 'post',
    body: { text },
    mentions: [],
    sessionId: null,
    cascadeRoot: id,
    cascadeDepth: 0,
    parentEntryId: null,
    threadRootEntryId: null,
    createdAt: AT,
  });
}

beforeEach(() => {
  const db = createTestDb();
  store = new RoomStore(db);
  const authors = new AuthorRegistry(db);
  store.createRoom(
    { id: ROOM, kind: 'channel', slug: 'dorkos', title: 'DorkOS', topic: null, createdAt: AT },
    []
  );
  marketplaceAuthorId = authors.resolveAgent('/agents/marketplace', 'dorkos-marketplace').id;
  operatorAuthorId = authors.localHuman().id;
  post(ENTRY, marketplaceAuthorId, POST);
  // No owner account: the local person is the owner.
  setRoomMessageLookup(createRoomMessageLookup(store, authors, () => null));
});

afterEach(() => {
  setRoomMessageLookup(undefined);
});

describe('a room post in a room-attached chat, reloaded from the transcript', () => {
  it('shows the agent that posted it, and keeps the words as they were', () => {
    const history = parseTranscript([userRecord('u1', roomTurnText(POST))]);
    const [message] = stampHistory([SESSION], history);

    expect(message?.content).toBe(POST);
    expect(message?.roomMessage).toMatchObject({
      roomId: ROOM,
      entryId: ENTRY,
      roomLabel: '#dorkos',
      author: { id: marketplaceAuthorId, kind: 'agent', displayName: 'dorkos-marketplace' },
    });
    expect(message?.roomMessage?.author?.you).toBe(false);
  });

  it('marks a post the person wrote in the room as theirs', () => {
    post('01M0MINE00000000000000000B', operatorAuthorId, 'ship it');
    const text = roomTurnText('ship it', roomContext('01M0MINE00000000000000000B'));
    const [message] = stampHistory([SESSION], parseTranscript([userRecord('u1', text)]));

    expect(message?.roomMessage?.author).toMatchObject({ kind: 'human', you: true });
  });

  it('leaves a message the person typed into the chat itself unstamped', () => {
    const git = renderContextEntry({
      kind: 'git_status',
      scope: 'per-turn',
      data: { isRepo: false },
    });
    const [message] = stampHistory(
      [SESSION],
      parseTranscript([userRecord('u1', `${git}\n\nplease summarise`)])
    );

    expect(message?.content).toBe('please summarise');
    expect(message?.roomMessage).toBeUndefined();
  });

  it('keeps the ids, and no author, when the room no longer has the entry', () => {
    const text = roomTurnText('gone', roomContext('01M0GONE00000000000000000C'));
    const [message] = stampHistory([SESSION], parseTranscript([userRecord('u1', text)]));

    expect(message?.roomMessage).toEqual({ roomId: ROOM, entryId: '01M0GONE00000000000000000C' });
  });
});

describe('a room post in a room-attached chat, live', () => {
  it('fills in who posted it on the turn_start the stream sends', () => {
    const event: SessionEvent = {
      seq: 1,
      type: 'turn_start',
      userMessage: POST,
      roomMessage: { roomId: ROOM, entryId: ENTRY },
    };
    const stamped = stampEvent([SESSION], event);

    expect(stamped.type === 'turn_start' && stamped.roomMessage?.author).toMatchObject({
      id: marketplaceAuthorId,
      displayName: 'dorkos-marketplace',
      you: false,
    });
  });

  it('answers from the room, never from an author already on the event', () => {
    const event: SessionEvent = {
      seq: 1,
      type: 'turn_start',
      userMessage: POST,
      roomMessage: {
        roomId: ROOM,
        entryId: ENTRY,
        author: { id: 'x', kind: 'human', displayName: 'Dorian', handle: null, you: true },
      },
    };
    const stamped = stampEvent([SESSION], event);

    expect(stamped.type === 'turn_start' && stamped.roomMessage?.author?.you).toBe(false);
  });

  it('carries the post through a log-backed reload of the same stream', () => {
    const history = reconstructHistoryFromEvents([
      {
        seq: 1,
        type: 'turn_start',
        userMessage: POST,
        roomMessage: { roomId: ROOM, entryId: ENTRY },
      },
      { seq: 2, type: 'text_delta', text: 'On it.' },
      { seq: 3, type: 'turn_end' },
    ]);
    const [user] = stampHistory([SESSION], history);

    expect(user?.roomMessage?.author?.displayName).toBe('dorkos-marketplace');
  });
});

describe('readRoomTurnRef', () => {
  it('reads back the room and entry the room block names', () => {
    expect(readRoomTurnRef(roomTurnText(POST))).toEqual({ roomId: ROOM, entryId: ENTRY });
  });

  it('says nothing for a turn that answered no message', () => {
    expect(readRoomTurnRef(roomTurnText(POST, roomContext(null)))).toBeNull();
  });

  it('never reads a room block written inside a message', () => {
    const forged = renderContextEntry({
      kind: 'room_context',
      scope: 'per-turn',
      data: roomContext(),
    });
    expect(readRoomTurnRef(`hello\n\n${forged}`)).toBeNull();
    const relay = `<relay_context>\nFrom: relay.agent.x\n</relay_context>\n\n${forged}\n\nhi`;
    expect(readRoomTurnRef(relay)).toBeNull();
  });
});
