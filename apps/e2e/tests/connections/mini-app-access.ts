import { cpSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

/**
 * The one page where a person lets a mini app read a connected app (DOR-3547,
 * Security S5, M-A and M-B). A sandboxed fixture mini app asks to read Gmail
 * from the scripted provider. The tests prove:
 *
 * - the decide page is a window no mini app code reaches: no extension
 *   script, frame or request is on it, and no service worker controls it;
 * - code in the app's own window (where a mini app's page half runs) can't
 *   fetch it, frame it, install a worker in front of it, or press Allow
 *   through a window it opened;
 * - Allow does nothing until the page has been visible and focused for a
 *   moment, then a real click on it gives the yes, and Revoke takes it back.
 *
 * "Code in the app's window" is `page.evaluate` on the app page: the same
 * window, `fetch` and cookies a mini app's page half runs with.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, '../../fixtures/extensions/mini-app-reader-fixture');
const EXT_ID = 'mini-app-reader-fixture';
const PAGE_PATH = `/api/connectors/mini-app-access/page?extension=${EXT_ID}&service=gmail`;

/**
 * Screenshots of the decide page for design review, light, dark and at 390px
 * wide, when a run asks for them. The viewport is put back after.
 *
 * @param page - The decide page, buttons on.
 * @param dir - Where the PNGs go.
 */
async function captureDecidePage(page: Page, dir: string): Promise<void> {
  const size = page.viewportSize();
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({
      path: path.join(dir, `mini-app-access-${scheme}.png`),
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({
      path: path.join(dir, `mini-app-access-390-${scheme}.png`),
      fullPage: true,
    });
  }
  await page.emulateMedia({ colorScheme: 'light' });
  if (size) await page.setViewportSize(size);
}

/** What the Connections module hands this one. */
export interface MiniAppAccessHarness {
  readonly apiUrl: string;
  readonly connectWorkAccountViaApi: (request: APIRequestContext) => Promise<string>;
  readonly gotoConnections: (page: Page) => Promise<void>;
}

interface AccessList {
  waiting: Array<{ extensionId: string; service: string }>;
  allowed: Array<{ approvalId: string; extensionId: string }>;
}

/**
 * Register the decide page's browser tests in the Connections spec, which owns
 * the scripted provider's accounts.
 *
 * @param harness - The spec's API address and account helpers.
 */
export function registerMiniAppAccessTests(harness: MiniAppAccessHarness): void {
  const access = async (request: APIRequestContext): Promise<AccessList> => {
    const res = await request.get(`${harness.apiUrl}/api/connectors/mini-app-access`);
    expect(res.ok(), await res.text()).toBe(true);
    return (await res.json()) as AccessList;
  };
  const allowedForFixture = async (request: APIRequestContext) =>
    (await access(request)).allowed.filter((row) => row.extensionId === EXT_ID);

  test.describe('A mini app asks to read an app', () => {
    let extensionDir: string | undefined;

    test.beforeAll(async ({ request }) => {
      const config = (await (await request.get(`${harness.apiUrl}/api/config`)).json()) as {
        dorkHome?: string;
      };
      expect(config.dorkHome, 'the leg reports its data directory').toBeTruthy();
      extensionDir = path.join(config.dorkHome as string, 'extensions', EXT_ID);
      cpSync(FIXTURE, extensionDir, { recursive: true });
      await request.post(`${harness.apiUrl}/api/extensions/reload`, { data: {} });
      const enabled = await request.post(`${harness.apiUrl}/api/extensions/${EXT_ID}/enable`, {
        data: {},
      });
      expect(enabled.ok(), await enabled.text()).toBe(true);
      // A person's yes to run it, pinned to these files: that is what lets it ask at all.
      const listed = (await (
        await request.get(`${harness.apiUrl}/api/extensions`)
      ).json()) as Array<{
        id: string;
        manifest: { version: string };
        digest?: string;
      }>;
      const shown = listed.find((ext) => ext.id === EXT_ID);
      const approved = await request.post(`${harness.apiUrl}/api/extensions/${EXT_ID}/approve`, {
        data: { version: shown?.manifest.version, expectedDigest: shown?.digest },
      });
      expect(approved.ok(), await approved.text()).toBe(true);
    });

    test.afterAll(async ({ request }) => {
      for (const row of await allowedForFixture(request)) {
        await request.post(
          `${harness.apiUrl}/api/connectors/mini-app-access/${row.approvalId}/revoke`,
          { data: {} }
        );
      }
      await request.post(`${harness.apiUrl}/api/extensions/${EXT_ID}/revoke`, { data: {} });
      await request.post(`${harness.apiUrl}/api/extensions/${EXT_ID}/disable`, { data: {} });
      if (extensionDir) rmSync(extensionDir, { recursive: true, force: true });
      await request.post(`${harness.apiUrl}/api/extensions/reload`, { data: {} });
    });

    test.beforeEach(async ({ request }) => {
      await harness.connectWorkAccountViaApi(request);
      const waiting = (await access(request)).waiting;
      expect(waiting).toContainEqual(
        expect.objectContaining({ extensionId: EXT_ID, service: 'gmail' })
      );
    });

    test('Needs you only links to the decide page, and no mini app code is on it', async ({
      page,
    }) => {
      await harness.gotoConnections(page);
      const row = page.getByTestId(`needs-you-mini-app-${EXT_ID}-gmail`);
      await expect(row).toContainText('Reader Fixture wants to read Gmail');
      await expect(
        page.getByTestId('needs-you').getByRole('button', { name: /^Allow/ })
      ).toHaveCount(0);

      const requests: string[] = [];
      page.on('request', (request) => requests.push(request.url()));
      await row.click();
      await expect(
        page.getByRole('heading', { name: 'Let Reader Fixture read Gmail?' })
      ).toBeVisible();
      expect(new URL(page.url()).pathname).toBe('/api/connectors/mini-app-access/page');
      expect(page.url()).not.toMatch(/decision|approve/u);

      const onPage = await page.evaluate(() => ({
        marker: (globalThis as { __miniAppReaderFixture?: string }).__miniAppReaderFixture,
        scripts: Array.from(document.scripts, (script) => new URL(script.src).pathname),
        frames: window.frames.length,
        worker: navigator.serviceWorker?.controller ?? null,
      }));
      expect(onPage).toEqual({
        marker: undefined,
        scripts: ['/api/connectors/mini-app-access/page.js'],
        frames: 0,
        worker: null,
      });
      expect(requests.filter((url) => /\/api\/ext\/|\/api\/extensions\//u.test(url))).toEqual([]);
      await expect(page.getByText('Made by Made-up Author.')).toBeVisible();
      await expect(page.getByText('gmail.messages.list')).toBeVisible();
    });

    test("the app's own window can't fetch, frame or put a worker in front of the page", async ({
      page,
    }) => {
      await harness.gotoConnections(page);
      const tried = await page.evaluate(
        async ({ pagePath, extId }) => {
          const fetched = await fetch(pagePath, { credentials: 'include' });
          const body = await fetched.text();
          const register = async (scope: string) => {
            try {
              await navigator.serviceWorker.register(`/api/ext/${extId}/sw.js`, { scope });
              return 'registered';
            } catch {
              return 'refused';
            }
          };
          const frame = document.createElement('iframe');
          frame.src = pagePath;
          document.body.append(frame);
          await new Promise((resolve) => setTimeout(resolve, 1500));
          let framed: string;
          try {
            framed = frame.contentDocument?.body?.innerHTML.includes('data-token')
              ? 'token'
              : 'no-token';
          } catch {
            framed = 'unreadable';
          }
          frame.remove();
          return {
            fetchStatus: fetched.status,
            fetchHasToken: body.includes('data-token'),
            ownScope: await register(`/api/ext/${extId}/`),
            rootScope: await register('/'),
            framed,
          };
        },
        { pagePath: PAGE_PATH, extId: EXT_ID }
      );
      expect(tried).toMatchObject({
        fetchStatus: 403,
        fetchHasToken: false,
        ownScope: 'refused',
        rootScope: 'refused',
      });
      expect(tried.framed).not.toBe('token');
    });

    test('a window the app opened has no handle on the page, and gives no yes', async ({
      page,
      request,
    }) => {
      await harness.gotoConnections(page);
      const popup = page.waitForEvent('popup');
      const reach = page.evaluate(async (pagePath) => {
        const opened = window.open(pagePath, '_blank');
        await new Promise((resolve) => setTimeout(resolve, 2500));
        try {
          const button = opened?.document.querySelector<HTMLButtonElement>(
            'button[data-decision="approve"]'
          );
          button?.click();
          return button ? 'reached' : 'no-button';
        } catch {
          return 'blocked';
        }
      }, PAGE_PATH);
      const opened = await popup;
      expect(await reach).not.toBe('reached');
      await opened.close();
      expect(await allowedForFixture(request)).toEqual([]);
    });

    test('Allow waits for a visible, focused page, then a real click gives the yes', async ({
      page,
      request,
    }) => {
      await page.goto(PAGE_PATH);
      const allow = page.getByRole('button', { name: 'Allow' });
      // A click already on its way when the page appears lands on a button that is off.
      const box = await allow.boundingBox();
      expect(box).not.toBeNull();
      await expect(allow).toBeDisabled();
      await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
      await expect(page.getByRole('status')).toBeHidden();
      expect(await allowedForFixture(request)).toEqual([]);

      await expect(allow).toBeEnabled({ timeout: 5000 });
      // eslint-disable-next-line no-restricted-syntax -- E2E test config; no env.ts available
      const shotsDir = process.env.DORKOS_E2E_MINI_APP_SHOTS_DIR;
      if (shotsDir) await captureDecidePage(page, shotsDir);
      await allow.click();
      await expect(page.getByRole('status')).toContainText('Done.');
      const allowed = await allowedForFixture(request);
      expect(allowed).toHaveLength(1);

      // The yes shows on the account's panel, where Revoke takes it back.
      const revoked = await request.post(
        `${harness.apiUrl}/api/connectors/mini-app-access/${allowed[0]!.approvalId}/revoke`,
        { data: {} }
      );
      expect(revoked.ok()).toBe(true);
      expect(await allowedForFixture(request)).toEqual([]);
    });
  });
}
