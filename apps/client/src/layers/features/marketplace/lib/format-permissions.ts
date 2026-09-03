/**
 * Formatting utilities for `PermissionPreview` — converts raw server data into
 * icon/label/severity groups ready for UI rendering.
 *
 * Keeping this logic here lets UI components stay as thin presentational
 * shells with no formatting concerns.
 *
 * @module features/marketplace/lib/format-permissions
 */
import { describeHookEvent, type PermissionPreview } from '@dorkos/shared/marketplace-schemas';
import { describePreviewSchedule, runsUnattended } from '@/layers/entities/marketplace';

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

/** Severity level used to style a permission row. */
export type PermissionSeverity = 'info' | 'warning' | 'error';

/**
 * One line inside a row's expandable detail list — a file path plus the plain
 * word for what happens to it. Rendered monospace, because these are literal
 * paths and a person is checking them character by character.
 */
export interface PermissionDetailItem {
  /**
   * The path itself. Relative to the folder the row's label names on the file
   * headline, where that folder is stated once and repeating it on 135 lines
   * would bury the part that differs. Absolute on the escape warning, where the
   * whole point of the row is that these paths are somewhere else.
   */
  text: string;
  /** Plain-language action word: `'new'`, `'changed'`, or `'removed'`. */
  tag?: string;
  /** Severity used to tint the tag. Defaults to `'info'` when absent. */
  severity?: PermissionSeverity;
}

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
  /**
   * Lines revealed by an inline disclosure on this row. A summary sentence is
   * what a person skims; this is what they check before consenting.
   */
  details?: PermissionDetailItem[];
  /** Label for the disclosure that reveals {@link details}. */
  detailsLabel?: string;
}

