import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { ChatPage } from '../../pages/ChatPage.js';

interface ChatConnectHarness {
  apiUrl: string;
  enableTestConnector: (request: APIRequestContext) => Promise<void>;
}

interface OwnerAgentRequest {
  requestId: string;
  status: string;
}

/** What the `connection-request` scenario's scripted call records. */
const REQUEST_INPUT = {
  version: 1,
  serviceSlug: 'slack',
  reason: 'Summarise today’s messages',
  access: 'read',
  requestedEvents: [],
};

/**
 * Register the chat card cases (DOR-2415) inside the credential-sequential
 * Connections spec: an agent asks for Slack mid-chat and the owner connects
 * and allows it from a card in the transcript, never visiting Connections.
 */
export function registerChatConnectCardTests(harness: ChatConnectHarness): void {
  test.describe('Connections — connect and allow from the chat', () => {
    // The card's first question depends on which accounts of the app exist,
    // and this project's server is shared by every Connections case. Earlier
    // cases leave Gmail connected, disconnected and removed, and the scripted
    // provider re-mints the same account ids each time its key is saved again,
    // so a fresh Gmail sign-in here could land on an account an earlier case
    // closed. These cases use Slack, which no other case signs in to, and each
    // starts with no Slack account connected.
    test.beforeEach(async ({ request }) => {
      await harness.enableTestConnector(request);
      await disconnectSlackAccounts(request, harness.apiUrl);
    });

    test('connects the app and allows the agent from the card, then the turn carries on', async ({
      page,
      request,
    }) => {
      test.setTimeout(90_000);
      const agent = await seedAgent(request, harness.apiUrl);
      const { sessionId } = await openRequestingChat(page, request, harness.apiUrl, agent);
      const held = startHeldRequest(request, harness.apiUrl, sessionId, agent.agentDir);

      const card = page.getByTestId('chat-agent-request');
      await expect(card.getByRole('heading', { name: 'Connect Slack' })).toBeVisible();
      await card.getByRole('button', { name: 'Connect Slack' }).click();
      // The scripted sign-in finishes on its first check; the same card then asks
      // the one question left, about this one agent.
      await expect(
        card.getByRole('heading', { name: `Let ${agent.agentName} use Slack?` })
      ).toBeVisible();
      await card.getByRole('button', { name: 'Allow' }).click();
      await expect(card.getByTestId('agent-request-receipt')).toHaveText(
        `Allowed ${agent.agentName} to use Slack`
      );

      // The agent's held call got the real answer.
      const answer = await held;
      expect(answer.ok(), await answer.text()).toBe(true);
      expect(readMcpResult(await answer.json())).toMatchObject({ status: 'granted' });
      await releaseStep(request, harness.apiUrl, sessionId);
      await expect(
        page
          .getByTestId('transcript-feed')
          .getByText('Here’s today in Slack: three threads need you.')
      ).toBeVisible();

      // Server truth survives a reload, and the page's list agrees it is answered.
      await page.reload();
      await expect(
        page.getByTestId('chat-agent-request').getByTestId('agent-request-receipt')
      ).toHaveAttribute('data-status', 'granted');
      const pending = await request.get(
        `${harness.apiUrl}/api/connectors/agent-requests?state=pending&sessionId=${encodeURIComponent(sessionId)}`
      );
      const body = (await pending.json()) as { requests: OwnerAgentRequest[] };
      expect(body.requests).toEqual([]);
    });

    test('asks only "may it use it?" when the app is connected, and Not now tells the agent no', async ({
      page,
      request,
    }) => {
      test.setTimeout(90_000);
      await connectSlackViaApi(request, harness.apiUrl);
      const agent = await seedAgent(request, harness.apiUrl);
      const { sessionId } = await openRequestingChat(page, request, harness.apiUrl, agent);
      const held = startHeldRequest(request, harness.apiUrl, sessionId, agent.agentDir);

      const card = page.getByTestId('chat-agent-request');
      await expect(
        card.getByRole('heading', { name: `Let ${agent.agentName} use Slack?` })
      ).toBeVisible();
      await expect(card.getByRole('heading', { name: 'Connect Slack' })).toHaveCount(0);
      await card.getByRole('button', { name: 'Not now' }).click();
      await expect(card.getByTestId('agent-request-receipt')).toHaveText(
        `${agent.agentName} wasn’t given Slack`
      );
      const answer = await held;
      expect(readMcpResult(await answer.json())).toMatchObject({ status: 'denied' });
      await releaseStep(request, harness.apiUrl, sessionId);
    });
  });
}

