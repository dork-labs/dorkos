/**
 * The one-time cutoff note's wire shapes: a stalled turn, a stop by another
 * chat, and timers that ended with their process (DOR-3755).
 */
import { describe, expect, it } from 'vitest';
import { TurnCutoffDataSchema } from '../owed-notes-context.js';

describe('TurnCutoffDataSchema', () => {
  it('accepts each of the three notes', () => {
    expect(TurnCutoffDataSchema.safeParse({ windowMs: 600_000, neverStarted: false }).success).toBe(
      true
    );
    expect(TurnCutoffDataSchema.safeParse({ stoppedBy: 'chat', via: 'stop' }).success).toBe(true);
    expect(
      TurnCutoffDataSchema.safeParse({ timersStopped: 2, at: 1_795_000_000_000 }).success
    ).toBe(true);
  });

  it('refuses a timers note that names no timer or no time', () => {
    expect(TurnCutoffDataSchema.safeParse({ timersStopped: 0, at: 1 }).success).toBe(false);
    expect(TurnCutoffDataSchema.safeParse({ timersStopped: 1 }).success).toBe(false);
  });
});
