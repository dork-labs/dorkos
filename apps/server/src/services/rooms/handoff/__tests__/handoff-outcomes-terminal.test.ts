import { describe, expect, it } from 'vitest';
import { HandoffOutcomes } from '../handoff-outcomes.js';
describe('terminal handoff outcomes', () => {
  it('does not resurrect or replace a terminal result', () => {
    const outcomes = new HandoffOutcomes();
    outcomes.noteWaiting('id', 'author', 'queued', 120000);
    outcomes.settle('id', 'author', { status: 'declined', reason: 'expired' });
    outcomes.noteWaiting('id', 'author', 'running', 240000);
    outcomes.settle('id', 'author', { status: 'posted', entryId: 'late' });
    expect(outcomes.read('id', 'author')).toEqual({ status: 'declined', reason: 'expired' });
    expect(outcomes.read('id', 'other').status).toBe('unknown');
  });
  it('retains pending entries while limiting settled history to 500', () => {
    const outcomes = new HandoffOutcomes();
    outcomes.noteWaiting('pending', 'author', 'queued', 120000);
    for (let i = 0; i < 501; i++)
      outcomes.settle(String(i), 'author', { status: 'declined', reason: 'no' });
    expect(outcomes.read('pending', 'author').status).toBe('pending');
    expect(outcomes.read('0', 'author').status).toBe('unknown');
    expect(outcomes.read('500', 'author').status).toBe('declined');
  });
});
