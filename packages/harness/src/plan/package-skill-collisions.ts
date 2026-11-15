/**
 * Which installed package skills a plan may project, given that a harness keys
 * skills by name (DOR-4387).
 *
 * OpenCode names a skill by the `name` in its `SKILL.md`, and of two skills that
 * share a name it keeps one and drops the other without a word (observed
 * against `opencode 1.19.3`, `vendor-facts/index.ts`). The `<pkg>__<skill>`
 * directory namespacing does not separate them. So a package skill that says
 * `name: deploy` can take the place of the person's own `deploy` skill, and
 * which one wins is not something anybody chose.
 *
 * The rule is the one the extension planner uses (`extension-skills.ts`): the
 * person's own skill always wins, and of two package skills the first one
 * planned wins. A losing skill is not projected at all, in any folder, because
 * every folder DorkOS writes a package skill into is one OpenCode also reads.
 * Each skip leaves a warning naming both skills and the reason, and a
 * structured record the install screen and the agent's context can show.
 *
 * **The rule applies whatever the manifest enables.** Every package skill is
 * linked into `.agents/skills` whichever harnesses a manifest lists (DOR-1518),
 * and an agent running on OpenCode reads that folder in any project, enabled or
 * not. Waiting for the manifest to list OpenCode would leave exactly the agent
 * this protects unprotected. The cost is that a package skill with a taken name
 * is left out for every harness; a person's own skill never shares its name.
 *
 * Nothing is skipped when no harness in the vendor table collapses by name.
 *
 * @module plan/package-skill-collisions
 */
import { HARNESS_IDS, HARNESS_LABELS, type HarnessId } from '../manifest/schema.js';
import type { SkillInventoryEntry } from '../inventory/types.js';
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

/** Every harness whose vendor facts say duplicate skill names collapse into one. */
export function byNameHarnesses(): HarnessId[] {
  return HARNESS_IDS.filter((harness) => skillsFactsFor(harness).dedupe === 'by-name');
}

/**
 * Map each of the person's own skill names, as a by-name harness sees them, to
 * where the skill lives.
 *
 * A by-name harness keys by the frontmatter `name`, falling back to the folder
 * name when there is none, so that is the key. Only skills in a folder one of
 * those harnesses reads count.
 *
 * @param skills - every authored skill the inventory found.
 * @param harnesses - the by-name harnesses.
 */
function ownSkillNames(
  skills: readonly SkillInventoryEntry[],
  harnesses: readonly HarnessId[]
): Map<string, string> {
  const roots = new Set(harnesses.flatMap((h) => skillsFactsFor(h).readPaths.project));
  const own = new Map<string, string>();
  for (const skill of [...skills].sort((a, b) => a.source.localeCompare(b.source))) {
    if (!roots.has(skill.root)) continue;
    const key = skill.frontmatterName ?? skill.name;
    if (!own.has(key)) own.set(key, skill.source);
  }
  return own;
}

/**
 * Remove every package skill whose name, as a by-name harness sees it, is
 * already the person's own skill or an earlier package skill.
 *
 * @param input.packages - the packages this plan would project, in plan order.
 * @param input.ownSkills - every authored skill the inventory found.
 * @param input.taken - names already claimed by an earlier call (packages before extensions).
 * @returns the packages to plan, the warnings and skip records, and the claimed names.
 */
export function settlePackageSkillNameCollisions<T extends SkillSourcePackage>(input: {
  packages: readonly T[];
  ownSkills: readonly SkillInventoryEntry[];
  taken?: ReadonlyMap<string, string>;
}): SettledPackageSkills<T> {
  const taken = new Map(input.taken ?? []);
  const collapsing = byNameHarnesses();
  if (collapsing.length === 0) {
    return { packages: [...input.packages], warnings: [], skipped: [], taken };
  }
  const own = ownSkillNames(input.ownSkills, collapsing);
  const label = collapsing.map((h) => HARNESS_LABELS[h]).join(' and ');
  const warnings: ProjectionWarning[] = [];
  const skipped: SkippedPackageSkill[] = [];
  const packages = input.packages.map((pkg) => {
    const kept = pkg.skills.filter((skill) => {
      const name = skill.frontmatterName ?? skill.name;
      const projection = `${pkg.name}__${skill.name}`;
      const ownSource = own.get(name);
      const earlier = taken.get(name);
      if (ownSource === undefined && earlier === undefined) {
        taken.set(name, projection);
        return true;
      }
      const record: SkippedPackageSkill =
        ownSource !== undefined
          ? {
              package: pkg.name,
              skill: skill.name,
              name,
              winner: { kind: 'own', source: ownSource },
            }
          : {
              package: pkg.name,
              skill: skill.name,
              name,
              winner: { kind: 'package', projection: earlier! },
            };
      skipped.push(record);
      const winner =
        record.winner.kind === 'own'
          ? `your own skill at ${record.winner.source} has the same name, and your own skill wins`
          : `the "${record.winner.projection}" skill already added has the same name, and the first one wins`;
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
