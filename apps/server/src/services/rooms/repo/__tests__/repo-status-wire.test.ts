/**
 * The room-repo shapes the server still declares for itself ARE the ones the
 * port promises.
 *
 * **Most of this file's original subject is gone, and that is the good
 * outcome.** `RoomRepoStatus`, `RoomMainStatus` and `RoomBranchStatus` used to
 * be declared twice — once here, once in `@dorkos/shared/room-repo` — and this
 * test existed to keep the two in step. DOR-1599 removed the duplication
 * instead: the service imports the shared types, so there is one declaration
 * and nothing left to drift. Checking those pairs now would compare a type to
 * itself and pass forever.
 *
 * Two pairs survive, and they are real:
 *
 * - `StrayChange` (git's own reading of a dirty checkout) against
 *   `RoomStrayChange` (what the room reports). Separate on purpose — one is
 *   this module's vocabulary, the other is the wire's — and separate is exactly
 *   what drifts.
 * - `RoomMainRepairResult`, which the repair route returns and the Transport
 *   port declares, still written out at both ends.
 *
 * Both directions are checked. One alone would miss the half that matters:
 * assignable-to-wire catches a field this end drops, assignable-from-wire
 * catches a field this end never learns about.
 *
 * @module services/rooms/repo/__tests__/repo-status-wire
 */
import { describe, expect, it } from 'vitest';
import type {
  RoomMainRepairResult as WireRepairResult,
  RoomRepoStatus,
  RoomStrayChange as WireStrayChange,
} from '@dorkos/shared/room-repo';
import {
  MAX_REPORTED_ROOM_STRAYS,
  RoomMainStatusSchema,
  RoomRepoStatusSchema,
} from '@dorkos/shared/room-repo';
import type { RoomMainRepairResult } from '../room-repo-service.js';
import type { StrayChange } from '../room-repo-git.js';

/**
 * `true` only when two types are each assignable to the other.
 *
 * Both directions, because one alone misses the half that matters:
 * server-assignable-to-wire catches a field this end drops, and
 * wire-assignable-to-server catches a field this end never learns about. The
 * tuple wrappers stop a union distributing, which would let a partial overlap
 * answer `true`.
 */
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * The same check, with every optional field made required first.
 *
 * **{@link Mutual} alone is blind to optional-field drift, and that was
 * measured rather than assumed**: dropping the required `authorId` from one
 * side reds immediately, while dropping the OPTIONAL `renamedFrom` does not —
 * `{ a: string }` and `{ a: string; b?: string }` are mutually assignable,
 * because a value satisfying the first satisfies the second by omitting `b`.
 *
 * That is exactly the drift this file exists to catch. `renamedFrom` is
 * optional and it is load-bearing: undoing a rename needs the old path as well
 * as the new one, so a wire type that quietly lost it would take a destructive
 * half-completion all the way to a client. `Required<>` makes both optionals
 * present, so a field on one side and not the other is a mismatch again.
 */
type MutualIncludingOptional<A, B> = Mutual<Required<A>, Required<B>>;

/**
 * Fails to COMPILE unless its argument type is `true`.
 *
 * A type-level assertion needs no runtime, but it does need to be read by the
 * compiler, and an unused type alias is the first thing an editor offers to
 * delete. Calling it from an expectation keeps it load-bearing in both.
 */
function mutual<T extends true>(): true {
  return true as T;
}

describe('the repo status this server computes and the one the port promises', () => {
  it('are the same shape, in both directions', () => {
    expect(mutual<Mutual<StrayChange, WireStrayChange>>()).toBe(true);
    expect(mutual<Mutual<RoomMainRepairResult, WireRepairResult>>()).toBe(true);
  });

  it('are the same shape down to their optional fields', () => {
    // The half the check above cannot see: `Mutual` is blind to a field that is
    // optional on one side and absent on the other. `StrayChange` carries the
    // one optional field today (`renamedFrom`).
    expect(mutual<MutualIncludingOptional<StrayChange, WireStrayChange>>()).toBe(true);
    expect(mutual<MutualIncludingOptional<RoomMainRepairResult, WireRepairResult>>()).toBe(true);
  });

  it('agree on how many stray changes a status carries', () => {
    // The cap is the server's decision and the client's expectation at once: a
    // reader that trusted a longer list would draw rows the server will never
    // send, and one that trusted a shorter one would hide changes it was given.
    expect(MAX_REPORTED_ROOM_STRAYS).toBe(50);
  });

  it('parses a status the server would really answer', () => {
    // The type check above is structural; this is the runtime half of the same
    // claim — a fully populated answer, through the schema a client validates
    // a conflict payload with.
    const answered: RoomRepoStatus = {
      mainCommit: 'a'.repeat(40),
      mainCommittedAt: '2026-08-29T10:00:00.000Z',
      main: {
        branch: 'main',
        dirty: true,
        strays: [
          { path: 'ROOM.md', kind: 'modified' },
          { path: 'notes/new.md', kind: 'untracked' },
          { path: 'notes/moved.md', kind: 'added', renamedFrom: 'notes/old.md' },
        ],
        strayCount: 3,
      },
      branches: [
        {
          slug: 'ana',
          branch: 'room/ana',
          agent: 'Ana',
          authorId: 'author-ana',
          mine: false,
          hasWorktree: true,
          ahead: 2,
          behind: 0,
          dirty: false,
          stranded: true,
        },
      ],
      strandedWorktrees: ['ana'],
      size: { usedBytes: 1024, maxRepoBytes: 500 * 1024 * 1024, maxFileBytes: 5 * 1024 * 1024 },
    };

    expect(RoomRepoStatusSchema.safeParse(answered).success).toBe(true);
    expect(RoomMainStatusSchema.safeParse(answered.main).success).toBe(true);
  });
});
