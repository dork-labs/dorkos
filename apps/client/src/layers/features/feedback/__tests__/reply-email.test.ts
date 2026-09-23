// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  looksLikeEmail,
  readReplyEmail,
  rememberReplyEmail,
  REPLY_EMAIL_STORAGE_KEY,
} from '../lib/reply-email';

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('looksLikeEmail', () => {
  it('accepts an address, ignoring the spaces around it', () => {
    expect(looksLikeEmail(' ike@example.com ')).toBe(true);
  });

  it.each(['', 'ike', 'ike@', '@example.com', 'ike @example.com', 'https://github.com/ike'])(
    'refuses %j, which the site would not email either',
    (value) => {
      expect(looksLikeEmail(value)).toBe(false);
    }
  );
});

describe('remembering the address', () => {
  it('keeps an email-shaped address, trimmed', () => {
    rememberReplyEmail(' ike@example.com ');
    expect(localStorage.getItem(REPLY_EMAIL_STORAGE_KEY)).toBe('ike@example.com');
    expect(readReplyEmail()).toBe('ike@example.com');
  });

  it('forgets it when the field was cleared', () => {
    rememberReplyEmail('ike@example.com');
    rememberReplyEmail('   ');
    expect(localStorage.getItem(REPLY_EMAIL_STORAGE_KEY)).toBeNull();
  });

  it('keeps the last good address rather than a typo', () => {
    rememberReplyEmail('ike@example.com');
    rememberReplyEmail('ike@');
    expect(readReplyEmail()).toBe('ike@example.com');
  });

  it('reads empty and writes nothing when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(readReplyEmail()).toBe('');
    expect(() => rememberReplyEmail('ike@example.com')).not.toThrow();
  });
});
