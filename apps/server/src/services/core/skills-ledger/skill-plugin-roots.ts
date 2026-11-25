/**
 * Read the running extensions' skills ledger back: the generated plugin roots
 * DorkOS's own Claude Code sessions load (DOR-2685, spec
 * `extension-agent-tools-and-skills` §7).
 *
 * Kernel: the space side decides which extensions run and writes the ledger
 * (`services/extensions/agent-skills/running-skills-ledger.ts`); the computer
 * side only reads the file it published. Nothing here decides who may run.
 *
 * @module services/core/skills-ledger/skill-plugin-roots
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { extensionSkillPluginRoot, readRunningExtensionSkillsSync } from '@dorkos/harness';
import { logger } from '../../../lib/logger.js';

/**
 * Whether `file` is a regular file (not a link, not a folder).
 *
 * @param file - The path to check.
 */
export async function isRegularFile(file: string): Promise<boolean> {
  try {
    return (await fs.lstat(file)).isFile();
  } catch {
    return false;
  }
}

/**
 * The generated plugin roots DorkOS's Claude Code sessions should load: one per
 * global extension the ledger lists, when its root is in place.
 *
 * Read from the ledger rather than from live server state, so it answers the
 * same question the global sync does. A root that is missing or is not a real
 * folder is left out. So is an extension whose id is the name of a global
 * plugin the session already loads: Claude Code names a plugin's skills by the
 * plugin's name, so two plugins of one name would collide, and the plugin wins,
 * as it does everywhere else. Never throws; a ledger it cannot read loads none.
 *
 * @param dorkHome - DorkOS's data directory.
 * @param loadedPluginNames - Names of the global plugins sessions already load.
 * @returns Absolute plugin root paths, sorted by extension id.
 */
export async function extensionSkillPluginRoots(
  dorkHome: string,
  loadedPluginNames: ReadonlySet<string> = new Set()
): Promise<string[]> {
  const roots: string[] = [];
  for (const entry of readRunningExtensionSkillsSync(dorkHome).entries) {
    if (entry.scope !== 'global') continue;
    if (loadedPluginNames.has(entry.id)) {
      logger.info(
        `[Extensions] Left the "${entry.id}" extension's skills out of Claude Code sessions: a plugin of the same name is loaded, and the plugin wins`
      );
      continue;
    }
    const root = extensionSkillPluginRoot(dorkHome, entry.id);
    try {
      if (!(await fs.lstat(root)).isDirectory()) continue;
      if (!(await isRegularFile(path.join(root, '.claude-plugin', 'plugin.json')))) continue;
    } catch {
      continue;
    }
    roots.push(root);
  }
  return roots;
}
