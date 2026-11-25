/**
 * `awayFromTheComputerSentence` (DOR-2969): the server's own sentence for an
 * action refused because of where this device is, and nothing else.
 */
import { describe, expect, it } from 'vitest';
import { awayFromTheComputerSentence, serverSentence } from '../server-sentence';

/** An error shaped the way the transport throws one. */
function refused(message: string, code?: string): Error {
  return Object.assign(new Error(message), code === undefined ? {} : { code });
}

describe('awayFromTheComputerSentence', () => {
  it.each(['not_from_wifi', 'operator_only'])('passes the sentence of %s', (code) => {
    expect(
      awayFromTheComputerSentence(refused('The terminal opens only at this computer.', code))
    ).toBe('The terminal opens only at this computer.');
  });

  it('is null for any other refusal, a bare code, or a non-error', () => {
    expect(
      awayFromTheComputerSentence(refused('Too many terminals.', 'terminal_limit'))
    ).toBeNull();
    expect(awayFromTheComputerSentence(refused('HTTP 403', 'not_from_wifi'))).toBeNull();
    // The old spellings are gone with the routes that sent them (DOR-4979).
    expect(
      awayFromTheComputerSentence(refused('Only at this computer.', 'NOT_FROM_WIFI'))
    ).toBeNull();
    expect(awayFromTheComputerSentence(refused('Forbidden.'))).toBeNull();
    expect(awayFromTheComputerSentence('not_from_wifi')).toBeNull();
  });
});

describe('serverSentence', () => {
  /** An error the way `fetchJSON` throws it: the reader's message, status and body. */
  function answered(message: string, body: unknown, status = 400): Error {
    return Object.assign(new Error(message), { status, body });
  }

  it('passes a problem document’s detail', () => {
    const body = {
      title: 'The request didn’t pass its checks.',
      status: 400,
      code: 'invalid_request',
      detail: 'Send the folder as `cwd`.',
    };
    expect(serverSentence(answered('Send the folder as `cwd`.', body))).toBe(
      'Send the folder as `cwd`.'
    );
  });

  it('never passes a problem’s generic title, so the caller’s fallback shows', () => {
    const body = { title: 'DorkOS hit an error on its side.', status: 500, code: 'internal_error' };
    expect(serverSentence(answered('DorkOS hit an error on its side.', body, 500))).toBeNull();
  });

  it('passes nothing from a body that is not a problem document', () => {
    expect(
      serverSentence(answered('That name is taken.', { error: 'That name is taken.' }))
    ).toBeNull();
  });
});
