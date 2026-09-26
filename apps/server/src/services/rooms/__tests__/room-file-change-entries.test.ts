/**
 * The line a room gets when a PERSON changes its files, and the turn it must
 * never start (spec `agent-home-desk` §7.2, invariant I10).
 *
 * The merge entry's shape and the merge entry's guarantees
 * (`room-merge-entries.test.ts`): a post in the room's own voice, addressing
 * nobody, its cascade already spent, and never dispatched. Run against the
 * shipped trigger machinery with two agents on `always`, so "no turn ran" is the
 * guard refusing rather than a room where nothing ever runs — the control at
 * the top of the cascade test is what makes that visible.
 *
 * Seeded defect, run red before the code stood: stamping the entry's cascade
 * as a person's (`authorKind: 'human'`) reddens "starts a cascade that is
 * already spent". The no-dispatch claim is held twice over — the entry never
 * goes through the trigger path, and its cascade starts spent — so the two
 * wake tests are the control that a person's line really does wake this room.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { RoomEntry, RoomFileChangeEvent, RoomWithRoster } from '@dorkos/shared/room-schemas';
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

const agents = agentLookupFor({
  [ANA]: { name: 'ana', displayName: 'Ana', responseMode: 'always' },
  [BEN]: { name: 'ben', displayName: 'Ben', responseMode: 'always' },
});

const MAX_AGENT_DEPTH = 3;

const CHANGE: RoomFileChangeEvent = {
  kind: 'edit',
  paths: ['ROOM.md'],
  pathCount: 1,
  commit: '97b2e8360101a1da7b1b9d5c74aed64f8738b89c',
};

describe('file-change entries', () => {
  let service: RoomService;
  let authors: AuthorRegistry;
  let runner: ScriptedTurnRunner;
  let room: RoomWithRoster;
  let human: string;

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
    const ana = authors.resolveAgent(ANA, 'Ana').id;
    const ben = authors.resolveAgent(BEN, 'Ben').id;
    service.updateMembership(room.id, human, ana, 'always');
    service.updateMembership(room.id, human, ben, 'always');
  });

  function announce(text = 'Dorian edited ROOM.md'): RoomEntry {
    return service.postFileChangeEvent(room.id, {
      text,
      fileChange: CHANGE,
      subjectAuthorId: human,
    });
  }

  it('writes a post in the room’s own voice, about the person who made the change', () => {
    const entry = announce();

    expect(entry.kind).toBe('post');
    expect(entry.body.notice).toBeUndefined();
    expect(entry.authorId).toBe(authors.system().id);
    expect(entry.body.text).toBe('Dorian edited ROOM.md');
    expect(entry.body.subjectAuthorId).toBe(human);
    expect(entry.body.fileChange).toEqual(CHANGE);
    const log = service.listEntries(room.id, human, { limit: 200 });
    expect(log.at(-1)?.id).toBe(entry.id);
  });

  it('addresses nobody, and starts a cascade that is already spent', () => {
    const entry = announce();

    expect(entry.mentions).toEqual([]);
    expect(entry.mentionSpans).toEqual([]);
    expect(entry.sessionId).toBeNull();
    expect(entry.cascadeDepth).toBe(MAX_AGENT_DEPTH);
    expect(entry.cascadeRoot).toBe(entry.id);
  });

  it('wakes nobody — a person’s edit is news about files, not a question', async () => {
    // The control: two agents on `always` live here, and a line from a person
    // wakes them.
    service.post(room.id, { authorId: human, text: 'morning' });
    await service.triggersIdle();
    const woken = runner.turns.length;
    expect(woken).toBeGreaterThan(0);

    announce();
    await service.triggersIdle();

    expect(runner.turns).toHaveLength(woken);
  });

  it('does not wake anybody even when a file name reads like an address', async () => {
    service.post(room.id, { authorId: human, text: 'morning' });
    await service.triggersIdle();
    const woken = runner.turns.length;

    const entry = announce('Dorian added @ben notes.md');
    await service.triggersIdle();

    expect(entry.mentions).toEqual([]);
    expect(runner.turns).toHaveLength(woken);
  });

  it('refuses to write into an archived room', () => {
    service.updateRoom(room.id, human, { archived: true });
    expect(() => announce()).toThrow(RoomError);
  });
});
