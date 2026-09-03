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
 * The modes that let a job act without stopping to ask. A job in one of these
 * that also starts switched on is the combination worth flagging.
 */
const UNATTENDED_MODES: ReadonlySet<string> = new Set<SchedulePermissionMode>([
  'bypassPermissions',
  'dontAsk',
  'auto',
]);

/**
 * Whether a job in this mode can act without a person answering a prompt.
 *
 * @param mode - The permission mode the job will run under, after the clamp.
 * @returns True when nothing stops to ask.
 */
export function runsUnattended(mode: string): boolean {
  return UNATTENDED_MODES.has(mode);
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
 * Say when a scheduled job fires, whether it arrives switched on, and how much
 * it may do on its own.
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
 * @param schedule - One scheduled job from a package's permission preview.
 * @returns A sentence naming the cadence, the starting state and the powers.
 */
export function describePreviewSchedule(schedule: PreviewSchedule): string {
  const when = schedule.cron ? describeCron(schedule.cron) : 'Runs only when you ask';
  const state = schedule.startsEnabled ? 'starts switched on' : 'starts switched off';
  return `${when}, ${state}. This job ${describeSchedulePermissionMode(schedule.permissionMode)}.`;
}
