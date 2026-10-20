/**
 * The session gate's `401` says how to sign in: on a hub, with a DorkOS
 * account, since a hub has no passwords; elsewhere with the app's own form.
 */
import { describe, expect, it, vi } from 'vitest';

const role = vi.hoisted(() => ({ value: 'hub' as 'computer' | 'hub' }));
vi.mock('../../../../lib/server-role.js', () => ({ currentServerRole: () => role.value }));

const { authRequiredBody, AUTH_REQUIRED_BODY } = await import('../session-gate.js');

describe('authRequiredBody', () => {
  it('names a DorkOS account on a hub', () => {
    role.value = 'hub';
    expect(authRequiredBody()).toEqual({ ...AUTH_REQUIRED_BODY, signInWith: 'dorkos' });
  });

  it('names nothing more on a person`s own computer', () => {
    role.value = 'computer';
    expect(authRequiredBody()).toEqual(AUTH_REQUIRED_BODY);
  });
});
