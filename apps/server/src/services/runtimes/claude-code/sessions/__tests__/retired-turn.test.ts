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
    expect(retireReasonOf('reaped', undefined)).toBe('ceiling');
  });

  it("reads a teardown by the pump's own reason", () => {
    expect(retireReasonOf('cold', 'shutdown')).toBe('shutdown');
    expect(retireReasonOf('cold', 'evict')).toBe('evict');
  });

  it('reads a teardown with no recorded reason as an eviction, the default teardown', () => {
    expect(retireReasonOf('cold', undefined)).toBe('evict');
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

  it('ends the turn as an error, so it is never read as finished', () => {
    expect(retiredResult('s', 'evict')).toMatchObject({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      session_id: 's',
    });
  });
});
