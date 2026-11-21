import { describe, expect, it } from 'vitest';
import type { RequestFacts } from '../../../../http/request-facts.js';
import { browserViewerPrincipal } from '../viewer-person.js';

function facts(headers: Record<string, string> = {}): RequestFacts {
  return {
    headers: { host: 'localhost', 'x-client-id': 'app-window', ...headers },
    peerAddress: '127.0.0.1',
    forwardedAddress: '127.0.0.1',
    connectionEncrypted: false,
    ingress: 'direct',
    agentIdentity: undefined,
    user: { userId: 'owner', credential: 'cookie', sessionId: 'cookie-session' },
  };
}

describe('browser viewer person boundary', () => {
  it('uses server session identity and the app instance after the shared owner bar passes', () => {
    expect(browserViewerPrincipal(facts(), true)).toEqual({
      ownerId: 'owner',
      sessionId: 'cookie-session',
      clientId: 'app-window',
    });
  });

  it.each([
    'x-dorkos-agent',
    'authorization',
    'x-api-key',
    'proxy-authorization',
    'x-dorkos-approval',
  ])('refuses %s even beside the owner cookie', (header) => {
    expect(browserViewerPrincipal(facts({ [header]: '' }), true)).toBeNull();
  });

  it('requires the shared owner bar and a proven session even on open local installs', () => {
    expect(browserViewerPrincipal(facts(), false)).toBeNull();
    expect(browserViewerPrincipal({ ...facts(), user: undefined }, true)).toBeNull();
    expect(
      browserViewerPrincipal({ ...facts(), user: { userId: 'owner', credential: 'api-key' } }, true)
    ).toBeNull();
    expect(
      browserViewerPrincipal({ ...facts(), user: { userId: 'owner', credential: 'cookie' } }, true)
    ).toBeNull();
  });

  it('does not accept a missing or unbounded client instance', () => {
    expect(browserViewerPrincipal(facts({ 'x-client-id': '' }), true)).toBeNull();
    expect(browserViewerPrincipal(facts({ 'x-client-id': 'x'.repeat(129) }), true)).toBeNull();
  });
});
