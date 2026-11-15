import type { Task } from '@dorkos/shared/types';
import { runsPrograms, writesOutsideTaskFolder } from '@dorkos/shared/permission-rules';

/** Schedule-specific consequence copy for a run with nobody present. */
const SCHEDULE_PERMISSION_EXPLANATIONS: Readonly<Record<string, string>> = {
  default: 'Reads only. Edits and commands are refused.',
  dontAsk: 'Runs only commands you allowed. Everything else is refused.',
  acceptEdits: 'Edits files on its own. Commands nobody allowed are refused.',
  bypassPermissions: 'Does anything, with no checks.',
  plan: 'Plans only. Changes nothing.',
  auto: 'Works within its approved limits. Everything else is refused.',
};

/** Use labels that describe unattended behavior while preserving runtime-specific write modes. */
export function schedulePermissionLabel(mode: string, runtimeLabel: string): string {
  if (mode === 'dontAsk') return 'Allowed commands';
  if (mode === 'default') return 'Read only';
  if (mode === 'bypassPermissions') return 'Full access';
  if (mode === 'plan') return 'Plan only';
  if (mode === 'auto') return 'Automatic';
  return runtimeLabel;
}

/** Explain one scheduled-run permission mode without interactive-session wording. */
export function schedulePermissionExplanation(mode: string): string {
  return SCHEDULE_PERMISSION_EXPLANATIONS[mode] ?? 'Uses this mode’s scheduled-run limits.';
}

/**
 * What the separate, ticked yes covers; mirrors the server's check
 * (`routes/task-approval-request.ts`). Each part is said in the tick's words.
 */
export interface ScheduleConfirmReason {
  /** The selected mode is looser than the one-click baseline. */
  mode: boolean;
  /** A rule starts programs. */
  programs: boolean;
  /** A rule may change files outside the task's folder. */
  writes: boolean;
  /** Outsider-written work carries rules, none of them covered above. */
  outsiderRules: boolean;
}

/**
 * What a schedule's approval needs the separate confirmation for, or `null`
 * when the plain Approve is enough (DOR-3637, Security Shoulds D-1 to D-3): a
 * mode looser than the one-click baseline, any rule that starts programs or
 * changes files outside the task's folder, or rules on work written after
 * reading outside words.
 *
 * @param task - The proposal on the card.
 * @param looserMode - Whether the selected mode is looser than the baseline.
 */
export function scheduleConfirmReason(
  task: Pick<Task, 'requestedAllow' | 'originMarks'>,
  looserMode: boolean
): ScheduleConfirmReason | null {
  const rules = task.requestedAllow ?? [];
  const programs = rules.some(runsPrograms);
  const writes = rules.some(writesOutsideTaskFolder);
  const outsiderRules = Boolean(task.originMarks?.outsider) && rules.length > 0;
  const reason = {
    mode: looserMode,
    programs,
    writes,
    outsiderRules: outsiderRules && !programs && !writes,
  };
  return Object.values(reason).some(Boolean) ? reason : null;
}

/**
 * The words beside the confirmation tick: what it allows, at most 15 words.
 *
 * @param reason - What the tick covers.
 */
export function scheduleConfirmLabel(reason: ScheduleConfirmReason): string {
  const parts = [
    reason.mode && 'a looser mode',
    reason.programs && 'these programs',
    reason.writes && 'file changes outside its folder',
    reason.outsiderRules && 'these rules',
  ].filter((part): part is string => typeof part === 'string');
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0];
  return `Allow ${list} with nobody there`;
}
