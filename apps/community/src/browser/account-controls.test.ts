import { describe, expect, it } from 'vitest';
import { describeInstallAccess, describeReauthenticationError } from './account-controls.js';
import { RequestError } from './api.js';

describe('describeInstallAccess', () => {
  it('names each ability in plain words and order', () => {
    expect(describeInstallAccess(['read'])).toBe('Can read');
    expect(describeInstallAccess(['read', 'post'])).toBe('Can read and post');
    expect(describeInstallAccess(['read', 'post', 'enroll-agent'])).toBe(
      'Can read, post and add agents'
    );
  });

  it('never shows a raw scope name it does not know', () => {
    expect(describeInstallAccess(['read', 'future-scope'])).toBe('Can read');
    expect(describeInstallAccess([])).toBe('No access');
  });
});

describe('describeReauthenticationError', () => {
  it('says the password was wrong only when the server says so, and that nothing changed', () => {
    const refused = new RequestError(403, 'REAUTH_FAILED', 'That password is not right.');
    expect(describeReauthenticationError(refused, 'Nothing was disconnected.')).toBe(
      'That password is not right. Nothing was disconnected.'
    );
  });

  it("keeps the server's reason for every other refusal", () => {
    // A 403 that is not a password failure must never read as one.
    for (const [code, message] of [
      ['FORBIDDEN', 'Your membership has ended.'],
      ['FORBIDDEN', 'Transfer ownership before leaving.'],
      ['COMMUNITY_SUSPENDED', 'This community is paused.'],
    ] as const)
      expect(
        describeReauthenticationError(
          new RequestError(403, code, message),
          'You are still a member.'
        )
      ).toBe(message);
    expect(
      describeReauthenticationError(new RequestError(0, 'OFFLINE', 'You appear to be offline.'), '')
    ).toBe('You appear to be offline.');
  });

  it('says a spent guess budget changed nothing', () => {
    const limited = new RequestError(
      429,
      'RATE_LIMITED',
      'Too many wrong passwords. Wait a minute, then try again.'
    );
    expect(describeReauthenticationError(limited, 'Nothing was disconnected.')).toBe(
      'Too many wrong passwords. Wait a minute, then try again. Nothing was disconnected.'
    );
  });
});
