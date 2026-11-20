/**
 * Drop what DorkOS still remembers about extensions that are gone (DOR-4305).
 *
 * An uninstall through the marketplace forgets an extension's approval as it
 * removes it (`forgetRunApproval`). An extension whose folder simply went away
 * (deleted by hand, or a project's copy removed) left its approval, its
 * permission set, its rooms and its agents in `config.json` until a person clicked
 * Forget. Removing them only ever narrows what can run, so no person is asked:
 * each scan drops them, writes a config log line and an audit line, and a
 * reinstall asks again like any new extension.
 *
 * Only what is plainly gone is dropped: no scan found the id, its recorded
 * folder no longer exists, and that folder's parent still does. A folder whose
 * parent is missing too (an unplugged drive, a project moved away) is left
 * alone, because it may come back as it was. An approval that never recorded
 * a folder is left alone for the same reason. Two things a person said stay:
 * the `disabled` list ("keep this off") and a "Not now" (`dismissedApprovals`),
 * because dropping either would let a later copy under that id start sooner.
 *
 * A scan that lands while a folder is briefly away (an update mid-swap, a
 * branch switch) drops that approval too. That is on purpose: it only narrows,
 * and the next run asks again.
 *
 * @module services/extensions/pin/stale-approvals
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ExtensionRecord } from '@dorkos/extension-api';
import type { UserConfig } from '@dorkos/shared/config-schema';
import type { PermissionState } from '@dorkos/shared/permissions';
import { auditTrail, recordAudit } from '../../audit/audit-trail.js';
import { configManager } from '../../core/config-manager.js';
import { logConfigWrite } from '../../core/operator/config-write.js';
import { logger } from '../../../lib/logger.js';
import { withoutExtension, withoutPersonChoices } from '../rooms/extension-room-access.js';

type ExtensionsConfig = UserConfig['extensions'];

/** Where an approved extension lived, when DorkOS recorded it. */
function recordedFolder(extensions: ExtensionsConfig, id: string): string | undefined {
  return extensions.approvedSources?.[id]?.path;
}

/**
 * The ids whose folder is plainly gone, and the `extensions` section without
 * them. Pure, so the rule is tested without a config file.
 *
 * @param extensions - The `extensions` config section.
 * @param found - Every id this scan found, shadowed copies included.
 * @param exists - Whether a path exists; the real filesystem by default.
 */
export function withoutStaleApprovals(
  extensions: ExtensionsConfig,
  found: ReadonlySet<string>,
  exists: (target: string) => boolean = existsSync
): { next: ExtensionsConfig; dropped: string[] } {
  const remembered = new Set<string>([
    ...extensions.approvedToRun,
    ...Object.keys(extensions.approvedSources ?? {}),
    ...Object.keys(extensions.approvedPermissions ?? {}),
  ]);
  const dropped = [...remembered].filter((id) => {
    if (found.has(id)) return false;
    const folder = recordedFolder(extensions, id);
    if (!folder || exists(folder)) return false;
    // Its parent gone too: an unplugged drive or a moved project, not a removal.
    return exists(path.dirname(folder));
  });
  if (dropped.length === 0) return { next: extensions, dropped };
  let next: ExtensionsConfig = {
    ...extensions,
    enabled: extensions.enabled.filter((id) => !dropped.includes(id)),
    approvedToRun: extensions.approvedToRun.filter((id) => !dropped.includes(id)),
  };
  for (const id of dropped) {
    next = {
      ...next,
      approvedSources: withoutExtension(next.approvedSources, id),
      approvedPermissions: withoutExtension(next.approvedPermissions, id),
      ...withoutPersonChoices(next, id),
    };
  }
  return { next, dropped };
}

/**
 * Drop the approvals of extensions that are gone, with a config log line and
 * one audit line each. Returns the ids dropped, so the caller can clear their
 * per-tool permission settings too.
 *
 * @param records - The records this scan produced.
 * @param shadowed - The copies newer ones shadow.
 */
export function dropStaleApprovals(
  records: readonly ExtensionRecord[],
  shadowed: readonly ExtensionRecord[]
): string[] {
  const before = configManager.get('extensions');
  const found = new Set([...records, ...shadowed].map((record) => record.id));
  const { next, dropped } = withoutStaleApprovals(before, found);
  if (dropped.length === 0) return dropped;
  configManager.set('extensions', next);
  logConfigWrite(
    'dropping approvals for extensions that are no longer installed',
    'extensions',
    before,
    configManager.get('extensions')
  );
  // DorkOS did this, whoever's reload or install started the scan.
  const system = auditTrail()?.accounts.system();
  for (const id of dropped) {
    recordAudit({
      ...(system ? { actor: system } : {}),
      source: { surface: 'system' },
      action: 'extension.stale_approval_dropped',
      operation: 'remove',
      outcome: 'ok',
      target: { type: 'extension', id, name: id },
      summary: `Dropped the approval for ${id}: it is no longer installed. A reinstall asks again.`,
    });
  }
  logger.info(
    `[Extensions] Dropped approvals for ${dropped.length} extension(s) no longer installed: ` +
      `${dropped.join(', ')}`
  );
  return dropped;
}

/**
 * The permission writer's forget for one extension's tool settings. `keep`
 * names the states a person chose that stay in place.
 */
export type ForgetToolPermissions = (
  extensionId: string,
  extensionName: string,
  opts?: { keep?: readonly PermissionState[] }
) => Promise<unknown>;

/**
 * What a drop keeps: a Blocked or Ask a person chose. The extension may come
 * back and be approved again, and its tools must not come back looser.
 */
const KEPT_ON_DROP: readonly PermissionState[] = ['blocked', 'ask'];

/**
 * Drop the approvals of extensions that are gone, then clear their Allowed
 * per-tool settings. A Blocked or Ask a person chose stays.
 *
 * @param records - The records this scan produced.
 * @param shadowed - The copies newer ones shadow.
 * @param forget - The permission writer's forget, or `null` before it is wired.
 */
export async function dropGoneExtensions(
  records: readonly ExtensionRecord[],
  shadowed: readonly ExtensionRecord[],
  forget: ForgetToolPermissions | null
): Promise<void> {
  for (const id of dropStaleApprovals(records, shadowed))
    await forgetToolSettings(forget, id, id, { keep: KEPT_ON_DROP });
}

/**
 * Clear one extension's per-tool permission settings, best-effort: a removed
 * extension's settings must not carry over to whatever is installed under its
 * id next (DOR-2685).
 *
 * @param forget - The permission writer's forget, or `null` before it is wired.
 * @param id - The extension.
 * @param name - Its name, for the change record.
 * @param opts - `keep`: the states that stay; an uninstall passes none.
 */
export async function forgetToolSettings(
  forget: ForgetToolPermissions | null,
  id: string,
  name: string,
  opts?: { keep?: readonly PermissionState[] }
): Promise<void> {
  if (!forget) return;
  try {
    // An uninstall passes no options, and its writer is called with exactly two.
    await (opts ? forget(id, name, opts) : forget(id, name));
  } catch (err) {
    logger.warn(`[Extensions] Could not clear the tool permission settings of ${id}`, err);
  }
}
