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
    pausedConnections: fill(counts.pausedConnections),
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

  describe('mini apps waiting, in their own words', () => {
    /** A queue of mini apps only: 'new' waits to be turned on, 'changed' for an OK. */
    const miniApps = (...kinds: ('new' | 'changed' | 'updated')[]) =>
      ({
        ...queue({}),
        extensionApprovals: kinds.map((kind, i) => ({
          name: i === 0 ? 'Flow' : `App ${i}`,
          changedFiles: kind === 'changed' ? ['index.ts'] : null,
          updatedFrom: kind === 'updated' ? '1.2.0' : null,
        })) as never[],
      }) as WaitingQueueCounts;

    it('says how many new ones wait to be turned on', () => {
      expect(describeWaitingQueue(miniApps('new', 'new'))).toBe(
        "2 mini apps are waiting to be turned on. They won't run until you decide."
      );
    });

    it('says how many changed ones wait for an OK, an update included', () => {
      expect(describeWaitingQueue(miniApps('changed', 'updated'))).toBe(
        "2 mini apps changed and are waiting for your OK. They won't run until you decide."
      );
    });

    it('says only that they wait for an OK when some are new and some changed', () => {
      expect(describeWaitingQueue(miniApps('new', 'changed'))).toBe(
        "2 mini apps are waiting for your OK. They won't run until you decide."
      );
    });

    it('names one by name, in the singular', () => {
      expect(describeWaitingQueue(miniApps('changed'))).toBe(
        "Flow changed and is waiting for your OK. It won't run until you decide."
      );
      expect(describeWaitingQueue(miniApps('new'))).toBe(
        "Flow is waiting to be turned on. It won't run until you decide."
      );
    });

    it('keeps each sentence within 15 words', () => {
      for (const kinds of [
        ['new', 'new'],
        ['changed', 'changed'],
        ['new', 'changed'],
        ['changed'],
      ] as const) {
        for (const sentence of describeWaitingQueue(miniApps(...kinds)).split(/(?<=\.)\s+/)) {
          expect(sentence.split(/\s+/).length).toBeLessThanOrEqual(15);
        }
      }
    });
  });

  it('names paused connections, alone and in a mix (DOR-3271)', () => {
    expect(describeWaitingQueue(queue({ pausedConnections: 1 }))).toBe(
      '1 connection is paused until you confirm what it sends.'
    );
    expect(describeWaitingQueue(queue({ pausedConnections: 2 }))).toBe(
      '2 connections are paused until you confirm what they send.'
    );
    expect(describeWaitingQueue(queue({ approvals: 1, pausedConnections: 1 }))).toBe(
      '1 request and 1 paused connection are waiting on you.'
    );
  });
});
