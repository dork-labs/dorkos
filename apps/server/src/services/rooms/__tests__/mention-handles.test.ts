/**
 * What the mention picker reads, and what happens to what it writes.
 *
 * The picker's whole claim is that the string it inserts is the string the
 * server resolves. That claim spans two modules and a wire format, so it is
 * tested where a client meets it: the roster `GET /api/rooms/:id` returns, and
 * the entry `POST /api/rooms/:id/entries` commits.
 */
import { describe, it, expect } from 'vitest';
import type { AuthorRef, RoomWithRoster } from '@dorkos/shared/room-schemas';
import type { RoomAgent, RoomAgentLookup } from '../room-errors.js';
import { createRoomHarness, scriptedRunner, type RoomHarness } from './room-test-harness.js';

/**
 * An agent lookup whose table can be rewritten mid-test, so a rename is the
 * thing that actually happens rather than a second harness pretending to be one.
 */
function mutableLookup(table: Record<string, Partial<RoomAgent> & { name: string }>): {
  lookup: RoomAgentLookup;
  rename: (agentPath: string, name: string) => void;
} {
  const current = { ...table };
  return {
    lookup: {
      byPath: (agentPath) => {
        const agent = current[agentPath];
        if (!agent) return null;
        return {
          id: agentPath,
          displayName: agent.name,
          responseMode: 'silent',
          emoji: null,
          color: null,
          ...agent,
        };
      },
    },
    rename: (agentPath, name) => {
      const agent = current[agentPath];
      if (agent) current[agentPath] = { ...agent, name };
    },
  };
}

/** Open a channel holding the given agents, and hand back its roster. */
function channelWith(harness: RoomHarness, slug: string, agentPaths: string[]) {
  const room = harness.service.createRoom(
    { kind: 'channel', slug, title: `#${slug}`, members: [], agentPaths },
    harness.human
  );
  return harness.service.getRoom(room.id, harness.human)!;
}

/** The roster row for the member whose display name is `displayName`. */
function memberNamed(room: RoomWithRoster, displayName: string): AuthorRef {
  const member = room.members.find((m) => m.author.displayName === displayName);
  if (!member) throw new Error(`No member called ${displayName}`);
  return member.author;
}

describe('the roster tells a picker what to insert', () => {
  it('carries the slug an agent is addressable by, not the display name it renders as', () => {
    // The shape that makes this necessary, taken from a real install: an agent
    // whose handle is a slug and whose display name has two spaces in it. A
    // picker inserting the display name writes `@Mio Clicker PM`, which the
    // mention pattern truncates to `@Mio` — a mention that reaches nobody.
    const { lookup } = mutableLookup({
      '/agents/mio': { name: 'mio-clicker-pm', displayName: 'Mio Clicker PM' },
    });
    const harness = createRoomHarness({ agents: lookup });
    const room = channelWith(harness, 'general', ['/agents/mio']);

    expect(memberNamed(room, 'Mio Clicker PM').mentionHandle).toBe('mio-clicker-pm');
  });

  it('carries no handle at all for an agent no string can address', () => {
    // `agents.name` is not always a slug — 7 of the 40 agents on the install
    // this was written against have a space in theirs. There is no string to
    // offer, and inventing one would invite a message that reaches nobody.
    const { lookup } = mutableLookup({
      '/agents/ab': { name: 'Art Blocks Analytics', displayName: 'Art Blocks Analytics' },
    });
    const harness = createRoomHarness({ agents: lookup });
    const room = channelWith(harness, 'general', ['/agents/ab']);

    expect(memberNamed(room, 'Art Blocks Analytics').mentionHandle).toBeUndefined();
  });

  it('carries a handle for the person reading, too', () => {
    const { lookup } = mutableLookup({ '/agents/ana': { name: 'ana' } });
    const harness = createRoomHarness({ agents: lookup });
    const room = channelWith(harness, 'general', ['/agents/ana']);

    expect(memberNamed(room, 'You').mentionHandle).toBe('You');
  });
});

