/**
 * One plain-language sentence for a scheduled job a package declares.
 *
 * Two surfaces now disclose the same fact to the same person: the install
 * confirmation dialog, for every package type that has one, and the agent
 * arrival confirm, which is the ONLY approval an agent package ever gets
 * (`useRequestInstall` routes `type: 'agent'` into the creation flow instead of
 * the confirm dialog — DOR-644). They have to say the same thing, so the
 * sentence lives here rather than in whichever feature drew it first.
 *
 * @module entities/marketplace/lib/describe-schedule
 */
import {
  describeSchedulePermissionMode,
  type PreviewSchedule,
  type SchedulePermissionMode,
} from '@dorkos/shared/marketplace-schemas';
import cronstrue from 'cronstrue';

/**
 * Whether a job in each mode can act without a person answering a prompt.
 *
 * A total `Record` rather than a `Set` of the interesting few, for the same
 * reason `SCHEDULE_PERMISSION_MODE_SUMMARY` beside it is one: a mode added to
 * `SchedulePermissionMode` has to be classified deliberately. Omitting it from a
 * `Set<string>` compiles, and silently answers "this one stops to ask" — which
 * is the wrong way for this particular question to fail.
 */
const MODE_RUNS_UNATTENDED: Record<SchedulePermissionMode, boolean> = {
  default: false,
  plan: false,
  acceptEdits: false,
  dontAsk: true,
  bypassPermissions: true,
  auto: true,
};

/**
 * Whether a job in this mode can act without a person answering a prompt.
 *
 * @param mode - The permission mode the job will run under, after the clamp.
 *   An open string, because the server may know a mode this build does not.
 * @returns True when nothing stops to ask. An unrecognised mode answers `false`
 *   — the caller uses this to ADD a warning, and inventing one for a mode whose
 *   powers are unknown would cry wolf on every future release.
 */
export function runsUnattended(mode: string): boolean {
  return MODE_RUNS_UNATTENDED[mode as SchedulePermissionMode] ?? false;
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
 * Say when a scheduled job fires, what has to happen before it first does, and
 * how much it may do on its own.
 *
 * Names the permission mode in plain words rather than echoing the raw id: a
 * person deciding whether to trust a package learns nothing from
 * "bypassPermissions" and everything from "can run any command without a
 * permission prompt". The cron expression gets the same treatment for the same
 * reason — translating one and not the other in a single sentence was the
 * inconsistency this disclosure exists to avoid.
 *
 * The mode passed in is the one the install will ACTUALLY create the job with:
 * `permission-preview.ts` runs every declared mode through
 * `clampSchedulePermissionMode` before it reaches the client, so a package that
 * asked for `bypassPermissions` is described as the `acceptEdits` it gets.
 *
 * ## Why `startsEnabled: true` is not "starts switched on"
 *
 * It reads as one, and this sentence used to say so, which was the alarming
 * half of a claim that is not true on any path a preview can describe. Every
 * schedule a package brings reaches its row through `upsertFromFile` with
 * `source: 'discovery'` — the SKILL.md files it ships, the ones
 * `materialize-schedules.ts` writes for a plugin manifest, and the ones
 * `shape-schedule-service.ts` writes for a Shape manifest alike — and
 * `resolveFileArmStatus` parks EVERY first sighting at `pending_approval`
 * whatever `enabled` says (ADR `260823-200726`). `enabled` is the author's
 * intent, and intent is not permission.
 *
 * So the flag is described as what it is, a request, and the approval that
 * actually stands between the package and its first run is named instead.
 *
 * @param schedule - One scheduled job from a package's permission preview.
 * @returns A sentence naming the cadence, what it waits on, and the powers.
 */
export function describePreviewSchedule(schedule: PreviewSchedule): string {
  const when = schedule.cron ? describeCron(schedule.cron) : 'Runs only when you ask';
  const arrival = schedule.startsEnabled
    ? 'waits for your approval before its first run'
    : 'arrives switched off, and would wait for your approval too';
  return `${when}, ${arrival}. This job ${describeSchedulePermissionMode(schedule.permissionMode)}.`;
}
