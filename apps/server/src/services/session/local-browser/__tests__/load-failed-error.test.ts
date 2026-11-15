import { describe, expect, it } from 'vitest';
import { loadFailedError } from '../page-action.js';

// DOR-4430: an agent's failed load reads as the title the person sees, as a sentence.
describe('loadFailedError', () => {
  it.each([
    ['net::ERR_NAME_NOT_RESOLVED', 'Can’t find northwind.example (ERR_NAME_NOT_RESOLVED).'],
    ['net::ERR_CONNECTION_RESET', 'northwind.example didn’t respond (ERR_CONNECTION_RESET).'],
    ['net::ERR_INTERNET_DISCONNECTED', 'You’re offline (ERR_INTERNET_DISCONNECTED).'],
    [
      'net::ERR_CERT_AUTHORITY_INVALID',
      'This connection isn’t private (ERR_CERT_AUTHORITY_INVALID).',
    ],
    ['net::ERR_BLOCKED_BY_CLIENT', 'DorkOS doesn’t open this page (ERR_BLOCKED_BY_CLIENT).'],
    [
      'net::ERR_BLOCKED_BY_ADMINISTRATOR',
      'northwind.example is blocked (ERR_BLOCKED_BY_ADMINISTRATOR).',
    ],
    [
      'net::ERR_TOO_MANY_REDIRECTS',
      'northwind.example redirects too many times (ERR_TOO_MANY_REDIRECTS).',
    ],
  ])('%s', (reason, sentence) => {
    const error = loadFailedError('https://northwind.example/pricing?token=made-up', reason);
    expect(error.code).toBe('load_failed');
    expect(error.message).toBe(`${sentence} Read the page again.`);
    expect(error.message).not.toContain('token');
  });

  it('says a host-free title even when the address can’t be read', () => {
    expect(loadFailedError('not a url', 'net::ERR_INTERNET_DISCONNECTED').message).toBe(
      'You’re offline (ERR_INTERNET_DISCONNECTED). Read the page again.'
    );
  });

  it('falls back to “didn’t load” when the title would need a host it doesn’t have', () => {
    expect(loadFailedError(undefined, 'net::ERR_NAME_NOT_RESOLVED').message).toBe(
      'The page didn’t load (ERR_NAME_NOT_RESOLVED). Read the page again.'
    );
  });

  it('names no cause the browser didn’t give', () => {
    expect(loadFailedError('https://northwind.example/', undefined).message).toBe(
      'northwind.example didn’t load. Read the page again.'
    );
  });
});
