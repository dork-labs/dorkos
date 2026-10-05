/**
 * The one sentence the bell and Pulse both say about the waiting queue
 * (DOR-2578). The bell's own suites pin the per-kind wording through the
 * popover; this pins the edges a second caller relies on.
 */
import { describe, it, expect } from 'vitest';
import { describeWaitingQueue, type WaitingQueueCounts } from '../model/describe-waiting-queue';

/** A queue holding `n` placeholder items of each named kind. */
function queue(counts: Partial<Record<keyof WaitingQueueCounts, number>>): WaitingQueueCounts {
  const fill = (n = 0) => Array.from({ length: n }, () => ({})) as never[];
  return {
    approvals: fill(counts.approvals),
    schedules: fill(counts.schedules),
    asks: fill(counts.asks),
    extensionApprovals: fill(counts.extensionApprovals),
    extensionDecisions: fill(counts.extensionDecisions),
  };
}

describe('describeWaitingQueue', () => {
  it('says nothing for an empty queue, so a caller never counts zero things', () => {
    expect(describeWaitingQueue(queue({}))).toBe('');
  });

  it('names a lone decision as a decision', () => {
    expect(describeWaitingQueue(queue({ extensionDecisions: 1 }))).toBe(
      '1 decision is waiting on you.'
    );
    expect(describeWaitingQueue(queue({ extensionDecisions: 3 }))).toBe(
      '3 decisions are waiting on you.'
    );
  });

  it('names every kind present when the queue is mixed', () => {
    expect(describeWaitingQueue(queue({ asks: 1, approvals: 2, extensionDecisions: 1 }))).toBe(
      '1 question, 2 requests, and 1 decision are waiting on you.'
    );
  });

  it('keeps a lone extension in its own words', () => {
    expect(describeWaitingQueue(queue({ extensionApprovals: 1 }))).toBe(
      '1 extension is waiting to be turned on. None of it runs until you decide.'
    );
  });
});
