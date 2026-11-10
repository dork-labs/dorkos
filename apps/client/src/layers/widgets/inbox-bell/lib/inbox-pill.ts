import { listWaitingKinds } from '@/layers/shared/lib';
import { BROWSER_HANDOFF_WAITING } from '@/layers/entities/attention';
import type { InboxBellGlyph } from '../ui/InboxBellPill';

/**
 * The pill's accessible name while something is waiting.
 *
 * Carries the count and what clicking does, because the visible label is trimmed
 * to an icon and a number on narrow screens.
 *
 * **It does not call everything by the same noun.** Three different objects are
 * counted here — a capability approval, a parked schedule, and a prompt an agent
 * is parked on — and none stands in for another: a schedule is not a question,
 * and neither is a permission request. When the queue is only one kind the
 * sentence says so in that kind's own words; when it is mixed it names every
 * kind that is actually present rather than reaching for a word that fits none
 * of them.
 *
 * @param approvals - Capability approvals waiting.
 * @param schedules - Parked schedules waiting.
 * @param asks - Prompts agents are parked on.
 * @param extensions - Installed extensions waiting to be turned on.
 * @param decisions - Decisions extensions are asking a person about.
 * @param paused - Connections paused until their owner confirms what they send.
 * @internal Exported for testing only.
 */
export function waitingLabel(
  approvals: number,
  schedules: number,
  asks: number,
  extensions: number,
  decisions: number,
  paused = 0
): string {
  if (paused > 0) {
    const verb =
      approvals + schedules + asks + extensions + decisions + paused === 1 ? 'is' : 'are';
    return `${listWaitingKinds(asks, approvals, schedules, extensions, decisions, paused)} ${verb} waiting on you. Open to answer.`;
  }
  if (approvals === 0 && schedules === 0 && asks === 0 && extensions === 0 && decisions > 0) {
    return decisions === 1
      ? '1 decision needs you. Open to answer it.'
      : `${decisions} decisions need you. Open to answer them.`;
  }
  if (decisions > 0) {
    return `${listWaitingKinds(asks, approvals, schedules, extensions, decisions)} are waiting on you. Open to answer them.`;
  }
  if (approvals === 0 && schedules === 0 && asks === 0 && extensions > 0) {
    return extensions === 1
      ? '1 mini app is waiting to be turned on. Open to answer it.'
      : `${extensions} mini apps are waiting to be turned on. Open to answer them.`;
  }
  if (extensions > 0) {
    return `${listWaitingKinds(asks, approvals, schedules, extensions)} are waiting on you. Open to answer them.`;
  }
  if (schedules === 0 && asks === 0 && approvals > 0) {
    return approvals === 1
      ? '1 request needs your approval. Open to answer it.'
      : `${approvals} requests need your approval. Open to answer them.`;
  }
  if (approvals === 0 && asks === 0 && schedules > 0) {
    return schedules === 1
      ? '1 schedule wants your approval. Open to answer it.'
      : `${schedules} schedules want your approval. Open to answer them.`;
  }
  if (approvals === 0 && schedules === 0 && asks > 0) {
    // **Questions, not agents.** One prompt is one entry in this queue whoever
    // raised it, and two prompts from one agent are two things to answer — so
    // counting agents here reported a different number than the badge beside it
    // and than the mixed-state sentence below, which already said "1 question".
    return asks === 1
      ? '1 question needs your answer. Open to answer it.'
      : `${asks} questions need your answer. Open to answer them.`;
  }
  return `${listWaitingKinds(asks, approvals, schedules)} are waiting on you. Open to answer them.`;
}

/**
 * The pill's accessible name when the only news is unread history.
 *
 * @param count - How many notifications are unread.
 */
function unreadLabel(count: number): string {
  return count === 1
    ? '1 unread notification. Open your Inbox.'
    : `${count} unread notifications. Open your Inbox.`;
}

/** What the pill draws this frame. */
interface PillState {
  tone: 'waiting' | 'neutral';
  glyph: InboxBellGlyph;
  count?: number;
  text: string;
  label: string;
}

/**
 * Which of the four things the pill is saying this frame.
 *
 * Ordered by urgency, and the order is the contract: something blocked, then a
 * receipt still being said, then a check that failed, then unread history. Everything below the first true branch
 * is still in the panel — the pill only decides what the header says.
 *
 * **`waitingCount` is a parameter, not a re-derivation.** The badge paints
 * this exact number (`count: counts.waitingCount` below); the per-kind counts
 * beside it exist only for `waitingLabel`'s nouns. An earlier version summed
 * `approvalCount + scheduleCount + askCount` again here — the same arithmetic
 * as the caller's `waitingCount`, expressed a second time, which is exactly
 * the shape of drift this file exists to close off (spec
 * `schedule-approval-experience` §C4 review).
 *
 * @param counts - Every number the pill could report, plus the read failure.
 */
export function resolvePill(counts: {
  waitingCount: number;
  approvalCount: number;
  scheduleCount: number;
  askCount: number;
  extensionCount: number;
  decisionCount: number;
  pausedCount: number;
  browserHandoff?: boolean;
  settlingCount: number;
  unreadable: boolean;
  unreadCount: number;
}): PillState {
  if (counts.waitingCount > 0) {
    return {
      tone: 'waiting',
      glyph: 'waiting',
      count: counts.waitingCount,
      text: 'waiting on you',
      label:
        counts.browserHandoff && counts.waitingCount === 1
          ? `${BROWSER_HANDOFF_WAITING} Open to answer it.`
          : `${waitingLabel(
              counts.approvalCount,
              counts.scheduleCount,
              counts.askCount,
              counts.extensionCount,
              counts.decisionCount,
              counts.pausedCount
            )}${counts.browserHandoff ? ` ${BROWSER_HANDOFF_WAITING}` : ''}`,
    };
  }
  if (counts.settlingCount > 0) {
    // Never a zero here: the pill stays mounted for the second a receipt is
    // still being said, and "0 waiting on you" is a sentence about nothing.
    return {
      tone: 'waiting',
      glyph: 'waiting',
      text: 'answered',
      label: 'Your answer was recorded.',
    };
  }
  if (counts.unreadable) {
    return {
      tone: 'waiting',
      glyph: 'waiting',
      text: 'can’t check approvals',
      label: 'DorkOS couldn’t check approvals. Open for details.',
    };
  }
  if (counts.unreadCount > 0) {
    return {
      tone: 'neutral',
      glyph: 'unread',
      count: counts.unreadCount,
      text: 'unread',
      label: unreadLabel(counts.unreadCount),
    };
  }
  // Nothing is true, and the bell is only on screen because somebody asked for
  // it. No number — "0 unread" is a sentence about nothing.
  return {
    tone: 'neutral',
    glyph: 'unread',
    text: 'Inbox',
    label: 'Inbox. Nothing waiting, nothing unread.',
  };
}
