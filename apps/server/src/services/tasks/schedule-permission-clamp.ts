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
import { EffortLevelSchema, type PermissionMode } from '@dorkos/shared/schemas';

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
export interface ApprovedSchedule extends ScheduleSettings {
  /** The mode the row holds. */
  permissionMode: PermissionMode;
  /** The row's lifecycle status. Only `active` is a live approval. */
  status: string;
  /** The prompt text the row holds — the work a person actually approved. */
  prompt: string;
  /** The row's cron, `''` for a task with no timer. */
  cron: string;
  /** The timezone the row's cron runs in (DOR-2307). */
  timezone: string;
  /**
   * The content key a person approved, or `null` when nobody has. The arm
   * grant — see {@link holdsGrantFor}.
   */
  approvedContentKey: string | null;
}

/**
 * The settings of a schedule that are part of what a person approves
 * (DOR-2323), beside its prompt and timing.
 *
 * Each one changes what an unattended run does, what it may cost, or what it
 * carries with it, so a person who approved one value did not approve another:
 *
 * - `name` is what the run is told it is doing (`Job: <name>`, `task-append.ts`);
 * - `runtime`, `model` and `effort` decide which agent does the work, how
 *   capable it is, and what it costs;
 * - `maxRuntime` is the ceiling on how long, and so how much, one unattended
 *   run may spend;
 * - `sticky` decides whether every run resumes one session and carries
 *   everything earlier runs saw, which changes what a run knows and can repeat.
 *
 * `enabled` and `permissionMode` are deliberately not here: the switch is the
 * person's own control, and the permission level has its own grant rule.
 */
export interface ScheduleSettings {
  /** The schedule's name (its folder name). */
  name: string;
  /** The runtime its runs execute on, `null` to follow the agent. */
  runtime: string | null;
  /** The model, in that runtime's ids, `null` to follow the agent. */
  model: string | null;
  /** The reasoning-effort rung, `null` to follow the agent. */
  effort: string | null;
  /** The longest one run may take, in milliseconds, `null` for the default. */
  maxRuntime: number | null;
  /** Whether every run resumes one persistent session. */
  sticky: boolean;
}

/**
 * The approved work a task describes: its prompt, its settings, and the timing
 * the API reports (which is the timing that runs).
 *
 * @param task - A task as the store hands it out.
 */
export function taskWorkOf(
  task: ScheduleSettings & { prompt: string; cron: string | null; timezone: string | null }
): IncomingTaskContent {
  return {
    ...scheduleSettingsOf(task),
    prompt: task.prompt,
    cron: task.cron ?? '',
    timezone: task.timezone ?? 'UTC',
  };
}

/** The {@link ScheduleSettings} of a row or task, and nothing else of it. */
export function scheduleSettingsOf(source: ScheduleSettings): ScheduleSettings {
  return {
    name: source.name,
    runtime: source.runtime ?? null,
    model: source.model ?? null,
    // Read the way the task reports it (`task-row-mappers.ts`): an effort the
    // schema does not know is no effort, so the key of a row and the key of
    // the task it maps to always agree.
    effort: EffortLevelSchema.safeParse(source.effort).success ? source.effort : null,
    maxRuntime: source.maxRuntime ?? null,
    // Absent means off, as it does to the store and the runner.
    sticky: source.sticky === true,
  };
}

/** The material content of the SKILL.md being synced into that row. */
export interface IncomingTaskContent extends ScheduleSettings {
  /** The file's body, which becomes the row's prompt. */
  prompt: string;
  /** The file's `cron:` frontmatter, `''` when absent. */
  cron: string;
  /**
   * The timezone that cron runs in. Part of the approved work since DOR-2307:
   * the same cron in another zone runs at another time — up to a day away —
   * so a person who approved one did not approve the other.
   */
  timezone: string;
}

/**
 * The identity of a piece of approved work: what it does, when, and how — the
 * prompt, the cron, the timezone the cron is read in (DOR-2307), and the
 * {@link ScheduleSettings} (DOR-2323).
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
  const settings = scheduleSettingsOf(content);
  return JSON.stringify([
    content.prompt,
    content.cron,
    content.timezone,
    settings.name,
    settings.runtime,
    settings.model,
    settings.effort,
    settings.maxRuntime,
    settings.sticky,
  ]);
}

/** How many parts a key this build writes has ({@link scheduleContentKey}). */
const CONTENT_KEY_PARTS = 9;

/**
 * The approved work a key records, read back, or `null` for a key this build
 * did not write in the current format.
 *
 * Used to say what changed when a schedule waits again (`approvalChanges`), so
 * it is strict: anything else reads as nothing.
 *
 * @param key - A stored content key.
 */
