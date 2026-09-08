import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test';
import { describeViolation, runAxe } from '../../axe.js';
import { ConnectionsPage } from '../../pages/ConnectionsPage.js';

const PROVIDER = 'composio';
const PROJECT_KEY = 'dorkos-offline-composio-project-key';
const WEBHOOK_SECRET = 'whsec_dorkos_offline_browser_fixture';
const PUBLIC_ORIGIN = 'https://offline-events.example';

interface EventBrowserHarness {
  apiUrl: string;
  gotoConnections: (page: Page) => Promise<void>;
}

interface ConnectionSummary {
  connectionId: string;
  label: string;
  lifecycle: string;
}

interface EventSubscription {
  id: string;
  state: string;
}

interface SeededAgent {
  agentDir: string;
  agentId: string;
}

interface OwnerAgentRequest {
  requestId: string;
  status: string;
  agent: { id: string; displayName: string };
}

/** Register real-route notification browser cases inside the credential-sequential suite. */
export function registerEventNotificationTests(harness: EventBrowserHarness): void {
  test.describe('Connections — account notifications', () => {
    test.beforeEach(async ({ request }) => {
      await cleanupComposio(request, harness.apiUrl);
      await setFixtureMode(request, harness.apiUrl, 'ready');
    });

    test.afterEach(async ({ request }) => {
      await cleanupComposio(request, harness.apiUrl);
    });

    test('uses exact consent, recovers pending setup, and reconciles a lost revoke response', async ({
      page,
      request,
    }, testInfo) => {
      test.setTimeout(90_000);
      const connectionId = await connectComposioGmail(request, harness.apiUrl, 'events work');
      await seedAgent(request, harness.apiUrl);
      await setFixtureMode(request, harness.apiUrl, 'unavailable');
      await harness.gotoConnections(page);

      const accountTrigger = new ConnectionsPage(page)
        .account('Gmail (events work)')
        .getByRole('button');
      const detail = await openAccount(page, 'Gmail (events work)');
      await detail.getByLabel('Public DorkOS address').fill(PUBLIC_ORIGIN);
      await detail.getByLabel('Signing secret').fill(WEBHOOK_SECRET);
      await detail.getByRole('button', { name: 'Save setup' }).click();
      await expect(detail.getByText('Webhook endpoint', { exact: true })).toBeVisible();
      await expect(detail.getByLabel('Signing secret')).toHaveValue('');

      await choose(page, detail, 'Account activity', 'New message');
      await choose(page, detail, 'Agent', 'E2E Test Agent');
      const createRequest = page.waitForRequest(
        (candidate) =>
          candidate.method() === 'POST' &&
          candidate
            .url()
            .endsWith(`/api/connectors/connections/${connectionId}/events/subscriptions`)
      );
      const createResponse = page.waitForResponse(
        (candidate) =>
          candidate.request().method() === 'POST' &&
          candidate
            .url()
            .endsWith(`/api/connectors/connections/${connectionId}/events/subscriptions`)
      );
      await detail.getByRole('button', { name: 'Set up notification' }).click();
      const [submitted, pendingResponse] = await Promise.all([createRequest, createResponse]);
      expect(pendingResponse.status()).toBe(202);
      expect(submitted.postDataJSON()).toMatchObject({
        agentId: expect.any(String),
        destination: { kind: 'agent', id: expect.any(String) },
        filter: {},
        manageExistingTrigger: false,
        requestId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      });
      expect(submitted.postDataJSON().destination.id).toBe(submitted.postDataJSON().agentId);
      const pendingRow = detail
        .getByTestId('connection-notification-list')
        .getByRole('listitem')
        .filter({ hasText: 'New message' });
      await expect(pendingRow.getByText('pending', { exact: true })).toBeVisible();
      await expect(pendingRow.getByText('active', { exact: true })).toHaveCount(0);

      await setFixtureMode(request, harness.apiUrl, 'ready');
      await expect(pendingRow.getByText('active', { exact: true })).toBeVisible({
        timeout: 45_000,
      });
      const ownerProjection = await request.get(
        `${harness.apiUrl}/api/connectors/connections/${connectionId}/events/subscriptions`
      );
      expect(ownerProjection.ok()).toBe(true);
      const projected = (await ownerProjection.json()) as {
        subscriptions: Array<Record<string, unknown>>;
      };
      expect(projected.subscriptions).toContainEqual(
        expect.objectContaining({
          connectionId,
          agentId: submitted.postDataJSON().agentId,
          destination: submitted.postDataJSON().destination,
          state: 'active',
        })
      );

      await choose(page, detail, 'Account activity', 'Message with unknown timing');
      await expect(
        detail.getByText('Delivery timing is unavailable', { exact: true })
      ).toBeVisible();
      await choose(page, detail, 'Agent', 'E2E Test Agent');
      await detail.getByRole('button', { name: 'Set up notification' }).click();
      const unknownRow = detail
        .getByTestId('connection-notification-list')
        .getByRole('listitem')
        .filter({ hasText: 'Message with unknown timing' });
      await expect(unknownRow.getByText('active', { exact: true })).toBeVisible();

      let unsupportedPosts = 0;
      page.on('request', (candidate) => {
        if (
          candidate.method() === 'POST' &&
          candidate
            .url()
            .endsWith(`/api/connectors/connections/${connectionId}/events/subscriptions`)
        ) {
          unsupportedPosts += 1;
        }
      });
      await choose(page, detail, 'Account activity', 'Message with unsupported filter');
      await expect(
        detail.getByText('This notification needs filter controls this app cannot safely show yet.')
      ).toBeVisible();
      await expect(detail.getByRole('button', { name: 'Set up notification' })).toBeDisabled();
      expect(unsupportedPosts).toBe(0);

      let revokeReachedServer = false;
      await page.route(
        `**/api/connectors/connections/${connectionId}/events/subscriptions/*`,
        async (route) => {
          if (route.request().method() !== 'DELETE') return route.continue();
          const response = await route.fetch();
          revokeReachedServer = response.status() === 204;
          await response.body();
          await route.abort('failed');
        }
      );
      await pendingRow.getByRole('button', { name: 'Remove New message' }).click();
      await expect(
        detail
          .getByRole('alert')
          .filter({ hasText: 'couldn’t confirm whether that notification was removed' })
      ).toBeVisible();
      expect(revokeReachedServer).toBe(true);
      await expect(pendingRow.getByText('revoked', { exact: true })).toBeVisible();
      await expect(pendingRow.getByRole('button', { name: 'Remove New message' })).toHaveCount(0);

      await attachNotificationProof(page, detail, testInfo, 'account-notifications');
      await page.keyboard.press('Escape');
      await expect(detail).toBeHidden();
      await expect(accountTrigger).toBeFocused();
    });

    test('keeps write-only setup and delayed decisions scoped to the selected account', async ({
      page,
      request,
    }) => {
      const accountA = await connectComposioGmail(request, harness.apiUrl, 'events A');
      const accountB = await connectComposioGmail(request, harness.apiUrl, 'events B');
      await seedAgent(request, harness.apiUrl);
      await configureSource(request, harness.apiUrl, accountA);
      await configureSource(request, harness.apiUrl, accountB);
      await harness.gotoConnections(page);

      let detail = await openAccount(page, 'Gmail (events A)');
      await detail.getByLabel('Signing secret').fill(`${WEBHOOK_SECRET}_unsaved`);
      await choose(page, detail, 'Account activity', 'New message');
      await choose(page, detail, 'Agent', 'E2E Test Agent');

      let releaseResponse!: () => void;
      const release = new Promise<void>((resolve) => {
        releaseResponse = resolve;
      });
      let serverProcessed!: () => void;
      const processed = new Promise<void>((resolve) => {
        serverProcessed = resolve;
      });
      let accountARequestId = '';
      await page.route(
        `**/api/connectors/connections/${accountA}/events/subscriptions`,
        async (route) => {
          const body = route.request().postDataJSON() as { requestId: string };
          accountARequestId = body.requestId;
          const response = await route.fetch();
          expect(response.status()).toBe(201);
          serverProcessed();
          await release;
          await route.fulfill({ response });
        }
      );
      await detail.getByRole('button', { name: 'Set up notification' }).click();
      await processed;
      await page.keyboard.press('Escape');
      detail = await openAccount(page, 'Gmail (events B)');
      await expect(detail.getByLabel('Signing secret')).toHaveValue('');
      await expect(detail.getByRole('combobox', { name: 'Account activity' })).toContainText(
        'Choose activity'
      );
      releaseResponse();
      await expect(detail.getByText(/New message is active/i)).toHaveCount(0);
      await expect(
        detail.getByTestId('connection-notification-list').getByText('New message', { exact: true })
      ).toHaveCount(0);

      await choose(page, detail, 'Account activity', 'New message');
      await choose(page, detail, 'Agent', 'E2E Test Agent');
      const accountBRequest = page.waitForRequest(
        (candidate) =>
          candidate.method() === 'POST' &&
          candidate.url().endsWith(`/api/connectors/connections/${accountB}/events/subscriptions`)
      );
      await detail.getByRole('button', { name: 'Set up notification' }).click();
      const submittedB = await accountBRequest;
      expect((submittedB.postDataJSON() as { requestId: string }).requestId).not.toBe(
        accountARequestId
      );
      await expect(
        detail
          .getByTestId('connection-notification-list')
          .getByRole('listitem')
          .filter({ hasText: 'New message' })
          .getByText('active', { exact: true })
      ).toBeVisible();
    });

    test('holds a real agent MCP request for one exact owner grant or denial', async ({
      page,
      request,
    }, testInfo) => {
      test.setTimeout(90_000);
      const connectionId = await connectComposioGmail(request, harness.apiUrl, 'agent work');
      const expectedAccountOrdinal = await latestFixtureAccountOrdinal(request, harness.apiUrl);
      await reconcileConnection(request, harness.apiUrl, connectionId);
      await configureSource(request, harness.apiUrl, connectionId);
      const agent = await seedAgent(request, harness.apiUrl);

      const grantedCall = startAgentRequest(request, harness.apiUrl, agent, {
        sessionId: crypto.randomUUID(),
        reason: 'Read new messages and continue when one arrives.',
      });
      const grantRequest = await waitForPendingAgentRequest(request, harness.apiUrl, agent.agentId);
      await harness.gotoConnections(page);
      const grantRequestTrigger = page.getByTestId(`agent-request-${grantRequest.requestId}`);
      await grantRequestTrigger.click();

      const dialog = page.getByRole('dialog', { name: 'Review agent access' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('combobox', { name: 'Account', exact: true })).toContainText(
        'agent work'
      );
      const notificationChoices = dialog.getByTestId('agent-request-event-scopes');
      await choose(page, notificationChoices, 'Account activity', 'New message');
      await expect(dialog.getByRole('button', { name: 'Grant access' })).toBeEnabled();
      await attachAgentRequestProof(page, dialog, testInfo);
      await dialog.getByRole('button', { name: 'Grant access' }).click();

      const grantedWire = await grantedCall;
      expect(grantedWire.ok(), await grantedWire.text()).toBe(true);
      const granted = readMcpResult(await grantedWire.json());
      expect(granted).toMatchObject({
        requestId: grantRequest.requestId,
        status: 'granted',
        connectionId,
        grantedOperationRevisionIds: [expect.any(String)],
        grantedEvents: ['GMAIL_NEW_MESSAGE'],
      });
      const operationRevisionId = (granted.grantedOperationRevisionIds as string[])[0]!;
      const execution = await executeAgentRead(
        request,
        harness.apiUrl,
        agent,
        connectionId,
        operationRevisionId
      );
      expect(execution.isError).not.toBe(true);
      expect(readMcpResult(execution)).toMatchObject({
        attemptCount: 1,
        result: {
          status: 'success',
          data: { messages: [{ subject: `Offline Gmail account ${expectedAccountOrdinal}` }] },
        },
      });
      await expect(dialog.getByTestId('agent-request-outcome')).toContainText('Granted');
      await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
      await expect(dialog).toBeHidden();
      await expect(page.getByRole('heading', { name: 'Agent requests' })).toBeFocused();

      const beforeDenial = await listSubscriptions(request, harness.apiUrl, connectionId);
      const deniedAgent = await seedDeniedAgent(request, harness.apiUrl);
      const deniedCall = startAgentRequest(request, harness.apiUrl, deniedAgent, {
        sessionId: crypto.randomUUID(),
        reason: 'Read more messages for an unrelated follow-up.',
      });
      const denyRequest = await waitForPendingAgentRequest(
        request,
        harness.apiUrl,
        deniedAgent.agentId,
        grantRequest.requestId
      );
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByTestId(`agent-request-${denyRequest.requestId}`).click();
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: 'Deny' }).click();

      const deniedWire = await deniedCall;
      expect(deniedWire.ok(), await deniedWire.text()).toBe(true);
      expect(readMcpResult(await deniedWire.json())).toMatchObject({
        requestId: denyRequest.requestId,
        status: 'denied',
      });
      expect(await listSubscriptions(request, harness.apiUrl, connectionId)).toEqual(beforeDenial);
      const refusedExecution = await executeAgentRead(
        request,
        harness.apiUrl,
        deniedAgent,
        connectionId,
        operationRevisionId
      );
      expect(refusedExecution).toMatchObject({ isError: true });
      expect(readMcpResult(refusedExecution)).toMatchObject({ code: 'CONNECTOR_GRANT_REQUIRED' });
    });
  });
}

