/** Room stranger classification and carried marks without a database-backed harness. */
import { describe, expect, it } from 'vitest';
import type { AgentRuntime, TurnPermissionLevel } from '@dorkos/shared/agent-runtime';
import type { RoomEntry } from '@dorkos/shared/room-schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import type { AuthorRecord, AuthorRegistry } from '../author-registry.js';
import { answersOutsideWords, strangerMarkForEntries } from '../limits/turn-ceiling.js';
import { turnBoundsOf } from '../limits/teammate-turn.js';
import { strangerMarkForShown } from '../limits/context-entries.js';
import type { RoomContextData } from '@dorkos/shared/additional-context';
import {
  lastTurnLevelOf,
  noteEntryMarks,
  recordTurnLevels,
} from '../../core/turn-power/turn-levels.js';
import { carryRoomPostWords } from '../../core/turn-power/outside-words.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../runtimes/claude-code/runtime-constants.js';

const record = (
  id: string,
  kind: AuthorRecord['kind'],
  naturalKey: string,
  linkedOwnerKey: string | null = null
): AuthorRecord => ({
  id,
  kind,
  naturalKey,
  displayName: id,
  handle: null,
  emoji: null,
  color: null,
  imageUrl: null,
  mintedForManifestId: null,
  linkedOwnerKey,
});

const owner = record('owner', 'human', 'user:owner-account');
const teammate = record('teammate', 'human', 'user:teammate-account');
const agent = record('agent', 'agent', '/agents/bolt');
const bridgedPhone = record(
  'phone',
  'human',
  'platform:telegram:bot-example:phone-7',
  'user:owner-account'
);
const records = new Map([owner, teammate, agent, bridgedPhone].map((one) => [one.id, one]));
const authors = {
  getMany: (ids: readonly string[]) =>
    new Map(ids.flatMap((id) => (records.has(id) ? [[id, records.get(id)!]] : []))),
} as unknown as AuthorRegistry;
const isOwner = (authorId: string) => authorId === owner.id;

/** Record the Full level produced by one room turn option set. */
function levelFor(carriedOutsider?: true): TurnPermissionLevel {
  const sessionId = `room-classification-${carriedOutsider ? 'marked' : 'owner'}`;
  const runtime = recordTurnLevels(
    {
      type: 'claude-code',
      getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
      async *sendMessage(): AsyncGenerator<StreamEvent> {
        yield { type: 'done', data: {} } as StreamEvent;
      },
    } as unknown as AgentRuntime,
    () => 'bypassPermissions'
  );
  runtime.sendMessage(
    sessionId,
    'made-up room message',
    turnBoundsOf({
      additionalDirectories: [],
      ...(carriedOutsider ? { carriedOutsider } : {}),
    })
  );
  return lastTurnLevelOf(sessionId)!;
}

describe('room stranger classification (DOR-3858)', () => {
  it('marks only non-owner people when enabled, including a linked bridged phone', () => {
    expect(strangerMarkForEntries(true, authors, [{ authorId: owner.id }], isOwner)).toEqual({});
    expect(strangerMarkForEntries(true, authors, [{ authorId: agent.id }], isOwner)).toEqual({});
    expect(strangerMarkForEntries(true, authors, [{ authorId: teammate.id }], isOwner)).toEqual({
      carriedOutsider: true,
    });
    expect(strangerMarkForEntries(true, authors, [{ authorId: bridgedPhone.id }], isOwner)).toEqual(
      {
        carriedOutsider: true,
      }
    );
  });

  it('adds no mark when disabled and never lowers Full', () => {
    expect(strangerMarkForEntries(false, authors, [{ authorId: teammate.id }], isOwner)).toEqual(
      {}
    );
    expect(levelFor()).toEqual({ asks: 'never', reach: 'everything' });
    expect(levelFor(true)).toEqual({ asks: 'never', reach: 'everything', outsider: true });
  });
});

describe('a mini app post in a room marks the turn that reads it (DOR-4587)', () => {
  const room = 'room-classification-mini-app';

  it('marks a turn reading a post kept with the outsider mark, flag on or off', () => {
    noteEntryMarks('entry-mini-app-reply', { outsider: true }, room);
    const read = [{ id: 'entry-mini-app-reply', authorId: agent.id }];
    for (const enabled of [true, false]) {
      expect(
        strangerMarkForEntries(enabled, authors, read, isOwner, room),
        String(enabled)
      ).toEqual({ carriedOutsider: true });
    }
  });

  it('marks a turn reading a forward a mini app made', () => {
    const via = {} as NonNullable<RoomEntry['body']['via']>;
    const read = [{ id: 'entry-forward', authorId: owner.id, body: { via } }];
    expect(strangerMarkForEntries(false, authors, read, isOwner, room)).toEqual({
      carriedOutsider: true,
    });
  });

  it("leaves the owner's and an agent's own posts unmarked", () => {
    const read = [
      { id: 'entry-owner-post', authorId: owner.id },
      { id: 'entry-agent-post', authorId: agent.id },
    ];
    expect(strangerMarkForEntries(true, authors, read, isOwner, room)).toEqual({});
  });
});

describe('an agent post that relays outside words marks the turn that reads it (DOR-4587)', () => {
  const room = 'room-classification-relay';

  it('marks a turn reading an agent post kept with the outsider mark', () => {
    noteEntryMarks('entry-agent-relay', { outsider: true }, room);
    const read = [{ id: 'entry-agent-relay', authorId: agent.id }];
    expect(strangerMarkForEntries(true, authors, read, isOwner, room)).toEqual({
      carriedOutsider: true,
    });
  });

  it('carries a second-hand relay as the outside-words note, never the mark', () => {
    carryRoomPostWords('entry-agent-hop', ['chat-that-read-a-stranger'], () => true);
    const read = [{ id: 'entry-agent-hop', authorId: agent.id }];
    // The gates read the note (`turnReadOutsideWords`); a spreading mark would hold local work.
    expect(answersOutsideWords(authors, read, room)).toBe(true);
    expect(strangerMarkForEntries(true, authors, read, isOwner, room)).toEqual({});
  });
});

describe('a mini app post the context showed but the turn does not answer (DOR-4587)', () => {
  const room = 'room-classification-shown';
  const shownPost = { id: 'entry-shown-mini-app', authorId: owner.id } as RoomEntry;
  const deps = {
    store: { listEntriesByIds: () => [shownPost] },
    authors,
    isOwnerAuthor: isOwner,
  };
  const context = { pending: [{ id: shownPost.id }] } as unknown as RoomContextData;

  it('marks the turn with stranger marking off', () => {
    noteEntryMarks(shownPost.id, { outsider: true }, room);
    expect(strangerMarkForShown(false, deps, room, [{ authorId: owner.id }], context)).toEqual({
      carriedOutsider: true,
    });
  });
});
