/**
 * `room_repo_status`: what the room's files look like to one member — the main
 * tip, every agent's branch, and what is unmerged or stranded (spec
 * `project-rooms` §3.6). Split from `room-merge-service.test.ts` by subject; it
 * stands on the same real-git world, in `room-merge-service.fixtures.ts`.
 */
import { describe, it, expect } from 'vitest';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOM_REPO_CAP_DEFAULTS } from '@dorkos/shared/room-repo';
import {
  agentPath,
  ANA,
  BEN,
  commitIn,
  enableRepo,
  git,
  knobs,
  merges,
  OPERATOR,
  refusalOf,
  ROOM_ID,
  slugOf,
  store,
  useMergeWorld,
} from './room-merge-service.fixtures.js';

describe('RoomMergeService', () => {
  // A fresh home inside an enclosing repo, per test (see the fixtures).
  useMergeWorld();

  describe('room_repo_status', () => {
    it('reports the main tip, every branch, and what is unmerged', async () => {
      await enableRepo();
      await commitIn(ANA, 'ana.md', 'ana\n');
      const benDir = await commitIn(BEN, 'ben.md', 'ben\n');
      await writeFile(path.join(benDir, 'scratch.md'), 'wip', 'utf-8');
      await merges.merge(ROOM_ID, ANA, { summary: 'Ana’s work' });

      const status = await merges.status(ROOM_ID, ANA);

      expect(status.mainCommit).toBe(await git(['rev-parse', 'main'], store.repoPath(ROOM_ID)));
      expect(status.mainCommittedAt).toMatch(/^\d{4}-/);

      const ana = status.branches.find((b) => b.slug === slugOf(ANA));
      // Ana has merged, so she is holding nothing — but she IS one behind, and
      // that is `--no-ff` being honest: the merge commit exists on main and on
      // no branch. Nothing is stranded, because stranded is about work nobody
      // has, not about a branch being level.
      expect(ana).toMatchObject({ agent: 'Ana', mine: true, ahead: 0, behind: 1, dirty: false });
      expect(ana?.stranded).toBe(false);

      const ben = status.branches.find((b) => b.slug === slugOf(BEN));
      expect(ben).toMatchObject({ agent: 'Ben', mine: false, ahead: 1, dirty: true });
      expect(ben?.behind).toBeGreaterThan(0);
      expect(ben?.stranded).toBe(true);
      expect(status.strandedWorktrees).toEqual([slugOf(BEN)]);

      expect(status.size.usedBytes).toBeGreaterThan(0);
      expect(status.size.maxRepoBytes).toBe(ROOM_REPO_CAP_DEFAULTS.maxRepoBytes);
    });

    it('never puts an agent’s workspace path in front of the room', async () => {
      await enableRepo();
      await commitIn(BEN, 'ben.md', 'ben\n');
      const status = await merges.status(ROOM_ID, ANA);
      // An agent reads its own rooms' status, and `/Users/…` is not something
      // to hand every member. The slug is a digest, which is the point.
      expect(JSON.stringify(status)).not.toContain(agentPath('ben'));
    });

    it('answers a non-member as no such room', async () => {
      await enableRepo();
      knobs.members = [OPERATOR, ANA];
      const refusal = await refusalOf(merges.status(ROOM_ID, BEN));
      expect(refusal.code).toBe('ROOM_NOT_FOUND');
    });

    it('gives each caller their OWN branch as `mine`, even off the same cached answer', async () => {
      // The answer is memoized per `(room, main sha)` for a few seconds, and
      // `mine` is the one field in it that is about who ASKED rather than about
      // the room. So the cache must hold the room's answer and re-aim `mine`
      // per caller — the tempting mistake is to cache the whole per-caller
      // object, which hands the second caller the first one's idea of whose
      // branch is theirs. Both agents commit so both have a branch to own.
      await enableRepo();
      await commitIn(ANA, 'ana.md', 'ana\n');
      await commitIn(BEN, 'ben.md', 'ben\n');

      // Ana asks first: a cache miss, so this computes and stores.
      const forAna = await merges.status(ROOM_ID, ANA);
      // Ben asks inside the memo window: a cache HIT on the same `main` sha, so
      // this exercises `withCaller` on a cached answer rather than a fresh one.
      const forBen = await merges.status(ROOM_ID, BEN);

      const anaSlug = slugOf(ANA);
      const benSlug = slugOf(BEN);

      // Each sees exactly their own row as theirs.
      expect(forAna.branches.find((b) => b.slug === anaSlug)?.mine).toBe(true);
      expect(forAna.branches.find((b) => b.slug === benSlug)?.mine).toBe(false);
      expect(forBen.branches.find((b) => b.slug === benSlug)?.mine).toBe(true);
      expect(forBen.branches.find((b) => b.slug === anaSlug)?.mine).toBe(false);

      // And it really was one cached computation, not two: the two answers agree
      // on every field that is about the ROOM, differing only in `mine`.
      expect(forBen.mainCommit).toBe(forAna.mainCommit);
      expect(forBen.branches.map((b) => b.slug)).toEqual(forAna.branches.map((b) => b.slug));
    });
  });
});
