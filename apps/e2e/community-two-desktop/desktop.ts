import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';

/**
 * The two packaged apps and the moves a person makes in them: launch (and
 * relaunch) a packaged DorkOS with its own home, connect it to a Community
 * through the real approval hand-off, and move between "this DorkOS" and a
 * Community with the context switcher.
 *
 * @module community-two-desktop/desktop
 */

/** One person's packaged DorkOS app. */
export interface Desktop {
  /** Short name used in evidence file names, e.g. `person-a`. */
  name: string;
  app: ElectronApplication;
  page: Page;
  /** The app's own local server, e.g. `http://localhost:4242`. */
  origin: string;
  /** The person's temporary home directory. */
  home: string;
  /** Where Electron keeps this app's data, always inside {@link home}. */
  userData: string;
}

/** Everything a launch needs that does not change between launches. */
export interface LaunchContext {
  executablePath: string;
  homeRoot: string;
  runRoot: string;
  /**
   * Every app this run has started, added the moment it launches, so the
   * runner can close (and photograph) one whose launch failed partway.
   */
  launched: ElectronApplication[];
  /**
   * Called after every launch. Playwright installs its own SIGINT/SIGTERM
   * handlers for Electron (they can't be turned off), and those exit the
   * process mid-cleanup; the runner uses this to take the signals back.
   */
  onLaunched: () => void;
}

/** The password every person in the journey uses; the accounts are disposable. */
export const PASSWORD = 'desktop-acceptance-password';

/**
 * Fetch JSON, failing loudly on anything but a 2xx.
 *
 * @param url - What to fetch.
 * @param init - Request options.
 */
export async function json<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const result = await fetch(url, init);
  assert(result.ok, `${init?.method ?? 'GET'} ${new URL(url).pathname}: ${result.status}`);
  return (result.status === 204 ? null : await result.json()) as T;
}

/**
 * Send a JSON body with the given method.
 *
 * @param method - The HTTP method.
 * @param body - The value to send as JSON.
 */
export const sendJson = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/**
 * Escape a string for use inside a regular expression.
 *
 * @param text - The literal text.
 */
export const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Launch one packaged DorkOS with its own home, or relaunch it on the home it
 * already has.
 *
 * A first launch skips first-run setup and settles the one-time prompts the
 * way a returning person would have, so a modal cannot hide the page from
 * assistive technology mid-journey. A relaunch does neither: whatever the app
 * shows after a restart is what the person would see.
 *
 * @param context - The executable and where homes and evidence live.
 * @param name - The person's short name; also the home folder's name.
 * @param relaunch - `true` to reopen an existing home rather than start a new one.
 */