describe('what the picker inserts is what the server resolves', () => {
  it('addresses the member whose handle the roster advertised', () => {
    const { lookup } = mutableLookup({
      '/agents/mio': { name: 'mio-clicker-pm', displayName: 'Mio Clicker PM' },
    });
    const harness = createRoomHarness({ agents: lookup });
    const room = channelWith(harness, 'general', ['/agents/mio']);
    const mio = memberNamed(room, 'Mio Clicker PM');

    // The round trip: take the handle off the wire, write it the way the picker
    // does, and check it lands on that exact author — not on "somebody".
    const entry = harness.service.post(room.id, {
      authorId: harness.human,
      text: `@${mio.mentionHandle} can you look`,
    });

    expect(entry.mentions).toEqual([mio.id]);
  });

  it('leaves the display name unresolved, which is the defect the handle removes', () => {
    const { lookup } = mutableLookup({
      '/agents/mio': { name: 'mio-clicker-pm', displayName: 'Mio Clicker PM' },
    });
    const harness = createRoomHarness({ agents: lookup });
    const room = channelWith(harness, 'general', ['/agents/mio']);

    const entry = harness.service.post(room.id, {
      authorId: harness.human,
      text: '@Mio Clicker PM can you look',
    });

    // Nobody addressed, and — this is the part that makes it a silent failure —
    // no error either. The words are stored exactly as typed.
    expect(entry.mentions).toEqual([]);
    expect(entry.body.text).toBe('@Mio Clicker PM can you look');
  });

  it('leaves an unresolvable @name as plain text rather than failing the post', () => {
    const { lookup } = mutableLookup({ '/agents/ana': { name: 'ana' } });
    const harness = createRoomHarness({ agents: lookup });
    const room = channelWith(harness, 'general', ['/agents/ana']);

    // Usually an email address or a price, which is why this is not an error.
    const entry = harness.service.post(room.id, {
      authorId: harness.human,
      text: 'write to dorian@dorkos.ai or @nobody about the @99 charge',
    });

    expect(entry.mentions).toEqual([]);
    expect(entry.body.text).toBe('write to dorian@dorkos.ai or @nobody about the @99 charge');
  });
});

describe('a handle is only advertised to the member it reaches', () => {
  /**
   * Two agents whose own handles are unusable — a space in each, which is the
   * shape 7 of the 40 agents on the install this was written against already
   * have — and whose display names are identical.
   *
   * So the only name either could be offered is `Shared`, and `resolveMentions`
   * gives it to exactly one of them. Deriving each member's handle in isolation
   * sees only that member's own names, finds `Shared` typeable for BOTH, and
   * advertises it twice; one of those two then addresses the other agent. The
   * wrong agent answers and the intended one stays silent, which from inside
   * the room is indistinguishable from a broken agent.
   *
   * Symmetrical on purpose. Memberships are ordered `(joinedAt, authorId)` and
   * a seeded roster ties on `joinedAt`, so which agent wins is decided by a
   * ULID and differs run to run — with an asymmetric fixture the defect hides
   * on roughly half of them. Here it does not matter which one wins: whoever
   * loses must be offered nothing.
   */
  const collidingAgents = {
    '/agents/one': { name: 'One Space Name', displayName: 'Shared' },
    '/agents/two': { name: 'Two Space Name', displayName: 'Shared' },
  };

  /** Open the contested channel and hand back its two agent rows. */
  function contestedRoom() {
    const { lookup } = mutableLookup(collidingAgents);
    const harness = createRoomHarness({ agents: lookup });
    const room = channelWith(harness, 'general', ['/agents/one', '/agents/two']);
    return { harness, room, agents: room.members.filter((m) => m.author.kind === 'agent') };
  }

  it('offers a contested name to exactly one of the members claiming it', () => {
    const { agents } = contestedRoom();
    expect(agents).toHaveLength(2);

    const offered = agents.filter((m) => m.author.mentionHandle !== undefined);
    // One, never two — and never zero, which would be a picker that had quietly
    // stopped offering anybody.
    expect(offered).toHaveLength(1);
    expect(offered[0]!.author.mentionHandle).toBe('Shared');
  });

  it('never advertises a handle that posts to somebody else', () => {
    const { harness, room } = contestedRoom();

    // The invariant, driven through the real write path: take every handle the
    // server advertised, post it, and check it landed on the member it was
    // advertised FOR — not merely on somebody.
    const advertised = room.members.filter((m) => m.author.mentionHandle !== undefined);
    for (const member of advertised) {
      const entry = harness.service.post(room.id, {
        authorId: harness.human,
        text: `@${member.author.mentionHandle} hi`,
      });
      expect(entry.mentions).toEqual([member.author.id]);
    }

    // The reader plus exactly one agent. A roster that offered nothing would
    // satisfy the loop above without testing anything.
    expect(advertised).toHaveLength(2);
    // And no two members were handed the same string to begin with.
    expect(new Set(advertised.map((m) => m.author.mentionHandle)).size).toBe(2);
  });
});

