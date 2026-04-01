import path from 'node:path';

/** Required filename inside every skill directory. */
export const SKILL_FILENAME = 'SKILL.md' as const;

/** Standard subdirectory names per the agentskills.io spec. */
export const SKILL_SUBDIRS = ['scripts', 'references', 'assets'] as const;

/**
 * Build the path to a SKILL.md file inside a parent directory.
 *
 * @param parentDir - The directory containing skill subdirectories
 * @param name - The skill's kebab-case name (directory name)
 * @returns Path like `{parentDir}/{name}/SKILL.md`
 */
export function skillFilePath(parentDir: string, name: string): string {
  return path.join(parentDir, name, SKILL_FILENAME);
}

/**
 * Build the path to a skill's directory.
 *
 * @param parentDir - The directory containing skill subdirectories
 * @param name - The skill's kebab-case name
 * @returns Path like `{parentDir}/{name}`
 */
export function skillDirPath(parentDir: string, name: string): string {
  return path.join(parentDir, name);
}
