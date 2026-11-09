/**
 * Removing an installed extension from Settings, and forgetting an approval
 * whose extension is gone (DOR-3541, DOR-3372).
 *
 * ## Why both exist
 *
 * A run approval is bound to a copy's path (and, since DOR-3068, its files).
 * When the folder disappears, the approval stays in `config.extensions`, and
 * anything that later puts code at that path meets an old yes. Settings had no
 * way to clear one: `/revoke` needs a discovered extension, and there was no
 * Remove at all, so people deleted folders by hand and left approvals behind.
 *
 * - {@link removeExtension} deletes an installed extension's folder AND every
 *   approval and choice recorded for it, in that order of safety: approvals
 *   first, so a failed delete leaves a folder that asks again, never a yes
 *   with nothing behind it.
 * - {@link forgetStaleApproval} clears the approval of an id that is no longer
 *   installed anywhere.
 *
 * Both are person-only at the route ({@link module:routes/extensions-removal});
 * nothing here checks who is asking.
 *
 * ## What Remove will not delete
 *
 * Only a folder DorkOS itself would have put there: `<dorkHome>/extensions/<id>`
 * or `<somewhere>/.dork/extensions/<id>`, with no symbolic link on the way and
 * the folder named after the id. A copy carried by a marketplace plugin is
 * removed by uninstalling the plugin (deleting one folder inside it would leave
 * a broken install), a dev link by unlinking it, and DorkOS's own extensions
 * not at all.
 *
 * @module services/extensions/removal/extension-removal
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { configManager } from '../../core/config-manager.js';
import { logConfigWrite } from '../../core/operator/config-write.js';
import { logger } from '../../../lib/logger.js';
import type { ExtensionManager } from '../extension-manager.js';

/** The part of the extension manager removal reads and drives. */
export type RemovalManager = Pick<
  ExtensionManager,
  'get' | 'listRecords' | 'listShadowedPublic' | 'forgetRunApproval' | 'reload' | 'dorkHome'
>;

/** An approval left behind by an extension that is no longer installed. */
export interface StaleApproval {
  /** The extension id the approval names. */
  id: string;
  /** The folder the approval was given to, when it recorded one. */
  path: string | null;
  /** The plugin that carried it, when it came inside one. */
  plugin: string | null;
}

/** Why {@link removeExtension} refused. */
export type RemoveRefusal = 'not_found' | 'core' | 'plugin' | 'dev_link' | 'unexpected_folder';

/** What {@link removeExtension} answers. */
export type RemoveResult =
  { ok: true; name: string; path: string } | { ok: false; reason: RemoveRefusal };

/** What {@link forgetStaleApproval} answers. */
export type ForgetResult = { ok: true } | { ok: false; reason: 'installed' | 'not_found' };

/**
 * Every id that has an approval or a person's choice recorded but no copy
 * installed anywhere (running or shadowed), A–Z.
 *
 * @param manager - The extension manager.
 */
export function listStaleApprovals(manager: RemovalManager): StaleApproval[] {
  const installed = new Set([
    ...manager.listRecords().map((record) => record.id),
    ...manager.listShadowedPublic().map((record) => record.id),
  ]);
  const extensions = configManager.get('extensions');
  const sources = extensions.approvedSources ?? {};
  const ids = new Set([
    ...extensions.approvedToRun,
    ...Object.keys(sources),
    ...Object.keys(extensions.approvedPermissions ?? {}),
  ]);
  return [...ids]
    .filter((id) => !installed.has(id))
    .sort((a, b) => a.localeCompare(b))
    .map((id) => ({
      id,
      path: sources[id]?.path ?? null,
      plugin: sources[id]?.plugin ?? null,
    }));
}

/**
 * Whether a folder sits where DorkOS puts an extension it installs or
 * creates: `<dorkHome>/extensions/<id>` or `…/.dork/extensions/<id>`, named
 * after the id, and reached through no symbolic link.
 *
 * @param folder - The copy's path.
 * @param id - Its extension id.
 * @param dorkHome - DorkOS's data directory.
 */
async function isRemovableFolder(folder: string, id: string, dorkHome: string): Promise<boolean> {
  const resolved = path.resolve(folder);
  if (path.basename(resolved) !== id) return false;
  const parent = path.dirname(resolved);
  if (path.basename(parent) !== 'extensions') return false;
  const underHome = parent === path.resolve(dorkHome, 'extensions');
  const underDork = path.basename(path.dirname(parent)) === '.dork';
  if (!underHome && !underDork) return false;
  try {
    const stat = await fs.lstat(resolved);
    if (!stat.isDirectory()) return false;
    // A link anywhere on the way would point the delete somewhere else.
    return (await fs.realpath(resolved)) === resolved;
  } catch {
    return false;
  }
}

/**
 * Drop the "Not now" and the on/off choice a person recorded for an id.
 *
 * @param id - The extension id.
 * @param subsystem - What is writing, as a person would name it.
 */
function forgetPersonChoices(id: string, subsystem: string): void {
  const before = configManager.get('extensions');
  const dismissed = { ...(before.dismissedApprovals ?? {}) };
  const hadDismissal = id in dismissed;
  delete dismissed[id];
  if (!hadDismissal && !before.enabled.includes(id) && !before.disabled.includes(id)) return;
  configManager.set('extensions', {
    ...before,
    enabled: before.enabled.filter((eid) => eid !== id),
    disabled: before.disabled.filter((eid) => eid !== id),
    dismissedApprovals: dismissed,
  });
  logConfigWrite(subsystem, 'extensions', before, configManager.get('extensions'));
}

/**
 * Remove an installed extension: forget every approval and choice recorded
 * for this copy, then delete its folder, then rescan.
 *
 * @param manager - The extension manager.
 * @param id - The extension to remove.
 */
export async function removeExtension(manager: RemovalManager, id: string): Promise<RemoveResult> {
  const record = manager.get(id);
  if (!record) return { ok: false, reason: 'not_found' };
  if (record.origin === 'core') return { ok: false, reason: 'core' };
  if (record.devLink) return { ok: false, reason: 'dev_link' };
  if (record.sourcePlugin) return { ok: false, reason: 'plugin' };
  if (!(await isRemovableFolder(record.path, id, manager.dorkHome))) {
    return { ok: false, reason: 'unexpected_folder' };
  }

  // Approvals first: if the delete then fails, what is left asks again.
  // Scoped to this copy's folder, so an approval for another copy of the
  // same id (another project) stays with that copy.
  await manager.forgetRunApproval(id, record.path);
  forgetPersonChoices(id, 'removing an extension');
  await fs.rm(record.path, { recursive: true, force: true });
  logger.info(`[Extensions] Removed ${id} from ${record.path}`);
  await manager.reload();
  return { ok: true, name: record.manifest.name, path: record.path };
}

/**
 * Forget the approval of an extension that is no longer installed anywhere.
 *
 * @param manager - The extension manager.
 * @param id - The extension id the stale approval names.
 */
export async function forgetStaleApproval(
  manager: RemovalManager,
  id: string
): Promise<ForgetResult> {
  if (!listStaleApprovals(manager).some((stale) => stale.id === id)) {
    const installed =
      manager.get(id) !== undefined || manager.listShadowedPublic().some((rec) => rec.id === id);
    return { ok: false, reason: installed ? 'installed' : 'not_found' };
  }
  await manager.forgetRunApproval(id);
  forgetPersonChoices(id, 'forgetting the approval of an extension that is gone');
  return { ok: true };
}
