import { describe, expect, it } from 'vitest';
import { pageErrorKind, pageErrorTitle } from '../local-browser-page-error.js';

describe('pageErrorKind', () => {
  it.each([
    ['ERR_NAME_NOT_RESOLVED', 'name-not-found'],
    ['net::ERR_NAME_RESOLUTION_FAILED', 'name-not-found'],
    ['ERR_CONNECTION_REFUSED', 'no-response'],
    ['ERR_CONNECTION_RESET', 'no-response'],
    ['ERR_CONNECTION_TIMED_OUT', 'no-response'],
    ['ERR_TIMED_OUT', 'no-response'],
    ['ERR_INTERNET_DISCONNECTED', 'offline'],
    ['ERR_CERT_AUTHORITY_INVALID', 'certificate'],
    ['ERR_CERT_DATE_INVALID', 'certificate'],
    ['ERR_SSL_PROTOCOL_ERROR', 'certificate'],
    ['ERR_BLOCKED_BY_CLIENT', 'blocked-by-dorkos'],
    ['ERR_BLOCKED_BY_ADMINISTRATOR', 'blocked-by-policy'],
    ['ERR_NETWORK_ACCESS_DENIED', 'blocked-by-policy'],
    ['ERR_TOO_MANY_REDIRECTS', 'too-many-redirects'],
  ])('%s reads as %s', (code, kind) => {
    expect(pageErrorKind(code)).toBe(kind);
  });

  it('a cancelled load shows nothing', () => {
    expect(pageErrorKind('ERR_ABORTED')).toBeNull();
    expect(pageErrorKind('net::ERR_ABORTED')).toBeNull();
  });

  it('a code it doesn’t know is one a person can retry', () => {
    expect(pageErrorKind('ERR_EMPTY_RESPONSE')).toBe('no-response');
  });

  it('never treats an inherited object key as a cause', () => {
    expect(pageErrorKind('constructor')).toBe('no-response');
  });
});

describe('pageErrorTitle', () => {
  it.each([
    ['name-not-found', 'Can’t find northwind.example'],
    ['no-response', 'northwind.example didn’t respond'],
    ['offline', 'You’re offline'],
    ['certificate', 'This connection isn’t private'],
    ['blocked-by-dorkos', 'DorkOS doesn’t open this page'],
    ['blocked-by-policy', 'northwind.example is blocked'],
    ['too-many-redirects', 'northwind.example redirects too many times'],
    ['crashed', 'This page stopped working'],
  ] as const)('%s → %s', (kind, title) => {
    expect(pageErrorTitle(kind, 'northwind.example')).toBe(title);
  });
});
