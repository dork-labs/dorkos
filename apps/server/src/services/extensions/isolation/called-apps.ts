/**
 * The other apps an app calls, as its approval card names them (DOR-3293).
 *
 * Each line uses DorkOS's own name for the other app and says what that app
 * shares with this one, read from that app's exports, never from the caller:
 * an app cannot describe another app's routes to make its card read better.
 *
 * @module services/extensions/isolation/called-apps
 */
import {
  calledApps,
  exportedAccess,
  openableApps,
  type ExtensionRecord,
} from '@dorkos/extension-api';
import type { ExtensionApprovalPermissions } from '@dorkos/shared/extension-approval-schemas';

/** One called app on the card. */
export type CalledAppView = NonNullable<ExtensionApprovalPermissions['apps']>[number];

/** Statuses a record has while it is turned on. */
const ON = new Set(['enabled', 'compiled', 'active']);

/**
 * The card lines for the apps `record` calls.
 *
 * @param record - The app being approved.
 * @param lookup - DorkOS's record of another app, by id.
 * @returns One entry per app it lists, in its order; an app that is not
 *   installed or not on has no name and no access. `opens` is the caller's own
 *   `navigate: true` for that app.
 */
export function calledAppsView(
  record: Pick<ExtensionRecord, 'id' | 'manifest'>,
  lookup: (id: string) => Pick<ExtensionRecord, 'manifest' | 'status'> | undefined
): CalledAppView[] {
  const opened = openableApps(record.manifest);
  return calledApps(record.manifest).map((id) => {
    const opens = opened.includes(id);
    const target = lookup(id);
    if (!target || !ON.has(target.status)) return { id, name: null, access: null, opens };
    return {
      id,
      name: target.manifest.name,
      access: exportedAccess(target.manifest, record.id),
      opens,
    };
  });
}

/**
 * What each target shares with a caller now, read from DorkOS's records: the
 * live answer approval coverage compares against what the person approved.
 * A target that is not installed or not on shares nothing.
 *
 * @param get - DorkOS's record of an app, by id.
 * @returns The lookup for `setCalledAppAccessLookup`.
 */
export function calledAppAccessLookupIn(
  get: (id: string) => Pick<ExtensionRecord, 'manifest' | 'status'> | undefined
): (callerId: string, targetId: string) => 'reads' | 'changes' | 'both' | null {
  return (callerId, targetId) => {
    const target = get(targetId);
    return target && ON.has(target.status) ? exportedAccess(target.manifest, callerId) : null;
  };
}
