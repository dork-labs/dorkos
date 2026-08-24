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
 * ## Two gates, one key
 *
 * Since DOR-1485 this module holds a second question of the same shape: not
 * only "what permission mode does content get?" but "may content arm itself at
 * all?" ({@link resolveFileArmStatus}). Both are answered from the same
 * {@link scheduleContentKey}, in one file, on purpose — the ADR that asked for
 * the arm gate (`260823-200726`) asked for it to live here rather than in a
 * twin module precisely so the two cannot drift into disagreeing about what
 * "the same schedule" means.
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
 * The identity of a piece of approved work: what it does, and when.
 *
 * **One helper, two gates.** The bypass keep-grant below and the arm gate
 * further down both answer "is this the same schedule a person already looked
 * at?", and both must answer it the same way — a schedule whose content changed
 * enough to drop its bypass but not enough to re-park (or the reverse) is a
 * gap. Sharing the key is what makes that impossible rather than merely
 * unlikely (ADR `260823-200726`).
 *
 * Serialized rather than concatenated, for the reason `upsertFromFile`'s
 * refusal key gives: a prompt may contain any text at all, including whatever
 * separator a joined string would pick, so two different schedules could share
 * one key.
 *
 * @param content - The material content of a schedule.
 * @returns A string that is equal exactly when the content is.
 */
export function scheduleContentKey(content: IncomingTaskContent): string {
  return JSON.stringify([content.prompt, content.cron]);
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
 * Together they say the grant belongs to a specific piece of approved work on an
 * un-retired task (`status: 'active'` — a switched-off task keeps its grant, a
 * removed one does not), not to a filename.
 */
function keepsApprovedBypass(
  existing: ApprovedSchedule | undefined,
  incoming: IncomingTaskContent
): boolean {
  if (!existing) return false;
  if (existing.permissionMode !== 'bypassPermissions') return false;
  return holdsGrantFor(existing, incoming);
}

/**
 * Whether a person's approval of THIS row still covers the content arriving
 * from disk — the one condition both content-keyed gates are built on.
 *
 * Two clauses, each closing a proven exploit (the notes on
 * {@link keepsApprovedBypass} spell both out): the row must still be `active`,
 * so a grant cannot outlive the file it was made for and be inherited by
 * whatever writes that path next; and the content must be unchanged, so a
 * grant belongs to a specific piece of reviewed work rather than to a filename.
 */
function holdsGrantFor(existing: ApprovedSchedule, incoming: IncomingTaskContent): boolean {
  if (existing.status !== 'active') return false;
  return (
    scheduleContentKey({ prompt: existing.prompt, cron: existing.cron }) ===
    scheduleContentKey(incoming)
  );
}

/**
 * Why a file-discovered schedule is waiting rather than running — the sentence
 * the approval card shows when nothing more specific is wrong with the file.
 */
const UNAPPROVED_REASON =
  'DorkOS found this schedule in a file on your computer. Nothing runs on a timer ' +
  'until you say so — read what it does below, then approve it or delete it.';

/** What {@link resolveFileArmStatus} decided about a file-discovered schedule. */
export interface FileArmVerdict {
  /** The status to write: `active` only when a person's approval still covers this content. */
  status: 'active' | 'pending_approval';
  /** Why it is parked, for the row's `reason`. `null` when it is not parked. */
  reason: string | null;
}

/**
 * Whether a schedule DorkOS found on disk may arm itself, or has to wait for a
 * person (ADR `260823-200726`).
 *
 * The answer is almost always "wait". Discovery reads every skills root — a
 * `git pull`, a plugin install, or an agent writing a file can all put a cron
 * where DorkOS will see it — so first sighting of new schedule content always
 * parks, `schedule.enabled: true` or not. `enabled` is the author's intent, and
 * intent is not permission.
 *
 * The grant that lifts it is not stored in a table of its own: it IS the row
 * being `active` at content that has not changed since, which is exactly what
 * the bypass keep-grant means by a grant, computed by the same
 * {@link holdsGrantFor}. Three things fall out of that, all of them wanted:
 *
 * - **Approval survives re-syncs.** The operator PATCHes `pending_approval →
 *   active` (that transition IS the approval, `task-write-policy.ts`), and
 *   every later sync of identical content finds an active row at a matching key
 *   and leaves it alone.
 * - **Editing the file re-parks it.** A changed prompt or cron is a different
 *   piece of work, and nobody has read this one.
 * - **Schedules that were already live stay live.** A row an older build wrote
 *   as `active` holds a grant for its own content the moment this ships, so
 *   upgrading does not re-park every schedule an alpha user already has. No
 *   backfill runs, because there is nothing to back-fill — the grant is a
 *   reading of the row, not a second copy of it.
 *
 * A `paused` row does NOT hold a grant, and that is deliberate: `paused` is
 * what DorkOS writes when the file went away, so a returning file at that path
 * is content nobody has approved since it came back.
 *
 * @param existing - The row this file is landing on, or undefined when new.
 * @param incoming - The material content of the file being synced.
 * @param problem - What is wrong with the file, when something is. A schedule
 *   DorkOS cannot fully read never arms, whatever the row says — the grant
 *   cannot cover content that does not mean anything yet.
 * @returns The status to write and, when parked, why.
 */
export function resolveFileArmStatus(
  existing: ApprovedSchedule | undefined,
  incoming: IncomingTaskContent,
  problem?: string | null
): FileArmVerdict {
  if (problem) return { status: 'pending_approval', reason: problem };
  if (existing && holdsGrantFor(existing, incoming)) return { status: 'active', reason: null };
  return { status: 'pending_approval', reason: UNAPPROVED_REASON };
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
