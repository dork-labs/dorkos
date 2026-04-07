/**
 * Skill-pack install flow.
 *
 * Implements the spec contract for `installSkillPack` from
 * marketplace-02-install § 4.3 — copies a downloaded package into the
 * staging directory, re-validates every `SKILL.md` via `@dorkos/skills`,
 * then atomically renames staging onto the install root. Skills are
 * picked up by Claude Code on next discovery; tasks by the
 * `task-file-watcher`. There is no explicit registration step.
 *
 * @module services/marketplace/flows/install-skill-pack
 */
import { cp, mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { SkillPackPackageManifest } from '@dorkos/marketplace';
import type { Logger } from '@dorkos/shared/logger';
import { SkillFrontmatterSchema } from '@dorkos/skills';
import { parseSkillFile } from '@dorkos/skills/parser';
import { atomicMove } from '../lib/atomic-move.js';
import { runTransaction } from '../transaction.js';
import type { InstallRequest, InstallResult } from '../types.js';

/** Filename every skill manifest must use. Mirrors `@dorkos/skills`' constant. */
const SKILL_FILENAME = 'SKILL.md';

/**
 * Constructor dependencies for {@link SkillPackInstallFlow}. `dorkHome`
 * is required (no fallback) per the dork-home convention.
 */
export interface SkillPackFlowDeps {
  /** Resolved DorkOS data directory (e.g. `~/.dork` or test temp). */
  dorkHome: string;
  /** Structured logger for diagnostics. */
  logger: Logger;
}

/**
 * Install flow for skill-pack packages. Wraps the staged-rename
 * transaction so failed installs leave zero residue and a git rollback
 * branch is created when the user is inside a working tree.
 */
export class SkillPackInstallFlow {
  constructor(private readonly deps: SkillPackFlowDeps) {}

  /**
   * Install a skill-pack package.
   *
   * @param packagePath - Filesystem path to the downloaded package source
   * @param manifest - Validated skill-pack manifest from `dork-package.json`
   * @param opts - Original install request (used for `projectPath`)
   * @returns Fully populated {@link InstallResult}
   */
  async install(
    packagePath: string,
    manifest: SkillPackPackageManifest,
    opts: InstallRequest
  ): Promise<InstallResult> {
    const installRoot = computeInstallRoot(this.deps.dorkHome, manifest.name, opts.projectPath);
    const txResult = await runTransaction({
      name: `install-skill-pack-${manifest.name}`,
      rollbackBranch: true,
      stage: (staging) => stageSkillPack(packagePath, staging.path),
      activate: (staging) => activateSkillPack(staging.path, installRoot),
    });
    return buildInstallResult(manifest, installRoot, txResult.rollbackBranch);
  }
}

/**
 * Compute the absolute install root for a skill-pack. Project-local
 * installs go under `<projectPath>/.dork/plugins/<name>/`; global
 * installs go under `<dorkHome>/plugins/<name>/`.
 *
 * @internal
 */
function computeInstallRoot(
  dorkHome: string,
  packageName: string,
  projectPath: string | undefined
): string {
  if (projectPath) {
    return path.join(projectPath, '.dork', 'plugins', packageName);
  }
  return path.join(dorkHome, 'plugins', packageName);
}

/**
 * Copy the package into the staging directory, then re-validate every
 * SKILL.md against the `@dorkos/skills` parser. Throws a clear error
 * naming the offending file if any frontmatter fails validation.
 *
 * @internal
 */
async function stageSkillPack(packagePath: string, stagingPath: string): Promise<void> {
  await cp(packagePath, stagingPath, { recursive: true });
  const skillFiles = await findSkillFiles(stagingPath);
  for (const absFile of skillFiles) {
    await validateSkillFile(absFile);
  }
}

/**
 * Move staging → install root via {@link atomicMove}, which performs an
 * atomic `fs.rename` on the same filesystem and falls back to
 * `cp` + `rm` on cross-device (`EXDEV`) moves — common on Linux CI
 * runners where `os.tmpdir()` lives on a distinct volume from the
 * user's home directory.
 *
 * @internal
 */
async function activateSkillPack(
  stagingPath: string,
  installRoot: string
): Promise<{ installPath: string }> {
  await mkdir(path.dirname(installRoot), { recursive: true });
  await atomicMove(stagingPath, installRoot);
  return { installPath: installRoot };
}

/**
 * Construct the public {@link InstallResult} returned to callers.
 *
 * @internal
 */
function buildInstallResult(
  manifest: SkillPackPackageManifest,
  installPath: string,
  rollbackBranch: string | undefined
): InstallResult {
  return {
    ok: true,
    packageName: manifest.name,
    version: manifest.version,
    type: 'skill-pack',
    installPath,
    manifest,
    rollbackBranch,
    warnings: [],
  };
}

/**
 * Recursively walk `root` and return absolute paths for every file
 * named `SKILL.md`. Uses Node's native `readdir({ recursive: true })`
 * (Node ≥ 20) so no glob dependency is required.
 *
 * @internal
 */
async function findSkillFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const matches: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name !== SKILL_FILENAME) continue;
    // `entry.parentPath` is preferred (Node 20.12+); fall back to `entry.path`
    // for older runtimes used in CI matrices.
    const parent = entry.parentPath ?? (entry as { path?: string }).path ?? root;
    matches.push(path.join(parent, entry.name));
  }
  return matches;
}

/**
 * Parse a single SKILL.md file via `@dorkos/skills` and throw a clear
 * `Error` on failure. The error message includes both the offending
 * file path and the parser's diagnostic so the install transaction
 * surfaces it directly to the user.
 *
 * @internal
 */
async function validateSkillFile(absFile: string): Promise<void> {
  const content = await readFile(absFile, 'utf8');
  const result = parseSkillFile(absFile, content, SkillFrontmatterSchema);
  if (!result.ok) {
    throw new Error(`Invalid SKILL.md at ${absFile}: ${result.error}`);
  }
}
