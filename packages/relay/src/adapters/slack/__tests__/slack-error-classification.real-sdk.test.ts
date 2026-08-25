/**
 * Real-SDK coverage for the Slack adapter's fatal-error classification.
 *
 * `slack-adapter.test.ts` mocks `@slack/web-api` and `@slack/bolt` wholesale,
 * including a hand-written stand-in for `WebAPIPlatformError`. That means
 * every `instanceof WebAPIPlatformError` check in that suite is asserted
 * against the mock class, not the real one — a real-SDK export rename, a
 * changed `data` shape, or a changed `code` constant would sail through it
 * unnoticed (DOR-1543).
 *
 * This file deliberately imports the real `@slack/web-api` and `@slack/bolt`
 * — no `vi.mock()` of either — and drives `findPlatformError` /
 * `classifySlackError` against the genuine error shapes those SDKs produce,
 * including the wrapped shapes Bolt actually hands to `app.error`.
 *
 * @module relay/adapters/slack/__tests__/slack-error-classification.real-sdk
 */
import { describe, it, expect } from 'vitest';
import { WebAPIPlatformError } from '@slack/web-api';
import { App, AuthorizationError, MultipleListenerError, SocketModeReceiver } from '@slack/bolt';
import { findPlatformError, classifySlackError } from '../index.js';

describe('Slack error classification against the real SDKs', () => {
  it('WebAPIPlatformError is exported, constructible, and instanceof-checkable', () => {
    const error = new WebAPIPlatformError({ ok: false, error: 'invalid_auth' });

    expect(error).toBeInstanceOf(WebAPIPlatformError);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('slack_webapi_platform_error');
    expect(error.data.error).toBe('invalid_auth');
  });

  describe('findPlatformError', () => {
    it('finds a bare WebAPIPlatformError', () => {
      const platformError = new WebAPIPlatformError({ ok: false, error: 'invalid_auth' });
      expect(findPlatformError(platformError)).toBe(platformError);
    });

    it('finds the platform error nested in a real Bolt AuthorizationError (.original)', () => {
      // This is the shape that matters most in production: Bolt authorizes
      // every incoming event, so a revoked token funnels every event through
      // this wrapper (see the comment on findPlatformError in slack-adapter.ts).
      const platformError = new WebAPIPlatformError({ ok: false, error: 'token_revoked' });
      const authError = new AuthorizationError('authorize() failed', platformError);

      expect(authError).toBeInstanceOf(Error);
      expect(findPlatformError(authError)).toBe(platformError);
    });

    it('finds the platform error nested in a real Bolt MultipleListenerError (.originals[])', () => {
      const platformError = new WebAPIPlatformError({ ok: false, error: 'account_inactive' });
      const unrelated = new Error('some other listener blew up');
      const multiError = new MultipleListenerError([unrelated, platformError]);

      expect(multiError).toBeInstanceOf(Error);
      expect(findPlatformError(multiError)).toBe(platformError);
    });

    it('returns null when no platform error is nested anywhere', () => {
      expect(findPlatformError(new Error('plain error, no wrapping'))).toBeNull();
      expect(
        findPlatformError(new AuthorizationError('failed', new Error('not a platform error')))
      ).toBeNull();
    });
  });

  describe('classifySlackError', () => {
    it('classifies a bare fatal platform error as fatal, using its data.error', () => {
      const error = new WebAPIPlatformError({ ok: false, error: 'invalid_auth' });
      expect(classifySlackError(error)).toEqual({ errorCode: 'invalid_auth', fatal: true });
    });

    it('classifies a bolt-wrapped fatal platform error as fatal (regression guard for DOR-1528)', () => {
      // Before DOR-1528, this path read the wrapper's own `.code`
      // ('slack_bolt_authorization_error') instead of walking to the nested
      // platform error's `data.error` — so a dead token never matched a
      // fatal code and the adapter retried forever.
      const platformError = new WebAPIPlatformError({ ok: false, error: 'token_revoked' });
      const authError = new AuthorizationError('authorize() failed', platformError);

      expect(classifySlackError(authError)).toEqual({ errorCode: 'token_revoked', fatal: true });
    });

    it('classifies a bolt-wrapped non-fatal platform error as non-fatal', () => {
      const platformError = new WebAPIPlatformError({ ok: false, error: 'ratelimited' });
      const authError = new AuthorizationError('authorize() failed', platformError);

      expect(classifySlackError(authError)).toEqual({ errorCode: 'ratelimited', fatal: false });
    });

    it('classifies a MultipleListenerError wrapping a fatal platform error as fatal', () => {
      const platformError = new WebAPIPlatformError({ ok: false, error: 'app_uninstalled' });
      const multiError = new MultipleListenerError([new Error('unrelated'), platformError]);

      expect(classifySlackError(multiError)).toEqual({ errorCode: 'app_uninstalled', fatal: true });
    });

    it('classifies a plain, un-nested error as non-fatal with no errorCode', () => {
      expect(classifySlackError(new Error('socket hiccup'))).toEqual({
        errorCode: undefined,
        fatal: false,
      });
    });
  });

  // Regression guard for the DOR-1542 proxy wiring (real @slack/bolt, not the
  // mock in slack-adapter.test.ts): _start() supplies its own SocketModeReceiver
  // carrying a proxy dispatcher, alongside `socketMode: true`, so it can reach
  // the Socket Mode connection Bolt's own convenience path never exposes a way
  // to proxy. Bolt allows this combination today (App.initReceiver checks
  // `receiver instanceof SocketModeReceiver`) but nothing stops a future bolt
  // major from tightening that guard — if it ever throws, this is where a
  // proxy user would find out, not production.
  it('bolt accepts a custom SocketModeReceiver + dispatcher alongside socketMode: true', () => {
    const dispatcher = { dispatch: () => true };

    expect(
      () =>
        new App({
          token: 'xoxb-test-token',
          socketMode: true,
          receiver: new SocketModeReceiver({ appToken: 'xapp-test-token', dispatcher }),
          deferInitialization: true,
        })
    ).not.toThrow();
  });
});
