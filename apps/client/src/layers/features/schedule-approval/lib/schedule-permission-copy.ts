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
