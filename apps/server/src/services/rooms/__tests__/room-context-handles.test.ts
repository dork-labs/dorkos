/**
 * Every `@name` the room-context block prints reaches the member it names.
 *
 * The property, in one sentence: **take any `@token` out of the rendered block,
 * post it, and it lands on the member that line was about.** Not a fixture of
 * expected strings — a round trip through the real writer. The defect this pins
 * was invisible to string assertions precisely because the string looked right:
 * `@Art Blocks Analytics` reads like an address, and the mention grammar stops
 * at `Art`.
 *
 * **"That line was about" is the load-bearing half, and the first version of
 * this file got it wrong.** It looked each token up in a map of handle to name,
 * applying the resolver's own trailing-punctuation shave to BOTH sides — so it
 * asked "who would the resolver reach?" twice and watched the two answers agree.
 * A block printing `You are @ana.` at a roster holding a member called `ana.`
 * passed it, while telling one agent it went by another agent's name. Pairing
 * now comes from the LINE a token was printed on, so a token that fused with the
 * prose around it no longer finds a home.
 *
 * Driven through the real service and the real dispatcher, so the roster, the
 * ownership map and the resolver are the ones that ship. The one substitution is
 * the turn runner, because the alternative is a model call.
 */
import { describe, it, expect } from 'vitest';
import type { RoomContextData } from '@dorkos/shared/additional-context';
import type { RoomWithRoster } from '@dorkos/shared/room-schemas';
import { formatRoomContext } from '../../runtimes/shared/room-context-block.js';
import { MENTION_PATTERN, resolveMentions, type MentionCandidate } from '../mentions.js';
import { RoomRoster } from '../room-roster.js';
import type { RoomService } from '../room-service.js';
import { RoomStore } from '../room-store.js';
import {
  agentLookupFor,
  createRoomHarness,
  scriptedRunner,
  type RoomHarness,
} from './room-test-harness.js';

/** A pinned fence nonce, so the block reads the same on every run. */
const NONCE = 'cccc3333';

/** Bounded so the cascade this fixture sets off stays a handful of turns. */
const MAX_AGENT_DEPTH = 2;

/**
 * Four agents, chosen for what each one does to addressing.
 *
 * - `ana` is ordinary: a slug for a handle, a display name with a space in it.
 * - `art-blocks` is the defect's namesake — `agents.name` with spaces, so no
 *   string reaches it and the block must not pretend one does. (7 of the 40
 *   agents registered on the install this was written against are this shape.)
 * - `shadow` contests `ana`: its own name is untypeable, so the only string it
 *   could be offered is its display name, which is the name `ana` answers to.
 *   Exactly one of the two may be offered `ana`, and the block must print it for
 *   whichever one it actually reaches.
 * - `dotted` is named `ana.` — legal, typeable, and genuinely resolvable, which
 *   is the trap. It is the token `@ana` becomes at the end of an English
 *   sentence, so any line that puts a handle next to punctuation mis-addresses
 *   somebody REAL rather than nobody. That is the difference between a test that
 *   catches this and a test that shrugs at it.
 *
 * The reader (`You`) joins as the room's creator.
 */
const AGENTS = agentLookupFor({
  '/agents/ana': { name: 'ana', displayName: 'Ana Reyes' },
  '/agents/art-blocks': { name: 'Art Blocks Analytics', displayName: 'Art Blocks Analytics' },
  '/agents/shadow': { name: 'Shadow Two Words', displayName: 'ana' },
  '/agents/dotted': { name: 'ana.', displayName: 'Dot Trailing' },
});

/**
 * Every `@token` in a piece of the block, read with the resolver's OWN grammar.
 *
 * A copy of the pattern here could pass while `resolveMentions` disagreed, which
 * is the exact class of failure under test, so it reads the real one. Run over a
 * single LINE as often as over the whole block: a token is only paired honestly
 * with an author when the pairing comes from where it was printed.
 */
function handlesIn(text: string): string[] {
  return [...text.matchAll(MENTION_PATTERN)].map((match) => match[1]);
}

/**
 * Every `(handle, name)` pair the context DATA carries, from every field the
 * block prints one from.
 *
 * Exact keys, with no shave applied to either side. A token that does not appear
 * here verbatim was not printed as anybody's handle, and the right answer is to
 * fail rather than to go looking for a near match.
 */
function claimsIn(data: RoomContextData): Map<string, string> {
  const claims = new Map<string, string>();
  const add = (handle: string | null, displayName: string): void => {
    if (handle) claims.set(handle, displayName);
  };
  for (const member of data.members) add(member.handle, member.displayName);
  for (const agent of data.working) add(agent.handle, agent.displayName);
  for (const entry of [...data.pending, ...data.ownRecent]) {
    add(entry.authorHandle, entry.authorDisplayName);
  }
  return claims;
}

