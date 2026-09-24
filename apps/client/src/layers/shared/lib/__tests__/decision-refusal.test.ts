/**
 * What a person is told when a decision is refused (spec `agent-permissions`
 * D7).
 *
 * The server writes a specific sentence for every refusal and the app-wide handler
 * replaces all of them with "That didn't work. Try again." These cases pin the
 * one place that stops happening.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { describeDecisionRefusal } from '../decision-refusal';

/** Build the error shape `fetchJSON` throws: server sentence plus its code. */
function serverError(message: string, code?: string): Error & { code?: string } {
  const err = new Error(message) as Error & { code?: string };
  if (code) err.code = code;
  return err;
}

describe('describeDecisionRefusal', () => {
  it('shows the server’s own sentence for every refusal that has one', () => {
    const cases: [string, string][] = [
      ['operator_cookie_required', 'Only a person signed in to DorkOS can change that'],
      [
        'ALWAYS_NOT_OFFERED',
        "Always allow isn't offered for this request. Answer it with Allow or Deny.",
      ],
      [
        'ALWAYS_ALLOW_NOT_RECORDED',
        'DorkOS could not save Always allow, so it allowed nothing. Try again.',
      ],
      ['APPROVAL_EXPIRED', 'This approval expired before it was decided'],
      ['APPROVAL_NOT_PENDING', 'This approval was already decided'],
    ];

    for (const [code, message] of cases) {
      expect(describeDecisionRefusal(serverError(message, code), true).message).toBe(message);
    }
  });

  it('says plainly that nothing happened when the code is unrecognised', () => {
    // A code nobody has read gets a sentence of our own rather than raw server
    // text, and the fallback still answers the question the person has: did any of
    // it go through?
    const refusal = describeDecisionRefusal(serverError('ECONNRESET', 'SOME_NEW_CODE'), true);
    expect(refusal.message).toBe(
      'DorkOS could not answer that. Nothing was allowed and nothing was changed.'
    );
  });

  it('does not mention a change when only a one-time answer was sent', () => {
    const refusal = describeDecisionRefusal(serverError('boom'), false);
    expect(refusal.message).toBe('DorkOS could not record your answer. Nothing was allowed.');
  });

  it('survives a rejection that is not an Error at all', () => {
    expect(describeDecisionRefusal(undefined, false).message).toContain('Nothing was allowed');
    expect(describeDecisionRefusal('nope', true).message).toContain('nothing was changed');
  });
});
