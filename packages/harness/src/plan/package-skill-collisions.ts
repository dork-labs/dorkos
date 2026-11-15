/**
 * Which installed package skills a plan may project, given that a harness keys
 * skills by name (DOR-4387, DOR-4392).
 *
 * OpenCode names a skill by the `name` in its `SKILL.md`, and of two skills that
 * share a name it keeps one and drops the other, with nothing but a log line
 * (observed against `opencode 1.19.3`, `vendor-facts/index.ts`). The
 * `<pkg>__<skill>` directory namespacing does not separate them. So a package
 * skill that says `name: deploy` could take the place of the person's own
 * `deploy` skill, and which one wins is not something anybody chose.
 *
 * The rule is the one the extension planner uses (`extension-skills.ts`): the
 * person's own skill always wins, and of two package skills the first one
 * planned wins. A losing skill is not projected at all, in any folder, because
 * every folder DorkOS writes a package skill into is one OpenCode also reads.
 * Each skip leaves a warning naming both skills and the reason, and a
 * structured record the install screen and the agent's context can show.
 *
 * **It applies whatever the manifest enables** (DOR-4392, Security and the PM).
 * Every package skill reaches `.agents/skills` whichever harnesses a manifest
 * lists (DOR-1518), and an agent running on OpenCode reads that folder in any
 * project, so a rule that waited for the manifest to list OpenCode left exactly
 * that agent unprotected. A package is an outsider; the person's skill is theirs.
 *
 * **Two names are the same name exactly when OpenCode says so**, measured on the
 * pinned binary (DOR-4392):
 *
 * - the `name` as the YAML parsed it, compared exactly: `c` and `C`, `c` and
 *   `"c "`, and NFC and NFD spellings of one word are all different skills to
 *   OpenCode, while `'c'`, `"c"` and `c` are one;
 * - a skill with no string `name` is not loaded at all, so it neither shadows
 *   nor is shadowed. There is no folder-name fallback;
 * - a blank `name: ""` IS loaded, and collides with another blank one.
 *
 * **The person's own skills include their user-level ones** (DOR-4392):
 * OpenCode reads `~/.config/opencode/skills`, `~/.claude/skills` and
 * `~/.agents/skills` in every project, so a package can replace a skill there
 * too. The caller reads those folders (`inventory/user-skills.ts`) and hands the
 * names in; the engine resolves no home directory.
 *
 * @module plan/package-skill-collisions
 */
import { HARNESS_IDS, HARNESS_LABELS, type HarnessId } from '../manifest/schema.js';
import type { SkillInventoryEntry } from '../inventory/types.js';
import type { UserSkillName } from '../inventory/user-skills.js';
import { skillsFactsFor } from '../vendor-facts/index.js';
import type { SkillSourcePackage } from './installed-projector.js';
import type { ProjectionWarning, SkippedPackageSkill } from './types.js';

/** A placeholder attribution; `harnessAgnostic` says the warning is about the whole project. */
const SKIP_ATTRIBUTION: HarnessId = 'opencode';

/** What survived, what was said about what did not, and which names are now taken. */
export interface SettledPackageSkills<T extends SkillSourcePackage> {
  /** The packages, each with its losing skills removed; every other field is untouched. */
  packages: T[];
  /** One warning per skipped skill. */
  warnings: ProjectionWarning[];
  /** One record per skipped skill. */
  skipped: SkippedPackageSkill[];
  /** Every name now claimed, with the projection that claims it, for a later call to continue. */
  taken: Map<string, string>;
}

/** Every harness in the vendor table whose skills collapse by name. */
export function byNameHarnesses(): HarnessId[] {
  return HARNESS_IDS.filter((harness) => skillsFactsFor(harness).dedupe === 'by-name');
}

/**
 * Map each of the person's own skill names, as a by-name harness sees them, to
 * where the skill lives.
 *
 * The key is the exact parsed `name`. A skill with none is left out: OpenCode
 * does not load it, so there is nothing for a package to shadow. Only project
 * skills in a folder one of those harnesses reads count; user-level skills come
 * already limited to those folders. Project skills are listed first.
 *
 * @param skills - every authored skill the inventory found.
 * @param userSkills - the person's user-level skills, already read.
 * @param harnesses - the by-name harnesses.
 */
