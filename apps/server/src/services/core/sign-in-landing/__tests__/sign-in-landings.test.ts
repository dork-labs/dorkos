/**
 * The landing records a finished sign-in leaves for its page: what they keep,
 * how long, and where they send a browser.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

// Read per call, so each test can say whose server this is.
const mockEnv = vi.hoisted(() => ({ DORKOS_MANAGED_BY: undefined as 'desktop' | undefined }));
vi.mock('../../../../env.js', () => ({ env: mockEnv }));

import {
  LANDING_TTL_MS,
  MAX_LANDINGS,
  SignInLandingStore,
  landingLocation,
} from '../sign-in-landings.js';

const BASE = { service: 'mcp' as const, serviceName: 'Linear' };

afterEach(() => {
  mockEnv.DORKOS_MANAGED_BY = undefined;
});

describe('SignInLandingStore', () => {
  it('returns the conversation that asked as the way back', () => {
    const store = new SignInLandingStore();
    const id = store.record({ ...BASE, connected: true, originSessionId: 'abc-123' });
    expect(store.get(id)).toMatchObject({
      status: 'connected',
      resumesConversation: true,
      returnPath: '/session?session=abc-123',
      canRetry: false,
    });
  });

  it('leaves out a session id that is not a plain id, rather than escaping it', () => {
    const store = new SignInLandingStore();
    const id = store.record({ ...BASE, connected: true, originSessionId: 'x&settings=open' });
    const landing = store.get(id);
    expect(landing?.returnPath).toBeUndefined();
    expect(landing?.resumesConversation).toBe(false);
  });

  it('defaults a failure without a reason to "failed", and offers Try again only with a retry', () => {
    const store = new SignInLandingStore();
    const withRetry = store.record({
      ...BASE,
      connected: false,
      retry: async () => ({ kind: 'connected' }),
    });
    const without = store.record({ ...BASE, connected: false });
    expect(store.get(withRetry)).toMatchObject({ reason: 'failed', canRetry: true });
    expect(store.get(without)).toMatchObject({ reason: 'failed', canRetry: false });
    expect(store.retry(without)).toBeUndefined();
  });

  it('never restarts a sign-in that finished', () => {
    const store = new SignInLandingStore();
    const retry = vi.fn(async () => ({ kind: 'connected' as const }));
    const id = store.record({ ...BASE, connected: true, retry });
    expect(store.retry(id)).toBeUndefined();
    expect(retry).not.toHaveBeenCalled();
  });

  it('forgets a record once it expires', () => {
    let now = 1_000;
    const store = new SignInLandingStore(() => now);
    const id = store.record({ ...BASE, connected: true });
    now += LANDING_TTL_MS - 1;
    expect(store.get(id)).toBeDefined();
    now += 1;
    expect(store.get(id)).toBeUndefined();
  });

  it('keeps at most MAX_LANDINGS records, dropping the oldest', () => {
    const store = new SignInLandingStore();
    const first = store.record({ ...BASE, connected: true });
    for (let i = 0; i < MAX_LANDINGS; i++) store.record({ ...BASE, connected: true });
    expect(store.get(first)).toBeUndefined();
  });

  it('mints ids nobody can guess or reuse', () => {
    const store = new SignInLandingStore();
    const a = store.record({ ...BASE, connected: true });
    const b = store.record({ ...BASE, connected: true });
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('says the desktop app is the way back on a server the desktop app runs', () => {
    const store = new SignInLandingStore();
    expect(store.get(store.record({ ...BASE, connected: true }))?.returnSurface).toBe('browser');
    mockEnv.DORKOS_MANAGED_BY = 'desktop';
    expect(store.get(store.record({ ...BASE, connected: true }))?.returnSurface).toBe('desktop');
  });
});

describe('landingLocation', () => {
  it('is a relative path when this server serves the app', () => {
    expect(landingLocation('abc', { servesApp: true, cockpitOrigin: 'http://localhost:1' })).toBe(
      '/signed-in?landing=abc'
    );
  });

  it('is the configured app origin when the app is elsewhere (development)', () => {
    expect(
      landingLocation('abc', { servesApp: false, cockpitOrigin: 'http://localhost:6241' })
    ).toBe('http://localhost:6241/signed-in?landing=abc');
  });
});
