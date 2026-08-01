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
 * The parts of an existing schedule row that decide whether a file may keep the
 * bypass that row already carries. Structural on purpose — the store passes the
 * four columns it read, and nothing here needs a Drizzle type.
 */
export interface ApprovedSchedule {
  /** The mode the row holds. */
  permissionMode: PermissionMode;
  /** The row's lifecycle status. Only `active` is a live approval. */
  status: string;
  /** The prompt text the row holds — the work a person actually approved. */
  prompt: string;
  /** The row's cron, `''` for a task with no timer. */
  cron: string;
}

/** The material content of the SKILL.md being synced into that row. */
export interface IncomingTaskContent {
  /** The file's body, which becomes the row's prompt. */
  prompt: string;
  /** The file's `cron:` frontmatter, `''` when absent. */
  cron: string;
}

/**
 * Whether a file's `bypassPermissions` is the SAME grant a person already made,
 * rather than a new one arriving from disk.
 *
 * Both conditions are load-bearing, and each closes a proven exploit:
 *
 * - **Active.** `markRemovedByFilePath` only PAUSES a task whose file vanished,
 *   so the row and its grant outlive the file. Without this, anything that can
 *   later write that path resurrects the task — `upsertFromFile` un-pauses a
 *   returning file by design — and inherits the bypass.
 * - **Unchanged content.** The row's prompt and cron are overwritten from the
 *   file on every sync. Without this, an attacker keeps `permissions:
 *   bypassPermissions` in the frontmatter and swaps the body: same path, same
 *   grant, entirely different instructions, running unattended at the next tick.
 *
 * Together they say the grant belongs to a specific piece of approved work on a
 * live task, not to a filename.
 */
function keepsApprovedBypass(
  existing: ApprovedSchedule | undefined,
  incoming: IncomingTaskContent
): boolean {
  if (!existing) return false;
  if (existing.permissionMode !== 'bypassPermissions') return false;
  if (existing.status !== 'active') return false;
  return existing.prompt === incoming.prompt && existing.cron === incoming.cron;
}

/**
 * Decide the permission mode a task's SKILL.md frontmatter actually gets, given
 * the schedule row it is landing on.
 *
 * A file on disk is nobody's approval. Anything that can write a project file
 * can set `permissions: bypassPermissions` — and that bar is LOWER than it
 * sounds: an agent already running in `acceptEdits` writes that file with no
 * prompt and no shell. So a file may never INTRODUCE a bypass; the clamp above
 * applies exactly as it does to a Shape manifest.
 *
 * The one exception is a bypass a person already granted on THIS task, which
 * only a caller that cleared the agent bar can have put in the row
 * (`task-write-policy.ts`). The cockpit writes that decision straight back into
 * the file, and the watcher and the five-minute reconciler re-read it within
 * seconds; clamping on the way back in would undo a person's choice moments
 * after they made it. {@link keepsApprovedBypass} is what keeps that exception
 * from widening into "whatever content lives at this path inherits the grant".
 *
 * A file can still LOWER a mode: in the safe direction the file stays the source
 * of truth.
 *
 * One ordering note, because it is a real dependency and not an accident:
 * `PATCH /api/tasks/:id` writes the file and then the row, so a watcher event
 * landing in between would see the new file against the old row, find the
 * content changed, and clamp. That window is the gap between two adjacent
 * statements and chokidar's debounce is orders of magnitude longer — and the
 * outcome if it ever lost that race is a task dropped to `acceptEdits`, which is
 * the safe direction to fail in.
 *
 * @param declared - The mode the SKILL.md frontmatter asked for.
 * @param existing - The schedule row this file is landing on, or undefined when
 *   it is landing as a new task.
 * @param incoming - The material content of the file being synced.
 * @returns The mode to write, and whether the file asked for more than it got.
 */
export function resolveFilePermissionMode(
  declared: PermissionMode,
  existing: ApprovedSchedule | undefined,
  incoming: IncomingTaskContent
): { mode: PermissionMode; clamped: boolean } {
  if (declared === 'bypassPermissions' && keepsApprovedBypass(existing, incoming)) {
    return { mode: 'bypassPermissions', clamped: false };
  }
  return clampSchedulePermissionMode(declared);
}
