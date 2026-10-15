/** Side-effect-free workspace pointer and extension-directory values. */
import { join } from 'node:path';

/** The deterministic body of the scaffolded Claude instruction pointer. */
export const CLAUDE_INSTRUCTION_CONTENT = '@../AGENTS.md\n';

/**
 * The folder holding one generated plugin root per running global extension
 * with skills: `{dorkHome}/cache/extensions/skill-plugins`.
 *
 * The server owns it whole. Each `<id>/` inside is a Claude Code plugin root
 * (`.claude-plugin/plugin.json` plus `skills/<name>` links to the extension's
 * validated skill folders) that DorkOS's own Claude Code sessions load, and it
 * is what every global-tier link points through, so removing a root withdraws
 * that extension's skills everywhere at once.
 *
 * @param dorkHome - the DorkOS data directory, absolute.
 * @returns the absolute folder.
 */
export function extensionSkillPluginsDir(dorkHome: string): string {
  return join(dorkHome, 'cache', 'extensions', 'skill-plugins');
}
