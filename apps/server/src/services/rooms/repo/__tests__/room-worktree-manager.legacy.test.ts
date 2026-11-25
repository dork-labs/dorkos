/**
 * room-worktree-manager: legacy plumbing, worktree status and the turn files context.
 * The suite's full rationale is on `room-worktree-manager.fixtures.ts`.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, promises as nodeFsPromises } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { OPERATING_SKILLS_PACK, seedOperatingSkills } from '@dorkos/operating-skills';
import { projectAgentWorkspace } from '../../../harness/project-agent-workspace.js';
import { PROJECTED_ATTACHMENTS_ROOT } from '@dorkos/shared/room-attachment-paths';
import { commitAll } from '../room-repo-git.js';

import {
  agentPath,
  git,
  makeManager,
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

  describe('legacy plumbing (spec `agent-home-desk` §5.9)', () => {
    /**
     * Every retirement below is asked of a FRESH manager — a restarted server —
     * because a worktree this process made holds nothing to retire and is
     * marked done at creation.
     *
     * What a release that stood room turns in the worktree left on disk: the
     * seeded pack and its projection (the same two production calls that wrote
     * them), an attachment projection, and the marker block in `info/exclude`
     * exactly as the last such release built it.
     */
    async function legacyWorktree(name: string): Promise<string> {
      const dir = await worktreeFor(name);
      await seedOperatingSkills(dir);
      // No such release wrote files beside a SKILL.md (DOR-4061 is the first
      // skill that ships them), so today's seeder's are taken back out, unless
      // a case committed them as the room's own.
      for (const skill of OPERATING_SKILLS_PACK) {
        for (const file of Object.keys(skill.files ?? {})) {
          const rel = path.join('.agents', 'skills', skill.name, file);
          if ((await git(['ls-files', rel], dir)) === '') await rm(path.join(dir, rel));
        }
      }
      projectAgentWorkspace(dir);
      await mkdir(path.join(dir, PROJECTED_ATTACHMENTS_ROOT, 'entry-1'), { recursive: true });
      await writeFile(path.join(dir, PROJECTED_ATTACHMENTS_ROOT, 'entry-1', 'a.txt'), 'x', 'utf-8');
      await mkdir(path.dirname(excludeFile()), { recursive: true });
      await writeFile(excludeFile(), LEGACY_BLOCK, 'utf-8');
      return dir;
    }

    function excludeFile(): string {
      return path.join(store.repoPath(ROOM_ID), '.git', 'info', 'exclude');
    }

    const LEGACY_BLOCK = [
      '# somebody’s own line',
      '/scratch/',
      '# --- DorkOS: generated for the agent, not anybody’s work (room-worktree-manager.ts) ---',
      '/.claude/skills/',
      '/.agents/harness.manifest.json',
      `/${path.posix.dirname(PROJECTED_ATTACHMENTS_ROOT)}/`,
      '/.claude/CLAUDE.md',
      ...OPERATING_SKILLS_PACK.map((skill) => `/.agents/skills/${skill.name}/SKILL.md`),
      '# --- end DorkOS ---',
      '',
    ].join('\n');

    it('TR-05: removes what DorkOS wrote, leaves the tree clean, and drops the block when it was the last', async () => {
      await service.enable(ROOM_ID, OPERATOR);
      const dir = await legacyWorktree('ana');
      // The fixture is real: the tree holds the pack, a link and the projection,
      // and reads clean only because the block hides them.
      expect(
        existsSync(path.join(dir, '.agents', 'skills', 'working-in-room-repos', 'SKILL.md'))
      ).toBe(true);
      expect(
        (
          await nodeFsPromises.lstat(path.join(dir, '.claude', 'skills', 'working-in-room-repos'))
        ).isSymbolicLink()
      ).toBe(true);
      expect(await git(['status', '--porcelain=v1'], dir)).toBe('');

      const outcome = await makeManager().retireLegacyPlumbing(ROOM_ID, dir, agentPath('ana'));

      expect(outcome.blockRemoved).toBe(true);
      expect(outcome.removed).toBeGreaterThan(OPERATING_SKILLS_PACK.length);
      expect(existsSync(path.join(dir, '.agents'))).toBe(false);
      expect(existsSync(path.join(dir, '.claude'))).toBe(false);
      expect(existsSync(path.join(dir, '.dork'))).toBe(false);
      const exclude = await readFile(excludeFile(), 'utf-8');
      expect(exclude).not.toContain('DorkOS');
      // Somebody else's lines survive.
      expect(exclude).toContain('# somebody’s own line');
      expect(exclude).toContain('/scratch/');
      // And with the block gone the tree still reads clean — nothing was left
      // that the block had been hiding.
      expect(await git(['status', '--porcelain=v1'], dir)).toBe('');
    });

    it('keeps a modified skill and a real file at a projection path, and keeps the block for them', async () => {
      await service.enable(ROOM_ID, OPERATOR);
      const dir = await legacyWorktree('ana');
      const edited = path.join(dir, '.agents', 'skills', 'working-in-room-repos', 'SKILL.md');
      await writeFile(edited, `${await readFile(edited, 'utf-8')}\nMy own note.\n`, 'utf-8');
      const realLink = path.join(dir, '.claude', 'skills', 'reading-activity');
      await rm(realLink, { force: true });
      await mkdir(realLink, { recursive: true });
      await writeFile(path.join(realLink, 'SKILL.md'), '# mine\n', 'utf-8');

      const outcome = await makeManager().retireLegacyPlumbing(ROOM_ID, dir, agentPath('ana'));

      expect(existsSync(edited)).toBe(true);
      expect(await readFile(path.join(realLink, 'SKILL.md'), 'utf-8')).toBe('# mine\n');
      // The unmodified ones and the attachments still went.
      expect(existsSync(path.join(dir, '.agents', 'skills', 'reading-activity'))).toBe(false);
      expect(existsSync(path.join(dir, PROJECTED_ATTACHMENTS_ROOT))).toBe(false);
      expect(outcome.blockRemoved).toBe(false);
      expect(await readFile(excludeFile(), 'utf-8')).toContain('# --- DorkOS:');
      // Removing it now would make the tree read dirty.
      expect(await git(['status', '--porcelain=v1'], dir)).toBe('');
    });

    it('keeps the block while ANOTHER worktree of the room still holds what it hides', async () => {
      await service.enable(ROOM_ID, OPERATOR);
      const ana = await legacyWorktree('ana');
      const bo = await legacyWorktree('bo');

      expect(
        (await makeManager().retireLegacyPlumbing(ROOM_ID, ana, agentPath('ana'))).blockRemoved
      ).toBe(false);
      expect(await git(['status', '--porcelain=v1'], bo)).toBe('');

      expect(
        (await makeManager().retireLegacyPlumbing(ROOM_ID, bo, agentPath('bo'))).blockRemoved
      ).toBe(true);
      expect(await git(['status', '--porcelain=v1'], ana)).toBe('');
    });

    it('keeps the block while the room`s MAIN checkout still holds something it hides', async () => {
      // `repo/` reads the same `info/exclude`, and `repo/` found dirty stops
      // every write to the room — so the block is not the worktrees' alone.
      await service.enable(ROOM_ID, OPERATOR);
      const dir = await legacyWorktree('ana');
      const repoDir = store.repoPath(ROOM_ID);
      await mkdir(path.join(repoDir, PROJECTED_ATTACHMENTS_ROOT), { recursive: true });
      await writeFile(path.join(repoDir, PROJECTED_ATTACHMENTS_ROOT, 'stray.txt'), 's', 'utf-8');
      expect(await git(['status', '--porcelain=v1'], repoDir)).toBe('');

      const outcome = await makeManager().retireLegacyPlumbing(ROOM_ID, dir, agentPath('ana'));

      expect(outcome.blockRemoved).toBe(false);
      expect(await git(['status', '--porcelain=v1'], repoDir)).toBe('');
    });

    it('never deletes a tracked file at a legacy path', async () => {
      // An exclude cannot hide a TRACKED file, so a room that committed its own
      // copy of a pack skill is somebody's work, even when it is byte for byte
      // what the seeder writes.
      await service.enable(ROOM_ID, OPERATOR);
      const repoDir = store.repoPath(ROOM_ID);
      await seedOperatingSkills(repoDir);
      await commitAll(
        repoDir,
        'commit a pack copy',
        { name: 'D', email: 'd@dorkos.local' },
        scratch
      );
      const dir = await legacyWorktree('ana');

      await makeManager().retireLegacyPlumbing(ROOM_ID, dir, agentPath('ana'));

      expect(
        existsSync(path.join(dir, '.agents', 'skills', 'working-in-room-repos', 'SKILL.md'))
      ).toBe(true);
      expect(await git(['status', '--porcelain=v1'], dir)).toBe('');
    });

    it('runs once per worktree per process', async () => {
      await service.enable(ROOM_ID, OPERATOR);
      const dir = await legacyWorktree('ana');
      const restarted = makeManager();
      await restarted.retireLegacyPlumbing(ROOM_ID, dir, agentPath('ana'));
      // Something the old code would have written reappears (a person put it
      // back): this process does not look again.
      await mkdir(path.join(dir, PROJECTED_ATTACHMENTS_ROOT), { recursive: true });
      await writeFile(path.join(dir, PROJECTED_ATTACHMENTS_ROOT, 'b.txt'), 'y', 'utf-8');

      expect((await restarted.retireLegacyPlumbing(ROOM_ID, dir, agentPath('ana'))).removed).toBe(
        0
      );
      expect(existsSync(path.join(dir, PROJECTED_ATTACHMENTS_ROOT, 'b.txt'))).toBe(true);
    });
  });

  describe('worktreeStatus', () => {
    it('is null for a worktree that was never made', async () => {
      await service.enable(ROOM_ID, OPERATOR);
      await expect(manager.worktreeStatus(ROOM_ID, 'nobody-00000000')).resolves.toBeNull();
    });

    it('reports a fresh tree as clean, merged and touched just now', async () => {
      await service.enable(ROOM_ID, OPERATOR);
      const handle = await manager.ensureWorktree(ROOM_ID, agentPath('ana'), 'Ana');

      const status = await manager.worktreeStatus(ROOM_ID, handle.slug);

      expect(status).toMatchObject({ slug: handle.slug, dirty: false, aheadOfMain: 0 });
      expect(Date.now() - new Date(status!.lastTouchedAt).getTime()).toBeLessThan(60_000);
    });

    it('reports uncommitted edits and unmerged commits', async () => {
      await service.enable(ROOM_ID, OPERATOR);
      const handle = await manager.ensureWorktree(ROOM_ID, agentPath('ana'), 'Ana');
      await writeFile(path.join(handle.path, 'done.md'), 'finished', 'utf-8');
      await commitAll(
        handle.path,
        'work',
        { name: 'Ana', email: 'ana@dorkos.local' },
        store.homeDir(ROOM_ID)
      );
      await writeFile(path.join(handle.path, 'wip.md'), 'half an idea', 'utf-8');

      await expect(manager.worktreeStatus(ROOM_ID, handle.slug)).resolves.toMatchObject({
        dirty: true,
        aheadOfMain: 1,
      });
    });
  });

  describe('turnFilesContext', () => {
    it('is null for a room with no files of its own', async () => {
      // No repo, no section: a conversation-only room renders a context
      // byte-identical to the one it rendered before this field existed.
      await expect(
        manager.turnFilesContext(ROOM_ID, agentPath('ana'), 'Ana', '/anywhere')
      ).resolves.toBeNull();
    });

    it('names both trees and measures the branch against main', async () => {
      await service.enable(ROOM_ID, OPERATOR);
      const handle = await manager.ensureWorktree(ROOM_ID, agentPath('ana'), 'Ana');

      const files = await manager.turnFilesContext(ROOM_ID, agentPath('ana'), 'Ana', handle.path);

      expect(files).toEqual({
        // The caller's directory verbatim: the section must describe the tree
        // the turn is standing in, never one rebuilt here.
        worktreePath: handle.path,
        branch: handle.branch,
        repoPath: store.repoPath(ROOM_ID),
        behind: 0,
        ahead: 0,
      });
    });

    it('counts the commits each side has that the other has not', async () => {
      await service.enable(ROOM_ID, OPERATOR);
      const handle = await manager.ensureWorktree(ROOM_ID, agentPath('ana'), 'Ana');
      await writeFile(path.join(handle.path, 'mine.md'), 'mine', 'utf-8');
      await commitAll(
        handle.path,
        'mine',
        { name: 'Ana', email: 'ana@dorkos.local' },
        store.homeDir(ROOM_ID)
      );
      // And the room moves on without her.
      const repoDir = store.repoPath(ROOM_ID);
      await writeFile(path.join(repoDir, 'theirs.md'), 'theirs', 'utf-8');
      await commitAll(
        repoDir,
        'theirs',
        { name: 'Bo', email: 'bo@dorkos.local' },
        store.homeDir(ROOM_ID)
      );

      await expect(
        manager.turnFilesContext(ROOM_ID, agentPath('ana'), 'Ana', handle.path)
      ).resolves.toMatchObject({ ahead: 1, behind: 1 });
    });

    it('still says where the agent works when git cannot answer', async () => {
      // DEGRADES rather than disappearing (DOR-1599 review). Here the branch does
      // not exist, so `rev-list main...room/<slug>` fails — but the paths and the
      // branch name are derived, not measured, so the one-writer prohibition the
      // block builds on them survives. Nulling the whole section would drop that
      // rule exactly when the repo is in a state nobody understands.
      await service.enable(ROOM_ID, OPERATOR);

      const files = await manager.turnFilesContext(
        ROOM_ID,
        agentPath('ana'),
        'Ana',
        '/where/the/turn/runs'
      );

      expect(files).toMatchObject({
        worktreePath: '/where/the/turn/runs',
        repoPath: store.repoPath(ROOM_ID),
        // Not zero. "Not measured" and "level with the room" must never collapse:
        // an agent told it is up to date when nothing checked edits without
        // syncing.
        behind: null,
        ahead: null,
      });
      expect(files?.branch).toMatch(/^room\//);
    });
  });
});
