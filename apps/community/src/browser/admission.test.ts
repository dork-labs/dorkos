import { describe, expect, it } from 'vitest';
import { RequestError } from './api.js';
import { describeAdmissionFailure, reactivationScope, recoveryInstruction } from './admission.js';

const check = { phase: 'check', accountCreated: false } as const;
const join = { phase: 'join', accountCreated: false } as const;

describe('describeAdmissionFailure', () => {
  it('says membership was not added, and that a new account still exists', () => {
    const cause = new RequestError(503, 'UNAVAILABLE', 'The community is unavailable.');
    expect(describeAdmissionFailure(cause, join).title).toBe('Membership was not added.');
    expect(describeAdmissionFailure(cause, { ...join, accountCreated: true }).title).toBe(
      'Your account was created, but membership was not added.'
    );
  });

  it('reads every refused invitation the same, whatever the server said', () => {
    const refusals = [
      new RequestError(403, 'FORBIDDEN', 'This invitation cannot be used. Ask for a new link.'),
      new RequestError(403, 'FORBIDDEN', 'This invitation is invalid or expired.'),
      new RequestError(404, 'NOT_FOUND', 'Community not found.'),
      new RequestError(
        409,
        'STATE_CONFLICT',
        'This invitation has no seats left. Ask for a new link.'
      ),
    ];
    for (const cause of refusals)
      expect(describeAdmissionFailure(cause, check)).toEqual({
        title: 'Membership was not added.',
        detail: 'This invitation cannot be used.',
        recovery: 'new-invitation',
      });
  });

  it('keeps the closed-community reason the server chose to reveal', () => {
    const cause = new RequestError(
      409,
      'STATE_CONFLICT',
      'This community is closed to new members.'
    );
    expect(describeAdmissionFailure(cause, join)).toMatchObject({
      detail: 'This community is closed to new members.',
      recovery: 'new-invitation',
    });
  });

  it('says a full community is full, and that the same invitation works once there is room', () => {
    // Purpose: fails if a full community reads as a dead link that needs a new invitation.
    const cause = new RequestError(
      409,
      'MEMBER_LIMIT_REACHED',
      'This community is full. Ask its owner to make room.'
    );
    for (const context of [check, join]) {
      const failure = describeAdmissionFailure(cause, context);
      expect(failure).toEqual({
        title: 'Membership was not added.',
        detail: 'This community is full. Ask its owner to make room.',
        recovery: 'wait-for-room',
      });
      expect(recoveryInstruction(failure.recovery)).toBe(
        'Your invitation still works. Open it again once the owner has made room.'
      );
      expect(recoveryInstruction(failure.recovery)).not.toMatch(/new (invitation )?link/u);
    }
  });

  it('asks to reopen the link when the join attempt itself is gone or bound elsewhere', () => {
    expect(
      describeAdmissionFailure(
        new RequestError(403, 'FORBIDDEN', 'This join attempt has expired.'),
        join
      ).recovery
    ).toBe('reopen');
    const other = describeAdmissionFailure(
      new RequestError(403, 'FORBIDDEN', 'This join attempt belongs to another account.'),
      join
    );
    expect(other.recovery).toBe('reopen');
    expect(other.detail).toContain('different account');
  });

  it('offers a retry only for failures a retry can fix', () => {
    expect(describeAdmissionFailure(new RequestError(0, 'OFFLINE', 'offline'), join)).toMatchObject(
      { recovery: 'retry', detail: 'You appear to be offline. Check your connection.' }
    );
    expect(
      describeAdmissionFailure(new RequestError(429, 'RATE_LIMITED', 'Too many attempts.'), check)
    ).toMatchObject({ recovery: 'retry', detail: 'Too many attempts.' });
    expect(describeAdmissionFailure(new Error('boom'), join)).toMatchObject({
      recovery: 'retry',
      detail: 'The community did not respond.',
    });
  });
});

describe('recoveryInstruction', () => {
  it('words the non-button recoveries and leaves retry to its button', () => {
    expect(recoveryInstruction('new-invitation')).toBe(
      'Ask the person who invited you for a new invitation link.'
    );
    expect(recoveryInstruction('reopen')).toBe('Open your invitation link again in this browser.');
    expect(recoveryInstruction('retry')).toBeNull();
  });
});

describe('reactivationScope', () => {
  it('restores identity only, and names every kind of access that stays removed', () => {
    const scope = reactivationScope(null);
    expect(scope.restored).toEqual(['Your name and handle in this community.']);
    expect(scope.notRestored.join(' ')).toMatch(/role.*Channels.*Agents.*DorkOS installations/su);
  });

  it('names the one channel an invitation brings back', () => {
    const scope = reactivationScope('general');
    expect(scope.restored).toContain('Access to #general, which this invitation includes.');
    expect(scope.notRestored).toContain('Other channels you were in before.');
  });
});