/** An author's handle as a token list, so a member with none compares as empty. */
function tokenOf(handle: string | null): string[] {
  return handle ? [handle] : [];
}

/**
 * Assert that every token the block printed is the handle of the author whose
 * line printed it — region by region, in order.
 *
 * This is what "printed for" has to mean. Looking a token up in a map answers
 * the RESOLVER's question ("who would this reach?"), and the renderer's mistakes
 * are invisible to it: a handle fused with the punctuation after it is still a
 * token, and may well be somebody's. Reading the tokens off the line that named
 * one author, and comparing them with that author's own handle, is the only form
 * of this check that can see the difference.
 *
 * @param block - The rendered `<room_context>` body.
 * @param data - The context it was rendered from.
 */
function expectEveryHandlePairedWithItsAuthor(block: string, data: RoomContextData): void {
  const lines = block.split('\n');

  // Line 2 of the preamble, always. Taken by position rather than by prefix
  // because line 1 names the room and also opens with "You are".
  const self = data.members.find((member) => member.isSelf);
  expect(handlesIn(lines[1]!)).toEqual(tokenOf(self?.handle ?? null));

  const membersLine = lines.find((line) => line.startsWith('Members: '));
  expect(membersLine).toBeDefined();
  expect(handlesIn(membersLine!)).toEqual(data.members.flatMap((m) => tokenOf(m.handle)));

  const workingLine = lines.find((line) => line.startsWith('Working right now: '));
  expect(workingLine === undefined).toBe(data.working.length === 0);
  if (workingLine) {
    expect(handlesIn(workingLine)).toEqual(data.working.flatMap((w) => tokenOf(w.handle)));
  }

  // `ownRecent` renders above the fence, `pending` inside it, each in order.
  const rendered = [...data.ownRecent, ...data.pending];
  const entryLines = lines.filter((line) => /^\[\d{2}:\d{2}\] /.test(line));
  expect(entryLines).toHaveLength(rendered.length);
  entryLines.forEach((line, index) => {
    const entry = rendered[index]!;
    // A notice is the room's own voice and names nobody after an `@`.
    expect(handlesIn(line)).toEqual(entry.kind === 'notice' ? [] : tokenOf(entry.authorHandle));
  });
}

/** Who each author id is, by the name the roster renders them under. */
function namesById(room: RoomWithRoster): Map<string, string> {
  return new Map(room.members.map((member) => [member.author.id, member.author.displayName]));
}

/** The reverse, for asking "did this token reach the member I meant?". */
function idsByName(room: RoomWithRoster): Map<string, string> {
  return new Map(room.members.map((member) => [member.author.displayName, member.author.id]));
}

