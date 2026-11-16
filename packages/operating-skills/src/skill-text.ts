/**
 * One operating skill as a single text, for a runtime that serves the pack from
 * memory rather than from seeded files.
 *
 * @module skill-text
 */
import type { OperatingSkill } from './pack.js';

/**
 * The skill's body, then each file seeded beside its SKILL.md wrapped in a
 * `<skill_file path="…">` tag. The body links to those files by relative path,
 * and with nothing on disk to answer the links the reader needs them inline.
 *
 * @param skill - The pack skill.
 */
export function operatingSkillText(skill: OperatingSkill): string {
  const files = Object.entries(skill.files ?? {}).map(
    ([file, content]) => `<skill_file path="${file}">\n${content}\n</skill_file>`
  );
  return [skill.body, ...files].join('\n\n');
}
