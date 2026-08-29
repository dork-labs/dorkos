/**
 * The line a room gets when work is merged into its files, and the turn it must
 * never start (spec `project-rooms` §3.6, resolution Q3).
 *
 * A merge is content: it is what a project room is FOR, and two merges a minute
 * apart have to be two lines. That rules out the notices machinery, which damps
 * on `(room, agent, reason)` — and it rules in the one thing left, an ordinary
 * post the room writes in its own voice.
 *
 * The claim that needs a real dispatcher to prove is the second one: **it wakes
 * nobody**. Everything here runs against the shipped trigger machinery
 * (`createRoomHarness`) with two agents on `always`, so "no turn ran" is the
 * guard refusing rather than a room where nothing ever runs — the control at the
 * top of the cascade test is what makes that difference visible.
 *
 * Seeded defects, each run red before the code stood:
 *
 * - Routing the announcement through `RoomService.post` under the merging
 *   agent's own author id reddens three tests, and **which three is worth
 *   knowing**: the voice test, the activity test, and the `@ben` case. It does
 *   NOT redden the plain "wakes nobody" case, because two independent
 *   mechanisms hold that one down — the entry is never dispatched at all, and
 *   its cascade starts spent — so breaking one leaves the other. The `@ben`
 *   case is therefore the discriminating no-cascade test and is written to be:
 *   a summary that names a member is the one input that could reach a
 *   colleague past the depth rule. The plain case stays as the control that a
 *   line from a person really does wake this room.
 * - Dropping `deriveCascade`'s system stamp (hand-stamping `cascadeDepth: 0`)
 *   reddens "starts a cascade that is already spent".
 * - Resolving mentions out of the text instead of storing an empty list reddens
 *   "addresses nobody" and the `@ben` case with it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { RoomEntry, RoomWithRoster } from '@dorkos/shared/room-schemas';
import type { AuthorRegistry } from '../author-registry.js';
import { RoomError } from '../room-errors.js';
import type { RoomService } from '../room-service.js';
import {
  agentLookupFor,
  createRoomHarness,
  scriptedRunner,
  type ScriptedTurnRunner,
} from './room-test-harness.js';

const ANA = '/agents/ana';
const BEN = '/agents/ben';

/** Both answer everything — so "nothing was triggered" means the guard. */
const agents = agentLookupFor({
  [ANA]: { name: 'ana', displayName: 'Ana', responseMode: 'always' },
  [BEN]: { name: 'ben', displayName: 'Ben', responseMode: 'always' },
});

/** The ceiling, pinned to a literal so the assertions measure a number. */
const MAX_AGENT_DEPTH = 3;

/** What one merge brought in. */
const MERGE = {
  branch: 'room/ana-466c1067',
  commit: '97b2e8360101a1da7b1b9d5c74aed64f8738b89c',
  files: 4,
  insertions: 120,
  deletions: 8,
};

