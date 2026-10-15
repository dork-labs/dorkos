/**
 * Where an agent's cheap checks run, in words (spec `heartbeats` §6.3, §14):
 * "Checks run on DorkOS credits. 41 today." or "Checks run on Claude Code.",
 * and what today's checks used. No dollar figure: the server reports none.
 *
 * Pure, so the page and a test say the same thing.
 *
 * @module features/profile/lib/checks-words
 */
import { runtimeDisplayName } from '@dorkos/shared/agent-runtime';
import type { HeartbeatChecks } from '@dorkos/shared/heartbeat-schemas';

/**
 * The page's "where checks run" line, from the live state.
 *
 * @param checks - The agent's checks block.
 */
export function checksSentence(checks: HeartbeatChecks): string {
  if (checks.runsOn === 'credits') return `Checks run on DorkOS credits. ${checks.today} today.`;
  return `Checks run on ${runtimeDisplayName(checks.runtime)}.`;
}

/**
 * What today's checks used, or null when none ran on credits today.
 *
 * @param checks - The agent's checks block.
 */
export function checksUsageWords(checks: HeartbeatChecks): string | null {
  if (checks.today === 0) return null;
  const tokens = `${checks.tokens.toLocaleString('en-US')} tokens`;
  if (checks.runsOn === 'credits') return `${tokens} today.`;
  const count = `${checks.today} ${checks.today === 1 ? 'check' : 'checks'}`;
  return `${count} on credits earlier today, ${tokens}.`;
}
