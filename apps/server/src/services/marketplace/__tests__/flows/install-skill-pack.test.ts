/**
 * Tests for {@link SkillPackInstallFlow}. Exercises the four enumerated
 * cases from spec marketplace-02-install task 4.3:
 *
 * 1. Happy path — fixture skill-pack with three SKILL.md files installs
 *    cleanly into `${dorkHome}/plugins/<name>/`.
 * 2. Project-local install — `opts.projectPath` redirects the install root
 *    to `<projectPath>/.dork/plugins/<name>/`.
 * 3. Stage failure — an invalid SKILL.md makes `stage()` throw via the
 *    real `@dorkos/skills` parser; transaction cleans up; install root
 *    is never created.
 * 4. Activate failure — `fs.rename` failure leaves no residue and the
 *    install root is never created.
 *
 * Uses the real `@dorkos/skills` parser (no mocks) so any drift in the
 * SKILL.md format is caught here.
 */
import { mkdtemp, mkdir, writeFile, rm, access, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { noopLogger } from '@dorkos/shared/logger';
import type { SkillPackPackageManifest } from '@dorkos/marketplace';
import { SkillPackInstallFlow } from '../../flows/install-skill-pack.js';
import { _internal as transactionInternal } from '../../transaction.js';

const VALID_SKILL_BODY = '# Body\n\nA short skill body for tests.';

const baseManifest: SkillPackPackageManifest = {
  schemaVersion: 1,
  name: 'sample-skill-pack',
  version: '0.1.0',
  type: 'skill-pack',
  description: 'A sample skill-pack used by install flow tests.',
};

function buildSkillFile(name: string, description: string): string {
  return [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    '---',
    '',
    VALID_SKILL_BODY,
    '',
  ].join('\n');
}

async function writeSkill(
  packageRoot: string,
  relativeDir: string,
  name: string,
  description: string
): Promise<void> {
  const dir = path.join(packageRoot, relativeDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'SKILL.md'), buildSkillFile(name, description), 'utf8');
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function buildValidPackage(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'dorkos-skill-pack-src-'));
  await writeSkill(root, '.dork/skills', 'first-skill', 'Does the first thing.');
  await writeSkill(root, '.dork/skills', 'second-skill', 'Does the second thing.');
  await writeSkill(root, '.dork/tasks', 'nightly-thing', 'Runs nightly to do a thing.');
  await mkdir(path.join(root, '.dork'), { recursive: true });
  await writeFile(
    path.join(root, '.dork', 'manifest.json'),
    JSON.stringify({ ...baseManifest }, null, 2),
    'utf8'
  );
  return root;
}

async function buildPackageWithInvalidSkill(): Promise<string> {
  const root = await buildValidPackage();
  // Write an invalid SKILL.md (missing required `description`).
  const badDir = path.join(root, '.dork/skills/broken-skill');
  await mkdir(badDir, { recursive: true });
  await writeFile(
    path.join(badDir, 'SKILL.md'),
    ['---', 'name: broken-skill', '---', '', VALID_SKILL_BODY, ''].join('\n'),
    'utf8'
  );
  return root;
}

