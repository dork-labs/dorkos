/**
 * room-worktree-manager: the reap and the sweep that runs it.
 * The suite's full rationale is on `room-worktree-manager.fixtures.ts`.
 */
import { describe, it, expect, vi } from 'vitest';
import { existsSync, promises as nodeFsPromises } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RoomRepoReconciler } from '../room-repo-reconciler.js';
import { RoomWorktreeManager } from '../room-worktree-manager.js';
import { commitAll, hasLocalBranch, removeWorktree } from '../room-repo-git.js';

import {
  agentPath,
  ancientWorktree,
  git,
  knobs,
  makeAncient,
  manager,
  OPERATOR,
  ROOM_ID,
  service,
  store,
  useWorktreeWorld,
  worktreeFor,
} from './room-worktree-manager.fixtures.js';

describe('RoomWorktreeManager', () => {
  useWorktreeWorld();

  describe('the reap', () => {
    it('SPARES A DIRTY WORKTREE, at any setting of worktreeReapDays', async () => {
      // The claim `config.rooms.repo.worktreeReapDays`'s no-risk verdict rests
      // on. Zero idle days is the most aggressive setting the code can be
      // given — more aggressive than the schema's minimum of 1 — so a tree that
      // survives THIS survives every real configuration.
      await service.enable(ROOM_ID, OPERATOR);
      const dir = await worktreeFor('ana');
      await writeFile(path.join(dir, 'wip.md'), 'half an idea', 'utf-8');
      knobs.reapAfterDays = 0;

      const swept = await manager.reapRoom(ROOM_ID);

      expect(swept.reaped).toEqual([]);
      expect(swept.stranded).toEqual([path.basename(dir)]);
      expect(existsSync(path.join(dir, 'wip.md'))).toBe(true);
      expect(await readFile(path.join(dir, 'wip.md'), 'utf-8')).toBe('half an idea');
    });

    it('SPARES A CLEAN WORKTREE MAIN HAS NOT GOT, at any setting of worktreeReapDays', async () => {
      // The other half of the same claim: `git status` says nothing is wrong
      // here, and the tree still holds a commit that would be lost.
      await service.enable(ROOM_ID, OPERATOR);
      const dir = await worktreeFor('bo');
      await writeFile(path.join(dir, 'done.md'), 'finished, unmerged', 'utf-8');
      const sha = await commitAll(
        dir,
        'work',
        { name: 'Bo', email: 'bo@dorkos.local' },
        store.homeDir(ROOM_ID)
      );
      expect(await git(['status', '--porcelain=v1'], dir)).toBe('');
      knobs.reapAfterDays = 0;

      const swept = await manager.reapRoom(ROOM_ID);

      expect(swept.reaped).toEqual([]);
      expect(swept.stranded).toEqual([path.basename(dir)]);
      expect(existsSync(dir)).toBe(true);
      expect(await git(['rev-parse', 'HEAD'], dir)).toBe(sha);
    });

    it('would be refused by git even if the stranded gate were wrong about a dirty tree', async () => {
      // The third gate, asked directly. `reapRoom` never reaches it for a dirty
      // worktree — the stranded list catches that first — so it is pinned here
      // instead: `git worktree remove` WITHOUT `--force` refuses a tree holding
      // work, at a later moment than DorkOS's own check. That is what protects
      // an agent that started typing between the two.
      await service.enable(ROOM_ID, OPERATOR);
      const dir = await worktreeFor('ana');
      await writeFile(path.join(dir, 'wip.md'), 'half an idea', 'utf-8');

      await expect(
        removeWorktree(store.repoPath(ROOM_ID), dir, store.homeDir(ROOM_ID))
      ).rejects.toThrow(/contains modified or untracked files/);
      expect(existsSync(path.join(dir, 'wip.md'))).toBe(true);
    });

    it('spares a directory git cannot read at all', async () => {
      await service.enable(ROOM_ID, OPERATOR);
      const junk = path.join(store.worktreesPath(ROOM_ID), 'mystery');
      await mkdir(junk, { recursive: true });
      await writeFile(path.join(junk, 'notes.md'), 'not a checkout', 'utf-8');
      knobs.reapAfterDays = 0;

      const swept = await manager.reapRoom(ROOM_ID);

      expect(swept.reaped).toEqual([]);
      expect(swept.stranded).toContain('mystery');
      expect(existsSync(path.join(junk, 'notes.md'))).toBe(true);
    });

    it('removes a clean, merged, idle working copy and retires its branch', async () => {
      await service.enable(ROOM_ID, OPERATOR);
      const handle = await manager.ensureWorktree(ROOM_ID, agentPath('ana'), 'Ana');
      makeAncient();

      const swept = await manager.reapRoom(ROOM_ID);

      expect(swept.reaped).toEqual([handle.slug]);
      expect(existsSync(handle.path)).toBe(false);
      // The branch goes with it — `git branch -d`, so a branch main did not
      // contain would have survived regardless.
      await expect(
        hasLocalBranch(store.repoPath(ROOM_ID), handle.branch, store.homeDir(ROOM_ID))
      ).resolves.toBe(false);
      // And git's own bookkeeping matches the disk again.
      expect(await git(['worktree', 'list', '--porcelain'], store.repoPath(ROOM_ID))).not.toContain(
        handle.slug
      );
    });

    it('keeps a working copy that was touched inside the idle window', async () => {
      await service.enable(ROOM_ID, OPERATOR);
      const handle = await manager.ensureWorktree(ROOM_ID, agentPath('ana'), 'Ana');

      const swept = await manager.reapRoom(ROOM_ID);

      expect(swept.reaped).toEqual([]);
      expect(swept.spared).toEqual([handle.slug]);
      expect(existsSync(handle.path)).toBe(true);
    });

    it('removes nothing while room files are switched off', async () => {
      await service.enable(ROOM_ID, OPERATOR);
      const handle = await manager.ensureWorktree(ROOM_ID, agentPath('ana'), 'Ana');
      knobs.reapAfterDays = 0;
      const offManager = new RoomWorktreeManager({
        store,
        hasRepo: () => false,
        listStrandedWorktrees: (roomId) => service.listStrandedWorktrees(roomId),
        reapAfterDays: () => 0,
        busyAgentPaths: () => [],
      });

      await expect(offManager.reapRoom(ROOM_ID)).resolves.toEqual({
        reaped: [],
        reapedTreeKeptBranch: [],
        spared: [],
        stranded: [],
      });
      expect(existsSync(handle.path)).toBe(true);
    });

    it('removes a genuinely ancient working copy at the SHIPPED default', async () => {
      // The control for the spare-because-busy and refresh-the-clock tests:
      // same fixture, same 14-day cap, and with nothing protecting it the idle
      // tree is reaped. This is also the regression guard for the load bug —
      // the reap's idle clock no longer reads any mtime the sweep can perturb,
      // so a genuinely idle tree is removed however slow the runner.
      await service.enable(ROOM_ID, OPERATOR);
      const dir = await ancientWorktree('ana');
      knobs.reapAfterDays = 14;

      const swept = await manager.reapRoom(ROOM_ID);

      expect(swept.reaped).toEqual([path.basename(dir)]);
      expect(existsSync(dir)).toBe(false);
    });

    it('never consults the git index for the idle decision', async () => {
      // The production fix — the reap's idle clock must not read the git index
      // mtime, so a sweep's `git status` (which rewrites that mtime to `now`)
      // cannot spare an idle tree. Proven DETERMINISTICALLY: earlier real-clock
      // versions of this guard aged the worktree's real mtimes and read them
      // back, and that coupling flaked on CI's loaded filesystem no matter how
      // the aging was ordered. So this asks the question a different way, with
      // no real mtime in the answer at all:
      //
      // - idle is driven by the injected clock (`makeAncient`), so the tree is
      //   reaped without a single backdated mtime;
      // - discrimination is a stat SPY. The index of a linked worktree lives at
      //   `<repo>/.git/worktrees/<slug>/index`. The dating path's only stats are
      //   `lstat`s on the worktree directory and its direct children — never
      //   anything under `.git`. Re-add the index as a source and the reap must
      //   `lstat` that path; the spy would catch it and this assertion reddens.
      await service.enable(ROOM_ID, OPERATOR);
      const handle = await manager.ensureWorktree(ROOM_ID, agentPath('ana'), 'Ana');
      // The hazard, made real: stamp the worktree index `now`, the way any sweep
      // git op does. Its mtime must simply never be looked at.
      await git(['status', '--porcelain=v1'], handle.path);
      makeAncient();
      knobs.reapAfterDays = 14;

      const statted: string[] = [];
      const realLstat = nodeFsPromises.lstat;
      vi.spyOn(nodeFsPromises, 'lstat').mockImplementation((async (target, opts) => {
        statted.push(String(target));
        return realLstat(target, opts);
      }) as typeof nodeFsPromises.lstat);

      const swept = await manager.reapRoom(ROOM_ID);
      vi.restoreAllMocks();

      // The idle decision still fires — the tree is gone.
      expect(swept.reaped).toEqual([handle.slug]);
      expect(existsSync(handle.path)).toBe(false);
      // The spy actually saw the dating pass (the worktree dir is statted by
      // the path ending in its slug) — without this, a production move off
      // `promises.lstat` would empty `statted` and fail the guard OPEN.
      expect(statted.some((p) => p.endsWith(handle.slug))).toBe(true);
      // And it never touched a git-index file to get there. The regex matches
      // an `index` file anywhere under a `.git` (the worktree's, at
      // `.git/worktrees/<slug>/index`, or a bare `.git/index`), and is immune to
      // the `/var` -> `/private/var` symlink that a literal prefix compare is not.
      const hits = statted.filter((p) => /[/\\]\.git[/\\](?:.*[/\\])?index$/.test(p));
      if (hits.length)
        console.error('INDEX-HITS', JSON.stringify(hits), 'TOTAL-STATS', statted.length);
      expect(hits).toEqual([]);
    });

    it('SPARES AN ANCIENT WORKTREE ITS AGENT IS WORKING IN RIGHT NOW', async () => {
      // Forty days idle, clean, merged, and the cwd of a live turn. Nothing the
      // filesystem can say distinguishes this from the test above — a turn that
      // reads its worktree and has not written yet moves no timestamp — so the
      // claim map is the only thing standing between the sweep and a running
      // turn's working directory.
      await service.enable(ROOM_ID, OPERATOR);
      const dir = await ancientWorktree('ana');
      knobs.reapAfterDays = 14;
      knobs.busyAgentPaths = [agentPath('ana')];

      const swept = await manager.reapRoom(ROOM_ID);

      expect(swept.reaped).toEqual([]);
      expect(swept.spared).toEqual([path.basename(dir)]);
      expect(existsSync(dir)).toBe(true);
    });

    it('spares a worktree whose agent claims a turn WHILE the sweep is running', async () => {
      // The snapshot race, reproduced. Every gate above the removal is decided
      // from one snapshot taken before the sweep's first `await`, and the sweep
      // then spans many of them — a `git status` per candidate, a stranded-list
      // walk, a `git log` per tree. A turn that claims inside that window was
      // not in `knobs.busyAgentPaths` when it was read and its `utimes` stamp was not
      // in `dated`, so the tree it is standing in was deleted underneath it —
      // and the attachment projector, which runs next, recreated the directory
      // as something that is not a checkout.
      //
      // Driven through the claim map's own reader: the sweep takes ONE snapshot
      // of it, and the turn arrives immediately afterwards. Every later read
      // sees the claim, so a sweep that only ever consults its snapshot deletes
      // a directory that is in use by the time it gets there.
      await service.enable(ROOM_ID, OPERATOR);
      const dir = await ancientWorktree('ana');
      knobs.reapAfterDays = 14;
      // Nobody is working when the sweep takes its snapshot; the turn claims
      // the instant it has.
      let reads = 0;
      knobs.busyAgentPathsReader = () => {
        reads += 1;
        return reads === 1 ? [] : [agentPath('ana')];
      };

      const swept = await manager.reapRoom(ROOM_ID);

      expect(swept.reaped).toEqual([]);
      expect(swept.spared).toEqual([path.basename(dir)]);
      // The whole point: the live turn's working directory is still a checkout.
      expect(existsSync(dir)).toBe(true);
      expect(existsSync(path.join(dir, '.git'))).toBe(true);
    });

    it('spares a worktree a READ-ONLY turn claimed mid-sweep, on the stamp alone', async () => {
      // The half the claim map cannot cover on its own, and the reason the
      // re-check re-stats the DIRECTORY rather than re-asking `lastTouchedAt`:
      // a turn that only thinks and reads writes nothing git can see, so
      // `ensureWorktree`'s stamp on the directory is the only trace it leaves.
      // Here the claim is already released by the time the removals run — the
      // turn was short — so that stamp is all there is left to save it.
      await service.enable(ROOM_ID, OPERATOR);
      const dir = await ancientWorktree('ana');
      knobs.reapAfterDays = 14;
      knobs.busyAgentPaths = [];
      let ran = false;
      knobs.strandedDuringSweep = async () => {
        if (ran) return;
        ran = true;
        // A whole turn: resolve the cwd, read nothing, release the claim.
        await manager.ensureWorktree(ROOM_ID, agentPath('ana'), 'ana');
      };

      const swept = await manager.reapRoom(ROOM_ID);

      expect(swept.spared).toEqual([path.basename(dir)]);
      expect(existsSync(path.join(dir, '.git'))).toBe(true);
    });

    it('is not fooled by another agent being busy', async () => {
      // The busy gate matches on the digest half of the worktree name, which is
      // the only join available between a directory and an agent path. A
      // different agent's claim must not spare this one.
      await service.enable(ROOM_ID, OPERATOR);
      const dir = await ancientWorktree('ana');
      knobs.reapAfterDays = 14;
      knobs.busyAgentPaths = [agentPath('somebody-else')];

      await expect(manager.reapRoom(ROOM_ID)).resolves.toMatchObject({
        reaped: [path.basename(dir)],
      });
    });

    it('reports a removal whose branch survived as its own outcome, not as reaped', async () => {
      // The commit-between-list-and-removal window, forced open by a stranded
      // list that lies. It cannot happen for real — the idle clock reads HEAD's
      // committer date AFTER the stranded list, and `worktreeReapDays` is
      // .min(1) — but if it ever did, "tidied away" would be a false summary of
      // a branch that is still sitting there.
      await service.enable(ROOM_ID, OPERATOR);
      const dir = await worktreeFor('ana');
      const slug = path.basename(dir);
      // A commit main does not have — real "now", so it is genuinely ahead. The
      // idle clock is advanced past the cap AFTER the commit, so the tree still
      // reads ancient; this is simulating a commit the stranded list MISSED, not
      // one the idle clock should have caught.
      await writeFile(path.join(dir, 'late.md'), 'committed after the list', 'utf-8');
      await commitAll(
        dir,
        'late',
        { name: 'Ana', email: 'ana@dorkos.local' },
        store.homeDir(ROOM_ID)
      );
      makeAncient();
      const blind = new RoomWorktreeManager({
        store,
        hasRepo: (roomId) => service.hasRepo(roomId),
        listStrandedWorktrees: async () => [],
        reapAfterDays: () => 14,
        busyAgentPaths: () => [],
        now: () => knobs.nowMs,
      });

      const swept = await blind.reapRoom(ROOM_ID);

      expect(swept.reaped).toEqual([]);
      expect(swept.reapedTreeKeptBranch).toEqual([slug]);
      // Nothing was lost: the commits are still on the branch.
      await expect(
        hasLocalBranch(store.repoPath(ROOM_ID), `room/${slug}`, store.homeDir(ROOM_ID))
      ).resolves.toBe(true);
    });

    it('is nothing at all for a room that never had files', async () => {
      await expect(manager.reapRoom(ROOM_ID)).resolves.toEqual({
        reaped: [],
        reapedTreeKeptBranch: [],
        spared: [],
        stranded: [],
      });
    });
  });

  describe('the sweep that runs it', () => {
    it('reaps through the reconciler, so the install has one pass and one guard', async () => {
      await service.enable(ROOM_ID, OPERATOR);
      const idle = await manager.ensureWorktree(ROOM_ID, agentPath('ana'), 'Ana');
      const busy = await manager.ensureWorktree(ROOM_ID, agentPath('bo'), 'Bo');
      await writeFile(path.join(busy.path, 'wip.md'), 'half an idea', 'utf-8');
      knobs.reapAfterDays = 14;
      makeAncient();

      const result = await new RoomRepoReconciler(store, undefined, manager).reconcile();

      expect(result.worktrees).toEqual({
        reaped: 1,
        reapedTreeKeptBranch: 0,
        spared: 0,
        stranded: 1,
      });
      expect(existsSync(idle.path)).toBe(false);
      expect(existsSync(busy.path)).toBe(true);
    });

    it('leaves the worktrees of a room whose binding has gone alone', async () => {
      // An orphaned home is reported and left standing (the reconciler's own
      // rule); its working copies are not the sweep's to reclaim either.
      await service.enable(ROOM_ID, OPERATOR);
      const handle = await manager.ensureWorktree(ROOM_ID, agentPath('ana'), 'Ana');
      await rm(store.sidecarPath(ROOM_ID), { force: true });
      knobs.reapAfterDays = 0;

      const result = await new RoomRepoReconciler(store, undefined, manager).reconcile();

      expect(result.worktrees).toEqual({
        reaped: 0,
        reapedTreeKeptBranch: 0,
        spared: 0,
        stranded: 0,
      });
      expect(existsSync(handle.path)).toBe(true);
    });
  });
});
