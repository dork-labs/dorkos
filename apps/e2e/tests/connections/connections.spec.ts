import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { BasePage } from '../../pages/BasePage.js';
import { ChatPage } from '../../pages/ChatPage.js';
import { ConnectionsPage } from '../../pages/ConnectionsPage.js';
import { RightPanelPage } from '../../pages/RightPanelPage.js';
import { registerOwnerManagementTests } from './owner-management.js';

/**
 * Browser proof of the connector gateway (connector-completion spec §Detailed
 * Design 8, task E2), driven against the test-mode server's scripted
 * `test-connector` provider: the REAL credential routes, connect flow, custody
 * disclosures, exact agent grants, and read-only session status — with no
 * provider-specific execution surface.
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
export async function gotoConnections(page: Page): Promise<void> {
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
export async function connectWorkAccountViaApi(request: APIRequestContext): Promise<string> {
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
  const result = (await poll.json()) as { status: string; account?: { id: string } };
  expect(result.status).toBe('connected');
  expect(result.account?.id).toBeTruthy();
  return result.account!.id;
}

test.describe('Connections — save key, connect, multi-account', () => {
  test('shows a verification-only connection without a sign-in claim', async ({
    page,
  }, testInfo) => {
    await gotoConnections(page);
    await saveKeyThroughUi(page);
    await page.route(`**/api/connectors/${PROVIDER}/connect`, async (route) => {
      await route.fulfill({
        json: {
          flowId: 'e2e-verification-only-flow',
          disclosure: 'This connection uses the server already configured in DorkOS.',
        },
      });
    });
    await page.route('**/api/connectors/flows/e2e-verification-only-flow', async (route) => {
      await route.fulfill({ json: { status: 'pending' } });
    });

    await page.locator('[data-testid="service-tile-gmail"]').getByRole('button').click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Continue' }).click();

    await expect(dialog.getByText('Checking the configured server…')).toBeVisible();
    await expect(dialog.getByRole('link', { name: /sign-in/i })).toHaveCount(0);
    await expect(
      dialog.getByText(/only if the server accepts the configured connection/i)
    ).toBeVisible();
    await testInfo.attach('verification-only-connect-dialog.png', {
      body: await dialog.screenshot(),
      contentType: 'image/png',
    });
  });

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
    // With nothing connectable, the region leads with its own first-run card
    // rather than an empty service grid (DOR-857) — the grid's own empty copy
    // is no longer what a person in this state is shown.
    await expect(page.getByText('Nothing can be connected yet')).toBeVisible();

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

registerOwnerManagementTests({ apiUrl: API_URL, connectWorkAccountViaApi, gotoConnections });

test.describe('Connections — session access status', () => {
  test('shows canonical agent access read-only and links to the exact access editor', async ({
    page,
    request,
  }) => {
    const connectionId = await connectWorkAccountViaApi(request);

    // Mint a real test-mode session by sending one message.
    const scenario = await request.post(`${API_URL}/api/test/scenario`, {
      data: { name: 'simple-text' },
    });
    expect(scenario.ok()).toBe(true);
    const seed = await request.post(`${API_URL}/api/test/seed-agent`);
    const { agentDir, agentId } = (await seed.json()) as { agentDir: string; agentId: string };

    // Give the seeded agent one exact immutable operation through the same
    // owner reconciliation boundary the Connections access dialog uses.
    const previewResponse = await request.post(
      `${API_URL}/api/connectors/reconciliation/previews`,
      { data: { connectionId } }
    );
    expect(previewResponse.ok()).toBe(true);
    const preview = (await previewResponse.json()) as {
      previewId: string;
      candidates: Array<{
        operationRevisionId: string;
        capabilityClassification: 'read' | 'write' | 'destructive';
      }>;
    };
    const read = preview.candidates.find(
      (candidate) => candidate.capabilityClassification === 'read'
    );
    expect(read).toBeTruthy();
    const apply = await request.post(`${API_URL}/api/connectors/reconciliation/apply`, {
      data: {
        previewId: preview.previewId,
        grants: [{ agentId, operationRevisionIds: [read!.operationRevisionId] }],
      },
    });
    expect(apply.ok()).toBe(true);

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
    const row = group.locator('[data-testid^="session-connector-"]', {
      hasText: 'Gmail (work)',
    });
    await expect(row).toBeVisible();
    await expect(row.getByText('Agent access')).toBeVisible();
    await expect(group.getByRole('button', { name: /attach|detach/i })).toHaveCount(0);

    // The retained session panel is status only. Its one action opens the
    // canonical owner workspace, where the exact connection and named agent
    // are reviewable rather than reconstructing consent from the session.
    await group.getByRole('button', { name: 'Manage agent access' }).click();
    await expect(page).toHaveURL(/\/connections/);
    const connections = new ConnectionsPage(page);
    const access = await connections.openAccess('Gmail (work)');
    await expect(access.getByRole('group', { name: 'E2E Test Agent' })).toBeVisible();
    await expect(access.getByRole('checkbox', { name: 'List for E2E Test Agent' })).toBeChecked();
    await expect(access.getByRole('checkbox', { name: 'List for DorkBot' })).not.toBeChecked();
  });
});
