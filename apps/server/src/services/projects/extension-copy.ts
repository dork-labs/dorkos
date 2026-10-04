/**
 * Whether a project root holds a copy of an extension, which is what puts the
 * project in that extension's scoped list (spec `flow-multiproject` §6.1).
 *
 * @module services/projects/extension-copy
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isInstallSiblingName } from '@dorkos/shared/marketplace-schemas';

/**
 * Whether a folder exists right now (and is a folder).
 *
 * @param dir - Any absolute path.
 */
export async function folderExists(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Whether a root holds a copy of an extension: a `.dork/extensions/<id>`
 * folder, or one inside a plugin at `.dork/plugins/<plugin>/.dork/extensions/<id>`.
 *
 * @param root - A project root.
 * @param extensionId - The extension's id.
 */
export async function holdsExtensionCopy(root: string, extensionId: string): Promise<boolean> {
  if (await folderExists(path.join(root, '.dork', 'extensions', extensionId))) return true;
  let plugins: string[];
  try {
    plugins = await fs.readdir(path.join(root, '.dork', 'plugins'));
  } catch {
    return false;
  }
  for (const plugin of plugins) {
    // A half-finished or backed-up install beside a plugin is not a copy.
    if (isInstallSiblingName(plugin)) continue;
    const copy = path.join(root, '.dork', 'plugins', plugin, '.dork', 'extensions', extensionId);
    if (await folderExists(copy)) return true;
  }
  return false;
}
