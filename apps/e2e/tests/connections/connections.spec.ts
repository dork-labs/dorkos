import Database from 'better-sqlite3';
import { test, expect, type Page, type APIRequestContext, type TestInfo } from '@playwright/test';
import { BasePage } from '../../pages/BasePage.js';
import { ChatPage } from '../../pages/ChatPage.js';
import { ConnectionsPage } from '../../pages/ConnectionsPage.js';
import { RightPanelPage } from '../../pages/RightPanelPage.js';
import { describeViolation, runAxe, settleAnimations } from '../../axe.js';
import { registerOwnerManagementTests } from './owner-management.js';
import { registerEventNotificationTests } from './event-notifications.js';
import { registerChatConnectCardTests } from './chat-connect-card.js';

/**
 * Browser proof of canonical Connections resources, driven against the
 * test-mode server's scripted provider: real provider setup, durable
 * authentication, stable multi-account inventory, exact agent grants, and
 * effective session access.
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

/** Open /connections and wait for the app shell. */
export async function gotoConnections(page: Page): Promise<void> {
  await page.goto('/connections', { waitUntil: 'domcontentloaded' });
  await new BasePage(page).waitForAppReady();
}

test('popular apps are listed before anything is set up, and the first connect asks how once @smoke', async ({
  page,
}, testInfo) => {
  await gotoConnections(page);
  // Your own key is set in Settings › Connections; the page keeps one pointer there.
  await expect(
    page.getByRole('button', { name: 'Set it up in Settings › Connections' })
  ).toHaveCount(1);
  // The popular apps are rows in the list from the first visit: no dialog to
  // open, no search needed, and never "No app matches".
  const gmail = page.getByTestId('catalog-app-gmail');
  await expect(gmail).toContainText('Read, search and send email.');
  await expect(page.getByText('No app matches', { exact: false })).toHaveCount(0);
  await page.getByRole('button', { name: 'Connect Gmail' }).click();

  const dialog = page.getByRole('dialog', { name: 'Connect Gmail' });
  await expect(dialog).toContainText('First, pick how DorkOS reaches your apps.');
  const step = dialog.getByTestId('first-connect-step');
  await expect(step.getByRole('button', { name: /Use my Composio key/ })).toBeVisible();
  // Nango stays folded, and no sign-in can start before a way is set up.
  await expect(step.getByText(/My own Nango server/)).toBeHidden();
  await expect(dialog.getByRole('button', { name: 'Continue' })).toHaveCount(0);
  await dialog.screenshot({ path: testInfo.outputPath('first-connect-desktop.png') });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(step).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  );
  await page.screenshot({ path: testInfo.outputPath('first-connect-mobile.png') });
});

/**
 * Open Settings › Connections, where your own keys live (DOR-2419), and return
 * the "add a way" entry for the scripted provider. Nothing is set up yet in
 * these specs, so the choices are already open under "Or set one up here now".
 */
async function openKeySetup(page: Page) {
  await page.getByRole('button', { name: 'Set it up in Settings › Connections' }).click();
  const settings = page.getByTestId('settings-dialog');
  await expect(
    settings.getByRole('heading', { name: 'How DorkOS reaches your apps' })
  ).toBeVisible();
  return settings.getByTestId(`add-connection-way-${PROVIDER}`);
}

/**
 * Save the provider key through the real UI form and wait for the live
 * registration to land (the way's row says "Working"), then close Settings.
 */
