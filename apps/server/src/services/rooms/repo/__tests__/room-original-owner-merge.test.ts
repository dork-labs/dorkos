import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { agents } from '@dorkos/db';
import request from '@dorkos/test-utils/supertest';
import { RoomMergeResultSchema } from '@dorkos/shared/room-repo';
import { RoomWorktreeManager, roomWorktreeBranch } from '../room-worktree-manager.js';
import {
  createOriginalOwnedRoomFixture,
  type OriginalOwnedRoomFixture,
} from './room-original-owned-fixture.js';
import { fixtureGit } from './fixture-git.js';

// These are owner HTTP merges of actual registered agent branches. Fixture Git
// only seeds the working copy; it does not attest a native Trigger placement.
describe('original owner Room merge bootstrap', () => {
  let owning: OriginalOwnedRoomFixture;
  let worktree: string;
  let slug: string;
  let branch: string;

  const git = (args: string[], cwd: string) =>
    fixtureGit(args, cwd, owning.repos.homeDir(owning.roomId));
  const merge = () =>
    request(owning.server)
      .post(`/api/rooms/${owning.roomId}/repo/merge`)
      .set('Authorization', `Bearer ${owning.ownerKey.key}`)
      .send({ worktree: slug, summary: 'Add the checklist' });
  async function commit(cwd: string, file: string, contents: string): Promise<void> {
    await writeFile(path.join(cwd, file), contents);
    await git(['add', '--all'], cwd);
    await git(
      [
        '-c',
        'user.name=Fixture Agent',
        '-c',
        'user.email=fixture@dorkos.local',
        'commit',
        '-q',
        '-m',
        'fixture work',
      ],
      cwd
    );
  }

  beforeEach(async () => {
    owning = await createOriginalOwnedRoomFixture();
    const agentPath = path.join(owning.dir, 'agent');
    await mkdir(agentPath);
    const now = new Date().toISOString();
    owning.db
      .insert(agents)
      .values({
        id: 'original-merge-agent',
        name: 'Ana',
        displayName: 'Ana',
        runtime: 'claude-code',
        projectPath: agentPath,
        registeredAt: now,
        updatedAt: now,
      })
      .run();
    owning.subsystem.service.addMember(owning.roomId, owning.operator.id, { agentPath });
    slug = RoomWorktreeManager.slugFor('Ana', agentPath);
    branch = roomWorktreeBranch(slug);
    worktree = path.join(owning.repos.worktreesPath(owning.roomId), slug);
    await mkdir(owning.repos.worktreesPath(owning.roomId), { recursive: true });
    await git(
      ['worktree', 'add', '-b', branch, worktree, 'main'],
      owning.repos.repoPath(owning.roomId)
    );
    await commit(worktree, 'checklist.md', 'one\n');
  });
  afterEach(async () => {
    if (owning) await owning.close();
  });

  it('merges through the actual owner route and records one original Room announcement', async () => {
    const result = await merge();
    expect(result.status).toBe(200);
    const receipt = RoomMergeResultSchema.parse(result.body);
    const repo = owning.repos.repoPath(owning.roomId);
    expect(receipt.branch).toBe(branch);
    expect(receipt.commit).toBe(await git(['rev-parse', 'HEAD'], repo));
    expect((await git(['rev-list', '--parents', '-n', '1', 'HEAD'], repo)).split(' ')).toHaveLength(
      3
    );
    expect(await readFile(path.join(repo, 'checklist.md'), 'utf8')).toBe('one\n');
    const announcements = owning.subsystem.service
      .listEntries(owning.roomId, owning.operator.id, { limit: 100 })
      .filter((entry) => entry.body.merge !== undefined);
    expect(announcements).toHaveLength(1);
    expect(announcements[0]?.seq).toBe(receipt.seq);
    expect(announcements[0]?.body.merge?.commit).toBe(receipt.commit);
  });

  it('keeps main and dirty agent bytes unchanged when the owned route refuses', async () => {
    const repo = owning.repos.repoPath(owning.roomId);
    const before = await git(['rev-parse', 'HEAD'], repo);
    await writeFile(path.join(worktree, 'checklist.md'), 'uncommitted\n');
    const result = await merge();
    expect(result.status).toBe(409);
    expect(result.body.code).toBe('UNCOMMITTED_WORK');
    expect(await git(['rev-parse', 'HEAD'], repo)).toBe(before);
    expect(await readFile(path.join(worktree, 'checklist.md'), 'utf8')).toBe('uncommitted\n');
  });

  it('preserves both branches when actual main has moved past the registered agent branch', async () => {
    const repo = owning.repos.repoPath(owning.roomId);
    await commit(repo, 'room-change.md', 'room update\n');
    const main = await git(['rev-parse', 'HEAD'], repo);
    const agent = await git(['rev-parse', 'HEAD'], worktree);
    const result = await merge();
    expect(result.status).toBe(409);
    expect(result.body.code).toBe('BEHIND_MAIN');
    expect(await git(['rev-parse', 'HEAD'], repo)).toBe(main);
    expect(await git(['rev-parse', 'HEAD'], worktree)).toBe(agent);
  });
});
