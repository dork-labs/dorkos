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
  it('says the password was wrong and that nothing changed', () => {
    const refused = new RequestError(403, 'FORBIDDEN', 'Reauthentication failed.');
    expect(describeReauthenticationError(refused, 'Nothing was disconnected.')).toBe(
      'That password is not right. Nothing was disconnected.'
    );
  });

  it('passes every other failure through unchanged', () => {
    const suspended = new RequestError(403, 'COMMUNITY_SUSPENDED', 'This community is paused.');
    expect(describeReauthenticationError(suspended, 'Nothing was disconnected.')).toBe(
      'This community is paused.'
    );
    expect(
      describeReauthenticationError(new RequestError(0, 'OFFLINE', 'You appear to be offline.'), '')
    ).toBe('You appear to be offline.');
  });
});
