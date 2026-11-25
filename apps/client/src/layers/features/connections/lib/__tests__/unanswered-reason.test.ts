import { describe, expect, it } from 'vitest';
import { unansweredReason } from '../unanswered-reason';

/** A transport error as the shared reader builds it: the server's sentence and code. */
function refusal(code: string, detail = 'The server’s own sentence.') {
  return Object.assign(new Error(detail), {
    code,
    status: 409,
    body: { type: `urn:dorkos:problem:${code}`, title: 'A title.', status: 409, code, detail },
  });
}

describe('unansweredReason', () => {
  it.each([
    ['app_off_in_chat', 'turned off for Bo', 'turn_on'],
    ['already_resolved', 'answered somewhere else', null],
    ['expired', 'ran out of time', null],
    ['request_open_elsewhere', 'Signing in already started', null],
    ['temporarily_unavailable', 'still being set up', 'retry'],
    ['precondition_failed', 'Access changed since you looked', 'retry'],
    ['conflict', 'isn’t ready for it yet', 'retry'],
    ['updates_unavailable', 'updates you picked can’t be set up', 'updates'],
    ['updates_changed', 'updates you picked can’t be set up', 'updates'],
    ['invalid_filter', 'updates you picked can’t be set up', 'updates'],
    ['destination_unavailable', 'updates you picked can’t be set up', 'updates'],
  ] as const)('reads %s by its code', (code, words, fix) => {
    const answer = unansweredReason(refusal(code), 'Bo', 'Gmail');
    expect(answer.reason).toContain(words);
    expect(answer.fix).toBe(fix);
  });

  it('says what is gone in the server’s own words for not_found', () => {
    const answer = unansweredReason(
      refusal('not_found', 'That app isn’t connected anymore. Pick it again from the list.'),
      'Bo',
      'Gmail'
    );
    expect(answer.reason).toBe('That app isn’t connected anymore. Pick it again from the list.');
    expect(answer.fix).toBeNull();
  });

  it('never calls a bad request body a bad choice of updates', () => {
    expect(unansweredReason(refusal('invalid_request'), 'Bo', 'Gmail').fix).toBe('retry');
  });

  it('falls back to a retry, in the server’s words when it wrote some', () => {
    expect(
      unansweredReason(refusal('rate_limited', 'Too many. Try later.'), 'Bo', 'Gmail')
    ).toEqual({
      reason: 'Too many. Try later.',
      fix: 'retry',
    });
    expect(unansweredReason(new Error('Failed to fetch'), 'Bo', 'Gmail')).toEqual({
      reason: 'The answer didn’t reach DorkOS.',
      fix: 'retry',
    });
  });
});
