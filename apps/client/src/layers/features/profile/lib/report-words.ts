/**
 * An agent's next report, in words (spec `heartbeats` §3.4, §9.3, §14): who
 * reads it, how often, and how much it covers so far.
 *
 * Pure, so the page and a test say the same thing.
 *
 * @module features/profile/lib/report-words
 */
import type { HeartbeatReportStatus } from '@dorkos/shared/heartbeat-schemas';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { heldRecipientNames } from './heartbeat-words';

/**
 * The page's "Next report" line: "Reports to you each workday. 3 items so far."
 *
 * @param report - The agent's next report.
 * @param readerName - Who reads it, as {@link reportReaderNames} names them.
 */
export function reportSentence(report: HeartbeatReportStatus, readerName: string): string {
  if (report.cadence === 'off') return 'Sends no reports.';
  const when = report.cadence === 'weekly' ? 'each week' : 'each workday';
  const sofar =
    report.items === 0
      ? 'Nothing to report yet.'
      : `${report.items} ${report.items === 1 ? 'item' : 'items'} so far.`;
  return `Reports to ${readerName} ${when}. ${sofar}`;
}

/**
 * A lookup from a report's reader to a name: an agent by its roster name, a
 * person the way held messages name them ("you" for the person reading).
 *
 * @param roster - The team roster.
 * @param agent - The agent whose report it is, to find its owner when the
 *   roster does not mark one as you.
 */
export function reportReaderNames(
  roster: readonly TeamMember[],
  agent?: TeamMember
): (accountId: string) => string {
  const personName = heldRecipientNames(roster, agent);
  return (accountId) =>
    roster.find((member) => member.agent?.manifestId === accountId)?.displayName ??
    personName(accountId);
}
