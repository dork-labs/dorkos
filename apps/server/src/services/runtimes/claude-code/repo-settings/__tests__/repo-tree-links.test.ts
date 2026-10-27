/**
 * Reading a commit's tree through its symlinks (DOR-3298, QA on #3213): a
 * linked skill is found under the path the worktree uses, and a link out of
 * the repo is refused as "not there", never followed and never an error.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listTreeThroughLinks } from '../repo-tree-links.js';
import { git, isolateGitEnv, makeRepo, writeFile, type RepoFixture } from './git-fixture.js';

let repo: RepoFixture;
let restoreEnv: () => void;
let head: string;

beforeEach(() => {
  restoreEnv = isolateGitEnv();
  repo = makeRepo({ '.agents/skills/x/SKILL.md': '---\nname: x\n---\n' });
  fs.mkdirSync(path.join(repo.main, '.claude/skills'), { recursive: true });
  fs.symlinkSync('../../.agents/skills/x', path.join(repo.main, '.claude/skills/x'));
  fs.symlinkSync('x', path.join(repo.main, '.claude/skills/y'));
  writeFile(path.join(repo.root, 'outside/z/SKILL.md'), '---\nname: z\n---\n');
  fs.symlinkSync('../../../outside/z', path.join(repo.main, '.claude/skills/z'));
  fs.symlinkSync(path.join(repo.root, 'outside/z'), path.join(repo.main, '.claude/skills/abs'));
  head = repo.commit('links');
});

afterEach(() => {
  repo.cleanup();
  restoreEnv();
});

describe('listTreeThroughLinks', () => {
  it('finds a linked skill under the path the worktree reads, with its real blob', async () => {
    const listed = await listTreeThroughLinks(repo.main, head, ['.claude/skills/x/SKILL.md']);
    const real = git(repo.main, ['rev-parse', `${head}:.agents/skills/x/SKILL.md`]);
    expect(listed.get('.claude/skills/x/SKILL.md')?.oid).toBe(real);
  });

  it('follows a link to a link', async () => {
    const listed = await listTreeThroughLinks(repo.main, head, ['.claude/skills/y/SKILL.md']);
    expect(listed.has('.claude/skills/y/SKILL.md')).toBe(true);
  });

  it('refuses a link up and out of the repo: not there, and no error', async () => {
    await expect(
      listTreeThroughLinks(repo.main, head, ['.claude/skills/z/SKILL.md'])
    ).resolves.toEqual(new Map());
  });

  it('refuses an absolute link, even one that names a real folder', async () => {
    await expect(
      listTreeThroughLinks(repo.main, head, ['.claude/skills/abs/SKILL.md'])
    ).resolves.toEqual(new Map());
  });
});
