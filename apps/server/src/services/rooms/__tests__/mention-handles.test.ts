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
import { HANDLE_PATTERN } from '@dorkos/shared/handle';
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
    // A manifest rename moves BOTH columns: `name` is the address and
    // `displayName` is the label, and a person renaming their agent changes
    // what it is called, not one of the two. Moving only `name` would leave the
    // fake in a state no manifest produces — a display name the manifest no
    // longer says — which `AuthorRegistry` now (correctly) declines to overwrite
    // with the new slug (DOR-1264).
    rename: (agentPath, name) => {
      const agent = current[agentPath];
      if (agent) current[agentPath] = { ...agent, name, displayName: name };
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

    expect(memberNamed(room, 'Mio Clicker PM').handle).toBe('mio-clicker-pm');
  });

  it('gives an agent whose NAME has a space a handle anyway — the whole point', () => {
    // `agents.name` is `z.string().min(1)`, and 7 of the 40 agents on the
    // install this was written against have a space in theirs. Before handles,
    // there was no string that reached them at all and the roster said so
    // honestly. Now derivation gives them one that the grammar guarantees is
    // typeable.
    const { lookup } = mutableLookup({
      '/agents/ab': { name: 'Art Blocks Analytics', displayName: 'Art Blocks Analytics' },
    });
    const harness = createRoomHarness({ agents: lookup });
    const room = channelWith(harness, 'general', ['/agents/ab']);
    const ab = memberNamed(room, 'Art Blocks Analytics');

    expect(ab.handle).toBe('art-blocks-analytics');
    expect(HANDLE_PATTERN.test(ab.handle!)).toBe(true);
    // And it reaches them, which is the part a slug on its own would not prove.
    const entry = harness.service.post(room.id, {
      authorId: harness.human,
      text: `@${ab.handle} can you look`,
    });
    expect(entry.mentions).toEqual([ab.id]);
  });

  it('leaves the person reading with no handle until they are asked for one', () => {
    // `'You'` is a placeholder, not a name, and deriving `@you` from it would
    // ship the exact defect this feature removes — as a PERMANENT default, on an
    // install that may never run an account onboarding at all. Absence is never
    // consent: the honest answer is null, and the cockpit asks.
    const { lookup } = mutableLookup({ '/agents/ana': { name: 'ana' } });
    const harness = createRoomHarness({ agents: lookup });
    const room = channelWith(harness, 'general', ['/agents/ana']);

    expect(memberNamed(room, 'You').handle).toBeNull();
  });

  it('gives the person a handle once they choose one, and it reaches them', () => {
    const { lookup } = mutableLookup({ '/agents/ana': { name: 'ana' } });
    const harness = createRoomHarness({ agents: lookup });
    const room = channelWith(harness, 'general', ['/agents/ana']);

    harness.authors.setHandle(harness.human, 'dorian');

    const asked = harness.service.getRoom(room.id, harness.human)!;
    expect(memberNamed(asked, 'You').handle).toBe('dorian');
    const entry = harness.service.post(room.id, {
      authorId: harness.human,
      text: 'cc @dorian',
    });
    expect(entry.mentions).toEqual([harness.human]);
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
      text: `@${mio.handle} can you look`,
    });

    expect(entry.mentions).toEqual([mio.id]);
  });

  it('stops resolving the display name, which is the second addressing path being deleted', () => {
    const { lookup } = mutableLookup({
      '/agents/ana': { name: 'ana', displayName: 'Reyes' },
    });
    const harness = createRoomHarness({ agents: lookup });
    const room = channelWith(harness, 'general', ['/agents/ana']);

    // `Reyes` is a perfectly typeable display name and used to be an address.
    // It is not one any more: a display name is unrestricted text, and keeping
    // it addressable would keep a second mechanism whose only distinguishing
    // property is being worse — non-unique, sometimes untypeable, resolving by
    // roster order.
    const byDisplayName = harness.service.post(room.id, {
      authorId: harness.human,
      text: '@Reyes can you look',
    });
    expect(byDisplayName.mentions).toEqual([]);

    const byHandle = harness.service.post(room.id, {
      authorId: harness.human,
      text: '@ana can you look',
    });
    expect(byHandle.mentions).toEqual([memberNamed(room, 'Reyes').id]);
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

describe('two agents cannot be handed the same handle', () => {
  /**
   * Two agents in different directories with the SAME `agents.name` — the shape
   * that used to be a collision and is now a de-collision.
   *
   * This is where Buzz fails: it has a case-folded unique handle column, its
   * mention path never reads it, and it ships a test asserting `@alice` notifies
   * every Alice. The unique index is what makes that impossible here, and the
   * counter suffix is what makes the loser still addressable.
   */
  const twins = {
    '/agents/one': { name: 'api-server', displayName: 'API Server (one)' },
    '/agents/two': { name: 'api-server', displayName: 'API Server (two)' },
  };

  it('suffixes the second with a decimal counter', () => {
    const { lookup } = mutableLookup(twins);
    const harness = createRoomHarness({ agents: lookup });
    const room = channelWith(harness, 'general', ['/agents/one', '/agents/two']);

    const handles = room.members
      .filter((m) => m.author.kind === 'agent')
      .map((m) => m.author.handle);
    expect(handles).toHaveLength(2);
    expect(new Set(handles).size).toBe(2);
    expect(handles.sort()).toEqual(['api-server', 'api-server-2']);
  });

  it('never advertises a handle that posts to somebody else', () => {
    const { lookup } = mutableLookup(twins);
    const harness = createRoomHarness({ agents: lookup });
    const room = channelWith(harness, 'general', ['/agents/one', '/agents/two']);

    // The invariant, driven through the real write path: take every handle the
    // server advertised, post it, and check it landed on the member it was
    // advertised FOR — not merely on somebody.
    const addressable = room.members.filter((m) => m.author.handle !== null);
    for (const member of addressable) {
      const entry = harness.service.post(room.id, {
        authorId: harness.human,
        text: `@${member.author.handle} hi`,
      });
      expect(entry.mentions).toEqual([member.author.id]);
    }

    // Both agents. The reader has no handle yet, so they are not in this set —
    // and a roster that offered nothing would satisfy the loop vacuously.
    expect(addressable).toHaveLength(2);
  });
});

describe('resolution happens once, at write time', () => {
  it('does not re-address a message already sent when the agent is renamed', () => {
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
    const [reread] = harness.service.listEntries(room.id, harness.human, { limit: 10 });
    expect(reread!.id).toBe(sentToday.id);
    expect(reread!.mentions).toEqual([ana.id]);
    expect(reread!.body.text).toBe('@ana please look');
  });

  it('keeps the handle a manifest rename would otherwise overwrite (D12)', () => {
    // **The regression that would silently undo the feature.** `agents` is a
    // derived cache the mesh reconciler rebuilds from disk every five minutes,
    // so a handle re-derived on each resolve would follow the manifest —
    // including back into a name with a space in it. The handle is written once,
    // at mint, and a rename moves the display name and nothing else.
    const { lookup, rename } = mutableLookup({
      '/agents/ana': { name: 'ana', displayName: 'Ana Reyes' },
    });
    const harness = createRoomHarness({ agents: lookup });
    const room = channelWith(harness, 'general', ['/agents/ana']);
    const ana = memberNamed(room, 'Ana Reyes');

    rename('/agents/ana', 'Ana The Second');
    // Re-resolving is what the roster read below runs through, and it is the
    // path that used to refresh every cached field on the row.
    harness.authors.resolveAgent('/agents/ana', 'Ana The Second');

    const after = harness.service.getRoom(room.id, harness.human)!;
    const anaAfter = after.members.find((m) => m.author.id === ana.id)!.author;
    expect(anaAfter.handle).toBe('ana');
    expect(anaAfter.displayName).toBe('Ana The Second');

    // And the address still works, which is the user-visible half.
    const addressed = harness.service.post(room.id, {
      authorId: harness.human,
      text: '@ana hi',
    });
    expect(addressed.mentions).toEqual([ana.id]);
  });

  it('refreshes a changed photo on the same resolve that leaves the handle alone', () => {
    // The two halves of the same rule, asserted together because that is where
    // they are decided: `image_url` is a render CACHE, so it follows its source
    // the way `display_name`, `emoji` and `color` do — while `handle` is a KEY
    // and is written once at mint (D12 above). A patch that folded the photo in
    // by refreshing the whole row would pass the first assertion and fail the
    // second, which is the point of pairing them.
    const harness = createRoomHarness({ agents: mutableLookup({}).lookup });
    const person = harness.authors.resolve({
      kind: 'human',
      naturalKey: 'local',
      displayName: 'You',
      imageUrl: '/api/profile/avatar/me?v=one',
    });
    harness.authors.setHandle(person.id, 'dorian');

    harness.authors.resolve({
      kind: 'human',
      naturalKey: 'local',
      displayName: 'You',
      imageUrl: '/api/profile/avatar/me?v=two',
    });

    // Re-read from the table rather than trusting the return value, so a change
    // that only decorated the response cannot pass.
    const stored = harness.authors.getById(person.id)!;
    expect(stored.imageUrl).toBe('/api/profile/avatar/me?v=two');
    expect(stored.handle).toBe('dorian');
  });

  it('leaves the stored photo alone for a caller that does not know one, and clears it on null', () => {
    // The `emoji`/`color` lifecycle exactly: `undefined` is "I do not know",
    // `null` is "they have none". A caller holding only a name must not blank
    // somebody's face on its way past.
    const harness = createRoomHarness({ agents: mutableLookup({}).lookup });
    const person = harness.authors.resolve({
      kind: 'human',
      naturalKey: 'local',
      displayName: 'You',
      imageUrl: '/api/profile/avatar/me?v=one',
    });

    harness.authors.resolve({ kind: 'human', naturalKey: 'local', displayName: 'You' });
    expect(harness.authors.getById(person.id)!.imageUrl).toBe('/api/profile/avatar/me?v=one');

    harness.authors.resolve({
      kind: 'human',
      naturalKey: 'local',
      displayName: 'You',
      imageUrl: null,
    });
    expect(harness.authors.getById(person.id)!.imageUrl).toBeNull();
  });
});