/**
 * Register the case where no way to reach apps is set up yet (DOR-2494): the
 * agent's request is still taken, and the card runs the one-time step before
 * sign-in. The spec's own `beforeEach` deletes the key, so the case starts with
 * nothing set up and no Slack account.
 */
export function registerChatConnectFirstStepTests(harness: ChatConnectHarness): void {
  test.describe('Connections — asked for an app before anything is set up', () => {
    test('takes the request, shows the one-time step first, then signs in and allows', async ({
      page,
      request,
    }, testInfo) => {
      test.setTimeout(90_000);
      const agent = await seedAgent(request, harness.apiUrl);
      const { sessionId } = await openRequestingChat(page, request, harness.apiUrl, agent);
      const held = startHeldRequest(request, harness.apiUrl, sessionId, agent.agentDir);

      // Nothing reaches Slack yet, and the request was still recorded.
      const card = page.getByTestId('chat-agent-request');
      await expect(card.getByRole('heading', { name: 'Connect Slack' })).toBeVisible();
      await card.getByRole('button', { name: 'Connect Slack' }).click();
      const step = card.getByTestId('first-connect-step');
      await expect(step.getByRole('button', { name: /Use my Composio key/ })).toBeVisible();
      await card.screenshot({ path: testInfo.outputPath('first-step-card-desktop.png') });
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(step).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
      ).toBe(true);
      await card.screenshot({ path: testInfo.outputPath('first-step-card-phone.png') });
      await page.setViewportSize({ width: 1280, height: 800 });

      // A way gets set up (the scripted key stands in for the person's own);
      // the same request, read again, goes straight to sign-in and the question.
      await harness.enableTestConnector(request);
      await page.reload();
      const reloaded = page.getByTestId('chat-agent-request');
      await reloaded.getByRole('button', { name: 'Connect Slack' }).click();
      await expect(
        reloaded.getByRole('heading', { name: `Let ${agent.agentName} use Slack?` })
      ).toBeVisible();
      await reloaded.getByRole('button', { name: 'Allow' }).click();
      await expect(reloaded.getByTestId('agent-request-receipt')).toHaveText(
        `Allowed ${agent.agentName} to use Slack`
      );

      const answer = await held;
      expect(answer.ok(), await answer.text()).toBe(true);
      expect(readMcpResult(await answer.json())).toMatchObject({ status: 'granted' });
      await releaseStep(request, harness.apiUrl, sessionId);
    });
  });
}

/** Disconnect every Slack account still connected, so a case starts with none. */
async function disconnectSlackAccounts(request: APIRequestContext, apiUrl: string): Promise<void> {
  const list = await request.get(`${apiUrl}/api/connectors/connections`);
  expect(list.ok(), await list.text()).toBe(true);
  const { connections } = (await list.json()) as {
    connections: Array<{ connectionId: string; toolkit: string; lifecycle: string }>;
  };
  for (const connection of connections) {
    if (connection.toolkit !== 'slack' || connection.lifecycle === 'disconnected') continue;
    const removed = await request.delete(
      `${apiUrl}/api/connectors/connections/${encodeURIComponent(connection.connectionId)}`
    );
    expect(removed.ok(), await removed.text()).toBe(true);
  }
}

