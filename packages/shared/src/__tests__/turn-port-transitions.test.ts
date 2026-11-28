/**
 * The run record's transition table says what the spec says
 * (`specs/turns-survive-restarts` §4.3): fifteen legal pairs, every other one
 * refused, and a way out of every status that is not terminal.
 */
import { describe, expect, it } from 'vitest';
import {
  RUN_TRANSITIONS,
  RunStatusSchema,
  TERMINAL_RUN_STATUSES,
  canTransition,
  type RunStatus,
} from '../turn-port.js';

describe('the transition table', () => {
  /** The fifteen legal pairs: the spec's table (§4.3) and the architect's rows 14 and 15. */
  const SPEC: ReadonlyArray<readonly [RunStatus | null, RunStatus]> = [
    [null, 'queued'],
    [null, 'running'],
    ['queued', 'queued'],
    ['queued', 'starting'],
    ['queued', 'cancelled'],
    ['queued', 'superseded'],
    ['starting', 'started'],
    ['starting', 'queued'],
    ['starting', 'cancelled'],
    ['started', 'running'],
    ['started', 'ended'],
    ['running', 'ended'],
    ['ended', 'settled'],
    ['started', 'queued'],
    ['running', 'queued'],
  ];
  const STATUSES = RunStatusSchema.options;

  it('holds exactly the fifteen rows, numbered 1 to 15', () => {
    expect(SPEC).toHaveLength(15);
    expect(RUN_TRANSITIONS.map(({ from, to }) => [from, to])).toEqual(SPEC);
    expect(RUN_TRANSITIONS.map(({ row }) => row)).toEqual(SPEC.map((_, index) => index + 1));
    expect(canTransition('starting', 'superseded')).toBe(false);
  });

  it('answers every pair, legal or not', () => {
    const legal = new Set(SPEC.map(([from, to]) => `${from}->${to}`));
    const pairs = [null, ...STATUSES].flatMap((from) => STATUSES.map((to) => [from, to] as const));
    expect(pairs).toHaveLength(9 * 8);
    for (const [from, to] of pairs) {
      expect(canTransition(from, to), `${from} -> ${to}`).toBe(legal.has(`${from}->${to}`));
    }
  });

  it('gives every non-terminal status a way out, and none to a terminal one', () => {
    expect(STATUSES).toHaveLength(8);
    for (const status of STATUSES) {
      const exits = STATUSES.filter((to) => to !== status && canTransition(status, to));
      if (TERMINAL_RUN_STATUSES.includes(status)) expect(exits, status).toEqual([]);
      else expect(exits.length, status).toBeGreaterThan(0);
    }
  });
});
