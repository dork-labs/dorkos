/**
 * `awayFromTheComputerSentence` (DOR-2969): the server's own sentence for an
 * action refused because of where this device is, and nothing else.
 */
import { describe, expect, it } from 'vitest';
import { awayFromTheComputerSentence } from '../server-sentence';

/** An error shaped the way the transport throws one. */
function refused(message: string, code?: string): Error {
  return Object.assign(new Error(message), code === undefined ? {} : { code });
}

describe('awayFromTheComputerSentence', () => {
  it.each(['NOT_FROM_WIFI', 'NEEDS_PERSON_AT_THIS_COMPUTER'])(
    'passes the sentence of %s',
    (code) => {
      expect(
        awayFromTheComputerSentence(refused('The terminal opens only at this computer.', code))
      ).toBe('The terminal opens only at this computer.');
    }
  );

  it('is null for any other refusal, a bare code, or a non-error', () => {
    expect(
      awayFromTheComputerSentence(refused('Too many terminals.', 'TERMINAL_LIMIT'))
    ).toBeNull();
    expect(awayFromTheComputerSentence(refused('HTTP 403', 'NOT_FROM_WIFI'))).toBeNull();
    expect(awayFromTheComputerSentence(refused('Forbidden.'))).toBeNull();
    expect(awayFromTheComputerSentence('NOT_FROM_WIFI')).toBeNull();
  });
});