export async function launchDesktop(
  context: LaunchContext,
  name: string,
  relaunch = false
): Promise<Desktop> {
  const home = path.join(context.homeRoot, name);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const app = await electron.launch({
    executablePath: context.executablePath,
    timeout: 180_000,
    env: {
      HOME: home,
      CFFIXED_USER_HOME: home,
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      SHELL: '/bin/zsh',
      TMPDIR: process.env.TMPDIR || '/tmp',
      LANG: 'en_US.UTF-8',
      DORKOS_DESKTOP_SUPPRESS_INSTALL_PROMPT: '1',
      // The scripted test runtime answers every agent turn: no model, no spend.
      DORKOS_TEST_RUNTIME: 'true',
      DORKOS_TEST_RUNTIME_CLAUDE_ALIAS: 'true',
      DORKOS_RELAY_ENABLED: 'true',
      DORKOS_SEARCH_NO_EXTERNAL_HISTORY: 'true',
    },
  });
  context.launched.push(app);
  context.onLaunched();
  const paths = await app.evaluate(({ app: electronApp, shell }) => {
    // Capture the Desktop's hand-off to the system browser without opening one.
    const g = globalThis as unknown as { __proofExternal: string[] };
    g.__proofExternal = [];
    shell.openExternal = async (url: string) => {
      g.__proofExternal.push(url);
    };
    return { home: electronApp.getPath('home'), userData: electronApp.getPath('userData') };
  });
  assert.equal(paths.home, home, 'the app runs in its own home');
  assert(paths.userData.startsWith(home + '/'), 'Electron data stays inside that home');
  const page = await app.firstWindow({ timeout: 180_000 });
  if (!relaunch) {
    const skip = page.getByRole('button', { name: 'Skip all setup', exact: true });
    await expect(skip).toBeVisible({ timeout: 180_000 });
    // The first click can land before the setup screen is interactive on a loaded machine.
    await expect(async () => {
      if (await skip.isVisible()) await skip.click();
      await expect(skip).toBeHidden({ timeout: 3000 });
    }).toPass({ timeout: 60_000 });
  } else {
    await page.waitForLoadState('domcontentloaded');
    await expect
      .poll(() => page.url(), { timeout: 180_000 })
      .toMatch(/^http:\/\/(localhost|127\.0\.0\.1):\d+\//);
  }
  const origin = new URL(page.url()).origin;
  const trail = path.join(context.runRoot, `${name}-network.log`);
  // A trail of every Community call and every failure, for diagnosis and step 19.
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (
      url.origin === origin &&
      (/community|communities|^\/api\/rooms\//.test(url.pathname) || response.status() >= 400)
    )
      appendFileSync(
        trail,
        `${new Date().toISOString()} ${response.request().method()} ${url.pathname}${url.search} ${response.status()}\n`
      );
  });
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame())
      appendFileSync(trail, `${new Date().toISOString()} NAV ${frame.url()}\n`);
  });
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning')
      appendFileSync(
        path.join(context.runRoot, `${name}-console.log`),
        `${new Date().toISOString()} ${message.type()} ${message.text()}\n`
      );
  });
  if (!relaunch) {
    const now = new Date().toISOString();
    await json(
      `${origin}/api/config`,
      sendJson('PATCH', {
        onboarding: { dismissedAt: now },
        profile: { rolePromptDismissedAt: now },
        telemetry: { userHasDecided: true },
        ui: { fullPowerDecidedAt: now, fullPowerChoice: 'supervised' },
      })
    );
    await page.reload();
  }
  return { name, app, page, origin, home, userData: paths.userData };
}

/**
 * The URLs this app has handed to the system browser so far.
 *
 * @param local - The app.
 */
export const externalOpens = (local: Desktop) =>
  local.app.evaluate(() =>
    (globalThis as unknown as { __proofExternal: string[] }).__proofExternal.slice()
  );

/**
 * Connect one app to one Community through the real approval hand-off: the
 * app gives the approval link to the system browser, and the person approves
 * it there, signing in first when that browser is signed out.
 *
 * @param local - The app that connects.
 * @param approver - The person's browser page on the Community.
 * @param origin - The Community's origin.
 * @param communityName - The Community's display name.
 * @param installName - What this installation is called on the Community.
 * @param signInEmail - The account to sign in with first, or `null` when already signed in.
 * @returns The new connection's local ref.
 */
export async function connectDesktop(
  local: Desktop,
  approver: Page,
  origin: string,
  communityName: string,
  installName: string,
  signInEmail: string | null
): Promise<string> {
  await local.page.goto(local.origin + '/connections?region=messaging');
  await expect(local.page.getByRole('heading', { name: 'Communities', exact: true })).toBeVisible({
    timeout: 60_000,
  });
  const before = (await externalOpens(local)).length;
  await local.page.getByLabel('Community address').fill(origin);
  await local.page.getByLabel('Name for this installation').fill(installName);
  const started = local.page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/community-connections'
  );
  await local.page.getByRole('button', { name: 'Connect community', exact: true }).click();
  const response = await started;
  assert.equal(response.status(), 201, 'connection start');
  const result = (await response.json()) as { approvalUrl: string; connection: { ref: string } };
  await local.page
    .getByRole('link', { name: `Open ${communityName} to approve`, exact: true })
    .click();
  await expect.poll(async () => (await externalOpens(local)).length).toBe(before + 1);
  const approval = (await externalOpens(local))[before];
  assert.equal(
    approval,
    result.approvalUrl,
    'the app hands the approval URL to the system browser'
  );
  await approver.goto(approval!);
  if (signInEmail) {
    await expect(
      approver.getByRole('button', { name: 'Sign in and review', exact: true })
    ).toBeVisible();
    await approver.getByLabel('Email', { exact: true }).fill(signInEmail);
    await approver.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await approver.getByRole('button', { name: 'Sign in and review', exact: true }).click();
  }
  await approver.getByRole('button', { name: 'Approve connection', exact: true }).click();
  await expect(approver.getByRole('status')).toContainText('Approved');
  // The newest row for this Community, since an earlier, ended connection can share its name.
  const row = local.page.locator('li').filter({ hasText: communityName });
  await expect(row.getByText('Connected', { exact: true }).first()).toBeVisible({
    timeout: 90_000,
  });
  return result.connection.ref;
}

