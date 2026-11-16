import type { Task } from '@dorkos/shared/types';
import {
  readsBroadly,
  runsPrograms,
  writesOutsideTaskFolder,
} from '@dorkos/shared/permission-rules';

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
  /** A Read rule is a pattern over an absolute or home path, or outsider work reads files. */
  reads: boolean;
  /** Outsider-written work carries rules none of the parts above names. */
  otherRules: boolean;
}

/**
 * What a schedule's approval needs the separate confirmation for, or `null`
 * when the plain Approve is enough (DOR-3637, Security Shoulds D-1 to D-3): a
 * mode looser than the one-click baseline; a rule that starts programs, changes
 * files outside the task's folder or reads by a broad pattern; and every rule
 * on work written after reading outside words, each named in the tick.
 *
 * @param task - The proposal on the card.
 * @param looserMode - Whether the selected mode is looser than the baseline.
 */
export function scheduleConfirmReason(
  task: Pick<Task, 'requestedAllow' | 'originMarks'>,
  looserMode: boolean
): ScheduleConfirmReason | null {
  const rules = task.requestedAllow ?? [];
  const outsider = Boolean(task.originMarks?.outsider);
  const reads = (rule: string) => /^Read\(/.test(rule.trim());
  const reason: ScheduleConfirmReason = {
    mode: looserMode,
    programs: rules.some(runsPrograms),
    writes: rules.some(writesOutsideTaskFolder),
    reads: rules.some((rule) => readsBroadly(rule) || (outsider && reads(rule))),
    otherRules:
      outsider &&
      rules.some((rule) => !runsPrograms(rule) && !writesOutsideTaskFolder(rule) && !reads(rule)),
  };
  return Object.values(reason).some(Boolean) ? reason : null;
}

/**
 * The words beside the confirmation tick: everything it allows, at most 15
 * words. "when you’re not there" is added while the line stays within that.
 *
 * @param reason - What the tick covers.
 * @param modeLabel - The selected mode in the card's words ("Full access"),
 *   named instead of "a looser mode" when the tick covers it.
 */
export function scheduleConfirmLabel(reason: ScheduleConfirmReason, modeLabel?: string): string {
  const named = [reason.mode, reason.programs, reason.writes, reason.reads].some(Boolean);
  const parts = [
    reason.mode && (modeLabel ?? 'a looser mode'),
    reason.programs && 'these programs',
    reason.writes && 'edits outside its folder',
    reason.reads && 'these reads',
    reason.otherRules && (named ? 'other rules' : 'these rules'),
  ].filter((part): part is string => typeof part === 'string');
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0];
  const label = `Allow ${list}`;
  const unattended = `${label} when you’re not there`;
  return unattended.split(/\s+/).length <= 15 ? unattended : label;
}