/** Sign in to Slack through the scripted provider, finishing on its first check. */
async function connectSlackViaApi(request: APIRequestContext, apiUrl: string): Promise<void> {
  const catalog = await request.get(`${apiUrl}/api/connectors/catalog?q=slack&limit=20`);
  expect(catalog.ok(), await catalog.text()).toBe(true);
  const { services } = (await catalog.json()) as {
    services: Array<{
      serviceSlug: string;
      intents: Array<{ kind: string; routes?: Array<{ providerInstanceId: string }> }>;
    }>;
  };
  const providerInstanceId = services
    .find((service) => service.serviceSlug === 'slack')
    ?.intents.find((intent) => intent.kind === 'account')?.routes?.[0]?.providerInstanceId;
  expect(providerInstanceId).toBeTruthy();
  const started = await request.post(`${apiUrl}/api/connectors/connections`, {
    data: {
      providerInstanceId,
      toolkit: 'slack',
      label: 'work',
      idempotencyKey: `e2e-${crypto.randomUUID()}`,
    },
  });
  expect(started.ok(), await started.text()).toBe(true);
  const { flowId } = (await started.json()) as { flowId: string };
  const poll = await request.get(`${apiUrl}/api/connectors/authentication-flows/${flowId}`);
  expect(poll.ok(), await poll.text()).toBe(true);
  expect(((await poll.json()) as { state: string }).state).toBe('connected');
}

async function seedAgent(
  request: APIRequestContext,
  apiUrl: string
): Promise<{ agentId: string; agentName: string; agentDir: string }> {
  const response = await request.post(`${apiUrl}/api/test/seed-agent`);
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { agentId: string; agentDir: string };
  return { agentId: body.agentId, agentDir: body.agentDir, agentName: 'E2E Test Agent' };
}

/** Open a chat in the agent's folder whose next turn asks for Slack, and send it. */
async function openRequestingChat(
  page: Page,
  request: APIRequestContext,
  apiUrl: string,
  agent: { agentDir: string }
): Promise<{ sessionId: string }> {
  const chat = new ChatPage(page);
  // The connection tool binds a turn as Claude Code, so the chat is opened on
  // this leg's Claude-Code-typed scripted runtime: one session, one runtime.
  // A fresh conversation each time: the folder's last one may still be open
  // from an earlier case.
  const sessionId = crypto.randomUUID();
  await chat.goto(sessionId, { dir: agent.agentDir, runtime: 'claude-code' });
  const bound = await request.post(`${apiUrl}/api/test/scenario`, {
    data: { name: 'connection-request', sessionId },
  });
  expect(bound.ok()).toBe(true);
  await chat.sendAndLand('Summarise my Slack from today.');
  return { sessionId };
}

/**
 * Open the REAL request through the agent's own connection tool, held open as a
 * live call waits for the owner. It resolves once the owner answers.
 */
function startHeldRequest(
  request: APIRequestContext,
  apiUrl: string,
  sessionId: string,
  agentPath: string
) {
  return request.post(`${apiUrl}/api/test/connectors/request`, {
    timeout: 60_000,
    data: { sessionId, agentPath, request: REQUEST_INPUT },
  });
}

async function releaseStep(
  request: APIRequestContext,
  apiUrl: string,
  sessionId: string
): Promise<void> {
  await expect
    .poll(async () => {
      const res = await request.post(`${apiUrl}/api/test/step`, { data: { sessionId } });
      return res.ok() && ((await res.json()) as { released: boolean }).released;
    })
    .toBe(true);
}

function readMcpResult(wire: unknown): Record<string, unknown> {
  const content = (wire as { content?: Array<{ type?: string; text?: string }> }).content;
  const text = content?.find((item) => item.type === 'text')?.text;
  expect(text).toBeTruthy();
  return JSON.parse(text!) as Record<string, unknown>;
}
