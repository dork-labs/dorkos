/**
 * How a sign-in callback answers the browser: a redirect into the app, or, on
 * a production server with no app build, a page of its own.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const dist = vi.hoisted(() => ({ path: undefined as string | undefined, present: true }));
vi.mock('../client-dist.js', () => ({
  clientDistPath: () => dist.path,
  clientBuildPresent: () => dist.present,
}));

import { respondWithSignInLanding } from '../sign-in-landing-response.js';
import { getLocalCockpitOrigin } from '../../lib/trusted-origins.js';
import type { SignInLandingInput } from '../../services/core/sign-in-landing/sign-in-landings.js';

function answer(input: SignInLandingInput): Promise<Response> {
  const app = new Hono();
  app.get('/cb', (c) => respondWithSignInLanding(c, input));
  return Promise.resolve(app.request('/cb'));
}

beforeEach(() => {
  dist.path = undefined;
  dist.present = true;
});

describe('respondWithSignInLanding', () => {
  it('sends a development browser to the app on its dev server', async () => {
    const res = await answer({ service: 'mcp', serviceName: 'Linear', connected: true });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toMatch(
      new RegExp(`^${getLocalCockpitOrigin()}/signed-in\\?landing=[A-Za-z0-9_-]+$`)
    );
  });

  it('keeps a production browser on the host it called back on', async () => {
    dist.path = '/opt/dorkos/client';
    const res = await answer({ service: 'mcp', serviceName: 'Linear', connected: true });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toMatch(/^\/signed-in\?landing=[A-Za-z0-9_-]+$/);
  });

  it('answers with its own page when there is no app to show, escaping the name', async () => {
    dist.path = '/opt/dorkos/client';
    dist.present = false;
    const res = await answer({ service: 'mcp', serviceName: '<i>Lin</i>', connected: false });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('cache-control')).toBe('no-store');
    const page = await res.text();
    expect(page).toContain('prefers-color-scheme:dark');
    expect(page).toContain('Couldn’t finish signing in');
    expect(page).toContain('&lt;i&gt;Lin&lt;/i&gt;');
    expect(page).not.toContain('<i>Lin');
    expect(page).not.toContain('<script');
  });
});
