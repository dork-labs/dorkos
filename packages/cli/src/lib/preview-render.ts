/**
 * Terminal renderer for the marketplace `PermissionPreview` payload.
 *
 * Mirrors the field shape declared in
 * `apps/server/src/services/marketplace/types.ts`. Kept structurally typed
 * (rather than importing the server type) so the CLI never pulls server
 * code into its bundle.
 *
 * @module lib/preview-render
 */

/** A single planned filesystem mutation surfaced by the preview. */
export interface PreviewFileChange {
  path: string;
  action: 'create' | 'modify' | 'delete';
}

/** A single conflict report between an incoming package and the install set. */
export interface PreviewConflict {
  level: 'error' | 'warning';
  type: string;
  description: string;
  conflictingPackage?: string;
}

/**
 * The structural shape of a `PermissionPreview` as serialised over the
 * marketplace HTTP API. Matches `services/marketplace/types.ts` exactly.
 */
export interface PreviewPayload {
  fileChanges: PreviewFileChange[];
  extensions: { id: string; slots: string[] }[];
  tasks: { name: string; cron: string | null }[];
  secrets: { key: string; required: boolean; description?: string }[];
  externalHosts: string[];
  requires: { type: string; name: string; version?: string; satisfied: boolean }[];
  conflicts: PreviewConflict[];
}

/** ANSI escape sequences. Inlined to keep the helper dependency-free. */
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

/**
 * Render a {@link PreviewPayload} to a multi-line string suitable for
 * `console.log`. Empty sections are omitted entirely so the output stays
 * scannable. Conflicts are always rendered last and use ANSI colour to
 * distinguish errors (red) from warnings (yellow).
 *
 * @param packageName - The package name being previewed; used in the header.
 * @param version - Resolved package version.
 * @param preview - The preview payload to render.
 * @returns A formatted multi-line string with no trailing newline.
 */
export function renderPreview(
  packageName: string,
  version: string,
  preview: PreviewPayload
): string {
  const lines: string[] = [];

  lines.push(`Package: ${packageName}@${version}`);
  lines.push('');

  if (preview.fileChanges.length > 0) {
    lines.push('Files:');
    for (const change of preview.fileChanges) {
      lines.push(`  ${change.action.padEnd(7)} ${change.path}`);
    }
    lines.push('');
  }

  if (preview.extensions.length > 0) {
    lines.push('Extensions:');
    for (const ext of preview.extensions) {
      const slots = ext.slots.length > 0 ? ` [${ext.slots.join(', ')}]` : '';
      lines.push(`  ${ext.id}${slots}`);
    }
    lines.push('');
  }

  if (preview.tasks.length > 0) {
    lines.push('Tasks:');
    for (const task of preview.tasks) {
      const cron = task.cron ? ` (${task.cron})` : '';
      lines.push(`  ${task.name}${cron}`);
    }
    lines.push('');
  }

  if (preview.secrets.length > 0) {
    lines.push('Secrets:');
    for (const secret of preview.secrets) {
      const required = secret.required ? ' (required)' : ' (optional)';
      const description = secret.description ? `${DIM} — ${secret.description}${RESET}` : '';
      lines.push(`  ${secret.key}${required}${description}`);
    }
    lines.push('');
  }

  if (preview.externalHosts.length > 0) {
    lines.push('External hosts:');
    for (const host of preview.externalHosts) {
      lines.push(`  ${host}`);
    }
    lines.push('');
  }

  if (preview.requires.length > 0) {
    lines.push('Requires:');
    for (const dep of preview.requires) {
      const version = dep.version ? `@${dep.version}` : '';
      const status = dep.satisfied ? '✓' : '✗';
      lines.push(`  ${status} ${dep.type}/${dep.name}${version}`);
    }
    lines.push('');
  }

  if (preview.conflicts.length > 0) {
    lines.push('Conflicts:');
    for (const conflict of preview.conflicts) {
      const colour = conflict.level === 'error' ? RED : YELLOW;
      const symbol = conflict.level === 'error' ? '✗' : '⚠';
      const target = conflict.conflictingPackage ? ` (${conflict.conflictingPackage})` : '';
      lines.push(
        `  ${colour}${symbol} [${conflict.type}] ${conflict.description}${target}${RESET}`
      );
    }
    lines.push('');
  }

  // Drop the trailing blank line if the last section emitted one.
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  return lines.join('\n');
}

/**
 * Whether the preview contains any error-level conflicts. Error-level
 * conflicts block install unless `--force` is supplied.
 *
 * @param preview - The preview payload to inspect.
 * @returns `true` when at least one conflict has `level: 'error'`.
 */
export function hasBlockingConflicts(preview: PreviewPayload): boolean {
  return preview.conflicts.some((c) => c.level === 'error');
}
