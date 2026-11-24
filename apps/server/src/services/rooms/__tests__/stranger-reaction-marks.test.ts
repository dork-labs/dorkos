/**
 * A room turn is shown who reacted to its agent's own recent posts (the context's
 * acknowledgments), so a stranger's reaction there counts as a stranger's line does (DOR-4144):
 * it notes the turn as one that read outside words, and with stranger marking on it marks the
 * turn. The owner's reaction and the agent's own mark nothing.
 */
import { describe, expect, it } from 'vitest';
import type { RoomContextData } from '@dorkos/shared/additional-context';
import type { RoomEntryReaction } from '@dorkos/shared/room-schemas';
import type { AuthorRecord, AuthorRegistry } from '../author-registry.js';
import { marksForShown, type ShownMarkDeps } from '../limits/context-entries.js';

const record = (id: string, kind: AuthorRecord['kind'], naturalKey: string): AuthorRecord => ({
  id,
  kind,
  naturalKey,
  displayName: id,
  handle: null,
  emoji: null,
  color: null,
  imageUrl: null,
  mintedForManifestId: null,
  linkedOwnerKey: null,
});

const owner = record('owner', 'human', 'user:owner-account');
const agent = record('agent', 'agent', '/agents/bolt');
// An agent author with a key from somewhere else: its reaction would mark a turn it is shown, so
// only leaving the turn's own agent out keeps that agent's turn clean.
const outsideAgent = record('outside-agent', 'agent', 'platform:a2a:peer-example:bolt');
const stranger = record('stranger', 'human', 'platform:telegram:bot-example:visitor-9');
const records = new Map([owner, agent, outsideAgent, stranger].map((one) => [one.id, one]));
const authors = {
  getMany: (ids: readonly string[]) =>
    new Map(ids.flatMap((id) => (records.has(id) ? [[id, records.get(id)!]] : []))),
} as unknown as AuthorRegistry;

const ROOM = 'room-reactions';
const OWN_POST = 'entry-agent-own-post';
const answered = [{ id: 'entry-owner-ask', authorId: owner.id }];
// The agent's own recent post, the one whose reactions the context shows as acknowledgments.
const context = { pending: [], ownRecent: [{ id: OWN_POST }] } as unknown as RoomContextData;

/** Deps whose only reaction is one emoji by each of `reactors` on the agent's own post. */
function depsWith(...reactors: string[]): ShownMarkDeps {
  return {
    store: { listEntriesByIds: () => [] },
    reactions: {
      listFor: (roomId, ids) =>
        new Map(
          roomId === ROOM && ids.includes(OWN_POST) && reactors.length > 0
            ? [[OWN_POST, [{ emoji: '👍', authorIds: reactors } as unknown as RoomEntryReaction]]]
            : []
        ),
    },
    authors,
    isOwnerAuthor: (authorId) => authorId === owner.id,
  };
}

describe('reactions a room turn is shown (DOR-4144)', () => {
  it("notes the turn when a stranger reacted to the agent's own post", () => {
    expect(marksForShown(false, depsWith(stranger.id), ROOM, answered, context, agent.id)).toEqual({
      outsideWords: true,
    });
  });

  it('also marks it with stranger marking on', () => {
    expect(marksForShown(true, depsWith(stranger.id), ROOM, answered, context, agent.id)).toEqual({
      carriedOutsider: true,
      outsideWords: true,
    });
  });

  it("marks nothing for the owner's reaction or another local agent's", () => {
    expect(
      marksForShown(true, depsWith(owner.id, agent.id), ROOM, answered, context, 'some-other-agent')
    ).toEqual({});
  });

  it("marks nothing for the turn's own agent's reaction, wherever its key is from", () => {
    expect(
      marksForShown(true, depsWith(outsideAgent.id), ROOM, answered, context, outsideAgent.id)
    ).toEqual({});
    // The control: the same reaction, shown to another agent's turn, marks it.
    expect(
      marksForShown(false, depsWith(outsideAgent.id), ROOM, answered, context, agent.id)
    ).toEqual({ outsideWords: true });
  });

  it('marks nothing when nothing was reacted to', () => {
    expect(marksForShown(true, depsWith(), ROOM, answered, context, agent.id)).toEqual({});
  });
});