/**
 * The switcher trigger in the sidebar header (the name, or the icon at phone width).
 *
 * @param local - The app.
 */
export const trigger = (local: Desktop) => local.page.getByTestId('sidebar-header-block');

/**
 * Open the switcher; a click that lands before hydration is retried, never skipped.
 *
 * @param local - The app.
 * @param via - The trigger to click, when not the default one.
 */
export async function openSwitcher(local: Desktop, via: Locator = trigger(local)): Promise<void> {
  const label = local.page.getByText('Switch context', { exact: true });
  await expect(async () => {
    if (!(await label.isVisible())) await via.click();
    await expect(label).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 30_000 });
}

/**
 * The switcher's destination rows (menu rows on a desktop, radios in the phone sheet).
 *
 * @param local - The app.
 */
export const destinations = (local: Desktop) =>
  local.page.getByRole('menuitemradio').or(local.page.getByRole('radio'));

/**
 * Open the switcher with a pointer and pick a destination by visible name or index.
 *
 * @param local - The app.
 * @param target - A destination's name, or its position (0 is this DorkOS).
 */
export async function switchTo(local: Desktop, target: string | number): Promise<void> {
  await openSwitcher(local);
  const item =
    typeof target === 'number'
      ? destinations(local).nth(target)
      : destinations(local).filter({ hasText: new RegExp(escapeRegExp(target)) });
  await expect(item).toBeVisible();
  await item.click();
  await expect(local.page.getByText('Switch context', { exact: true })).toBeHidden();
}

/**
 * Open the switcher and step into the selected Community's "Manage" submenu.
 *
 * @param local - The app, with a Community selected.
 * @param communityName - That Community's name.
 */
export async function openManageMenu(local: Desktop, communityName: string): Promise<void> {
  await openSwitcher(local);
  const manage = local.page.getByRole('menuitem', { name: `Manage ${communityName}` });
  await expect(manage).toBeVisible();
  await expect(async () => {
    await manage.hover();
    await manage.press('ArrowRight');
    await expect(local.page.getByRole('menuitem', { name: /^Disconnect/ })).toBeVisible({
      timeout: 3000,
    });
  }).toPass({ timeout: 30_000 });
}

/**
 * The Community channel feed in an app.
 *
 * @param local - The app.
 */
export const feed = (local: Desktop) =>
  local.page.getByRole('feed', { name: 'Community messages' });

/**
 * The open thread's feed in an app.
 *
 * @param local - The app.
 */
export const threadFeed = (local: Desktop) =>
  local.page.getByRole('feed', { name: 'Community thread' });

/**
 * The message composer. It offers @mention completion, so it is a combobox, not a bare textbox.
 *
 * @param local - The app.
 * @param name - The composer's accessible name.
 */
export const composer = (local: Desktop, name: RegExp = /^Message /) =>
  local.page.getByRole('combobox', { name }).or(local.page.getByRole('textbox', { name })).first();

/**
 * The innermost element that holds a message's text and its own thread button.
 *
 * @param scope - The feed to look in.
 * @param text - The message text.
 */
export const messageRow = (scope: Locator, text: string) =>
  scope
    .locator('div, article, li')
    .filter({ hasText: text })
    .filter({ has: scope.page().getByRole('button', { name: /Reply in thread|Open thread/ }) })
    .last();

/**
 * Type a message into a composer and send it with Enter.
 *
 * @param box - The composer.
 * @param text - What to send.
 */
export async function send(box: Locator, text: string): Promise<void> {
  await box.click();
  await box.fill(text);
  await box.press('Enter');
}

/**
 * The conversation timeline, whose `data-landed-on` says where a reopened channel landed.
 *
 * @param local - The app.
 */
export const timeline = (local: Desktop) =>
  local.page.locator('[data-slot="conversation-timeline"]').first();

/** One Community connection as the local server lists it. */
export interface ConnectionRow {
  ref: string;
  status: string;
  label: string;
}

/**
 * The app's Community connections, straight from its local server.
 *
 * @param local - The app.
 */
export async function connections(local: Desktop): Promise<ConnectionRow[]> {
  return (await json<{ connections: ConnectionRow[] }>(`${local.origin}/api/community-connections`))
    .connections;
}
