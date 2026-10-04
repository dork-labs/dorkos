/**
 * What Settings → Extensions says about each skill an extension declares
 * (DOR-2685): shipped, or left out with a short reason.
 *
 * The rules are the harness's own (`checkExtensionSkillFolder` in
 * `@dorkos/harness`), so a skill Settings calls fine is one a sync projects.
 * The harness's reason names absolute paths, which is right for a sync log and
 * wrong for a card, so the card's sentence is chosen here from the code.
 *
 * @module services/extensions/agent-skills/skill-checks
 */
import path from 'path';
import { checkExtensionSkillFolder, type ExtensionSkillDropCode } from '@dorkos/harness';
import type { ExtensionManifest, ExtensionSkillStatus } from '@dorkos/extension-api';

/** The sentence a person reads for each reason a skill is left out. */
export const SKILL_DROP_REASON: Record<ExtensionSkillDropCode, string> = {
  'invalid-name': 'Its name isn’t a valid skill name.',
  'missing-folder': 'Its folder is missing from skills/.',
  'not-a-folder': 'Its entry in skills/ isn’t a plain folder.',
  'missing-file': 'Its SKILL.md file is missing.',
  unreadable: 'Its SKILL.md file couldn’t be read.',
  'invalid-file': 'Its SKILL.md file isn’t a valid skill.',
};

/**
 * Check every skill a manifest declares against the extension's folder.
 *
 * @param extensionDir - The extension's folder, absolute.
 * @param manifest - Its parsed manifest.
 * @returns One status per declared skill, in manifest order, or `undefined`
 *   when it declares none.
 */
export function checkDeclaredSkills(
  extensionDir: string,
  manifest: Pick<ExtensionManifest, 'skills'>
): ExtensionSkillStatus[] | undefined {
  const declared = manifest.skills ?? [];
  if (declared.length === 0) return undefined;
  const skillsDir = path.join(extensionDir, 'skills');
  return declared.map((name) => {
    const checked = checkExtensionSkillFolder(skillsDir, name);
    return checked.ok
      ? { name, status: 'ok' as const }
      : { name, status: 'dropped' as const, reason: SKILL_DROP_REASON[checked.code] };
  });
}
