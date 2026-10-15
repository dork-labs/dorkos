/**
 * The Heartbeat page's measures in words (spec `heartbeats` §13, §14): "92%",
 * "11 of 12", "Target 95% or more". A target is shown beside a number, never as
 * a grade: nothing here says good or bad.
 *
 * Pure, so the page and a test say the same thing.
 *
 * @module features/profile/lib/measures-words
 */
import type { HeartbeatMeasures, MeasureRate } from '@dorkos/shared/heartbeat-schemas';

/**
 * A share as a whole percent, or null when there was nothing to count.
 *
 * @param rate - The share.
 */
export function percentWords(rate: MeasureRate): string | null {
  return rate.value === null ? null : `${Math.round(rate.value * 100)}%`;
}

/**
 * "11 of 12".
 *
 * @param rate - The share.
 */
export function partOfWords(rate: MeasureRate): string {
  return `${rate.part} of ${rate.whole}`;
}

/**
 * "Target 95% or more".
 *
 * @param target - The target as the server words it.
 */
export function targetWords(target: string): string {
  return `Target ${target.charAt(0).toLowerCase()}${target.slice(1)}`;
}

/**
 * Interruptions per useful outcome to one decimal. With messages sent and
 * nothing useful to divide by, the counts are the value ("5 sent, none useful");
 * with neither, null.
 *
 * @param interruptions - The agent's interruptions measure.
 */
export function interruptionsWords(
  interruptions: HeartbeatMeasures['interruptions']
): string | null {
  if (interruptions.value !== null) return interruptions.value.toFixed(1);
  return interruptions.messages > 0 ? `${interruptions.messages} sent, none useful` : null;
}

/**
 * "No checks in the last 7 days."
 *
 * @param measures - The agent's measures.
 */
export function noChecksWords(measures: HeartbeatMeasures): string {
  return measures.windowDays === 1
    ? 'No checks in the last day.'
    : `No checks in the last ${measures.windowDays} days.`;
}

/**
 * "Last 7 days."
 *
 * @param measures - The agent's measures.
 */
export function windowWords(measures: HeartbeatMeasures): string {
  return measures.windowDays === 1 ? 'Last day.' : `Last ${measures.windowDays} days.`;
}

/**
 * A count with its noun, "1 pause" or "3 pauses".
 *
 * @param n - The count.
 * @param one - The noun for one.
 * @param many - The noun for more.
 */
function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * What made up the mutes and pauses, or null when there were none.
 *
 * @param measures - The agent's measures.
 */
export function mutesDetailWords(measures: HeartbeatMeasures): string | null {
  const { pauses, wakeOff, mutes } = measures.mutesAndPauses;
  const parts = [
    pauses > 0 ? count(pauses, 'pause', 'pauses') : null,
    wakeOff > 0 ? count(wakeOff, 'switch-off', 'switch-offs') : null,
    mutes > 0 ? count(mutes, 'mute', 'mutes') : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(', ');
}

/**
 * The supporting measures, one short line each, in the order canon §6.2 lists
 * them. Lines with nothing to say are left out.
 *
 * @param measures - The agent's measures.
 */
export function supportingLines(measures: HeartbeatMeasures): string[] {
  const s = measures.supporting;
  const tokens = (n: number) => Math.round(n).toLocaleString('en-US');
  const quiet = percentWords(s.quietBeats);
  const onTime = percentWords(s.commitmentsOnTime);
  const lines = [
    quiet ? `Quiet checks: ${quiet}, ${partOfWords(s.quietBeats)}.` : null,
    onTime
      ? `Promises kept on time: ${onTime}, ${partOfWords(s.commitmentsOnTime)}.`
      : 'No promises came due.',
    s.noEndBeat > 0 ? `Ended without a summary: ${s.noEndBeat}.` : null,
    s.triage.checks > 0
      ? `Cheap checks: ${s.triage.checks}, ${tokens(s.triage.tokens)} tokens.`
      : null,
    s.turns.count > 0
      ? s.turns.tokensPerTurn === null
        ? `Full runs: ${s.turns.count}.`
        : `Full runs: ${s.turns.count}, about ${tokens(s.turns.tokensPerTurn)} tokens each.`
      : null,
    s.bypass > 0 ? `Posted outside a check’s summary: ${s.bypass}.` : null,
    s.held > 0 ? `Held for people’s hours: ${s.held}.` : null,
  ];
  return lines.filter((line): line is string => line !== null);
}
