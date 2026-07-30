import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { BasePage } from '../../pages/BasePage.js';
import { ChatPage } from '../../pages/ChatPage.js';
import { RightPanelPage } from '../../pages/RightPanelPage.js';

/**
 * Browser proof of the connector gateway (connector-completion spec §Detailed
 * Design 8, task E2), driven against the test-mode server's scripted
 * `test-connector` provider: the REAL credential routes, connect flow, custody
 * disclosures, and session attach — with no vendor anywhere.
 *
 * Runs in the `chromium-connections` project (baseURL = the test-mode Vite
 * client). ONE spec file on purpose, exactly like `chat-mock.spec.ts`: the
 * provider's credential and its accounts are server-global state, and the
 * "provider shows unconfigured" opening assertion is only true while no other
 * worker has saved the key — so this file opts back into sequential same-worker
 * execution and no sibling spec file may share the connector surface.
 */

// eslint-disable-next-line no-restricted-syntax -- E2E test config; no env.ts available
const MOCK_PORT = process.env.DORKOS_MOCK_PORT || '4243';
const API_URL = `http://localhost:${MOCK_PORT}`;

const PROVIDER = 'test-connector';
const CREDENTIAL_URL = `${API_URL}/api/connectors/providers/${PROVIDER}/credential`;

/**
 * A stable fragment of the managed-custody sentence (ADR `260718-045630`,
 * `custody-disclosure.ts`) — the copy every consent surface must show.
 */
const CUSTODY_FRAGMENT = 'login access in its own secure vault';

test.describe.configure({ mode: 'default' });

/**
 * Start every test from "no key saved": DELETE is idempotent and the reload it
 * triggers replaces the provider instance, so accounts from an earlier test (or
 * an earlier retry of THIS test) are gone too. This is what makes the
 * unconfigured-first assertions retry-safe.
 */
test.beforeEach(async ({ request }) => {
  const res = await request.delete(CREDENTIAL_URL);
  expect(res.ok()).toBe(true);
});

/** Open /connections and wait for the cockpit shell. */
async function gotoConnections(page: Page): Promise<void> {
  await page.goto('/connections', { waitUntil: 'domcontentloaded' });
  await new BasePage(page).waitForAppReady();
}

/**
 * Save the provider key through the real UI form and wait for the live
 * registration to land ("Ready" badge on the provider card).
 */
async function saveKeyThroughUi(page: Page): Promise<void> {
  const card = page.locator(`[data-testid="provider-card-${PROVIDER}"]`);
  await card.getByLabel(/Test connector API key/i).fill('e2e-test-key');
  await card.getByRole('button', { name: 'Save key' }).click();
  // exact: a substring match would also accept future copy like "Not Ready".
  await expect(card.getByText('Ready', { exact: true })).toBeVisible();
}

/**
 * Drive one connect through the dialog, asserting the consent order: the
 * custody sentence is on screen BEFORE the sign-in link is opened.
 *
 * @param page - The page, already on /connections with the service grid live.
 * @param label - The account label to submit.
 * @param expectPrefilled - Assert the label input arrives pre-filled with this
 *   value before typing (the multi-account suggestion).
 */
async function connectGmail(
  page: Page,
  label: string,
  opts?: { expectPrefilled?: string }
): Promise<void> {
  await page.locator('[data-testid="service-tile-gmail"]').getByRole('button').click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Connect Gmail')).toBeVisible();

  const labelInput = dialog.getByLabel(/Account label/i);
  if (opts?.expectPrefilled !== undefined) {
    // Multi-account made visible: a second account of one service starts with
    // a suggested label, so two connections never collide unnamed.
    await expect(labelInput).toHaveValue(opts.expectPrefilled);
  }
  await labelInput.fill(label);
  await dialog.getByRole('button', { name: 'Continue' }).click();

  // The consent invariant (spec §UX): the server's custody sentence renders
  // before anything opens. The sign-in link exists but has not been followed.
  const disclosure = dialog.locator('[data-testid="connect-disclosure"]');
  await expect(disclosure).toBeVisible();
  await expect(disclosure).toContainText(CUSTODY_FRAGMENT);

  // Only now open the sign-in page — a real click, a real new tab, landing on
  // the test-mode server's local no-op page.
  const popupPromise = page.waitForEvent('popup');
  await dialog.getByRole('link', { name: /Open the sign-in page/i }).click();
  const popup = await popupPromise;
  await expect(popup.getByRole('heading', { name: 'Signed in' })).toBeVisible();
  await popup.close();

  // Polling reaches the scripted instant success.
  await expect(dialog.getByText(`Gmail (${label}) is connected.`)).toBeVisible({
    timeout: 15_000,
  });
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toBeHidden();
}

/**
 * Arrange a connected "Gmail (work)" account through the API — the same routes
 * the UI drives, without re-walking the dialog the flow test already proves.
 * The PUT replaces the provider instance, so the account set starts empty.
 */