async function saveKeyThroughUi(page: Page): Promise<void> {
  const settings = page.getByTestId('settings-dialog');
  const entry = settings.getByTestId(`add-connection-way-${PROVIDER}`);
  if (!(await entry.isVisible())) await openKeySetup(page);
  await entry.getByLabel(/Test connector API key/i).fill('e2e-test-key');
  await entry.getByRole('button', { name: 'Save key' }).click();
  const row = settings.getByTestId(`connection-way-${PROVIDER}`);
  // exact: a substring match would also accept future copy like "Not working".
  await expect(row.getByText('Working', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
}

/**
 * Drive one connect through the dialog, asserting the consent order: the
 * custody sentence is on screen BEFORE the sign-in link is opened.
 *
 * @param page - The page, already on /connections with the service grid live.
 * @param label - The account label to submit.
 * @param opts - Optional durable-resume and visual-proof controls.
 */
async function connectGmail(
  page: Page,
  label: string,
  opts?: {
    proveReloadResume?: boolean;
    capture?: { testInfo: TestInfo; viewport: 'desktop' | 'phone' };
  }
): Promise<void> {
  // The first Gmail is a Connect in "All apps"; once one is connected, Gmail
  // lives in "Yours" and another account is added from its side panel.
  const connections = new ConnectionsPage(page);
  const connectRow = page.getByRole('button', { name: 'Connect Gmail' });
  if (await connectRow.isVisible()) {
    await connectRow.click();
  } else {
    await connections.openPanel('Gmail');
    const more = await connections.openMore();
    await more.getByRole('button', { name: 'Connect another Gmail account' }).click();
    await expect(connections.panel).toBeHidden();
  }

  let dialog = page.getByRole('dialog', { name: 'Connect Gmail' });
  await expect(dialog).toBeVisible();
  await settleAnimations(page);

  const labelInput = dialog.getByLabel(/Account label/i);
  await labelInput.fill(label);

  // The consent invariant: the server's custody sentence renders before the
  // flow starts. The test provider completes on its first real poll, while
  // the pending-link state stays covered by the component contract tests.
  const disclosure = dialog.locator('[data-testid="connect-disclosure"]');
  await expect(disclosure).toBeVisible();
  await expect(disclosure).toContainText(CUSTODY_FRAGMENT);
  if (opts?.capture) {
    if (opts.capture.viewport === 'desktop') {
      const close = dialog.getByRole('button', { name: 'Close' });
      await expect(close).toBeVisible();
      const [dialogBounds, closeBounds] = await Promise.all([
        dialog.boundingBox(),
        close.boundingBox(),
      ]);
      expect(dialogBounds).not.toBeNull();
      expect(closeBounds).not.toBeNull();
      expect(closeBounds!.x).toBeGreaterThan(dialogBounds!.x + dialogBounds!.width / 2);
      expect(closeBounds!.y).toBeLessThan(dialogBounds!.y + dialogBounds!.height / 3);

      const accessibility = await runAxe(page, '[data-testid="connect-auth-dialog"]');
      expect(
        accessibility.violations.map(describeViolation),
        'the authentication disclosure should have no automated accessibility violations'
      ).toEqual([]);
      await opts.capture.testInfo.attach('connections-auth-dialog-axe.json', {
        body: Buffer.from(JSON.stringify(accessibility, null, 2)),
        contentType: 'application/json',
      });
      await opts.capture.testInfo.attach('connections-auth-dialog-aria.txt', {
        body: Buffer.from(await dialog.ariaSnapshot()),
        contentType: 'text/plain',
      });
    }
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      await settleAnimations(page);
      await opts.capture.testInfo.attach(
        `connections-auth-${opts.capture.viewport}-${colorScheme}.png`,
        { body: await page.screenshot(), contentType: 'image/png' }
      );
    }
    await page.emulateMedia({ colorScheme: 'light' });
    await settleAnimations(page);
  }
  await dialog.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/(?:\?|&)flow=[^&]+/);

  // Polling reaches the scripted instant success.
  await expect(dialog.getByText('Gmail is connected')).toBeVisible({ timeout: 15_000 });
  await expect(dialog.getByRole('heading', { name: 'Who can use Gmail?' })).toBeVisible();

  if (opts?.proveReloadResume) {
    await page.reload();
    dialog = page.getByRole('dialog', { name: 'Connect Gmail' });
    await expect(dialog.getByText('Gmail is connected')).toBeVisible({ timeout: 15_000 });
  }

  // The exact per-action editor stays one link away from the simple card.
  await dialog.getByRole('button', { name: 'Choose exact actions' }).click();
  const access = page.getByRole('dialog', { name: 'Choose agent access' });
  await expect(access).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(access).toBeHidden();
  await expect(page).not.toHaveURL(/(?:\?|&)flow=/);
}

/**
 * Arrange a connected "Gmail (work)" account through the API — the same routes
 * the UI drives, without re-walking the dialog the flow test already proves.
 * The PUT replaces the provider instance, so the account set starts empty.
 */
