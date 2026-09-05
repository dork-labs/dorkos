/**
 * What a person is told when a decision is refused (spec
 * `agent-approval-settings` §3.5).
 *
 * The server writes a specific sentence for every refusal and the app-wide handler
 * replaces all of them with "That didn't work. Try again." These cases pin the
 * one place that stops happening, and in particular pin the case where saying
 * "failed" is not merely unhelpful but dangerous.
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
  it('never calls the partial-success case a failure', () => {
    // The 500 that means "the irreversible action DID run, only the permission was
    // not recorded". Reporting this as a failure invites somebody to repeat
    // something that cannot be undone, which is the worst outcome this feature
    // could cause.
    const refusal = describeDecisionRefusal(
      serverError(
        'DorkOS allowed this one action, but could not record the permission to stop asking. The agent will ask again next time.',
        'STANDING_PERMISSION_NOT_RECORDED'
      ),
      true
    );

    expect(refusal.tone).toBe('warning');
    expect(refusal.message).toContain('allowed this one action');
    expect(refusal.message).not.toMatch(/failed/i);
  });

  it('keeps the partial-success wording even if the server sent none', () => {
    const refusal = describeDecisionRefusal(
      serverError('', 'STANDING_PERMISSION_NOT_RECORDED'),
      true
    );
    expect(refusal.tone).toBe('warning');
    expect(refusal.message).toContain('allowed this one action');
  });

  it("shows the server's own sentence for every refusal that has one", () => {
    const cases: [string, string][] = [
      [
        'standing_grants_require_login',
        'Standing permissions need Require login turned on, because without it DorkOS cannot tell you apart from an agent running on this machine',
      ],
      ['operator_cookie_required', 'Only a person signed in to DorkOS can change that'],
      [
        'STANDING_GRANTS_DISABLED',
        'Standing permissions are switched off. Turn them on in Settings, under Security, first.',
      ],
      [
        'APPROVAL_HAS_NO_AGENT',
        'DorkOS does not know which agent asked for this, so it cannot stop asking about that agent. Answer this one on its own.',
      ],
      ['APPROVAL_EXPIRED', 'This approval expired before it was decided'],
      ['APPROVAL_NOT_PENDING', 'This approval was already decided'],
    ];

    for (const [code, message] of cases) {
      const refusal = describeDecisionRefusal(serverError(message, code), true);
      expect(refusal.tone).toBe('error');
      expect(refusal.message).toBe(message);
    }
  });

  it('says plainly that nothing happened when the code is unrecognised', () => {
    // A code nobody has read gets a sentence of our own rather than raw server
    // text, and the fallback still answers the question the person has: did any of
    // it go through?
    const refusal = describeDecisionRefusal(serverError('ECONNRESET', 'SOME_NEW_CODE'), true);
    expect(refusal.tone).toBe('error');
    expect(refusal.message).toContain('no permission was created');
  });

  it('does not mention permissions when none was asked for', () => {
    const refusal = describeDecisionRefusal(serverError('boom'), false);
    expect(refusal.message).toBe('DorkOS could not record your answer. Nothing was allowed.');
  });

  it('survives a rejection that is not an Error at all', () => {
    expect(describeDecisionRefusal(undefined, false).tone).toBe('error');
    expect(describeDecisionRefusal('nope', true).message).toContain('no permission was created');
  });
});
