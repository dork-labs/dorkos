/**
 * Formatting utilities for `PermissionPreview` — converts raw server data into
 * icon/label/severity groups ready for UI rendering.
 *
 * Keeping this logic here lets UI components stay as thin presentational
 * shells with no formatting concerns.
 *
 * @module features/marketplace/lib/format-permissions
 */
import {
  describeHookEvent,
  describeSchedulePermissionMode,
  type PermissionPreview,
} from '@dorkos/shared/marketplace-schemas';
import cronstrue from 'cronstrue';

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
  /**
   * Render the label as literal code. Set for rows whose label is a verbatim
   * shell command, so it is never mistaken for prose the UI wrote.
   */
  mono?: boolean;
}

/**
 * All permission rows grouped by category, mirroring the sections of the
 * install confirmation UI.
 */
export interface FormattedPermissionGroups {
  /** Files the package will create, modify, or delete. */
  effects: FormattedPermission[];
  /** Shell commands the package registers as harness hooks. */
  commands: FormattedPermission[];
  /** Scheduled jobs the package will create, and what each may do unattended. */
  schedules: FormattedPermission[];
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
 * Format the `fileChanges`, `npmDependencies`, and `extensions` fields of a
 * `PermissionPreview` into the `effects` group.
 *
 * The npm row sits here rather than under "Dependencies" — that group is other
 * marketplace packages this one needs, which are a different thing from third-
 * party libraries fetched off the npm registry. It says "download" because that
 * is the part a person is consenting to: an install that reaches the network
 * before the package has run a single line. It counts only what the package
 * DECLARED and says "and everything they depend on", because the transitive
 * total is unknown until npm resolves it and is routinely an order of magnitude
 * larger.
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

  if (preview.npmDependencies.length > 0) {
    const count = preview.npmDependencies.length;
    rows.push({
      icon: 'globe',
      // "and everything they depend on" is doing real work: `count` is what the
      // package declared, and one declared library routinely pulls dozens more
      // (`express` alone is 68 packages). A bare "Download 1 npm library" would
      // be a number a person could reasonably rely on, and it would be wrong.
      label: `Download ${count} npm ${count === 1 ? 'library' : 'libraries'}, and everything they depend on`,
      // Every declared library is named, not just the first few: this is the
      // row that tells a person what code is about to be fetched onto their
      // machine, and a truncated list would hide the one that matters.
      description: preview.npmDependencies
        .map((dep) => `${dep.name}@${dep.range}${dep.optional ? ' (optional)' : ''}`)
        .join(', '),
    });
  }

  for (const ext of preview.extensions) {
    rows.push({
      icon: 'puzzle',
      label: `Register UI extension: ${ext.id}`,
      description: ext.slots.length > 0 ? `Slots: ${ext.slots.join(', ')}` : undefined,
    });
  }

  return rows;
}

/**
 * Format the `hooks` and `unreadableHooks` fields into the `commands` group.
 *
 * The label is the shell command exactly as the package wrote it — this is the
 * one fact a person needs to judge whether to trust the package, so it is never
 * paraphrased or truncated here.
 *
 * A hook declaration we could not parse is listed too, at warning severity.
 * Dropping it would render "declares commands we cannot read" identically to
 * "declares no commands", and those are very different things to be told right
 * before you click Install.
 *
 * @param preview - Full permission preview from the server.
 */
function formatCommands(preview: PermissionPreview): FormattedPermission[] {
  const rows: FormattedPermission[] = preview.hooks.map((hook) => ({
    icon: 'terminal',
    label: hook.command,
    description: `Runs ${describeHookEvent(hook.event, hook.matcher)}`,
    mono: true,
  }));

  for (const unreadable of preview.unreadableHooks) {
    rows.push({
      icon: 'alert-triangle',
      label: 'This package sets up a command to run, but we could not read it',
      description: unreadable.event
        ? `${unreadable.path} declares "${unreadable.event}" in a form DorkOS cannot read`
        : `${unreadable.path} is not readable`,
      severity: 'warning' satisfies PermissionSeverity,
    });
  }

  return rows;
}

/**
 * Translate a cron expression into plain words via `cronstrue`, the same
 * library (and the same fallback stance) the task builder already uses.
 *
 * An expression `cronstrue` cannot parse falls back to the raw text rather
 * than to silence: the preview would otherwise claim less than it knows.
 */
function describeCron(cron: string): string {
  try {
    return cronstrue.toString(cron);
  } catch {
    return `On the schedule ${cron}`;
  }
}

/**
 * Format the `schedules` field into the `schedules` group.
 *
 * Names the permission mode in plain words rather than echoing the raw id: a
 * person deciding whether to trust a package learns nothing from
 * "bypassPermissions" and everything from "can run any command without asking
 * you". The cron expression gets the same treatment for the same reason —
 * translating one and not the other in a single sentence was the inconsistency
 * this dialog exists to avoid. A job that runs unattended without asking is
 * flagged at warning severity.
 *
 * @param preview - Full permission preview from the server.
 */
function formatSchedules(preview: PermissionPreview): FormattedPermission[] {
  return preview.schedules.map((schedule) => {
    const when = schedule.cron ? describeCron(schedule.cron) : 'Runs only when you ask';
    const state = schedule.startsEnabled ? 'starts switched on' : 'starts switched off';
    const unattended =
      schedule.permissionMode === 'bypassPermissions' ||
      schedule.permissionMode === 'dontAsk' ||
      schedule.permissionMode === 'auto';
    return {
      icon: 'clock',
      label: schedule.name,
      description: `${when}, ${state}. This job ${describeSchedulePermissionMode(schedule.permissionMode)}.`,
      severity: (unattended && schedule.startsEnabled
        ? 'warning'
        : 'info') satisfies PermissionSeverity,
    };
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Normalise a `PermissionPreview` into icon/label/severity groups ready for
 * UI rendering.
 *
 * The returned object mirrors the sections of the install confirmation dialog.
 * Each entry carries an `icon` string, a `label`, an optional `description`,
 * and an optional `severity`.
 *
 * @param preview - Raw `PermissionPreview` from the server.
 * @returns Grouped and formatted permission rows.
 */
export function formatPermissionPreview(preview: PermissionPreview): FormattedPermissionGroups {
  return {
    effects: formatEffects(preview),

    commands: formatCommands(preview),

    schedules: formatSchedules(preview),

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
