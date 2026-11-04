/** The saved mode and its unattended limits, for a new schedule's server notice. */
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';

export interface ScheduleExecutionCopy {
  modeLabel: string;
  /** What the asking Accept edits mode permits without somebody answering. */
  modeSummary?: string;
  limitation: string;
  /** Approval requests are refused because timer runs have nobody to answer. */
  refusesUnansweredApprovals: boolean;
}

const FALLBACK_LABELS: Readonly<Record<string, string>> = {
  default: 'Default',
  plan: 'Plan',
  dontAsk: 'Never ask',
  acceptEdits: 'Accept edits',
  auto: 'Auto',
  bypassPermissions: 'Bypass permissions',
};

/**
 * Use the resolved runtime's label and semantics, never assume a mode id means
 * the same thing on Codex and Claude Code. No remedy here grants more power.
 */
export function scheduleExecutionCopy(
  mode: string,
  capabilities?: RuntimeCapabilities
): ScheduleExecutionCopy {
  const descriptor = capabilities?.permissionModes.values.find((value) => value.id === mode);
  const modeLabel =
    descriptor?.label ??
    (Object.hasOwn(FALLBACK_LABELS, mode) ? FALLBACK_LABELS[mode]! : 'Unknown mode');
  let limitation: string;
  if (mode === 'dontAsk') {
    limitation = 'Only allowed commands run. Others are refused without asking.';
  } else if (mode === 'plan' || descriptor?.reach === 'read') {
    limitation = 'Reads and plans only. Commands that change things are refused.';
  } else if (descriptor?.asks === 'never' || mode === 'bypassPermissions') {
    limitation =
      descriptor?.reach === 'everything' || mode === 'bypassPermissions'
        ? 'Commands run without waiting for approval.'
        : 'Commands run within its limits. It cannot stop to ask for approval.';
  } else if (descriptor || Object.hasOwn(FALLBACK_LABELS, mode)) {
    limitation =
      'Some commands run on their own. Others are refused, because nobody’s there to approve them.';
  } else {
    limitation = 'This mode’s command permissions could not be checked.';
  }
  const refusesUnansweredApprovals =
    mode !== 'plan' &&
    mode !== 'dontAsk' &&
    mode !== 'bypassPermissions' &&
    descriptor?.reach !== 'read' &&
    descriptor?.asks !== 'never' &&
    (descriptor !== undefined || Object.hasOwn(FALLBACK_LABELS, mode));
  return {
    modeLabel,
    ...(mode === 'acceptEdits' && refusesUnansweredApprovals
      ? { modeSummary: 'Edits files without asking.' }
      : {}),
    limitation,
    refusesUnansweredApprovals,
  };
}
