/**
 * Package installs, updates and removals in the audit log (spec `audit-trail`
 * PR2).
 *
 * Recorded where the change commits, not at each door, so the app, the HTTP
 * routes and the MCP tools are covered by one call each. An update removes the
 * old version and installs the new one; it is recorded once, as an update, and
 * the removal half (`replacing: true`) records nothing. Who acted comes from the
 * current audit scope.
 *
 * @module services/marketplace/lib/record-package-change
 */
import { recordAudit } from '../../audit/audit-trail.js';

/** What happened to a package. */
export type PackageChange =
  | { kind: 'installed'; name: string; version: string; source?: string; projectPath?: string }
  | { kind: 'updated'; name: string; version: string; source?: string; projectPath?: string }
  | { kind: 'uninstalled'; name: string; purge: boolean; projectPath?: string };

const OPERATION = { installed: 'create', updated: 'modify', uninstalled: 'remove' } as const;

/**
 * Record one package change.
 *
 * @param change - What happened.
 */
export function recordPackageChange(change: PackageChange): void {
  const where = change.projectPath ? ` in ${change.projectPath}` : '';
  const what =
    change.kind === 'uninstalled'
      ? `Removed ${change.name}${change.purge ? ' and its data' : ''}${where}`
      : `${change.kind === 'installed' ? 'Installed' : 'Updated'} ${change.name} ${change.version}${where}`;
  recordAudit({
    action: `marketplace.${change.kind}`,
    operation: OPERATION[change.kind],
    target: {
      type: 'package',
      id: change.name,
      name: change.name,
      ...(change.projectPath ? { containerId: change.projectPath } : {}),
    },
    outcome: 'ok',
    ...(change.kind !== 'uninstalled'
      ? {
          change: [
            { field: 'version', after: change.version },
            ...(change.source ? [{ field: 'source', after: change.source }] : []),
          ],
        }
      : {}),
    summary: what,
  });
}
