import path from 'node:path';

/** Required filename inside every skill directory. */
export const SKILL_FILENAME = 'SKILL.md' as const;

/**
 * Standard subdirectory names. `scripts`, `references`, and `assets` are
 * per the agentskills.io spec; `ui` is a DorkOS extension holding widget
 * templates (`ui/*.widget.json`, see `ui-template.ts`).
 */
export const SKILL_SUBDIRS = ['scripts', 'references', 'assets', 'ui'] as const;

/** File suffix identifying a widget template inside a skill's `ui/` subdirectory. */
export const WIDGET_TEMPLATE_SUFFIX = '.widget.json' as const;

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