async function connectWorkAccountViaApi(request: APIRequestContext): Promise<void> {
  const put = await request.put(CREDENTIAL_URL, { data: { secret: 'e2e-test-key' } });
  expect(put.ok()).toBe(true);

  const start = await request.post(`${API_URL}/api/connectors/${PROVIDER}/connect`, {
    data: { toolkit: 'gmail', label: 'work' },
  });
  expect(start.ok()).toBe(true);
  const { flowId } = (await start.json()) as { flowId: string };

  // One poll completes the scripted flow and records the account binding.
  const poll = await request.get(`${API_URL}/api/connectors/flows/${flowId}`);
  expect(poll.ok()).toBe(true);
  expect(((await poll.json()) as { status: string }).status).toBe('connected');
}

test.describe('Connections — save key, connect, multi-account', () => {
  test('walks unconfigured → key saved → connect Gmail twice with custody disclosed before every auth step', async ({
    page,
  }) => {
    await gotoConnections(page);

    // Before any key: the provider card says so, and the service grid is
    // honestly empty (the raw-MCP baseline has no configured servers).
    const card = page.locator(`[data-testid="provider-card-${PROVIDER}"]`);
    await expect(card).toBeVisible();
    await expect(card.getByText('Not set up')).toBeVisible();
    // The custody stance is disclosed on the setup card BEFORE any key exists.
    await expect(card).toContainText(CUSTODY_FRAGMENT);
    await expect(page.getByText('No services to connect yet')).toBeVisible();

    // Save the key → the provider registers live, no restart: the badge flips
    // to Ready and the scripted toolkits appear as service tiles.
    await saveKeyThroughUi(page);
    await expect(page.locator('[data-testid="service-tile-gmail"]')).toBeVisible();
    await expect(page.locator('[data-testid="service-tile-slack"]')).toBeVisible();

    // First account: disclosure-before-URL is asserted inside connectGmail.
    await connectGmail(page, 'work');

    // The new account's row carries its own server-composed custody sentence.
    const workRow = page.locator('[data-testid^="account-row-"]', { hasText: 'Gmail (work)' });
    await expect(workRow).toBeVisible();
    await expect(workRow).toContainText(CUSTODY_FRAGMENT);

    // Second account of the SAME service: the label input arrives pre-filled
    // with the suggested 'personal', and both rows are visibly distinct.
    await connectGmail(page, 'personal', { expectPrefilled: 'personal' });
    await expect(
      page.locator('[data-testid^="account-row-"]', { hasText: 'Gmail (work)' })
    ).toBeVisible();
    await expect(
      page.locator('[data-testid^="account-row-"]', { hasText: 'Gmail (personal)' })
    ).toBeVisible();
  });
});

test.describe('Connections — session attach', () => {
  test('attaches Gmail (work) to a session, shows it with exposure state, and detaches', async ({
    page,
    request,
  }) => {
    await connectWorkAccountViaApi(request);

    // Mint a real test-mode session by sending one message.
    const scenario = await request.post(`${API_URL}/api/test/scenario`, {
      data: { name: 'simple-text' },
    });
    expect(scenario.ok()).toBe(true);
    const seed = await request.post(`${API_URL}/api/test/seed-agent`);
    const { agentDir } = (await seed.json()) as { agentDir: string };

    const chatPage = new ChatPage(page);
    await chatPage.goto(undefined, { dir: agentDir });
    await chatPage.sendMessage('Hello connectors');
    await expect(page).toHaveURL(/session=/);

    // The session's connector surface lives in the right panel's Session tab.
    const rightPanel = new RightPanelPage(page);
    await rightPanel.open();
    await page.getByRole('tab', { name: 'Session', exact: true }).click();
    const group = page.locator('[data-testid="session-connectors"]');
    await expect(group).toBeVisible();
    await expect(group.getByText('No accounts attached to this session.')).toBeVisible();

    // Attach: pick the account, read its custody sentence (the consent point
    // re-shows it), then confirm.
    await group.getByRole('button', { name: 'Attach account' }).click();
    await page
      .getByRole('list', { name: 'Connected accounts to attach' })
      .getByRole('button', { name: 'Gmail (work)' })
      .click();
    const attachDisclosure = page.locator('[data-testid="attach-disclosure"]');
    await expect(attachDisclosure).toBeVisible();
    await expect(attachDisclosure).toContainText(CUSTODY_FRAGMENT);
    await page.getByRole('button', { name: 'Attach', exact: true }).click();

    // The attached row lists the account with its tool-server exposure state:
    // the scripted provider exposes active accounts, so "tools on".
    const row = page.locator('[data-testid^="session-connector-"]', { hasText: 'Gmail (work)' });
    await expect(row).toBeVisible();
    await expect(row.getByText('tools on')).toBeVisible();

    // Detach removes it — one action, back to the quiet empty state.
    await row.getByRole('button', { name: 'Detach Gmail (work) from this session' }).click();
    await expect(row).toBeHidden();
    await expect(group.getByText('No accounts attached to this session.')).toBeVisible();
  });
});
