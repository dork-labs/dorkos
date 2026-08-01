/**
 * What permission mode a scheduled task actually gets when the mode arrived as
 * CONTENT — a Shape manifest's `schedules[]`, or a task's SKILL.md frontmatter
 * on disk — rather than from a caller the server can hold responsible.
 *
 * ## Why this lives under `services/tasks`
 *
 * Both sources end at the same row, so the rule has to be one function or the
 * two copies drift, and the direction they drift is a preview warning about an
 * unattended `bypassPermissions` job the installer would never create. Tasks is
 * the domain that owns the row, and `services/shapes` already imports
 * `services/tasks`; parking the rule in shapes and importing it back the other
 * way would close the loop.
 *
 * @module services/tasks/schedule-permission-clamp
 */
import type { PermissionMode } from '@dorkos/shared/schemas';

/**
 * The mode a clamped schedule falls back to — the same value both content
 * schemas default `permissionMode`/`permissions` to, so a clamp lands a package
 * or a file exactly where declaring nothing would have.
 */
const CLAMPED_PERMISSION_MODE = 'acceptEdits' as const;

/**
 * Decide the permission mode a content-declared schedule actually gets
 * (DOR-607).
 *
 * `task-write-policy.ts` classifies `permissionMode` as operator-only: an agent
 * that names itself cannot hand a future unattended run a mode it does not have
 * itself. CONTENT reaching the same field is the identical risk, and until
 * DOR-607 it got the opposite verdict — installing a third-party Shape could
 * stand up a cron job running with every approval prompt turned off, without a
 * person ever seeing the word.
 *
 * So `bypassPermissions` is refused here rather than rejected in the manifest
 * schema: a package may legitimately DECLARE what it would like, and telling the
 * operator "this asked for more than it got" is more legible than a validation
 * error at install time that names no consequence. Raising it back is a person's
 * call, in the cockpit, on a task they can see.
 *
 * Exported because the install permission preview
 * (`services/marketplace/permission-preview.ts`) has to disclose the mode a
 * schedule will ACTUALLY get, not the one it asked for.
 *
 * @param declared - The mode the content asked for.
 * @returns The mode to create the schedule with, and whether it was clamped.
 */
export function clampSchedulePermissionMode(declared: PermissionMode): {
  mode: PermissionMode;
  clamped: boolean;
} {
  return declared === 'bypassPermissions'
    ? { mode: CLAMPED_PERMISSION_MODE, clamped: true }
    : { mode: declared, clamped: false };
}

/**
 * Decide the permission mode a task's SKILL.md frontmatter actually gets, given
 * what the schedule row already holds.
 *
 * A file on disk is nobody's approval. Anything that can write a project file
 * can set `permissions: bypassPermissions` — and that bar is LOWER than it
 * sounds: an agent already running in `acceptEdits` writes that file with no
 * prompt and no shell. So a file may never INTRODUCE a bypass; the clamp above
 * applies exactly as it does to a Shape manifest.
 *
 * The one exception is a task that already carries a bypass in the row. Only a
 * caller that cleared the agent bar can have put it there
 * (`task-write-policy.ts`), so it is a person's decision on record — and the
 * cockpit writes that decision straight back into the file, which the watcher
 * and the five-minute reconciler then re-read. Clamping on the way back in would
 * undo a person's choice seconds after they made it, which is why this asks what
 * the row holds rather than clamping the file blind. A file can still LOWER a
 * mode: the file stays the source of truth in the safe direction.
 *
 * @param declared - The mode the SKILL.md frontmatter asked for.
 * @param stored - The mode the existing schedule row holds, or undefined when
 *   this file is landing as a new task.
 * @returns The mode to write, and whether the file asked for more than it got.
 */
export function resolveFilePermissionMode(
  declared: PermissionMode,
  stored: PermissionMode | undefined
): { mode: PermissionMode; clamped: boolean } {
  if (declared === 'bypassPermissions' && stored === 'bypassPermissions') {
    return { mode: 'bypassPermissions', clamped: false };
  }
  return clampSchedulePermissionMode(declared);
}
