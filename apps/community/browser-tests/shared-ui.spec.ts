import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { test, expect, type Page, type Route } from '@playwright/test';

// Exercise the real built admission page with requests controlled at the browser boundary.
// No database or live account is involved; missing controls and missing generated CSS fail.
let server: ReturnType<typeof serve>;
let baseURL: string;
test.beforeAll(async () => {
  const root = fileURLToPath(new URL('../dist/', import.meta.url));
  const app = new Hono();
  app.use('*', serveStatic({ root }));
  app.get('*', serveStatic({ root, path: 'index.html' }));
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (address) => {
      baseURL = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});
test.afterAll(
  () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))
);

async function mockAdmission(page: Page, owner = false) {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/auth-options'))
      return route.fulfill({ json: { google: true, github: false, oidc: null } });
    if (path.endsWith('/community'))
      return route.fulfill(
        owner
          ? { status: 404, json: { code: 'NOT_FOUND' } }
          : { json: { id: 'ui', name: 'UI workshop', description: null, createdAt: '2026-09-23' } }
      );
    if (path.endsWith('/bootstrap/preflight')) return route.fulfill({ json: {} });
    return route.fulfill({
      status: 401,
      json: { code: 'UNAUTHORIZED', message: 'Sign in again.' },
    });
  });
}

for (const colorScheme of ['light', 'dark'] as const) {
  for (const width of [390, 1280]) {
    test(`sign-in controls, pending and error — ${colorScheme} ${width}`, async ({
      page,
    }, testInfo) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      await mockAdmission(page);
      let submitRoute: Route | undefined;
      await page.route('**/api/auth/sign-in/email', (route) => {
        submitRoute = route;
      });
      await page.goto(`${baseURL}/c/ui`);
      const email = page.getByLabel('Email', { exact: true });
      const password = page.getByLabel('Password', { exact: true });
      await expect(email).toHaveAttribute('data-slot', 'input');
      await expect(email).toHaveAttribute('autocomplete', 'email');
      await expect(password).toHaveAttribute('autocomplete', 'current-password');
      await expect(page.locator('[data-slot="field-label"]')).toHaveCount(2);
      await expect(page.getByRole('alert')).toHaveCount(0);
      await email.fill('member@example.test');
      await password.fill('test-password');
      await password.press('Enter');
      await expect(page.getByRole('button', { name: 'Working…' })).toBeDisabled();
      await expect.poll(() => submitRoute !== undefined).toBe(true);
      expect(submitRoute!.request().postDataJSON()).toEqual({
        email: 'member@example.test',
        password: 'test-password',
      });
      await submitRoute!.fulfill({
        status: 401,
        json: { message: 'Check your email and password.' },
      });
      await expect(page.getByRole('alert')).toHaveText('Check your email and password.');
      await expect(page.getByRole('alert')).toHaveAttribute('data-slot', 'notice');
      await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
      await email.focus();
      const styles = await email.evaluate((element) => ({
        height: element.getBoundingClientRect().height,
        font: getComputedStyle(element).fontSize,
        focus: getComputedStyle(element).boxShadow,
        overflow: document.documentElement.scrollWidth > innerWidth,
      }));
      expect(styles.height).toBe(width < 768 ? 44 : 36);
      expect(styles.font).toBe(width < 768 ? '16px' : '14px');
      expect(styles.focus).not.toBe('none');
      expect(styles.overflow).toBe(false);
      await page.screenshot({
        path: testInfo.outputPath('sign-in.png'),
        fullPage: true,
        animations: 'disabled',
      });
      // An explicit app choice wins over the OS in shared controls AND the legacy shell.
      for (const theme of ['light', 'dark']) {
        await page.evaluate((value) => {
          document.documentElement.className = value;
        }, theme);
        await expect
          .poll(() => page.getByRole('alert').evaluate((e) => getComputedStyle(e).color))
          .toBe(theme === 'light' ? 'rgb(202, 28, 39)' : 'rgb(250, 74, 66)');
        expect(
          await page.locator('body').evaluate((e) => getComputedStyle(e).backgroundColor)
        ).toBe(theme === 'light' ? 'rgb(246, 245, 242)' : 'rgb(21, 26, 23)');
      }
      expect(errors).toEqual([]);
    });
  }
}

test('owner preflight keeps heading focus and explicit submission', async ({ page }) => {
  await mockAdmission(page, true);
  await page.goto(`${baseURL}/setup`);
  await page.getByLabel('Setup secret').fill('fixture-secret');
  const next = page.getByRole('button', { name: 'Continue', exact: true });
  await expect(next).toHaveAttribute('type', 'submit');
  await next.click();
  await expect(page.getByRole('heading', { name: 'Make it yours.' })).toBeFocused();
  await expect(page.getByLabel('Your name')).toHaveAttribute('data-slot', 'input');
  await expect(page.getByLabel('First channel')).toHaveValue('general');
  await expect(page.getByRole('button', { name: 'Create community', exact: true })).toHaveAttribute(
    'type',
    'submit'
  );
  await expect(page.getByRole('button', { name: 'Create account', exact: true })).toHaveAttribute(
    'type',
    'button'
  );
});

test('invited member switches modes, uses social sign-in and recovers joining', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockAdmission(page);
  let signedIn = false;
  let attempts = 0;
  await page.route('**/invites/pending', (route) =>
    route.fulfill({
      json: {
        expiresAt: '2026-09-24T12:00:00Z',
        communityName: 'UI workshop',
        inviterName: 'Casey',
        channelName: 'general',
        account: signedIn ? { membership: 'none', boundToAnotherAccount: false } : null,
      },
    })
  );
  await page.route('**/api/auth/sign-in/social', (route) =>
    route.fulfill({ status: 503, json: { message: 'Social sign-in is unavailable.' } })
  );
  await page.route('**/api/auth/sign-in/email', (route) => {
    signedIn = true;
    return route.fulfill({ json: {} });
  });
  await page.route('**/invites/bind', (route) => route.fulfill({ json: { bound: true } }));
  await page.route('**/invites/redeem', (route) => {
    attempts++;
    return route.fulfill(
      attempts === 1 ? { status: 503, json: { message: 'Try joining again.' } } : { json: {} }
    );
  });
  await page.goto(`${baseURL}/c/ui/join`);
  await expect(page.getByLabel('Your name')).toBeVisible();
  await page.getByRole('button', { name: 'Sign in to this host', exact: true }).click();
  expect(signedIn).toBe(false);
  await expect(page.getByLabel('Your name')).toHaveCount(0);
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page.getByRole('alert')).toHaveText('Social sign-in is unavailable.');
  expect(signedIn).toBe(false);
  await page.getByLabel('Email', { exact: true }).fill('member@example.test');
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Join community', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('The community did not respond.');
  const retry = page.getByRole('button', { name: 'Try again', exact: true });
  // Unconverted recovery controls retain their existing class styling.
  expect(await retry.evaluate((e) => e.getBoundingClientRect().height)).toBeGreaterThanOrEqual(40);
  await retry.click();
  await expect(page.getByRole('heading', { name: 'You’re in UI workshop.' })).toBeFocused();
  expect(attempts).toBe(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
});
