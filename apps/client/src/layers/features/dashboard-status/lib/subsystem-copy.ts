/**
 * Outcome-language copy for the dashboard system-status cards. The primary line
 * on each card states what it means for the operator ("Nothing scheduled yet",
 * "Connected to Telegram") rather than a raw metric ("0 schedules", "1
 * adapter"). Pure and plain, following writing-for-humans.
 *
 * @module features/dashboard-status/lib/subsystem-copy
 */

/**
 * Title-case an integration/adapter type for display, e.g. `telegram` becomes
 * "Telegram" and `claude-code` becomes "Claude Code".
 *
 * @param type - The adapter type identifier.
 */
export function formatIntegrationName(type: string): string {
  return type
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Tasks outcome: whether anything is scheduled.
 *
 * @param scheduleCount - Number of active schedules.
 */
export function tasksOutcome(scheduleCount: number): string {
  if (scheduleCount === 0) return 'Nothing scheduled yet';
  return `${scheduleCount} scheduled`;
}

/**
 * Relay outcome: which integrations are active.
 *
 * @param connectedTypes - Adapter types of active integrations.
 */
export function relayOutcome(connectedTypes: string[]): string {
  if (connectedTypes.length === 0) return 'No integrations yet';
  return `Connected to ${connectedTypes.map(formatIntegrationName).join(', ')}`;
}

/**
 * Mesh outcome: how many agents are ready.
 *
 * @param totalAgents - Total registered agents.
 */
export function meshOutcome(totalAgents: number): string {
  const noun = totalAgents === 1 ? 'agent' : 'agents';
  return `${totalAgents} ${noun} ready`;
}

/**
 * Activity outcome: how busy the week has been.
 *
 * @param runsThisWeek - Session runs in the last 7 days.
 */
export function activityOutcome(runsThisWeek: number): string {
  if (runsThisWeek === 0) return 'Quiet this week';
  const noun = runsThisWeek === 1 ? 'run' : 'runs';
  return `${runsThisWeek} ${noun} this week`;
}
