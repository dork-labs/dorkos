/**
 * room-worktree-manager: slugs and making a worktree.
 * The suite's full rationale is on `room-worktree-manager.fixtures.ts`.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { OPERATING_SKILLS_PACK } from '@dorkos/operating-skills';
import { RoomError } from '../../room-errors.js';
import { roomWorktreeSlug } from '../../../core/room-worktree-name/room-worktree-name.js';
import { commitAll, commonGitDir, hasLocalBranch } from '../room-repo-git.js';

import {
  agentPath,
  ancientWorktree,
  git,
  knobs,
  manager,
  OPERATOR,
  ROOM_ID,
  scratch,
  service,
  store,
  useWorktreeWorld,
  worktreeFor,
} from './room-worktree-manager.fixtures.js';

describe('RoomWorktreeManager', () => {
  useWorktreeWorld();

  describe('slugFor', () => {
    it('is filesystem-safe whatever the agent is called', () => {
      const slug = roomWorktreeSlug('../../etc/passwd', '/tmp/a');
      expect(slug).toMatch(/^[a-z][a-z0-9-]*-[0-9a-f]{8}$/);
      expect(path.basename(slug)).toBe(slug);
    });

    it('keeps a name that is nothing but punctuation from becoming an empty path', () => {
      expect(roomWorktreeSlug('...', '/tmp/a')).toMatch(/^agent-[0-9a-f]{8}$/);
    });

    it('gives two agents with one name two different worktrees', () => {
      // The collision case, and why the digest is unconditional: a suffix added
      // only on collision would depend on who arrived first, and would change
      // under the survivor when the other agent was deleted.
      const ana = roomWorktreeSlug('Ana', '/agents/ana');
      const other = roomWorktreeSlug('ana', '/agents/ana-the-second');
      expect(ana).not.toBe(other);
      expect(ana.startsWith('ana-')).toBe(true);
      expect(other.startsWith('ana-')).toBe(true);
    });

    it('is the same answer every time for the same agent, however its path is spelled', () => {
      expect(roomWorktreeSlug('Ana', '/agents/ana')).toBe(
        roomWorktreeSlug('Ana', '/agents/./ana/')
      );
    });
  });

  describe('ensureWorktree', () => {
    it('refuses a room that has no files of its own', async () => {
      await expect(worktreeFor('ana')).rejects.toThrow(RoomError);
      await expect(worktreeFor('ana')).rejects.toMatchObject({ code: 'NOT_A_PROJECT_ROOM' });
    });

    it('branches room/<slug> off main and checks it out under worktrees/', async () => {
      await service.enable(ROOM_ID, OPERATOR);

      const handle = await manager.ensureWorktree(ROOM_ID, agentPath('ana'), 'Ana');

      expect(handle.created).toBe(true);
      expect(handle.path).toBe(path.join(store.worktreesPath(ROOM_ID), handle.slug));
      expect(handle.branch).toBe(`room/${handle.slug}`);
      expect(await git(['rev-parse', '--abbrev-ref', 'HEAD'], handle.path)).toBe(handle.branch);
      // It starts from main's tip, so ROOM.md is there and nothing is unmerged.
      expect(existsSync(path.join(handle.path, 'ROOM.md'))).toBe(true);
      expect(await git(['rev-list', '--count', 'main..HEAD'], handle.path)).toBe('0');
    });

    it('is idempotent: the second call answers the same tree and creates nothing', async () => {
      await service.enable(ROOM_ID, OPERATOR);
      const first = await manager.ensureWorktree(ROOM_ID, agentPath('ana'), 'Ana');
      await writeFile(path.join(first.path, 'wip.md'), 'half an idea', 'utf-8');

      const second = await manager.ensureWorktree(ROOM_ID, agentPath('ana'), 'Ana');

      expect(second.created).toBe(false);
      expect(second.path).toBe(first.path);
      // Uncommitted work survives — that is the whole point of a STANDING tree.
      expect(await readFile(path.join(second.path, 'wip.md'), 'utf-8')).toBe('half an idea');
    });

    it('creates one tree when two turns ask at the same moment', async () => {
      await service.enable(ROOM_ID, OPERATOR);

      const [a, b] = await Promise.all([
        manager.ensureWorktree(ROOM_ID, agentPath('ana'), 'Ana'),
        manager.ensureWorktree(ROOM_ID, agentPath('ana'), 'Ana'),
      ]);

      expect(a.path).toBe(b.path);
      expect(existsSync(a.path)).toBe(true);
    });

    it('gives two agents in one room two trees on two branches', async () => {
      await service.enable(ROOM_ID, OPERATOR);
      const ana = await manager.ensureWorktree(ROOM_ID, agentPath('ana'), 'Ana');
      const bo = await manager.ensureWorktree(ROOM_ID, agentPath('bo'), 'Bo');

      expect(ana.path).not.toBe(bo.path);
      expect(await git(['rev-parse', '--abbrev-ref', 'HEAD'], ana.path)).toBe(ana.branch);
      expect(await git(['rev-parse', '--abbrev-ref', 'HEAD'], bo.path)).toBe(bo.branch);
    });

    it('re-attaches a branch the reap left behind rather than failing forever', async () => {
      // `git worktree remove` takes the directory and leaves the branch, and a
      // `git branch -d` can refuse or never run. `-b` would then fail on every
      // later turn for that agent, permanently.
      await service.enable(ROOM_ID, OPERATOR);
      const first = await manager.ensureWorktree(ROOM_ID, agentPath('ana'), 'Ana');
      await git(['worktree', 'remove', first.path], store.repoPath(ROOM_ID));
      expect(await hasLocalBranch(store.repoPath(ROOM_ID), first.branch, store.homeDir(ROOM_ID)));

      const again = await manager.ensureWorktree(ROOM_ID, agentPath('ana'), 'Ana');

      expect(again.created).toBe(true);
      expect(again.branch).toBe(first.branch);
      expect(await git(['rev-parse', '--abbrev-ref', 'HEAD'], again.path)).toBe(first.branch);
    });

    it('writes nothing into a new worktree: no pack, no projection, no exclude block', async () => {
      // Spec `agent-home-desk` §5.8: a room turn stands in its agent's home,
      // where its skills and instructions already are, so a worktree is exactly
      // the room's files on the agent's branch. A room whose files carry skills
      // and an AGENTS.md is the shape that used to draw projection into it.
      await service.enable(ROOM_ID, OPERATOR);
      const repoDir = store.repoPath(ROOM_ID);
      await mkdir(path.join(repoDir, '.agents', 'skills', 'house-style'), { recursive: true });
      await writeFile(
        path.join(repoDir, '.agents', 'skills', 'house-style', 'SKILL.md'),
        '# house style\n',
        'utf-8'
      );
      await writeFile(path.join(repoDir, 'AGENTS.md'), '# Room rules\n', 'utf-8');
      await commitAll(repoDir, 'skills and rules', { name: 'D', email: 'd@dorkos.local' }, scratch);

      const handle = await manager.ensureWorktree(ROOM_ID, agentPath('ana'), 'Ana');

      expect(handle.repo).toBe(repoDir);
      expect(existsSync(path.join(handle.path, '.claude'))).toBe(false);
      for (const skill of OPERATING_SKILLS_PACK) {
        expect(existsSync(path.join(handle.path, '.agents', 'skills', skill.name))).toBe(false);
      }
      expect(existsSync(path.join(handle.path, '.agents', 'harness.manifest.json'))).toBe(false);
      const excludeFile = path.join(
        await commonGitDir(repoDir, store.homeDir(ROOM_ID)),
        'info',
        'exclude'
      );
      const exclude = existsSync(excludeFile) ? await readFile(excludeFile, 'utf-8') : '';
      expect(exclude).not.toContain('DorkOS');
      expect(await git(['status', '--porcelain=v1'], handle.path)).toBe('');
    });

    it('heals a directory that is not a checkout instead of handing it back forever', async () => {
      // The wedge: a creation that died part-way leaves a directory with no
      // `.git` in it. Returning it as valid was permanent — the reap lists an
      // unreadable directory as stranded work and never removes it, so nothing
      // could ever repair the thing this method kept answering with.
      await service.enable(ROOM_ID, OPERATOR);
      const slug = roomWorktreeSlug('Ana', agentPath('ana'));
      const corpse = path.join(store.worktreesPath(ROOM_ID), slug);
      await mkdir(corpse, { recursive: true });
      await writeFile(path.join(corpse, 'half-written.md'), 'from the crash', 'utf-8');

      const handle = await manager.ensureWorktree(ROOM_ID, agentPath('ana'), 'Ana');

      expect(handle.created).toBe(true);
      expect(handle.path).toBe(corpse);
      expect(existsSync(path.join(corpse, '.git'))).toBe(true);
      expect(await git(['rev-parse', '--abbrev-ref', 'HEAD'], corpse)).toBe(handle.branch);
      // And the contents were moved aside, never deleted: nothing here knows
      // why that directory had files in it.
      const aside = (await readdir(store.worktreesPath(ROOM_ID))).find((n) =>
        n.startsWith(`${slug}.orphaned-`)
      );
      expect(aside).toBeDefined();
      expect(
        await readFile(path.join(store.worktreesPath(ROOM_ID), aside!, 'half-written.md'), 'utf-8')
      ).toBe('from the crash');
    });

    it('gives two callers racing on a half-made directory one real checkout each', async () => {
      // PROBE-B, made deterministic: the directory is already there and is NOT
      // a checkout, which is exactly what the second caller of a creation still
      // in flight would see. With the existence check ahead of the in-flight
      // map, that caller took the early return and handed a turn a path with no
      // `.git` in it.
      await service.enable(ROOM_ID, OPERATOR);
      const slug = roomWorktreeSlug('Ana', agentPath('ana'));
      await mkdir(path.join(store.worktreesPath(ROOM_ID), slug), { recursive: true });

      const [a, b] = await Promise.all([
        manager.ensureWorktree(ROOM_ID, agentPath('ana'), 'Ana'),
        manager.ensureWorktree(ROOM_ID, agentPath('ana'), 'Ana'),
      ]);

      expect(a.path).toBe(b.path);
      for (const handle of [a, b]) {
        expect(handle.created).toBe(true);
        expect(existsSync(path.join(handle.path, '.git'))).toBe(true);
      }
      expect(await git(['rev-parse', '--abbrev-ref', 'HEAD'], a.path)).toBe(a.branch);
    });

    it('refreshes the idle clock every time it hands the path out', async () => {
      // The reap's first line of defence, and the reason it is needed: once the
      // cwd rung landed this method IS how a turn learns where to run, and a
      // turn that only READS its worktree moves no timestamp of its own. The
      // sibling test 'removes a genuinely ancient working copy at the SHIPPED
      // default' is this one's control — same fixture, same setting, and it is
      // reaped when nothing hands the path out first. The only difference here
      // is the extra `ensureWorktree`, whose stamp writes `now()` onto the
      // directory and pulls it back inside the window.
      await service.enable(ROOM_ID, OPERATOR);
      const dir = await ancientWorktree('ana');
      knobs.reapAfterDays = 14;

      await manager.ensureWorktree(ROOM_ID, agentPath('ana'), 'Ana');
      const swept = await manager.reapRoom(ROOM_ID);

      expect(swept.reaped).toEqual([]);
      expect(swept.spared).toEqual([path.basename(dir)]);
      expect(existsSync(dir)).toBe(true);
    });
  });
});
