/**
 * A project a person kept to some accounts keeps that limit when its repo
 * becomes one git will not be run in (Security's Must on #3216, DOR-3343).
 * An agent in the repo can write a `credential.helper` into its settings; that
 * makes the lookup `refused`, and without this the folder read as "no project"
 * and every account became eligible there. Matched by path against the roots
 * the account rules name, so no git runs.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lookupProjectRoot } from '../resolve-project-root.js';
import { accountEligibility, projectOfFolder } from '../../core/usage/account-eligibility.js';

let base: string;
let project: string;
let sibling: string;

/** Rules that keep `project` to account `alpha` only. */
function rulesKeeping(root: string) {
  return {
    get: () => ({ claudeCode: { projectAccounts: { [root]: { allow: ['alpha'] } } } }),
  };
}

beforeAll(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'refused-rules-')));
  project = path.join(base, 'proj');
  mkdirSync(path.join(project, 'src'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: project });
  // What an agent in the repo could write: now git will not be run there.
  execFileSync('git', ['config', '--local', 'credential.helper', 'store'], { cwd: project });
  // A neighbour whose name starts with the project's, under no rule.
  sibling = path.join(base, 'proj-other');
  mkdirSync(sibling, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: sibling });
  execFileSync('git', ['config', '--local', 'credential.helper', 'store'], { cwd: sibling });
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('a kept project whose repo git will not read', () => {
  it('is still that project, from its root and from a folder inside it', async () => {
    await expect(lookupProjectRoot(project)).resolves.toEqual({ kind: 'refused' });
    const config = rulesKeeping(project);
    await expect(projectOfFolder(project, config)).resolves.toMatchObject({ root: project });
    await expect(projectOfFolder(path.join(project, 'src'), config)).resolves.toMatchObject({
      root: project,
    });
  });

  it('keeps every other account out, and the allowed one in', async () => {
    const config = rulesKeeping(project);
    const found = await projectOfFolder(project, config);
    expect(accountEligibility(config, 'claude-code', 'beta', found)).toMatchObject({
      eligible: false,
      reason: 'project-allowlist',
    });
    expect(accountEligibility(config, 'claude-code', 'alpha', found)).toEqual({ eligible: true });
  });

  it('never matches a neighbour that only starts with the same name', async () => {
    await expect(projectOfFolder(sibling, rulesKeeping(project))).resolves.toBeNull();
  });
});
