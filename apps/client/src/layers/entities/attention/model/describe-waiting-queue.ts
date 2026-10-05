/**
 * The one sentence that says what is waiting on a person.
 *
 * Two surfaces say it: the Inbox popover's "Needs you" summary and the Pulse
 * panel's "Needs attention" section. Both read the same queue
 * ({@link useWaitingQueue}), so both say the same words about it — a sentence
 * kept in each widget is two places for a new kind to be named in one and
 * forgotten in the other (DOR-2578).
 *
 * @module entities/attention/model/describe-waiting-queue
 */
import { listWaitingKinds } from '@/layers/shared/lib';
import type { WaitingQueueState } from './use-waiting-queue';

/** The five queues {@link describeWaitingQueue} counts — any slice of {@link WaitingQueueState}. */
export type WaitingQueueCounts = Pick<
  WaitingQueueState,
  'approvals' | 'schedules' | 'asks' | 'extensionApprovals' | 'extensionDecisions'
>;

/**
 * Say what is waiting, one kind in its own words or every kind present by name.
 *
 * **It does not call everything by the same noun.** A capability approval, a
 * parked schedule, a prompt an agent is parked on, an extension waiting to be
 * turned on and a decision an extension asked about are five different objects,
 * and none stands in for another. When the queue is only one kind the sentence
 * says so in that kind's own words; when it is mixed it names every kind that is
 * actually present.
 *
 * Answers `''` for an empty queue — a caller that has nothing waiting should be
 * saying something else (an all-clear, or "Answered."), not counting nothing.
 *
 * @param queue - The waiting queues, at full per-item granularity.
 */
export function describeWaitingQueue(queue: WaitingQueueCounts): string {
  const approvals = queue.approvals.length;
  const schedules = queue.schedules.length;
  const asks = queue.asks.length;
  const extensions = queue.extensionApprovals.length;
  const decisions = queue.extensionDecisions.length;

  if (approvals + schedules + asks + extensions + decisions === 0) return '';
  if (approvals === 0 && schedules === 0 && asks === 0 && extensions === 0 && decisions > 0) {
    const subject = decisions === 1 ? '1 decision is' : `${decisions} decisions are`;
    return `${subject} waiting on you.`;
  }
  if (decisions > 0) {
    return `${listWaitingKinds(asks, approvals, schedules, extensions, decisions)} are waiting on you.`;
  }
  if (approvals === 0 && schedules === 0 && asks === 0 && extensions > 0) {
    const subject = extensions === 1 ? '1 extension is' : `${extensions} extensions are`;
    return `${subject} waiting to be turned on. None of it runs until you decide.`;
  }
  if (extensions > 0) {
    return `${listWaitingKinds(asks, approvals, schedules, extensions)} are waiting on you. Nothing runs until you decide.`;
  }
  if (schedules === 0 && asks === 0 && approvals > 0) {
    const subject = approvals === 1 ? '1 request is' : `${approvals} requests are`;
    return `${subject} waiting for your approval. Nothing runs until you decide.`;
  }
  if (approvals === 0 && asks === 0 && schedules > 0) {
    const subject = schedules === 1 ? '1 schedule wants' : `${schedules} schedules want`;
    return `${subject} your approval. Nothing runs until you decide.`;
  }
  if (approvals === 0 && schedules === 0 && asks > 0) {
    // One prompt is one question, however many agents raised them — the same
    // noun the bell's pill and the mixed sentence below use.
    const subject = asks === 1 ? '1 question is' : `${asks} questions are`;
    return `${subject} waiting on your answer. Nothing carries on until you answer.`;
  }
  return `${listWaitingKinds(asks, approvals, schedules)} are waiting on you. Nothing runs until you decide.`;
}