export async function connectWorkAccountViaApi(request: APIRequestContext): Promise<string> {
  const put = await request.put(CREDENTIAL_URL, { data: { secret: 'e2e-test-key' } });
  expect(put.ok()).toBe(true);

  const catalog = await request.get(`${API_URL}/api/connectors/catalog?q=gmail&limit=20`);
  expect(catalog.ok()).toBe(true);
  const catalogBody = (await catalog.json()) as {
    services: Array<{
      serviceSlug: string;
      intents: Array<{
        kind: 'messages' | 'account';
        routes?: Array<{ providerInstanceId: string }>;
      }>;
    }>;
  };
  const accountIntent = catalogBody.services
    .find((service) => service.serviceSlug === 'gmail')
    ?.intents.find((intent) => intent.kind === 'account');
  const providerInstanceId = accountIntent?.routes?.[0]?.providerInstanceId;
  expect(providerInstanceId).toBeTruthy();

  const start = await request.post(`${API_URL}/api/connectors/connections`, {
    data: {
      providerInstanceId,
      toolkit: 'gmail',
      label: 'work',
      idempotencyKey: `e2e-${crypto.randomUUID()}`,
    },
  });
  expect(start.ok()).toBe(true);
  const { flowId } = (await start.json()) as { flowId: string };

  // One poll completes the scripted flow and records the account binding.
  const poll = await request.get(`${API_URL}/api/connectors/authentication-flows/${flowId}`);
  expect(poll.ok()).toBe(true);
  const result = (await poll.json()) as { state: string; connectionId?: string };
  expect(result.state).toBe('connected');
  expect(result.connectionId).toBeTruthy();
  return result.connectionId!;
}

