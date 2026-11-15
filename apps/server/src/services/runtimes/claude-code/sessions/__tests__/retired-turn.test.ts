/**
 * A turn DorkOS ends with its process says which of the three reasons it was
 * (DOR-2705). One message used to cover all three, and no log named any.
 */
import { describe, it, expect } from 'vitest';
import { retiredResult, retireReasonOf } from '../diagnostics/retired-turn.js';

function wordsOf(message: unknown): string {
  return (message as { errors: string[] }).errors[0]!;
}

describe('retireReasonOf', () => {
  it('reads a reap as the ceiling, since an idle reap never takes an open turn', () => {
    expect(retireReasonOf('reaped', {})).toBe('ceiling');
  });

  it("reads a teardown by the pump's own reason", () => {
    expect(retireReasonOf('cold', { teardownReason: 'shutdown' })).toBe('shutdown');
    expect(retireReasonOf('cold', { teardownReason: 'evict' })).toBe('evict');
    expect(retireReasonOf('cold', { teardownReason: 'sweep' })).toBe('evict');
  });

  it('reads a teardown with no recorded reason as an eviction, the default teardown', () => {
    expect(retireReasonOf('cold', {})).toBe('evict');
  });

  it("names the 16-hour limit only for DorkOS's own reap or record sweep", () => {
    const pastLimit = { isPastHardLimit: () => true };
    expect(retireReasonOf('reaped', pastLimit)).toBe('limit');
    expect(retireReasonOf('cold', { ...pastLimit, teardownReason: 'sweep' })).toBe('limit');
  });

  it("never names the limit over a person's pause, a relaunch or a shutdown", () => {
    const pastLimit = { isPastHardLimit: () => true };
    // A pause and a relaunch both tear down with `evict`.
    expect(retireReasonOf('cold', { ...pastLimit, teardownReason: 'evict' })).toBe('evict');
    expect(retireReasonOf('cold', { ...pastLimit, teardownReason: 'shutdown' })).toBe('shutdown');
  });
});

describe('retiredResult', () => {
  it('names a shutdown as a shutdown', () => {
    expect(wordsOf(retiredResult('s', 'shutdown'))).toBe(
      'DorkOS shut down before the agent finished this turn.'
    );
  });

  it('names the ceiling, and no other reason, as four silent hours', () => {
    expect(wordsOf(retiredResult('s', 'ceiling'))).toMatch(/four hours/);
    expect(wordsOf(retiredResult('s', 'evict'))).not.toMatch(/four hours/);
  });

  it('names the 16-hour limit in at most fifteen words', () => {
    const words = wordsOf(retiredResult('s', 'limit'));
    expect(words).toMatch(/16-hour limit/);
    expect(words.split(/\s+/).length).toBeLessThanOrEqual(15);
  });

  it('ends the turn as an error, so it is never read as finished', () => {
    expect(retiredResult('s', 'evict')).toMatchObject({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      session_id: 's',
    });
  });
});
