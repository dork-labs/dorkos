/**
 * Which skills installing one package would leave out, before it is installed
 * (DOR-4387).
 *
 * The install screen has to say, before the person confirms, when a package's
 * skill will not be added because a skill with the same name is already the
 * person's own, or already another package's, on a harness that keys skills by
 * name. This answers it with the same rule the plan applies
 * (`package-skill-collisions.ts`) and in the same order: project packages
 * sorted by name, so a new package can also take a name from one installed
 * after it in that order, and that is reported too.
 *
 * @module plan/package-skill-preview
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadManifest } from '../engine.js';
import { inventorySourceTree } from '../inventory/index.js';
import {
  isProjectScoped,
  readPackageSkills,
  scanInstalledSources,
  PROJECT_PLUGINS_DIR,
} from '../sources/installed.js';
import { PROJECTABLE_PLUGIN_TYPES, type SkillSourcePackage } from './installed-projector.js';
import { settlePackageSkillNameCollisions } from './package-skill-collisions.js';
import type { SkippedPackageSkill } from './types.js';

/**
 * Preview the skills a project install would skip.
 *
 * @param input.repoRoot - the project the package is being installed into.
 * @param input.packageName - the package's name, which is its folder name once installed.
 * @param input.packageDir - where the package's files are now (a staging folder).
 * @param input.packageType - the package's manifest type; types the plan does not project skip nothing.
 * @returns every skip the install would cause: this package's skills, and any
 *   installed package's skill this one would take the name of. Empty when the
 *   project has no harness manifest (nothing is projected) or enables no
 *   harness that keys skills by name.
 */
export function previewPackageSkillSkips(input: {
  repoRoot: string;
  packageName: string;
  packageDir: string;
  packageType: string;
}): SkippedPackageSkill[] {
  if (!PROJECTABLE_PLUGIN_TYPES.has(input.packageType)) return [];
  // No harness manifest, nothing is projected, so nothing can be skipped.
  if (!existsSync(join(input.repoRoot, '.agents', 'harness.manifest.json'))) return [];
  const installed: SkillSourcePackage[] = scanInstalledSources({ projectRoot: input.repoRoot })
    .plugins.filter(isProjectScoped)
    .filter((p) => PROJECTABLE_PLUGIN_TYPES.has(p.type) && p.name !== input.packageName);
  const staged: SkillSourcePackage = {
    name: input.packageName,
    skills: readPackageSkills(input.packageDir, `${PROJECT_PLUGINS_DIR}/${input.packageName}`),
  };
  const packages = [...installed, staged].sort((a, b) => a.name.localeCompare(b.name));
  const settled = settlePackageSkillNameCollisions({
    packages,
    harnesses: loadManifest(input.repoRoot).harnesses,
    ownSkills: inventorySourceTree(input.repoRoot).skills,
  });
  return settled.skipped.filter(
    (skip) =>
      skip.package === input.packageName ||
      (skip.winner.kind === 'package' &&
        skip.winner.projection.startsWith(`${input.packageName}__`))
  );
}

/**
 * The skills the project's installed packages have left out right now, for a
 * runtime that keys skills by name to tell its agent (DOR-4387).
 *
 * The same rule and order as the plan, over what is installed today; no
 * staged package.
 *
 * @param repoRoot - the project the agent works in.
 * @returns every package skill the plan skips, empty when the project has no
 *   harness manifest.
 */
export function currentPackageSkillSkips(repoRoot: string): SkippedPackageSkill[] {
  if (!existsSync(join(repoRoot, '.agents', 'harness.manifest.json'))) return [];
  const packages = scanInstalledSources({ projectRoot: repoRoot })
    .plugins.filter(isProjectScoped)
    .filter((p) => PROJECTABLE_PLUGIN_TYPES.has(p.type));
  return settlePackageSkillNameCollisions({
    packages,
    harnesses: loadManifest(repoRoot).harnesses,
    ownSkills: inventorySourceTree(repoRoot).skills,
  }).skipped;
}