test.describe('Connections — save key, connect, multi-account', () => {
  test('walks unconfigured → key saved → connect Gmail twice with custody disclosed before every auth step', async ({
    page,
  }, testInfo) => {
    await gotoConnections(page);

    // Nothing connected yet: no Gmail row in "Yours", and Gmail waits in
    // "All apps" (the list is the empty state).
    const connections = new ConnectionsPage(page);
    await expect(connections.yourApp('Gmail')).toHaveCount(0);
    await expect(page.getByTestId('catalog-app-gmail')).toBeVisible();

    // Before any key: Settings › Connections has no way set up, and the
    // custody stance is disclosed on the key's entry BEFORE any key exists.
    const entry = await openKeySetup(page);
    await expect(entry).toBeVisible();
    await expect(entry).toContainText(CUSTODY_FRAGMENT);

    // Save the key → the provider registers live, no restart: the way's row
    // says Working and the scripted toolkits appear as service tiles.
    await saveKeyThroughUi(page);
    // Slack does two things, so its one row asks which, in plain words.
    await page.getByRole('button', { name: 'Connect Slack' }).click();
    const choice = page.getByTestId('app-use-choice');
    await expect(choice.getByRole('button', { name: /Let agents use my Slack/ })).toBeVisible();
    await choice.getByRole('button', { name: /Talk to my agents in Slack/ }).click();
    await expect(choice).toBeHidden();
    // A chat app goes straight to its own setup, never the account sign-in.
    const slackSetup = page.getByRole('dialog', { name: 'Add Slack' });
    await expect(slackSetup).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Connect Slack' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(slackSetup).toBeHidden();

    // First account: disclosure-before-URL is asserted inside connectGmail.
    await connectGmail(page, 'work', {
      proveReloadResume: true,
      capture: { testInfo, viewport: 'desktop' },
    });

    // The new account is a row in "Yours"; its side panel carries the server's
    // own custody sentence under More › How it's connected.
    await expect(connections.yourApp('Gmail', 'work')).toBeVisible();
    await connections.openPanel('Gmail', 'work');
    await expect(page).toHaveURL(/(?:\?|&)app=/);
    const more = await connections.openMore();
    await expect(more).toContainText(CUSTODY_FRAGMENT);
    await page.keyboard.press('Escape');
    await expect(connections.panel).toBeHidden();

    // Second account of the SAME service: the label input arrives pre-filled
    // with the suggested 'personal', and both rows are visibly distinct.
    await page.setViewportSize({ width: 390, height: 844 });
    await connectGmail(page, 'personal', { capture: { testInfo, viewport: 'phone' } });
    await page.setViewportSize({ width: 1280, height: 720 });
    // A second account of the same app is a second row.
    await expect(connections.yourApp('Gmail', 'work')).toBeVisible();
    await expect(connections.yourApp('Gmail', 'personal')).toBeVisible();

    await connections.yours.scrollIntoViewIfNeeded();
    const accessibility = await runAxe(page, '[aria-labelledby="connections-yours"]');
    expect(
      accessibility.violations.map(describeViolation),
      'the canonical account inventory should have no automated accessibility violations'
    ).toEqual([]);
    await testInfo.attach('connections-inventory-axe.json', {
      body: Buffer.from(JSON.stringify(accessibility, null, 2)),
      contentType: 'application/json',
    });
    await testInfo.attach('connections-inventory-aria.txt', {
      body: Buffer.from(await connections.yours.ariaSnapshot()),
      contentType: 'text/plain',
    });
    await page.emulateMedia({ colorScheme: 'light' });
    await settleAnimations(page);
    await testInfo.attach('connections-inventory-desktop-light.png', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    await page.emulateMedia({ colorScheme: 'dark' });
    await settleAnimations(page);
    await testInfo.attach('connections-inventory-desktop-dark.png', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });

    // The row is a keyboard target: Enter opens its panel, Escape closes it.
    const personalRow = connections.yourApp('Gmail', 'personal').getByRole('button').first();
    await personalRow.focus();
    await page.keyboard.press('Enter');
    await expect(connections.panel).toBeVisible();
    await expect(
      connections.panel.getByRole('heading', { name: 'Who can use Gmail?' })
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(connections.panel).toBeHidden();

    await page.setViewportSize({ width: 390, height: 844 });
    await connections.yours.scrollIntoViewIfNeeded();
    await expect(connections.yourApp('Gmail', 'work')).toBeVisible();
    await expect(connections.yourApp('Gmail', 'personal')).toBeVisible();
    await page.emulateMedia({ colorScheme: 'light' });
    await settleAnimations(page);
    await testInfo.attach('connections-inventory-phone-light.png', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    await page.emulateMedia({ colorScheme: 'dark' });
    await settleAnimations(page);
    await testInfo.attach('connections-inventory-phone-dark.png', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
  });
});

registerOwnerManagementTests({ apiUrl: API_URL, connectWorkAccountViaApi, gotoConnections });
registerEventNotificationTests({ apiUrl: API_URL, gotoConnections });
registerChatConnectCardTests({
  apiUrl: API_URL,
  enableTestConnector: async (request) => {
    const put = await request.put(CREDENTIAL_URL, { data: { secret: 'e2e-test-key' } });
    expect(put.ok()).toBe(true);
  },
});

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
    const row = group.locator('[data-testid^="session-connection-"]', {
      hasText: 'Gmail (work)',
    });
    await expect(row).toBeVisible();
    await expect(row.getByText('Inherited from agent')).toBeVisible();
    await expect(group.getByRole('button', { name: /attach|detach/i })).toHaveCount(0);

    // Arrange historical session-scoped authority in the isolated database.
    // The public UI intentionally has no attach/detach control; real queries and
    // rendering must still explain each retained session override accurately.
    const sessionUrl = page.url();
    const sessionId = new URL(sessionUrl).searchParams.get('session');
    expect(sessionId).toBeTruthy();
    const db = new Database(`/tmp/dorkos-test-mode-${MOCK_PORT}/dork.db`);
    try {
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO connection_operation_grants
        (id, subject_type, subject_id, agent_id, connection_id, operation_revision_id,
          created_by, created_at) VALUES (?, 'session', ?, ?, ?, ?, 'e2e-session-fixture', ?)`
      ).run(crypto.randomUUID(), sessionId, agentId, connectionId, read!.operationRevisionId, now);
      db.prepare(
        `INSERT INTO session_connection_overrides
        (session_id, agent_id, connection_id, state, updated_at) VALUES (?, ?, ?, 'attached', ?)`
      ).run(sessionId, agentId, connectionId, now);
      await page.reload();
      await rightPanel.open();
      await page.getByRole('tab', { name: 'Session', exact: true }).click();
      await expect(row.getByText('Allowed only in this session')).toBeVisible();
      const scoped = await request.get(
        `${API_URL}/api/connectors/sessions/${sessionId}/connections`
      );
      expect(scoped.ok()).toBe(true);
      expect(await scoped.json()).toMatchObject({
        connections: [
          expect.objectContaining({
            connectionId,
            access: 'session_only',
            operationRevisionIds: [read!.operationRevisionId],
          }),
        ],
      });
      db.prepare(
        `UPDATE session_connection_overrides SET state = 'detached'
        WHERE session_id = ? AND connection_id = ?`
      ).run(sessionId, connectionId);
      await page.reload();
      await rightPanel.open();
      await page.getByRole('tab', { name: 'Session', exact: true }).click();
      await expect(row.getByText('Disabled in this session')).toBeVisible();
      await expect(row.getByText('This session is blocked from using the account.')).toBeVisible();
      // Arrange a pending hosted acknowledgement without a live hosted account.
      // This is a persistence/status fixture, not a proof of hosted delivery.
      const commandId = crypto.randomUUID();
      db.prepare(
        `INSERT INTO connector_managed_authority_outbox
        (command_id, connection_id, provider_instance_id, execution_config_generation,
         owner_kind, owner_id, managed_connection_id, scope_kind, subject_id, scope_version,
         request_hash, request_json, state, next_attempt_at, created_at, updated_at)
        SELECT ?, c.id, p.id, p.execution_config_generation, p.owner_kind, p.owner_id,
          c.external_account_ref, 'connection_lifecycle', 'connection', 1,
          'browser-status-fixture', '{}', 'pending', '2099-01-01T00:00:00.000Z', ?, ?
        FROM connections c JOIN connector_provider_instances p ON p.id = c.provider_instance_id
        WHERE c.id = ?`
      ).run(commandId, now, now, connectionId);
      db.prepare(
        `INSERT INTO connector_managed_authority_scopes
        (managed_connection_id, scope_kind, subject_id, scope_version, last_command_id,
          last_command_hash, updated_at)
        SELECT external_account_ref, 'connection_lifecycle', 'connection', 1, ?,
          'browser-status-fixture', ? FROM connections WHERE id = ?`
      ).run(commandId, now, connectionId);
      db.prepare(
        `UPDATE connector_provider_instances SET mode = 'managed'
        WHERE id = (SELECT provider_instance_id FROM connections WHERE id = ?)`
      ).run(connectionId);
      db.prepare(
        `UPDATE session_connection_overrides SET state = 'attached'
        WHERE session_id = ? AND connection_id = ?`
      ).run(sessionId, connectionId);
      await page.reload();
      await rightPanel.open();
      await page.getByRole('tab', { name: 'Session', exact: true }).click();
      await expect(row.getByText('Disabled in this session')).toBeVisible();
      await expect(row.getByText('Account access has not finished updating.')).toBeVisible();
      await expect(row.getByText(/actions available/)).toHaveCount(0);
      db.prepare(
        `UPDATE connector_managed_authority_outbox SET state = 'applied'
        WHERE command_id = ?`
      ).run(commandId);
      await page.reload();
      await rightPanel.open();
      await page.getByRole('tab', { name: 'Session', exact: true }).click();
      await expect(row.getByText('Allowed only in this session')).toBeVisible();
      db.prepare(`DELETE FROM connector_managed_authority_scopes WHERE last_command_id = ?`).run(
        commandId
      );
      db.prepare(`DELETE FROM connector_managed_authority_outbox WHERE command_id = ?`).run(
        commandId
      );
      db.prepare(
        `UPDATE connector_provider_instances SET mode = 'byo'
        WHERE id = (SELECT provider_instance_id FROM connections WHERE id = ?)`
      ).run(connectionId);
      // Restore inherited state before proving the owner editor link below.
      db.prepare(
        'DELETE FROM session_connection_overrides WHERE session_id = ? AND connection_id = ?'
      ).run(sessionId, connectionId);
    } finally {
      db.close();
    }

    // The retained session panel is status only. Its one action opens the
    // canonical owner workspace, where the exact connection and named agent
    // are reviewable rather than reconstructing consent from the session.
    await group.getByRole('button', { name: 'Manage agent access' }).click();
    await expect(page).toHaveURL(/\/connections/);
    const connections = new ConnectionsPage(page);
    const access = await connections.openAccess('Gmail', 'work');
    const agentAccess = access.getByRole('group', { name: /E2E Test Agent/ });
    const dorkBotAccess = access.getByRole('group', { name: /DorkBot/ });
    await expect(agentAccess).toContainText('Read');
    await expect(dorkBotAccess).toContainText('No access');
    await agentAccess.getByRole('button', { name: 'Advanced' }).click();
    await expect(access.getByRole('checkbox', { name: 'List for E2E Test Agent' })).toBeChecked();
  });
});
