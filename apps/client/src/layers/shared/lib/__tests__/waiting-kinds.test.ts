/**
 * The nouns the cockpit counts "what's waiting on you" in.
 *
 * Two widgets say this sentence — the Inbox bell and the home triage header —
 * and they drifted once: the popover named all three kinds honestly while the
 * header still called the whole queue "approvals". This is the one wording both
 * now read.
 */
import { describe, it, expect } from 'vitest';
import { listWaitingKinds } from '../waiting-kinds';

describe('listWaitingKinds', () => {
  it('names one kind on its own, singular', () => {
    expect(listWaitingKinds(1, 0, 0)).toBe('1 question');
  });

  it('pluralizes a kind with more than one waiting', () => {
    // The pluralization is only reachable through this door now — `countNoun`
    // is private, because a general pluralizer on the barrel would invite a
    // second counting vocabulary beside the one this module exists to keep
    // single.
    expect(listWaitingKinds(3, 0, 0)).toBe('3 questions');
  });

  it('joins two kinds with "and", never with a comma', () => {
    expect(listWaitingKinds(0, 1, 2)).toBe('1 request and 2 schedules');
  });

  it('joins three with an Oxford comma, in listing order', () => {
    // The order is the contract: questions first (shortest window), then
    // capability requests, then schedules, which are on no clock at all — the
    // same order both surfaces draw them in.
    expect(listWaitingKinds(2, 1, 3)).toBe('2 questions, 1 request, and 3 schedules');
  });

  it('leaves out a kind with nothing waiting rather than reporting a zero', () => {
    // "1 question, 0 requests, and 2 schedules" is three facts where one of them
    // is noise.
    expect(listWaitingKinds(1, 0, 2)).toBe('1 question and 2 schedules');
  });

  it('says nothing at all when nothing is waiting', () => {
    // The shape that used to reach a screen: joining an empty list produced
    // ", and undefined are waiting on you." Callers with nothing to count have
    // their own sentence, and this returning '' is what lets them say it.
    expect(listWaitingKinds(0, 0, 0)).toBe('');
  });
});
