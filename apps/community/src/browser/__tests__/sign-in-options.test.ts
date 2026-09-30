import { describe, expect, it } from 'vitest';
import { describeSignInError } from '../sign-in-options.js';

describe('describeSignInError', () => {
  it('tells a sign-up page to tick the age box, and a sign-in-only page where to sign up', () => {
    // Purpose: fails if the pairing page, which has no way to create an account, tells people to
    // use one, or if the sign-up pages lose the instruction that fixes the refusal.
    expect(describeSignInError('age_confirmation_required')).toContain('tick the box');
    const pairing = describeSignInError('age_confirmation_required', true);
    expect(pairing).toContain('invitation link');
    expect(pairing).not.toMatch(/create an account|tick the box/iu);
    // Codes with no sign-in-only wording keep their usual message there.
    expect(describeSignInError('invitation_required', true)).toBe(
      describeSignInError('invitation_required')
    );
  });
});