describe('SkillPackInstallFlow', () => {
  let dorkHome: string;
  let projectPath: string;
  const cleanupRoots: string[] = [];

  beforeEach(async () => {
    // CRITICAL: prevent runTransaction from doing real `git reset --hard` against
    // the live worktree. The transaction engine's failure-path rollback would
    // otherwise wipe uncommitted tracked-file changes during test runs.
    vi.spyOn(transactionInternal, 'isGitRepo').mockResolvedValue(false);

    dorkHome = await mkdtemp(path.join(tmpdir(), 'dorkos-skill-pack-home-'));
    projectPath = await mkdtemp(path.join(tmpdir(), 'dorkos-skill-pack-proj-'));
    cleanupRoots.push(dorkHome, projectPath);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    while (cleanupRoots.length > 0) {
      const dir = cleanupRoots.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('installs a valid skill-pack into the global plugins directory', async () => {
    const packagePath = await buildValidPackage();
    cleanupRoots.push(packagePath);

    const flow = new SkillPackInstallFlow({ dorkHome, logger: noopLogger });
    const result = await flow.install(packagePath, baseManifest, { name: baseManifest.name });

    const expectedRoot = path.join(dorkHome, 'plugins', baseManifest.name);
    expect(result).toMatchObject({
      ok: true,
      packageName: baseManifest.name,
      version: baseManifest.version,
      type: 'skill-pack',
      installPath: expectedRoot,
      manifest: baseManifest,
      warnings: [],
    });
    expect(await exists(expectedRoot)).toBe(true);

    // Spot-check that all three SKILL.md files made the trip.
    const firstSkill = path.join(expectedRoot, '.dork/skills/first-skill/SKILL.md');
    const secondSkill = path.join(expectedRoot, '.dork/skills/second-skill/SKILL.md');
    const taskSkill = path.join(expectedRoot, '.dork/tasks/nightly-thing/SKILL.md');
    expect(await exists(firstSkill)).toBe(true);
    expect(await exists(secondSkill)).toBe(true);
    expect(await exists(taskSkill)).toBe(true);
    const firstContent = await readFile(firstSkill, 'utf8');
    expect(firstContent).toContain('name: first-skill');
  });

  it('installs project-local when projectPath is supplied', async () => {
    const packagePath = await buildValidPackage();
    cleanupRoots.push(packagePath);

    const flow = new SkillPackInstallFlow({ dorkHome, logger: noopLogger });
    const result = await flow.install(packagePath, baseManifest, {
      name: baseManifest.name,
      projectPath,
    });

    const expectedRoot = path.join(projectPath, '.dork/plugins', baseManifest.name);
    expect(result.installPath).toBe(expectedRoot);
    expect(await exists(expectedRoot)).toBe(true);

    // Confirm the global plugins dir was untouched.
    const globalRoot = path.join(dorkHome, 'plugins', baseManifest.name);
    expect(await exists(globalRoot)).toBe(false);
  });

  it('rolls back when a SKILL.md fails validation in stage()', async () => {
    const packagePath = await buildPackageWithInvalidSkill();
    cleanupRoots.push(packagePath);

    const flow = new SkillPackInstallFlow({ dorkHome, logger: noopLogger });

    await expect(
      flow.install(packagePath, baseManifest, { name: baseManifest.name })
    ).rejects.toThrow(/broken-skill/);

    const expectedRoot = path.join(dorkHome, 'plugins', baseManifest.name);
    expect(await exists(expectedRoot)).toBe(false);
    // Plugins directory should also be empty (no orphan staging contents).
    const pluginsDir = path.join(dorkHome, 'plugins');
    if (await exists(pluginsDir)) {
      const entries = await readdir(pluginsDir);
      expect(entries).toEqual([]);
    }
  });

  it('rolls back when fs.rename fails during activate()', async () => {
    const packagePath = await buildValidPackage();
    cleanupRoots.push(packagePath);

    // Make the destination already exist so the rename will fail with EEXIST/ENOTEMPTY.
    const installRoot = path.join(dorkHome, 'plugins', baseManifest.name);
    await mkdir(installRoot, { recursive: true });
    await writeFile(path.join(installRoot, 'occupant.txt'), 'pre-existing', 'utf8');

    // Spy on staging cleanup so we can verify it ran.
    const cleanupSpy = vi.spyOn(transactionInternal, 'cleanupStaging');

    const flow = new SkillPackInstallFlow({ dorkHome, logger: noopLogger });
    await expect(
      flow.install(packagePath, baseManifest, { name: baseManifest.name })
    ).rejects.toThrow();

    // The pre-existing occupant should still be present (no partial overwrite).
    expect(await exists(path.join(installRoot, 'occupant.txt'))).toBe(true);
    expect(cleanupSpy).toHaveBeenCalled();
  });
});
