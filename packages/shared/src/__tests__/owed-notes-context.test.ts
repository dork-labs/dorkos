/**
 * The owed notes' wire shapes: the cutoff note (a stalled turn, or a stop by
 * another chat) and the stopped-timers note, which has a slot of its own
 * (DOR-3755).
 */
import { describe, expect, it } from 'vitest';
import { TimersStoppedDataSchema, TurnCutoffDataSchema } from '../owed-notes-context.js';

describe('TurnCutoffDataSchema', () => {
  it('accepts both cutoffs', () => {
    expect(TurnCutoffDataSchema.safeParse({ windowMs: 600_000, neverStarted: false }).success).toBe(
      true
    );
    expect(TurnCutoffDataSchema.safeParse({ stoppedBy: 'chat', via: 'stop' }).success).toBe(true);
  });

  it('does not take a stopped-timers note, which has its own kind', () => {
    expect(TurnCutoffDataSchema.safeParse({ timers: 1, at: 1 }).success).toBe(false);
  });
});

describe('TimersStoppedDataSchema', () => {
  it('accepts a count and a time', () => {
    expect(TimersStoppedDataSchema.safeParse({ timers: 2, at: 1_795_000_000_000 }).success).toBe(
      true
    );
  });

  it('refuses a note that names no timer or no time', () => {
    expect(TimersStoppedDataSchema.safeParse({ timers: 0, at: 1 }).success).toBe(false);
    expect(TimersStoppedDataSchema.safeParse({ timers: 1 }).success).toBe(false);
  });
});
