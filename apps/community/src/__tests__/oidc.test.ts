import { describe, expect, it } from 'vitest';
import { discoveryProblem } from '../oidc.js';

const endpoints = (origin: string) => ({
  authorization_endpoint: `${origin}/authorize`,
  token_endpoint: `${origin}/token`,
  jwks_uri: `${origin}/jwks`,
});

describe('discoveryProblem', () => {
  it('accepts the configured issuer with HTTPS endpoints, trailing slash or not', () => {
    // Purpose: fails if a correct document from a real issuer is refused.
    const issuer = 'https://id.example.com/realms/team';
    expect(discoveryProblem(issuer, { issuer, ...endpoints('https://id.example.com') })).toBeNull();
    expect(
      discoveryProblem(issuer, { issuer: `${issuer}/`, ...endpoints('https://login.example.com') })
    ).toBeNull();
  });

  it('refuses another issuer, a missing endpoint, or plain HTTP outside a local test issuer', () => {
    // Purpose: fails if codes or tokens could be sent to another issuer or over plain HTTP,
    // including a loopback HTTP endpoint behind an HTTPS issuer.
    const issuer = 'https://id.example.com';
    const good = { issuer, ...endpoints(issuer) };
    expect(discoveryProblem(issuer, { ...good, issuer: 'https://evil.example.com' })).toMatch(
      /different issuer/u
    );
    expect(discoveryProblem(issuer, { ...good, jwks_uri: undefined })).toMatch(/jwks_uri/u);
    expect(
      discoveryProblem(issuer, { ...good, token_endpoint: 'http://id.example.com/token' })
    ).toMatch(/not HTTPS/u);
    expect(
      discoveryProblem(issuer, { ...good, userinfo_endpoint: 'http://127.0.0.1:9/userinfo' })
    ).toMatch(/not HTTPS/u);
    expect(discoveryProblem(issuer, null)).toMatch(/not a discovery document/u);
  });

  it('allows loopback HTTP endpoints only for a loopback HTTP issuer', () => {
    // Purpose: fails if a local test issuer cannot be used, or if it may point off-machine.
    const issuer = 'http://127.0.0.1:9000';
    expect(discoveryProblem(issuer, { issuer, ...endpoints(issuer) })).toBeNull();
    expect(
      discoveryProblem(issuer, {
        issuer,
        ...endpoints(issuer),
        token_endpoint: 'http://example.com/t',
      })
    ).toMatch(/not HTTPS/u);
  });
});