describe('every @name in the room-context block reaches the member it names', () => {
  let harness: RoomHarness;
  let service: RoomService;
  let room: RoomWithRoster;

  /**
   * The roster `RoomService.post` resolves a message against — the same class
   * over the same database, since the service keeps its own copy private.
   */
  function candidates(): MentionCandidate[] {
    const roster = new RoomRoster({
      store: new RoomStore(harness.db),
      authors: harness.authors,
      agents: AGENTS,
    });
    return roster.mentionCandidates(room.id);
  }

  /**
   * Open a channel holding every fixture agent, set them all answering, and say
   * something in it — so the block has a roster, working claims, message lines
   * and own-post lines to print handles into.
   *
   * Message bodies are deliberately `@`-free. The fenced region carries whatever
   * a member wrote, and these tests read every `@token` in the whole block on
   * the grounds that the block wrote it; a body containing one would break that
   * reading, and the block makes no claim about it anyway — it is quoted text.
   *
   * **Two messages, not one, and the second is what makes the entry-line half
   * of the pairing real.** After one message every agent's `pending` is empty —
   * the only entry in the room is the trigger, which is excluded by definition —
   * and its `ownRecent` is empty too, because it has not spoken yet. A block
   * with no entry lines cannot catch a renderer that pairs them wrongly. The
   * second message gives every later turn both: what it said last time, and what
   * everybody else said since.
   *
   * @param reply - What each agent says when triggered; `null` keeps them quiet.
   */
  async function openAndSpeak(
    reply: () => string | null = () => 'looking now'
  ): Promise<RoomContextData[]> {
    harness = createRoomHarness({
      agents: AGENTS,
      runner: scriptedRunner(reply),
      maxAgentDepth: MAX_AGENT_DEPTH,
    });
    service = harness.service;
    const created = service.createRoom(
      {
        kind: 'channel',
        slug: 'build',
        title: '#build',
        members: [],
        agentPaths: ['/agents/ana', '/agents/art-blocks', '/agents/shadow', '/agents/dotted'],
      },
      harness.human
    );
    // A channel seeds `mention-only`; these tests want every agent triggered by
    // an ordinary message, so the roster is not filtered down to one turn.
    room = service.getRoom(created.id, harness.human)!;
    for (const member of room.members) {
      if (member.author.kind !== 'agent') continue;
      service.updateMembership(created.id, harness.human, member.author.id, 'always');
    }

    service.post(created.id, { authorId: harness.human, text: 'is the build green?' });
    await service.triggersIdle();
    service.post(created.id, { authorId: harness.human, text: 'and the docs?' });
    await service.triggersIdle();
    room = service.getRoom(created.id, harness.human)!;
    return harness.runner.turns.map((turn) => turn.roomContext);
  }

  it('posts every handle it printed and lands on the author it printed it for', async () => {
    const contexts = await openAndSpeak();
    const names = namesById(room);
    const roster = candidates();
    expect(contexts.length).toBeGreaterThan(0);

    let checked = 0;
    for (const context of contexts) {
      const block = formatRoomContext(context, { nonce: NONCE });
      const claims = claimsIn(context);
      // Each token belongs to the author whose line printed it — asserted before
      // anything looks a token up, because a lookup cannot see this.
      expectEveryHandlePairedWithItsAuthor(block, context);

      for (const token of new Set(handlesIn(block))) {
        // Exact: a token that is not verbatim somebody's handle is one the
        // renderer fused with its surroundings, and no near match excuses it.
        expect(claims.get(token)).toBeDefined();
        // The round trip. `resolveMentions` is what `RoomService.post` runs over
        // a message body, against this same roster, so this is the same question
        // as "if the agent writes this, who gets it?"
        const reached = resolveMentions(`@${token} hi`, roster);
        expect(reached).toHaveLength(1);
        expect(names.get(reached[0])).toBe(claims.get(token));
        checked += 1;
      }
    }
    // Not vacuous: several turns' worth of blocks, each naming several members.
    expect(checked).toBeGreaterThan(5);
    // And specifically not vacuous in the arm that is easiest to leave that way.
    // The entry-line pairing walks `[...ownRecent, ...pending]` against the
    // lines in render order, so it only discriminates on a turn where BOTH
    // regions have something in them — with either empty, a renderer that
    // swapped the two would sail through. Asserted rather than assumed, because
    // an earlier revision of this file had exactly that hole and looked fine.
    expect(
      contexts.some((context) => context.ownRecent.length > 0 && context.pending.length > 0)
    ).toBe(true);
  });

  it('tells an agent an identity that addresses that same agent', async () => {
    // The line this PR broke and a review caught: `You are @ana.` is one token to
    // an English reader and another to the mention grammar, and the resolver
    // matches the exact token BEFORE shaving punctuation — so with `ana.` on the
    // roster (it is, above) that sentence addressed a different agent entirely.
    const contexts = await openAndSpeak();
    const roster = candidates();
    const ids = idsByName(room);

    let checked = 0;
    for (const context of contexts) {
      const self = context.members.find((member) => member.isSelf)!;
      if (!self.handle) continue;
      const identityLine = formatRoomContext(context, { nonce: NONCE }).split('\n')[1]!;
      // Read off the SENTENCE, not off the field it was built from: the whole
      // failure was those two coming apart.
      expect(handlesIn(identityLine)).toEqual([self.handle]);
      expect(resolveMentions(identityLine, roster)).toEqual([ids.get(self.displayName)]);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('drives the same handles through the real write path', async () => {
    // The stronger form of the round trip, run once: take the handles out of a
    // rendered block, post them the way an agent would, and check the stored
    // entry addressed that author. This is the one that would catch a renderer
    // and a test-local resolver agreeing with each other and both being wrong
    // about what a message does.
    const [context] = await openAndSpeak();
    const claims = claimsIn(context!);
    const names = namesById(room);

    const printed = handlesIn(formatRoomContext(context!, { nonce: NONCE }));
    expect(printed.length).toBeGreaterThan(0);
    for (const token of printed) {
      const entry = service.post(room.id, { authorId: harness.human, text: `@${token} hi` });
      expect(entry.mentions).toHaveLength(1);
      expect(names.get(entry.mentions[0])).toBe(claims.get(token));
    }
    await service.triggersIdle();
  });

  it('names a member no string reaches, without inviting a mention of them', async () => {
    const [context] = await openAndSpeak();
    const block = formatRoomContext(context!, { nonce: NONCE });
    const art = context!.members.find((m) => m.displayName === 'Art Blocks Analytics')!;

    // Which agent takes the first turn is a ULID tie-break on an identical
    // `joinedAt`, so whether this member is reading its own block differs run to
    // run — and `(you` rather than `(agent` is how that reads. The invariant
    // does not vary: named, and not addressable.
    expect(art.handle).toBeNull();
    expect(block).toContain(
      `Art Blocks Analytics (${art.isSelf ? 'you' : 'agent'}, cannot be mentioned)`
    );
    // The failure this replaces, in the form it shipped in: `@Art Blocks
    // Analytics`, which the grammar reads as `@Art`, which reaches nobody.
    expect(block).not.toContain('@Art');
    expect(handlesIn(block)).not.toContain('Art');
  });

  it('offers a contested name to exactly one member, and prints it for that one', async () => {
    // Which of the two wins is decided by roster order, and a seeded roster ties
    // on `joinedAt` so a ULID breaks it — differently on every run. So the
    // assertion is the invariant rather than a name: whoever loses `ana` is
    // printed without an `@`, and whoever wins it is who `@ana` reaches.
    const [context] = await openAndSpeak();
    const block = formatRoomContext(context!, { nonce: NONCE });
    const contested = context!.members.filter((member) =>
      ['Ana Reyes', 'ana'].includes(member.displayName)
    );
    expect(contested).toHaveLength(2);

    const offered = contested.filter((member) => member.handle !== null);
    expect(offered).toHaveLength(1);
    expect(offered[0]!.handle).toBe('ana');
    expect(handlesIn(block)).toContain('ana');

    const entry = service.post(room.id, { authorId: harness.human, text: '@ana hi' });
    expect(entry.mentions).toHaveLength(1);
    expect(namesById(room).get(entry.mentions[0])).toBe(offered[0]!.displayName);
    await service.triggersIdle();
  });

  it('never offers a name that ends in punctuation, however typeable it looks', async () => {
    // `ana.` passes every test a handle used to have to pass — one word, legal
    // characters, and `@ana.` really does resolve to it. It is withheld because
    // that same token is what `ana` gets at the end of a sentence, and the
    // resolver hands it to whoever owns it exactly.
    const [context] = await openAndSpeak();
    const block = formatRoomContext(context!, { nonce: NONCE });
    const dotted = context!.members.find((m) => m.displayName === 'Dot Trailing')!;

    expect(dotted.handle).toBeNull();
    expect(handlesIn(block)).not.toContain('ana.');
    // The residual, stated so nobody mistakes this for a fix of the underlying
    // shape: `claimNames` claims every roster name whether or not it is ever
    // advertised, so a person writing `thanks @ana.` in free text still reaches
    // this member. Only `specs/handles` §1 removes it, by requiring a handle to
    // end alphanumeric (Phase 2). What this PR can promise is that nothing
    // DorkOS itself writes puts that string in front of anybody.
    const reached = resolveMentions('thanks @ana.', candidates());
    expect(namesById(room).get(reached[0]!)).toBe('Dot Trailing');
  });

  it('names the author of an old message who has left, and offers no handle for them', async () => {
    // History is not the roster. An entry outlives its author's membership, and
    // nothing typed reaches somebody who is no longer on the roster — so a
    // handle here would be inert at best, and at worst would reach whoever
    // answers to that name now.
    await openAndSpeak(() => null);
    const priya = harness.authors.resolve({
      kind: 'human',
      naturalKey: 'user:priya',
      displayName: 'Priya',
    });
    service.addMember(room.id, harness.human, { authorId: priya.id });
    service.post(room.id, { authorId: priya.id, text: 'the deploy is stuck' });
    await service.triggersIdle();
    service.removeMember(room.id, harness.human, priya.id);
    harness.runner.turns.length = 0;

    service.post(room.id, { authorId: harness.human, text: 'anyone?' });
    await service.triggersIdle();

    const context = harness.runner.turns[0]!.roomContext;
    const hers = context.pending.find((entry) => entry.text === 'the deploy is stuck');
    expect(hers?.authorDisplayName).toBe('Priya');
    expect(hers?.authorHandle).toBeNull();

    const block = formatRoomContext(context, { nonce: NONCE });
    expect(block).toContain('Priya (person, cannot be mentioned): the deploy is stuck');
    expect(block).not.toContain('@Priya');
    // And the invariant still holds over the whole block, departed author and all.
    expectEveryHandlePairedWithItsAuthor(block, context);
  });
});