export function parseContentKey(key: string): IncomingTaskContent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(key);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== CONTENT_KEY_PARTS) return null;
  const [prompt, cron, timezone, name, runtime, model, effort, maxRuntime, sticky] = parsed;
  const text = (v: unknown) => typeof v === 'string';
  const nullableText = (v: unknown) => v === null || typeof v === 'string';
  if (![prompt, cron, timezone, name].every(text)) return null;
  if (![runtime, model, effort].every(nullableText)) return null;
  if (!(maxRuntime === null || typeof maxRuntime === 'number')) return null;
  if (typeof sticky !== 'boolean') return null;
  return { prompt, cron, timezone, name, runtime, model, effort, maxRuntime, sticky };
}

/**
 * Move a grant recorded in an older key format onto today's key, or return
 * `null` when it needs no moving.
 *
 * Two older formats exist. `[prompt, cron]` (before DOR-2307) never said which
 * timezone was approved; `[prompt, cron, timezone]` (before DOR-2323) never
 * said which {@link ScheduleSettings}. Each was only ever checked against the
 * values the row runs with now, since a change to any of them never withdrew
 * it. So the grant is extended with exactly those values: what was running
 * approved keeps running approved, and nothing else is approved by the
 * upgrade. A legacy key that no longer matches the row's prompt and timing
 * still does not match after it, so a grant that was about to be withdrawn is
 * withdrawn just the same.
 *
 * @param key - The stored grant.
 * @param current - The timezone and settings the row runs with now.
 * @returns The upgraded key, or `null` for a key that is already current or
 *   is not one this build wrote.
 */