describe('merge entries', () => {
  let service: RoomService;
  let authors: AuthorRegistry;
  let runner: ScriptedTurnRunner;
  let room: RoomWithRoster;
  let human: string;
  let ana: string;
  let ben: string;

  beforeEach(() => {
    ({ service, authors, runner, human } = createRoomHarness({
      agents,
      runner: scriptedRunner(() => 'on it'),
      maxAgentDepth: MAX_AGENT_DEPTH,
    }));
    room = service.createRoom(
      { kind: 'channel', title: 'Release train', members: [], agentPaths: [ANA, BEN] },
      human
    );
    ana = authors.resolveAgent(ANA, 'Ana').id;
    ben = authors.resolveAgent(BEN, 'Ben').id;
    // A channel seeds `engaged`, which answers inside a window. Both go to
    // `always`, so every "nothing ran" below is the guard rather than a window
    // that had not opened.
    service.updateMembership(room.id, human, ana, 'always');
    service.updateMembership(room.id, human, ben, 'always');
  });

  /** Every entry in the room, oldest first. */
  function log(): RoomEntry[] {
    return service.listEntries(room.id, human, { limit: 200 });
  }

  /** Announce one merge, as `RoomMergeService` does. */
  function announce(text = 'Ana merged: Add the deploy checklist — 4 files, +120/−8'): RoomEntry {
    return service.postMergeEvent(room.id, { text, merge: MERGE, subjectAuthorId: ana });
  }

  it('writes a post in the room’s own voice, about the agent whose work landed', () => {
    const entry = announce();

    // A post, not a fourth entry kind and not a notice: the history page, the
    // stream, a thread and a bridge all carry it with no new branch, and
    // nothing damps it.
    expect(entry.kind).toBe('post');
    expect(entry.body.notice).toBeUndefined();
    expect(entry.authorId).toBe(authors.system().id);
    expect(entry.body.text).toBe('Ana merged: Add the deploy checklist — 4 files, +120/−8');
    // The identity the feed draws beside a sentence the room wrote.
    expect(entry.body.subjectAuthorId).toBe(ana);
    // The machine-readable half, which is what the file explorer refreshes off.
    expect(entry.body.merge).toEqual(MERGE);
    expect(log().at(-1)?.id).toBe(entry.id);
  });

  it('addresses nobody, however the sentence reads', () => {
    const entry = announce();
    // The agent's name is in the text as a FACT. Mentions resolve once, at
    // write time, and are stored — so nothing re-reads this line later and
    // decides it was addressed to somebody.
    expect(entry.mentions).toEqual([]);
    expect(entry.mentionSpans).toEqual([]);
    expect(entry.sessionId).toBeNull();
  });

  it('starts a cascade that is already spent', () => {
    const entry = announce();
    // The shipped rule rather than a hand-stamped number: a non-human write
    // with no trigger behind it begins at the ceiling, so even a future path
    // that DID dispatch from an entry like this one could not open a fresh
    // reply budget with it.
    expect(entry.cascadeDepth).toBe(MAX_AGENT_DEPTH);
    expect(entry.cascadeRoot).toBe(entry.id);
  });

  it('wakes nobody — a merge is news about files, not a question', async () => {
    // The control, so "nothing ran" cannot pass in a room where nothing ever
    // runs: two agents on `always` live here, and a line from a person wakes
    // them.
    service.post(room.id, { authorId: human, text: 'morning' });
    await service.triggersIdle();
    const woken = runner.turns.length;
    expect(woken).toBeGreaterThan(0);

    announce();
    await service.triggersIdle();

    expect(runner.turns).toHaveLength(woken);
  });

  it('does not wake anybody even when the merge summary names an agent', async () => {
    service.post(room.id, { authorId: human, text: 'morning' });
    await service.triggersIdle();
    const woken = runner.turns.length;

    // A summary an agent wrote could say anything, `@ben` included. Nothing
    // parses this text for addresses, which is the whole reason `mentions` is
    // set to empty at write time rather than derived.
    const entry = announce('Ana merged: pair with @ben on the rollout — 1 file, +2/−0');
    await service.triggersIdle();

    expect(entry.mentions).toEqual([]);
    expect(runner.turns).toHaveLength(woken);
  });

  it('DOES move the room up the sidebar, because a merge is real activity', () => {
    // Stated as the behaviour rather than the opposite, which is what an earlier
    // version of this test claimed while asserting neither. A merge goes through
    // the ordinary entry writer, which bumps `lastActivityAt` unconditionally —
    // and that is right: work landing in a room's files is something a person
    // wants to see the room surface for, unlike a reaction, which deliberately
    // does not move it. What a merge must not do is take a TURN, and the tests
    // above are where that is proved.
    const before = service.getRoom(room.id, human)?.lastActivityAt;
    const entry = announce();
    const after = service.getRoom(room.id, human)?.lastActivityAt;

    expect(entry.seq).toBeGreaterThan(0);
    expect(after).toBeDefined();
    expect(Date.parse(after!)).toBeGreaterThanOrEqual(Date.parse(before!));
    expect(after).toBe(entry.createdAt);
    expect(log().filter((e) => e.body.merge !== undefined)).toHaveLength(1);
  });

  it('refuses to write a merge into an archived room', () => {
    service.updateRoom(room.id, human, { archived: true });
    // Archiving promises a room stops gaining entries, in its own voice least
    // of all. `RoomMergeService` asks this BEFORE it merges, so nothing lands
    // in git that the room could never be told about.
    expect(() => announce()).toThrow(RoomError);
  });
});
