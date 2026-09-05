import type { Server } from 'node:http';
import { test, expect } from '../../fixtures';
import {
  APP_READY,
  DEEP_PATH,
  openInCanvasBrowser,
  reserveClosedPort,
  startDevServer,
} from '../../pages/canvas-dev-server';

/**
 * The app as it ships, under the policy it ships with.
 *
 * ## Why this file exists
 *
 * Every other spec in this suite loads the app from a Vite dev server, which
 * serves its own shell with NO `Content-Security-Policy` header. The shipped
 * policy (`SHELL_CSP` in `apps/server/src/app.ts`) goes out only with the built
 * shell an `NODE_ENV=production` server serves — so until this file existed, a
 * directive that broke a real browser surface was invisible to the whole browser
 * suite and to CI. That is not hypothetical: DOR-560 shipped a `connect-src`
 * without `http:`, which makes the canvas report EVERY healthy dev server as
 * unreachable, and `workbench/dev-server-preview.spec.ts` would have stayed
 * green through it forever. A human driving a production server in Chromium by
 * hand is what caught it.
 *
 * The policy's other coverage, `apps/server/src/__tests__/app-spa-fallback.test.ts`,
 * pins the header byte for byte. That answers "did the string change"; it cannot
 * answer "can a browser still run the app under it", which is the question a
 * user's blank window actually asks. This file answers only the second one, and
 * deliberately does not restate the policy — one copy of that string, in the test
 * that owns it.
 *
 * ## Why it is a smoke subset
 *
 * Its leg has to build the client before it can serve anything, so it costs more
 * than every other leg in the suite and is opt-in outside CI (`E2E_PROD`). What
 * belongs here is only what the policy can silently take away: the shell booting
 * at all, and the canvas — the one surface whose reachability probe (`connect-src`)
 * and preview frame (`frame-src`) both read a CSP refusal as an ordinary failure.
 * Feature coverage belongs on the cockpit leg, where it is cheap.
 *
 * NEVER drive a turn here. This leg registers the real Claude Code runtime, so a
 * send would bill the machine's own sign-in — the same rule that keeps
 * `home-surface/team-room.spec.ts` off the cockpit leg.
 */

/** Console text Chromium emits when the policy refuses something. */
const CSP_REFUSAL = /Content Security Policy/i;

test.describe('The shipped shell — served by Express under the production CSP @smoke', () => {
  let devServer: Server;
  let devPort: number;

  test.beforeAll(async () => {
    const started = await startDevServer();
    devServer = started.server;
    devPort = started.port;
  });

  test.afterAll(async () => {
    await new Promise<void>((resolve) => devServer.close(() => resolve()));
  });

  test('boots the built app under a policy the server really sent', async ({ page }) => {
    /** Everything Chromium said the policy refused, in the order it said it. */
    const refusals: string[] = [];
    page.on('console', (message) => {
      if (CSP_REFUSAL.test(message.text())) refusals.push(message.text());
    });

    const shell = await page.goto('/');
    // The assertion that stops this whole project from passing vacuously: with
    // no header, every test below runs against exactly the same unprotected
    // shell the Vite legs already serve, and proves nothing about production.
    const policy = shell?.headers()['content-security-policy'];
    expect(policy, 'the production shell served no Content-Security-Policy').toBeTruthy();

    await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 15_000 });

    // A deep link is served by different Express machinery from `/` (the
    // sendFile fallback, not the static hit), so the header is set in two places
    // and can diverge in one. The server test pins the bytes; this pins that a
    // browser gets the SAME bytes whichever door it came through.
    const deepLink = await page.goto('/team');
    expect(deepLink?.headers()['content-security-policy']).toBe(policy);
    await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 15_000 });

    // Nothing the shell needs may be refused. Broader than any single directive
    // on purpose: this is the assertion that notices a tightening nobody
    // predicted, which is the class of bug this whole leg exists for.
    expect(refusals).toEqual([]);
  });

  test('frames a dev server running on this machine (DOR-560)', async ({ page, rightPanel }) => {
    const refusals: string[] = [];
    page.on('console', (message) => {
      if (CSP_REFUSAL.test(message.text())) refusals.push(message.text());
    });

    await openInCanvasBrowser(page, rightPanel, `http://localhost:${devPort}${DEEP_PATH}`);

    // Two directives are on trial here and both fail the same silent way. The
    // canvas first asks the BROWSER whether it can reach the dev server
    // (`canvas/lib/probe-direct.ts`, a plain-http fetch — `connect-src`), and a
    // policy refusal is indistinguishable there from a refused connection, so a
    // `connect-src` without `http:` reports the server below as absent and never
    // frames it. Then it frames the answer (`frame-src`). Waiting for the
    // fixture app's own painted element proves both got through.
    //
    // Measured, by dropping `http:` from `connect-src` and rerunning: this is
    // the assertion that goes red, and its message is what says why. A blocked
    // probe presents here as an empty canvas, never as a policy error — which
    // is the whole reason DOR-560 was invisible in the first place.
    const frame = page.frameLocator('iframe[title="Web Page"]');
    await expect(
      frame.getByTestId(APP_READY),
      'the canvas never framed a dev server that is definitely running — on this leg that is almost always the shipped policy refusing the reachability probe (connect-src) or the frame itself (frame-src)'
    ).toBeVisible({ timeout: 15_000 });
    expect(refusals).toEqual([]);
  });

  test('still calls a dead port dead, rather than blaming the policy', async ({
    page,
    rightPanel,
  }) => {
    // The negative control, and it is what makes the test above mean anything: a
    // policy that blocks the probe makes EVERY port look dead, so "the live one
    // framed" is only evidence when a genuinely dead one is still reported as
    // dead by the same code path.
    const deadPort = await reserveClosedPort();
    await openInCanvasBrowser(page, rightPanel, `http://localhost:${deadPort}/`);

    await expect(page.getByText(`Nothing is listening on localhost:${deadPort}.`)).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator('iframe[title="Web Page"]')).toHaveCount(0);
  });
});
