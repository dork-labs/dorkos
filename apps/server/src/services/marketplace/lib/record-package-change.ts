/**
 * Package installs, updates and removals in the audit log (spec `audit-trail`
 * PR2).
 *
 * Recorded where the change commits, not at each door, so the app, the HTTP
 * routes and the MCP tools are covered by one call each. An update removes the
 * old version and installs the new one; it is recorded once, as an update, and
 * the removal half (`replacing: true`) records nothing. An update that fails
 * is recorded too, and says whether the package was left in place or is now
 * gone: the removal half can succeed and the install half fail, and that must
 * not happen without a trace. Who acted comes from the current audit scope.
 *
 * @module services/marketplace/lib/record-package-change
 */
import type { AuditChange } from '@dorkos/shared/audit-schemas';
import { recordAudit } from '../../audit/audit-trail.js';

/** What a package's sidecar said, either side of a change. */
export interface PackageVersionFacts {
  /** The version installed. */
  version?: string;
  /** The commit it was installed from, when it came from git. */
  commitSha?: string;
}

/** What happened to a package. */
export type PackageChange =
  | {
      kind: 'installed' | 'updated';
      name: string;
      source?: string;
      projectPath?: string;
      before?: PackageVersionFacts | null;
      after: PackageVersionFacts;
    }
  | { kind: 'uninstalled'; name: string; purge: boolean; projectPath?: string }
  | {
      kind: 'update_failed';
      name: string;
      projectPath?: string;
      before: PackageVersionFacts | null;
      /** Whether the package is gone now (the removal half ran, the install did not). */
      removed: boolean;
      error: string;
    };

/** A short commit id: a full one is long hex, which redaction hides. */
const short = (sha?: string) => (sha ? sha.slice(0, 12) : undefined);

/** Before/after rows for the facts that changed or are known. */
function versionChanges(
  before: PackageVersionFacts | null | undefined,
  after: PackageVersionFacts
): AuditChange[] {
  const change: AuditChange[] = [];
  if (after.version !== undefined || before?.version !== undefined) {
    change.push({
      field: 'version',
      ...(before?.version !== undefined ? { before: before.version } : {}),
      ...(after.version !== undefined ? { after: after.version } : {}),
    });
  }
  if (after.commitSha !== undefined || before?.commitSha !== undefined) {
    change.push({
      field: 'commit',
      ...(before?.commitSha !== undefined ? { before: short(before.commitSha) } : {}),
      ...(after.commitSha !== undefined ? { after: short(after.commitSha) } : {}),
    });
  }
  return change;
}

/**
 * Record one package change.
 *
 * @param change - What happened.
 */
export function recordPackageChange(change: PackageChange): void {
  const where = change.projectPath ? ` in ${change.projectPath}` : '';
  const target = {
    type: 'package',
    id: change.name,
    name: change.name,
    ...(change.projectPath ? { containerId: change.projectPath } : {}),
  };
  if (change.kind === 'uninstalled') {
    recordAudit({
      action: 'marketplace.uninstalled',
      operation: 'remove',
      target,
      outcome: 'ok',
      summary: `Removed ${change.name}${change.purge ? ' and its data' : ''}${where}`,
    });
    return;
  }
  if (change.kind === 'update_failed') {
    recordAudit({
      action: 'marketplace.update_failed',
      operation: change.removed ? 'remove' : 'modify',
      target,
      outcome: 'failed',
      error: change.error,
      ...(change.before ? { change: versionChanges(change.before, {}) } : {}),
      summary: change.removed
        ? `Tried to update ${change.name}${where}; the old version was removed and the new one did not install`
        : `Tried to update ${change.name}${where}; nothing changed`,
    });
    return;
  }
  const change_ = versionChanges(change.before, change.after);
  if (change.source) change_.push({ field: 'source', after: change.source });
  recordAudit({
    action: `marketplace.${change.kind}`,
    operation: change.kind === 'installed' ? 'create' : 'modify',
    target,
    outcome: 'ok',
    ...(change_.length ? { change: change_ } : {}),
    summary: `${change.kind === 'installed' ? 'Installed' : 'Updated'} ${change.name}${
      change.after.version ? ` ${change.after.version}` : ''
    }${where}`,
  });
}
