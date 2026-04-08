/**
 * Formatting utilities for `PermissionPreview` — converts raw server data into
 * icon/label/severity groups ready for UI rendering.
 *
 * Keeping this logic here lets UI components stay as thin presentational
 * shells with no formatting concerns.
 *
 * @module features/marketplace/lib/format-permissions
 */
import type { PermissionPreview } from '@dorkos/shared/marketplace-schemas';

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

/** Severity level used to style a permission row. */
export type PermissionSeverity = 'info' | 'warning' | 'error';

/**
 * A single permission row ready for UI rendering.
 *
 * `icon` is a string identifier (e.g. `'file'`, `'key'`) — icon components
 * are resolved by the caller so this lib stays free of UI imports.
 */
export interface FormattedPermission {
  /** Icon identifier string. UI layer maps this to an actual icon component. */
  icon: string;
  /** Human-readable label shown in the permission row. */
  label: string;
  /** Optional supplemental description shown below the label. */
  description?: string;
  /** Severity level used to style the row. Defaults to `'info'` when absent. */
  severity?: PermissionSeverity;
}

/**
 * All permission rows grouped by category, mirroring the five sections of the
 * install confirmation UI.
 */
export interface FormattedPermissionGroups {
  /** Files the package will create, modify, or delete. */
  effects: FormattedPermission[];
  /** Secrets the package will request from the user. */
  secrets: FormattedPermission[];
  /** External hosts the package will contact. */
  hosts: FormattedPermission[];
  /** Other packages this package depends on. */
  dependencies: FormattedPermission[];
  /** Conflicts with already-installed packages. */
  conflicts: FormattedPermission[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format the `fileChanges`, `extensions`, and `tasks` fields of a
 * `PermissionPreview` into the `effects` group.
 *
 * @param preview - Full permission preview from the server.
 */
function formatEffects(preview: PermissionPreview): FormattedPermission[] {
  const rows: FormattedPermission[] = [];

  if (preview.fileChanges.length > 0) {
    rows.push({
      icon: 'file',
      label: `${preview.fileChanges.length} file${preview.fileChanges.length === 1 ? '' : 's'} will be created, modified, or deleted`,
    });
  }

  for (const ext of preview.extensions) {
    rows.push({
      icon: 'puzzle',
      label: `Register UI extension: ${ext.id}`,
      description: ext.slots.length > 0 ? `Slots: ${ext.slots.join(', ')}` : undefined,
    });
  }

  for (const task of preview.tasks) {
    rows.push({
      icon: 'clock',
      label: `Schedule task: ${task.name}${task.cron ? ` (${task.cron})` : ''}`,
    });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Normalise a `PermissionPreview` into icon/label/severity groups ready for
 * UI rendering.
 *
 * The returned object mirrors the five sections of the install confirmation
 * dialog. Each entry carries an `icon` string, a `label`, an optional
 * `description`, and an optional `severity`.
 *
 * @param preview - Raw `PermissionPreview` from the server.
 * @returns Grouped and formatted permission rows.
 */
export function formatPermissionPreview(preview: PermissionPreview): FormattedPermissionGroups {
  return {
    effects: formatEffects(preview),

    secrets: preview.secrets.map((s) => ({
      icon: 'key',
      label: s.key + (s.required ? '' : ' (optional)'),
      description: s.description,
      severity: (s.required ? 'warning' : 'info') satisfies PermissionSeverity,
    })),

    hosts: preview.externalHosts.map((host) => ({
      icon: 'globe',
      label: host,
    })),

    dependencies: preview.requires.map((dep) => ({
      icon: dep.satisfied ? 'check' : 'alert-triangle',
      label: `${dep.type}:${dep.name}${dep.version ? `@${dep.version}` : ''}`,
      severity: (dep.satisfied ? 'info' : 'warning') satisfies PermissionSeverity,
    })),

    conflicts: preview.conflicts.map((conflict) => ({
      icon: 'alert-triangle',
      label: conflict.description,
      description: conflict.conflictingPackage
        ? `Conflicts with: ${conflict.conflictingPackage}`
        : undefined,
      severity: (conflict.level === 'error' ? 'error' : 'warning') satisfies PermissionSeverity,
    })),
  };
}