async function executeAgentRead(
  request: APIRequestContext,
  apiUrl: string,
  agent: SeededAgent,
  connectionId: string,
  operationRevisionId: string
): Promise<Record<string, unknown>> {
  const response = await request.post(`${apiUrl}/api/test/connectors/execute-read`, {
    data: {
      sessionId: crypto.randomUUID(),
      agentPath: agent.agentDir,
      target: { connectionId, operationRevisionId, arguments: {} },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as Record<string, unknown>;
}

async function choose(
  page: Page,
  scope: ReturnType<Page['getByTestId']>,
  label: string,
  option: string
) {
  await scope.getByRole('combobox', { name: label }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

async function openAccount(page: Page, name: string) {
  const connections = new ConnectionsPage(page);
  await connections.account(name).getByRole('button').click();
  const detail = page.getByTestId('connection-detail');
  await expect(detail.getByRole('heading', { name, exact: true })).toBeVisible();
  return detail;
}

async function seedAgent(request: APIRequestContext, apiUrl: string): Promise<SeededAgent> {
  const result = await request.post(`${apiUrl}/api/test/seed-agent`);
  expect(result.ok(), await result.text()).toBe(true);
  return (await result.json()) as SeededAgent;
}

async function seedDeniedAgent(request: APIRequestContext, apiUrl: string): Promise<SeededAgent> {
  const result = await request.post(`${apiUrl}/api/test/seed-agent`, {
    data: { slot: 'denied-access' },
  });
  expect(result.ok(), await result.text()).toBe(true);
  return (await result.json()) as SeededAgent;
}

function startAgentRequest(
  request: APIRequestContext,
  apiUrl: string,
  agent: SeededAgent,
  input: { sessionId: string; reason: string }
): Promise<APIResponse> {
  return request.post(`${apiUrl}/api/test/connectors/request`, {
    timeout: 60_000,
    data: {
      sessionId: input.sessionId,
      agentPath: agent.agentDir,
      request: {
        version: 1,
        serviceSlug: 'gmail',
        reason: input.reason,
        requestedOperations: ['GMAIL_FETCH_EMAILS'],
        requestedEvents: ['GMAIL_NEW_MESSAGE'],
      },
    },
  });
}

async function waitForPendingAgentRequest(
  request: APIRequestContext,
  apiUrl: string,
  agentId: string,
  excludedRequestId?: string
): Promise<OwnerAgentRequest> {
  let found: OwnerAgentRequest | undefined;
  await expect
    .poll(
      async () => {
        const response = await request.get(`${apiUrl}/api/connectors/agent-requests?state=pending`);
        expect(response.ok(), await response.text()).toBe(true);
        const body = (await response.json()) as { requests: OwnerAgentRequest[] };
        found = body.requests.find(
          (candidate) => candidate.agent.id === agentId && candidate.requestId !== excludedRequestId
        );
        return found?.status;
      },
      { timeout: 10_000 }
    )
    .toBe('awaiting_owner');
  return found!;
}

function readMcpResult(wire: unknown): Record<string, unknown> {
  const content = (wire as { content?: Array<{ type?: string; text?: string }> }).content;
  const text = content?.find((item) => item.type === 'text')?.text;
  expect(text).toBeTruthy();
  return JSON.parse(text!) as Record<string, unknown>;
}

async function listSubscriptions(
  request: APIRequestContext,
  apiUrl: string,
  connectionId: string
): Promise<EventSubscription[]> {
  const response = await request.get(
    `${apiUrl}/api/connectors/connections/${connectionId}/events/subscriptions`
  );
  expect(response.ok(), await response.text()).toBe(true);
  return ((await response.json()) as { subscriptions: EventSubscription[] }).subscriptions;
}

async function connectComposioGmail(
  request: APIRequestContext,
  apiUrl: string,
  label: string
): Promise<string> {
  const credential = await request.put(
    `${apiUrl}/api/connectors/providers/${PROVIDER}/credential`,
    {
      data: { secret: PROJECT_KEY },
    }
  );
  expect(credential.ok(), await credential.text()).toBe(true);
  const catalog = await request.get(`${apiUrl}/api/connectors/catalog?q=gmail&limit=20`);
  expect(catalog.ok(), await catalog.text()).toBe(true);
  const body = (await catalog.json()) as {
    services: Array<{
      serviceSlug: string;
      intents: Array<{
        kind: string;
        routes?: Array<{ providerInstanceId: string; displayName: string }>;
      }>;
    }>;
  };
  const route = body.services
    .find((service) => service.serviceSlug === 'gmail')
    ?.intents.find((intent) => intent.kind === 'account')
    ?.routes?.find((candidate) => candidate.displayName.toLowerCase() === PROVIDER);
  expect(route).toBeTruthy();
  const started = await request.post(`${apiUrl}/api/connectors/connections`, {
    data: {
      providerInstanceId: route!.providerInstanceId,
      toolkit: 'gmail',
      label,
      idempotencyKey: crypto.randomUUID(),
    },
  });
  expect(started.status(), await started.text()).toBe(201);
  const flow = (await started.json()) as { flowId: string; authorizeUrl?: string };
  expect(flow.authorizeUrl).toBeTruthy();
  const consent = await request.post(flow.authorizeUrl!);
  expect(consent.ok(), await consent.text()).toBe(true);
  const completed = await request.get(
    `${apiUrl}/api/connectors/authentication-flows/${flow.flowId}`
  );
  expect(completed.ok(), await completed.text()).toBe(true);
  const result = (await completed.json()) as { state: string; connectionId?: string };
  expect(result.state).toBe('connected');
  expect(result.connectionId).toBeTruthy();
  return result.connectionId!;
}

async function configureSource(
  request: APIRequestContext,
  apiUrl: string,
  connectionId: string
): Promise<void> {
  const response = await request.put(
    `${apiUrl}/api/connectors/connections/${connectionId}/events/source`,
    { data: { publicOrigin: PUBLIC_ORIGIN, webhookSecret: WEBHOOK_SECRET } }
  );
  expect(response.ok(), await response.text()).toBe(true);
}

async function reconcileConnection(
  request: APIRequestContext,
  apiUrl: string,
  connectionId: string
): Promise<void> {
  const previewResponse = await request.post(`${apiUrl}/api/connectors/reconciliation/previews`, {
    data: { connectionId },
  });
  expect(previewResponse.ok(), await previewResponse.text()).toBe(true);
  const preview = (await previewResponse.json()) as { previewId: string };
  const applied = await request.post(`${apiUrl}/api/connectors/reconciliation/apply`, {
    data: { previewId: preview.previewId, grants: [] },
  });
  expect(applied.ok(), await applied.text()).toBe(true);
}

async function setFixtureMode(
  request: APIRequestContext,
  apiUrl: string,
  mode: 'ready' | 'unavailable'
): Promise<void> {
  const response = await request.post(`${apiUrl}/api/test/composio/events-state`, {
    data: { mode },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

async function latestFixtureAccountOrdinal(
  request: APIRequestContext,
  apiUrl: string
): Promise<number> {
  const response = await request.get(`${apiUrl}/api/test/composio/status`);
  expect(response.ok(), await response.text()).toBe(true);
  const { accountOrdinals } = (await response.json()) as { accountOrdinals: number[] };
  expect(accountOrdinals).toHaveLength(1);
  return accountOrdinals[0]!;
}

async function cleanupComposio(request: APIRequestContext, apiUrl: string): Promise<void> {
  const list = await request.get(`${apiUrl}/api/connectors/connections`);
  if (list.ok()) {
    const { connections } = (await list.json()) as { connections: ConnectionSummary[] };
    for (const connection of connections) {
      const detail = await request.get(
        `${apiUrl}/api/connectors/connections/${connection.connectionId}`
      );
      if (!detail.ok()) continue;
      const projection = (await detail.json()) as { provider: { displayName: string } };
      if (projection.provider.displayName.toLowerCase() !== PROVIDER) continue;
      const subscriptions = await request.get(
        `${apiUrl}/api/connectors/connections/${connection.connectionId}/events/subscriptions`
      );
      if (subscriptions.ok()) {
        const body = (await subscriptions.json()) as { subscriptions: EventSubscription[] };
        for (const subscription of body.subscriptions) {
          if (subscription.state !== 'active' && subscription.state !== 'pending') continue;
          const removed = await request.delete(
            `${apiUrl}/api/connectors/connections/${connection.connectionId}/events/subscriptions/${subscription.id}`
          );
          expect(removed.ok(), await removed.text()).toBe(true);
        }
      }
      if (connection.lifecycle !== 'disconnected') {
        const removed = await request.delete(
          `${apiUrl}/api/connectors/connections/${connection.connectionId}`
        );
        expect(removed.ok(), await removed.text()).toBe(true);
      }
    }
  }
  const credential = await request.delete(
    `${apiUrl}/api/connectors/providers/${PROVIDER}/credential`
  );
  expect(credential.ok(), await credential.text()).toBe(true);
}

async function attachNotificationProof(
  page: Page,
  detail: ReturnType<Page['getByTestId']>,
  testInfo: TestInfo,
  name: string
): Promise<void> {
  for (const viewport of [
    { name: 'desktop', width: 1280, height: 900 },
    { name: 'phone', width: 390, height: 844 },
  ] as const) {
    await page.setViewportSize(viewport);
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      await settleFiniteAnimations(detail);
      await expectSurfaceWithinViewport(page, detail);
      const accessibility = await runAxe(page, '[data-testid="connection-detail"]');
      expect(
        accessibility.violations.map(describeViolation),
        `the ${viewport.name} ${colorScheme} notification sheet should have no automated accessibility violations`
      ).toEqual([]);
      await testInfo.attach(`${name}-${viewport.name}-${colorScheme}-axe.json`, {
        body: Buffer.from(JSON.stringify(accessibility, null, 2)),
        contentType: 'application/json',
      });
      await testInfo.attach(`${name}-${viewport.name}-${colorScheme}-aria.txt`, {
        body: Buffer.from(await detail.ariaSnapshot()),
        contentType: 'text/plain',
      });
      await testInfo.attach(`${name}-${viewport.name}-${colorScheme}.png`, {
        body: await page.screenshot(),
        contentType: 'image/png',
      });
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
}

async function attachAgentRequestProof(
  page: Page,
  dialog: ReturnType<Page['getByRole']>,
  testInfo: TestInfo
): Promise<void> {
  await testInfo.attach('agent-request-event-scope.png', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
  const body = dialog.locator('[data-slot="responsive-dialog-body"]');
  await body.evaluate((element) => {
    element.scrollTop = 0;
  });
  await testInfo.attach('agent-request-event-scope-aria.txt', {
    body: Buffer.from(await dialog.ariaSnapshot()),
    contentType: 'text/plain',
  });
  for (const viewport of [
    { name: 'desktop', width: 1280, height: 900 },
    { name: 'phone', width: 390, height: 844 },
  ] as const) {
    await page.setViewportSize(viewport);
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      await body.evaluate((element) => {
        element.scrollTop = 0;
      });
      await settleFiniteAnimations(dialog);
      await expectSurfaceWithinViewport(page, dialog);
      const accessibility = await runAxe(page, '[data-testid="agent-request-dialog"]');
      expect(
        accessibility.violations.map(describeViolation),
        `the ${viewport.name} ${colorScheme} agent access review should have no automated accessibility violations`
      ).toEqual([]);
      await testInfo.attach(`agent-request-${viewport.name}-${colorScheme}-axe.json`, {
        body: Buffer.from(JSON.stringify(accessibility, null, 2)),
        contentType: 'application/json',
      });
      await testInfo.attach(`agent-request-${viewport.name}-${colorScheme}-aria.txt`, {
        body: Buffer.from(await dialog.ariaSnapshot()),
        contentType: 'text/plain',
      });
      await testInfo.attach(`agent-request-${viewport.name}-${colorScheme}.png`, {
        body: await page.screenshot(),
        contentType: 'image/png',
      });
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
  await focusWithKeyboard(page, dialog.getByRole('button', { name: 'Grant access' }));
}

async function expectSurfaceWithinViewport(page: Page, surface: Locator): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
      )
    )
    .toBe(true);
  const bounds = await surface.boundingBox();
  const viewport = page.viewportSize();
  expect(bounds).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(-1);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport!.width + 1);
}

async function focusWithKeyboard(page: Page, target: Locator): Promise<void> {
  for (let step = 0; step < 50; step += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  await expect(target).toBeFocused();
}

async function settleFiniteAnimations(locator: Locator): Promise<void> {
  await locator.evaluate(async (element) => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    const finite = element
      .getAnimations({ subtree: true })
      .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.allSettled(finite.map((animation) => animation.finished));
  });
}