export function upgradeLegacyContentKey(
  key: string,
  current: { timezone: string } & ScheduleSettings
): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(key);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || (parsed.length !== 2 && parsed.length !== 3)) return null;
  if (!parsed.every((part) => typeof part === 'string')) return null;
  const [prompt, cron, timezone = current.timezone] = parsed as string[];
  return scheduleContentKey({ ...scheduleSettingsOf(current), prompt, cron, timezone });
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
 * - **Unchanged content.** The row's prompt, cron and timezone are overwritten
 *   from the file on every sync. Without this, an attacker keeps `permissions:
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
  if (existing.status !== 'active') return false;
  return scheduleContentKey(existing) === scheduleContentKey(incoming);
}

/**
 * Whether a person's approval covers the content arriving from disk.
 *
 * One comparison, and deliberately not a clever one: the key a person's approval
 * was recorded under, against the key of what is on disk now. It does not
 * consult `status`, and that is the entire point of the DOR-1485 review's second
 * round.
 *
 * The gate used to INFER the grant from the row's status — active (and later,
 * paused) meant approved. Every writer that touched `status` for its own reasons
 * therefore minted consent as a side effect, and two of them did:
 * `markRemovedByFilePath` pausing a row whose file vanished, and
 * `disableTasksByAgentId` pausing every row of an unregistered agent. Both let a
 * never-approved schedule arm itself — delete the file and put it back, or
 * unregister the agent and register it again. Guarding each writer as it was
 * found is a losing game; there was always going to be a third.
 *
 * A stored key cannot be produced by writing a status, so the whole class is
 * closed rather than patched. It also makes the two remaining questions
 * independent and readable on their own: `status` says what the schedule is
 * doing, `approvedContentKey` says what a person agreed to.
 *
 * @param existing - The row the file is landing on.
 * @param incoming - The content arriving from disk.
 */
function holdsGrantFor(existing: ApprovedSchedule, incoming: IncomingTaskContent): boolean {
  return (
    existing.approvedContentKey !== null &&
    existing.approvedContentKey === scheduleContentKey(incoming)
  );
}

/**
 * Why a file-discovered schedule is waiting rather than running — the sentence
 * the approval card shows when nothing more specific is wrong with the file.
 */
const UNAPPROVED_REASON =
  'DorkOS found this schedule in a file on your computer. Nothing runs on a timer ' +
  'until you say so — read what it does below, then approve it or delete it.';

/**
 * Why a schedule that WAS approved is waiting again.
 *
 * A different sentence from {@link UNAPPROVED_REASON} because it is a different
 * situation, and the first one would be a lie on a schedule the person made
 * themselves months ago: nothing was "found", something changed.
 */
export const CHANGED_REASON =
  'This schedule’s file changed since it was last approved, so it is waiting for you again. ' +
  'Read what it does now, then approve it or delete it.';

/**
 * Why an approved schedule that follows its agent is waiting again: the agent's
 * runtime, model or effort was changed outside DorkOS (DOR-2337).
 *
 * Fixed, like every park sentence a sync keeps, so the next sync recognises it
 * rather than rewriting it (`file-sync-gates.ts`). What changed is on the card
 * beside it, old → new.
 */
export const AGENT_DEFAULTS_CHANGED_OUTSIDE_REASON =
  'This schedule runs on its agent’s own runtime, model or effort, and those were changed ' +
  'outside DorkOS, so it is waiting for you again. Check what changed, then approve it or ' +
  'change the agent back.';

/** One of an agent's execution defaults a schedule can follow. */
export type FollowedAgentField = 'runtime' | 'model' | 'effort';

/**
 * A change to one of an agent's execution defaults, as a followed schedule
 * records it: `from` is the value when the change was first seen, `to` the
 * value now.
 */
export interface FollowedAgentChange {
  field: FollowedAgentField;
  from: string | null;
  to: string | null;
}

/** The followed fields, in the order a card lists them. */
const FOLLOWED_AGENT_FIELDS: readonly FollowedAgentField[] = ['runtime', 'model', 'effort'];

/**
 * Read `pulse_schedules.followed_agent_changes` back, strictly: anything this
 * build did not write reads as no changes at all.
 *
 * @param stored - The column's value.
 */
export function parseFollowedAgentChanges(stored: string | null): FollowedAgentChange[] {
  if (stored === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const nullableText = (v: unknown): v is string | null => v === null || typeof v === 'string';
  return parsed.filter(
    (entry): entry is FollowedAgentChange =>
      typeof entry === 'object' &&
      entry !== null &&
      FOLLOWED_AGENT_FIELDS.includes((entry as FollowedAgentChange).field) &&
      nullableText((entry as FollowedAgentChange).from) &&
      nullableText((entry as FollowedAgentChange).to)
  );
}

/**
 * Fold a newly seen change into what a schedule already records: the first
 * `from` is kept, the latest `to` wins, and a field that is back where it
 * started drops out. Listed in card order.
 *
 * @param recorded - What the schedule records already.
 * @param seen - The change just seen.
 */
export function mergeFollowedAgentChanges(
  recorded: readonly FollowedAgentChange[],
  seen: readonly FollowedAgentChange[]
): FollowedAgentChange[] {
  const byField = new Map(recorded.map((c) => [c.field, c]));
  for (const change of seen) {
    const earlier = byField.get(change.field);
    byField.set(change.field, {
      field: change.field,
      from: earlier ? earlier.from : change.from,
      to: change.to,
    });
  }
  return FOLLOWED_AGENT_FIELDS.flatMap((field) => {
    const change = byField.get(field);
    return change && change.from !== change.to ? [change] : [];
  });
}

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
 * - **Editing the file re-parks it.** A changed prompt, cron or timezone is a
 *   different piece of work, and nobody has read this one.
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
  return {
    status: 'pending_approval',
    // A row that has been approved before and drifted is a different story from
    // one nobody has ever seen, and telling a person their own schedule was
    // "found in a file" would be a lie.
    reason: existing?.approvedContentKey ? CHANGED_REASON : UNAPPROVED_REASON,
  };
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

/**
 * Whether a scheduled task genuinely needs the operator's attention right now
 * (DOR-2059) — the third question this module answers, alongside what mode a
 * schedule gets and whether it may arm itself.
 *
 * A package can ship a schedule switched off (`schedule.enabled: false`),
 * documented as opt-in. {@link resolveFileArmStatus} still parks it at
 * `pending_approval` on first sighting — the arm gate applies to every file
 * discovery, because a package can change its mind about what the schedule
 * does before anyone approves it — but a schedule that is not even asking to
 * run has nothing for a person to decide about *right now*. So the row stays
 * `pending_approval`, every write-time invariant that status protects is
 * untouched (`status` stays operator-only, an agent flipping `enabled` still
 * leaves the scheduler ineligible), and this is the one place that decides
 * whether the condition should reach the operator at all — read by the
 * boot-time re-arm in `index.ts`.
 *
 * **Keyed on `origin`, not on `enabled`, and that is load-bearing.** `enabled`
 * is agent-writable (`task-write-policy.ts`) by design — flipping it on an
 * already-APPROVED schedule is a reversible nuisance, not an escalation. But
 * the first cut of this fix read `enabled` alone, which let an agent hide its
 * OWN proposal: `tasks_create` parks a schedule and raises `schedule.parked`
 * with `enabled: true`, and a follow-up `tasks_update({enabled: false})` — an
 * ordinary agent-writable field, `status` untouched — quieted every consumer
 * of this decision at once, with the escalation ladder still armed and
 * nothing anywhere explaining why (adversarial review, DOR-2059). `origin` is
 * `'file'` ONLY for a row `upsertFromFile` wrote with `source: 'discovery'`
 * (`task-store.ts`) — never for a row `tasks_create` or `POST /api/tasks`
 * made — and `TaskStore.updateTask` never sets it. An agent cannot manufacture
 * the one condition that quiets a schedule, whatever it does to `enabled`.
 *
 * The client draws the identical line for its approval card and OS-level
 * knock (`entities/tasks/lib/is-schedule-awaiting-approval.ts`, which this
 * mirrors).
 *
 * @param task - The status, switch, and origin a schedule's row carries.
 * @returns True for a schedule a person still has to decide about.
 */
export function needsScheduleApprovalAttention(task: {
  status: string;
  enabled: boolean;
  origin: string | null;
}): boolean {
  return task.status === 'pending_approval' && (task.origin !== 'file' || task.enabled);
}
