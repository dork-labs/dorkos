import type { Task } from '@dorkos/shared/types';
import { runsPrograms } from '@dorkos/shared/permission-rules';

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

/** Why approving needs a separate, ticked yes; mirrors the server's check. */
export type ScheduleConfirmReason = 'looser' | 'programs' | 'outsider-rules';

/**
 * The reason a schedule's approval needs the separate confirmation, or `null`
 * when the plain Approve is enough (DOR-3637, Security Shoulds D-1 to D-3): a
 * mode looser than proposed, any rule that starts programs, or rules on work
 * written after reading outside words.
 *
 * @param task - The proposal on the card.
 * @param looserMode - Whether the selected mode is looser than the proposal.
 */
export function scheduleConfirmReason(
  task: Pick<Task, 'requestedAllow' | 'originMarks'>,
  looserMode: boolean
): ScheduleConfirmReason | null {
  const rules = task.requestedAllow ?? [];
  if (looserMode) return 'looser';
  if (rules.some(runsPrograms)) return 'programs';
  if (task.originMarks?.outsider && rules.length > 0) return 'outsider-rules';
  return null;
}

/**
 * The words beside the confirmation tick, at most a short line.
 *
 * @param reason - Why the tick is needed.
 * @param agent - The proposer's name, when known.
 */
export function scheduleConfirmLabel(reason: ScheduleConfirmReason, agent: string | null): string {
  if (reason === 'looser') return `Run it looser than ${agent ?? 'the agent'} asked`;
  if (reason === 'programs') return 'Let it run these programs with nobody there';
  return 'Allow these rules, though it read outside words';
}
