/**
 * Which running extension skills a plan may project, once every name a plugin
 * or the person already holds is taken out (DOR-2685).
 *
 * An extension's skill projects as `<id>__<skill>`, the same namespace a
 * plugin's uses (`<pkg>__<skill>`). The two meet whenever a plugin carries an
 * extension of its own name — Flow does — and ships a skill of the same name in
 * both. Two actions racing for one link would make the apply write it twice and
 * the sweep argue with itself, so one side has to win, and it is always the
 * plugin: its install is the thing a person chose, and the extension is a part
 * of some package. An authored skill of the same name wins too: it is the
 * person's own file, and DorkOS never writes over one. The extension's skill is
 * dropped with a warning naming both, so nothing goes quiet.
 *
 * Shared by the project plan and the global plan, which apply the same rule to
 * their own plugins.
 *
 * @module plan/extension-skills
 */
import type { HarnessId } from '../manifest/schema.js';
import type { ExtensionSkillPackage } from '../sources/running-extension-skills.js';
import type { SkillSourcePackage } from './installed-projector.js';
import type { ProjectionWarning } from './types.js';

/** A placeholder attribution; `harnessAgnostic` says the warning is about every harness. */
const COLLISION_ATTRIBUTION: HarnessId = 'claude-code';

/** What survived, and what was said about what did not. */
export interface SettledExtensionSkills {
  /** The extensions with every losing skill removed; an extension left with none is gone. */
  packages: ExtensionSkillPackage[];
  /** One warning per dropped skill. */
  warnings: ProjectionWarning[];
}

/**
 * Remove every extension skill whose `<id>__<skill>` a plugin or an authored
 * skill already claims.
 *
 * @param input.extensions - the running extensions this plan would project.
 * @param input.plugins - the plugins this plan projects at the same scope.
 * @param input.authoredSkillNames - the repository's own skill names (none at
 *   global scope).
 * @returns the extensions to plan and the warnings to print.
 */
export function settleExtensionSkillCollisions(input: {
  extensions: readonly ExtensionSkillPackage[];
  plugins: readonly SkillSourcePackage[];
  authoredSkillNames?: ReadonlySet<string>;
}): SettledExtensionSkills {
  const pluginOwner = new Map<string, string>();
  for (const plugin of input.plugins) {
    for (const skill of plugin.skills)
      pluginOwner.set(`${plugin.name}__${skill.name}`, plugin.name);
  }
  const authored = input.authoredSkillNames ?? new Set<string>();
  const packages: ExtensionSkillPackage[] = [];
  const warnings: ProjectionWarning[] = [];
  for (const extension of input.extensions) {
    const kept = extension.skills.filter((skill) => {
      const namespaced = `${extension.name}__${skill.name}`;
      const plugin = pluginOwner.get(namespaced);
      const winner =
        plugin !== undefined
          ? `the "${plugin}" plugin has a skill of the same name, and a plugin's skill wins`
          : authored.has(namespaced)
            ? `this project's own skill "${namespaced}" has the same name, and your own skill wins`
            : undefined;
      if (winner === undefined) return true;
      warnings.push({
        artifact: 'skill',
        harness: COLLISION_ATTRIBUTION,
        harnessAgnostic: true,
        name: namespaced,
        source: skill.sourceDir,
        reason: `the "${extension.name}" extension's skill "${skill.name}" was left out: ${winner}`,
      });
      return false;
    });
    if (kept.length > 0) packages.push({ ...extension, skills: kept });
  }
  return { packages, warnings };
}