/** Options for {@link formatPermissionPreview}. */
export interface FormatPermissionOptions {
  /**
   * The folder every changed file is expected to stay inside — the DorkOS data
   * directory for a global install, the project's `.dork` folder for an
   * agent-local one. When given, any path that escapes it earns a warning row.
   * When omitted, the check is skipped entirely rather than run against a
   * folder we are only guessing at.
   */
  installBase?: string;
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
// Helpers — file paths
// ---------------------------------------------------------------------------

/**
 * The path separator a server-supplied path uses. Preview paths are built with
 * Node's `path.join` on the host, so a Windows host sends backslashes and the
 * browser must echo them back rather than normalising them into something the
 * user cannot paste into their own shell.
 */
function detectSeparator(path: string): '/' | '\\' {
  return path.includes('\\') && !path.includes('/') ? '\\' : '/';
}

/** Split a path on either separator, so mixed input still segments correctly. */
function segments(path: string): string[] {
  return path.split(/[\\/]/);
}

/**
 * The deepest folder that contains every one of `paths`.
 *
 * Returns `''` when the paths share no folder at all (bare relative file names),
 * so the caller can drop the "under X" clause instead of claiming a root that
 * does not exist.
 */
function commonDirectory(paths: string[]): string {
  const first = paths[0];
  if (first === undefined) return '';
  const separator = detectSeparator(first);

  let common = segments(first).slice(0, -1);
  for (const path of paths.slice(1)) {
    const parts = segments(path).slice(0, -1);
    let shared = 0;
    while (shared < common.length && shared < parts.length && common[shared] === parts[shared]) {
      shared += 1;
    }
    common = common.slice(0, shared);
    if (common.length === 0) break;
  }

  if (common.length === 0) return '';
  // A single empty segment is the POSIX filesystem root, which joins to ''.
  if (common.length === 1 && common[0] === '') return separator;
  return common.join(separator);
}

/** Strip `root` from the front of `path`, leaving the path untouched if it does not match. */
function relativeTo(path: string, root: string): string {
  if (root === '') return path;
  const separator = detectSeparator(path);
  const prefix = root.endsWith(separator) ? root : root + separator;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/**
 * Reduce a path to the form segment comparison can trust: forward slashes, no
 * repeated or trailing separators, no `.` segments.
 *
 * The two sides being compared are built differently. The server writes preview
 * paths with Node's `path.join`, which already normalises; the client assembles
 * the install base by concatenating a stored `projectPath` with `/.dork`, which
 * does not. A stored path with a trailing slash or a `./` prefix would otherwise
 * read as "outside your folder" for every single file — a false alarm on an
 * install that is perfectly ordinary.
 */
function normalizeForCompare(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/(^|\/)\.(?=\/|$)/g, '$1')
    .replace(/\/+/g, '/')
    .replace(/(.)\/$/, '$1');
}

/**
 * Whether `path` sits inside `base`. Compares whole segments, so
 * `~/.dork-backup/x` is correctly outside `~/.dork`.
 */
function isInside(path: string, base: string): boolean {
  if (base === '') return false;
  const root = normalizeForCompare(base);
  // `base` was nothing but separators, i.e. the filesystem root: everything is inside.
  if (root === '/' || root === '') return true;
  const candidate = normalizeForCompare(path);
  return candidate === root || candidate.startsWith(`${root}/`);
}

// ---------------------------------------------------------------------------
// File changes
// ---------------------------------------------------------------------------

/** Plain words for the three things an install does to a file. */
const ACTION_WORD = {
  delete: 'removed',
  modify: 'changed',
  create: 'new',
} as const;

/** Render order: what disappears first, what changes next, what arrives last. */
const ACTION_ORDER = ['delete', 'modify', 'create'] as const;

type FileChange = PermissionPreview['fileChanges'][number];

/** Turn file changes into detail lines, removed first, alphabetical within each action. */
function toDetailItems(changes: FileChange[], root: string): PermissionDetailItem[] {
  const items: PermissionDetailItem[] = [];
  for (const action of ACTION_ORDER) {
    const matching = changes
      .filter((change) => change.action === action)
      .map((change) => relativeTo(change.path, root))
      .sort((a, b) => a.localeCompare(b));
    for (const text of matching) {
      items.push({
        text,
        tag: ACTION_WORD[action],
        // A deletion is the one effect an uninstall cannot give back, so it is
        // the one that carries a warning tint.
        ...(action === 'delete' ? { severity: 'warning' as const } : {}),
      });
    }
  }
  return items;
}

/**
 * Build the file rows of the effects group: one headline naming the shared
 * folder and a count per action, with the full path list behind a disclosure,
 * plus a warning row naming anything that lands outside the install folder.
 *
 * A count alone is not consent — the person approving an install needs to know
 * where the files go and, above all, which existing files disappear.
 */
function formatFileChanges(
  changes: FileChange[],
  installBase: string | undefined
): FormattedPermission[] {
  if (changes.length === 0) return [];

  const root = commonDirectory(changes.map((change) => change.path));
  const counts = {
    create: changes.filter((change) => change.action === 'create').length,
    modify: changes.filter((change) => change.action === 'modify').length,
    delete: changes.filter((change) => change.action === 'delete').length,
  };
  const noun = changes.length === 1 ? 'file' : 'files';
  const where = root === '' ? '' : ` under ${root}`;

  const rows: FormattedPermission[] = [
    {
      icon: 'file',
      // Every action is named even at zero: "0 removed" is the answer to the
      // question a person actually has before approving an install.
      label: `${changes.length} ${noun}${where}: ${counts.create} new, ${counts.modify} changed, ${counts.delete} removed`,
      details: toDetailItems(changes, root),
      detailsLabel: `Show ${changes.length} ${noun}`,
    },
  ];

  // No install folder (or an empty one from a config that has not loaded) means
  // there is nothing to check the paths against, so say nothing.
  if (!installBase) return rows;

  // Escapes only. The reassuring "everything stays inside X" twin was dropped:
  // the headline already names the folder every file shares, and the preview
  // builder resolves every path against the install root, so the positive row
  // could never be false — it spent the dialog's scarcest resource, vertical
  // space, restating the line above it. The warning stays as a guard, so a
  // future install flow that writes outside the target cannot do it quietly.
  const outside = changes.filter((change) => !isInside(change.path, installBase));
  if (outside.length > 0) {
    rows.push({
      icon: 'alert-triangle',
      label: `${outside.length} ${outside.length === 1 ? 'file lands' : 'files land'} outside ${installBase}.`,
      severity: 'warning' satisfies PermissionSeverity,
      // Full paths here, not relative ones — the point of this row is where.
      details: toDetailItems(outside, ''),
      detailsLabel: `Show ${outside.length} ${outside.length === 1 ? 'file' : 'files'}`,
    });
  }

  return rows;
}

/**
 * Format the `fileChanges`, `npmDependencies`, and `extensions` fields of a
 * `PermissionPreview` into the `effects` group.
 *
 * The npm row sits here rather than under "Dependencies" — that group is other
 * marketplace packages this one needs, which are a different thing from
 * third-party libraries fetched off the npm registry. It says "download"
 * because that is the part a person is consenting to: an install that reaches
 * the network before the package has run a single line.
 *
 * @param preview - Full permission preview from the server.
 * @param installBase - Folder every path is expected to stay inside, if known.
 */
function formatEffects(
  preview: PermissionPreview,
  installBase: string | undefined
): FormattedPermission[] {
  const rows: FormattedPermission[] = formatFileChanges(preview.fileChanges, installBase);

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
 * Format the `schedules` field into the `schedules` group.
 *
 * The sentence itself comes from `describePreviewSchedule` in
 * `entities/marketplace`, because the agent arrival confirm has to say exactly
 * the same thing about exactly the same job (DOR-644) and two copies would
 * drift. A job that runs unattended without asking is flagged at warning
 * severity here, which is this dialog's own concern: the arrival confirm's
 * ledger has no severity column.
 *
 * @param preview - Full permission preview from the server.
 */
function formatSchedules(preview: PermissionPreview): FormattedPermission[] {
  return preview.schedules.map((schedule) => ({
    icon: 'clock',
    label: schedule.name,
    description: describePreviewSchedule(schedule),
    severity: (runsUnattended(schedule.permissionMode) && schedule.startsEnabled
      ? 'warning'
      : 'info') satisfies PermissionSeverity,
  }));
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
 * an optional `severity`, and — for the file effects — an optional `details`
 * list of paths behind a disclosure.
 *
 * @param preview - Raw `PermissionPreview` from the server.
 * @param options - Formatting context, e.g. the folder the install targets.
 * @returns Grouped and formatted permission rows.
 */
export function formatPermissionPreview(
  preview: PermissionPreview,
  options: FormatPermissionOptions = {}
): FormattedPermissionGroups {
  return {
    effects: formatEffects(preview, options.installBase),

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