describe('resolution happens once, at write time', () => {
  it('does not re-address a message already sent when the agent is renamed', () => {
    // Her display name has a space in it, so the handle is the ONLY string that
    // can address her — which is what makes renaming it observable. With a
    // one-word display name the author row goes on claiming `@ana` after the
    // rename, because that row is a render cache refreshed only on re-join.
    const { lookup, rename } = mutableLookup({
      '/agents/ana': { name: 'ana', displayName: 'Ana Reyes' },
    });
    const runner = scriptedRunner();
    const harness = createRoomHarness({ agents: lookup, runner });
    const room = channelWith(harness, 'general', ['/agents/ana']);
    const ana = memberNamed(room, 'Ana Reyes');

    const sentToday = harness.service.post(room.id, {
      authorId: harness.human,
      text: '@ana please look',
    });
    expect(sentToday.mentions).toEqual([ana.id]);

    // Tomorrow, somebody renames the agent.
    rename('/agents/ana', 'ana-the-second');

    // The message sent today still addresses exactly who it addressed today.
    // This is the guarantee an edit would otherwise be able to break: because
    // the resolved ids were stored rather than re-derived, there is no read
    // path that could re-run resolution over old text and summon somebody.
    const [reread] = harness.service.listEntries(room.id, harness.human, { limit: 10 });
    expect(reread!.id).toBe(sentToday.id);
    expect(reread!.mentions).toEqual([ana.id]);
    expect(reread!.body.text).toBe('@ana please look');
  });

  it('resolves the same sentence differently after a rename, proving the read is not re-run', () => {
    // Her display name has a space in it, so the handle is the ONLY string that
    // can address her — which is what makes renaming it observable. With a
    // one-word display name the author row goes on claiming `@ana` after the
    // rename, because that row is a render cache refreshed only on re-join.
    const { lookup, rename } = mutableLookup({
      '/agents/ana': { name: 'ana', displayName: 'Ana Reyes' },
    });
    const harness = createRoomHarness({ agents: lookup });
    const room = channelWith(harness, 'general', ['/agents/ana']);
    const ana = memberNamed(room, 'Ana Reyes');

    const before = harness.service.post(room.id, { authorId: harness.human, text: '@ana hi' });
    rename('/agents/ana', 'ana-the-second');
    const after = harness.service.post(room.id, { authorId: harness.human, text: '@ana hi' });

    // Identical words, two different outcomes — which is only possible because
    // resolution ran at each WRITE. If the client re-parsed text on read, both
    // would show the same thing and this pair could not come apart.
    expect(before.mentions).toEqual([ana.id]);
    expect(after.mentions).toEqual([]);

    // And the new handle works from the roster, exactly as the picker would
    // read it now.
    const renamed = harness.service.getRoom(room.id, harness.human)!;
    expect(memberNamed(renamed, 'Ana Reyes').mentionHandle).toBe('ana-the-second');
    const addressed = harness.service.post(room.id, {
      authorId: harness.human,
      text: '@ana-the-second hi',
    });
    expect(addressed.mentions).toEqual([ana.id]);
  });
});