function ownSkillNames(
  skills: readonly SkillInventoryEntry[],
  userSkills: readonly UserSkillName[],
  harnesses: readonly HarnessId[]
): Map<string, string> {
  const roots = new Set(harnesses.flatMap((h) => skillsFactsFor(h).readPaths.project));
  const own = new Map<string, string>();
  for (const skill of [...skills].sort((a, b) => a.source.localeCompare(b.source))) {
    if (!roots.has(skill.root) || skill.exactFrontmatterName === undefined) continue;
    if (!own.has(skill.exactFrontmatterName)) own.set(skill.exactFrontmatterName, skill.source);
  }
  for (const skill of userSkills) {
    if (!own.has(skill.exactFrontmatterName)) own.set(skill.exactFrontmatterName, skill.source);
  }
  return own;
}

/**
 * Remove every package skill whose name, as a by-name harness sees it, is
 * already the person's own skill or an earlier package skill.
 *
 * @param input.packages - the packages this plan would project, in plan order.
 * @param input.ownSkills - every authored skill the inventory found.
 * @param input.userSkills - the person's user-level skills, read by the caller.
 * @param input.taken - names already claimed by an earlier call (packages before extensions).
 * @returns the packages to plan, the warnings and skip records, and the claimed names.
 */
export function settlePackageSkillNameCollisions<T extends SkillSourcePackage>(input: {
  packages: readonly T[];
  ownSkills: readonly SkillInventoryEntry[];
  userSkills?: readonly UserSkillName[];
  taken?: ReadonlyMap<string, string>;
}): SettledPackageSkills<T> {
  const taken = new Map(input.taken ?? []);
  const collapsing = byNameHarnesses();
  if (collapsing.length === 0) {
    return { packages: [...input.packages], warnings: [], skipped: [], taken };
  }
  const own = ownSkillNames(input.ownSkills, input.userSkills ?? [], collapsing);
  const label = collapsing.map((h) => HARNESS_LABELS[h]).join(' and ');
  const warnings: ProjectionWarning[] = [];
  const skipped: SkippedPackageSkill[] = [];
  const packages = input.packages.map((pkg) => {
    const kept = pkg.skills.filter((skill) => {
      const projection = `${pkg.name}__${skill.name}`;
      // DorkOS could not read the name (file over the cap, frontmatter the
      // parser refuses), but OpenCode may: fail closed (Security M1).
      if (skill.nameUnreadable === true) {
        skipped.push({
          package: pkg.name,
          skill: skill.name,
          name: skill.name,
          winner: { kind: 'unreadable' },
        });
        warnings.push({
          artifact: 'skill',
          harness: SKIP_ATTRIBUTION,
          harnessAgnostic: true,
          name: projection,
          source: skill.sourceDir,
          reason: `the "${pkg.name}" package's skill folder "${skill.name}" was not added: its name could not be read, so it might replace a skill of yours. ${label} keeps only one skill per name`,
        });
        return false;
      }
      // No string `name`: OpenCode does not load it, so it cannot shadow anything.
      const name = skill.frontmatterName;
      if (name === undefined) return true;
      const ownSource = own.get(name);
      const earlier = taken.get(name);
      if (ownSource === undefined && earlier === undefined) {
        taken.set(name, projection);
        return true;
      }
      skipped.push({
        package: pkg.name,
        skill: skill.name,
        name,
        winner:
          ownSource !== undefined
            ? { kind: 'own', source: ownSource }
            : { kind: 'package', projection: earlier! },
      });
      const winner =
        ownSource !== undefined
          ? `your own skill at ${ownSource} has the same name, and your own skill wins`
          : `the "${earlier!}" skill already added has the same name, and the first one wins`;
      warnings.push({
        artifact: 'skill',
        harness: SKIP_ATTRIBUTION,
        harnessAgnostic: true,
        name: projection,
        source: skill.sourceDir,
        reason: `the "${pkg.name}" package's skill "${name}" was not added: ${winner}. ${label} keeps only one skill per name`,
      });
      return false;
    });
    return { ...pkg, skills: kept };
  });
  return { packages, warnings, skipped, taken };
}
