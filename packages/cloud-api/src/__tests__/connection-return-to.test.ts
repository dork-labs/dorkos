/**
 * `returnTo` on the managed-connection start request: where in the DorkOS app
 * the person started, so the finishing page can offer a way back.
 */
import { describe, expect, it } from 'vitest';

import { AuthenticationFlowRequestSchema, ConnectionReturnToSchema } from '../index.js';

describe('AuthenticationFlowRequestSchema.returnTo', () => {
  it('is optional, so a request without it parses exactly as before', () => {
    expect(AuthenticationFlowRequestSchema.parse({ toolkit: 'tk_0001' })).toEqual({
      toolkit: 'tk_0001',
    });
  });

  it('carries a dorkos: link into the desktop app and an app address', () => {
    for (const returnTo of [
      'dorkos://connections',
      'http://localhost:4242/connections',
      'https://app.example.invalid/connections',
    ]) {
      expect(AuthenticationFlowRequestSchema.parse({ toolkit: 'tk_0001', returnTo })).toEqual({
        toolkit: 'tk_0001',
        returnTo,
      });
    }
  });

  it('refuses a value that is not a link the app could be reached at', () => {
    for (const returnTo of [
      'javascript:alert(1)',
      '//app.example.invalid/connections',
      '/connections',
      'file:///etc/passwd',
      `https://app.example.invalid/${'a'.repeat(2048)}`,
    ]) {
      expect(ConnectionReturnToSchema.safeParse(returnTo).success, returnTo).toBe(false);
    }
  });

  it('is ignored by a service that predates it', () => {
    // A service built against the previous release reads the request with the
    // schema as it was then. Zod objects strip a key they do not define, so the
    // new field costs that service nothing: the request still starts.
    const previous = AuthenticationFlowRequestSchema.omit({ returnTo: true });
    expect(previous.parse({ toolkit: 'tk_0001', returnTo: 'dorkos://connections' })).toEqual({
      toolkit: 'tk_0001',
    });
  });
});
