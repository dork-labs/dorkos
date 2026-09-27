import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { ChatPage } from '../../pages/ChatPage.js';

interface ChatConnectHarness {
  apiUrl: string;
  connectWorkAccountViaApi: (request: APIRequestContext) => Promise<string>;
  enableTestConnector: (request: APIRequestContext) => Promise<void>;
}

interface OwnerAgentRequest {
  requestId: string;
  status: string;
}

/** What the `connection-request` scenario's scripted call records. */
const REQUEST_INPUT = {
  version: 1,
  serviceSlug: 'gmail',
  reason: 'Summarise today’s inbox',
  requestedOperations: ['GMAIL_FETCH_EMAILS'],
  requestedEvents: [],
};

/**
 * Register the chat card cases (DOR-2415) inside the credential-sequential
 * Connections spec: an agent asks for Gmail mid-chat and the owner connects
 * and allows it from a card in the transcript, never visiting Connections.
 */
export function registerChatConnectCardTests(harness: ChatConnectHarness): void {
  test.describe('Connections — connect and allow from the chat', () => {
    test('connects the app and allows the agent from the card, then the turn carries on', async ({
      page,
      request,
    }) => {
      test.setTimeout(90_000);
      await harness.enableTestConnector(request);
      const agent = await seedAgent(request, harness.apiUrl);
      const { sessionId } = await openRequestingChat(page, request, harness.apiUrl, agent);
      const held = startHeldRequest(request, harness.apiUrl, sessionId, agent.agentDir);

      const card = page.getByTestId('chat-agent-request');
      await expect(card.getByRole('heading', { name: 'Connect Gmail' })).toBeVisible();
      await card.getByRole('button', { name: 'Connect Gmail' }).click();
      // The scripted sign-in finishes on its first check; the same card then asks
      // the one question left, about this one agent.
      await expect(
        card.getByRole('heading', { name: `Let ${agent.agentName} use Gmail?` })
      ).toBeVisible();
      await card.getByRole('button', { name: 'Allow' }).click();
      await expect(card.getByTestId('agent-request-receipt')).toHaveText(
        `Allowed ${agent.agentName} to use Gmail`
      );

      // The agent's held call got the real answer.
      const answer = await held;
      expect(answer.ok(), await answer.text()).toBe(true);
      expect(readMcpResult(await answer.json())).toMatchObject({ status: 'granted' });
      await releaseStep(request, harness.apiUrl, sessionId);
      await expect(
        page
          .getByTestId('transcript-feed')
          .getByText('Here’s today’s inbox: three things need you.')
      ).toBeVisible();

      // Server truth survives a reload, and the page's list agrees it is answered.
      await page.reload();
      await expect(
        page.getByTestId('chat-agent-request').getByTestId('agent-request-receipt')
      ).toHaveAttribute('data-status', 'granted');
      const pending = await request.get(
        `${harness.apiUrl}/api/connectors/agent-requests?state=pending`
      );
      const body = (await pending.json()) as { requests: OwnerAgentRequest[] };
      expect(body.requests).toEqual([]);
    });

    test('asks only "may it use it?" when the app is connected, and Not now tells the agent no', async ({
      page,
      request,
    }) => {
      test.setTimeout(90_000);
      await harness.connectWorkAccountViaApi(request);
      const agent = await seedAgent(request, harness.apiUrl);
      const { sessionId } = await openRequestingChat(page, request, harness.apiUrl, agent);
      const held = startHeldRequest(request, harness.apiUrl, sessionId, agent.agentDir);

      const card = page.getByTestId('chat-agent-request');
      await expect(
        card.getByRole('heading', { name: `Let ${agent.agentName} use Gmail?` })
      ).toBeVisible();
      await expect(card.getByRole('heading', { name: 'Connect Gmail' })).toHaveCount(0);
      await card.getByRole('button', { name: 'Not now' }).click();
      await expect(card.getByTestId('agent-request-receipt')).toHaveText(
        `${agent.agentName} wasn’t given Gmail`
      );
      const answer = await held;
      expect(readMcpResult(await answer.json())).toMatchObject({ status: 'denied' });
      await releaseStep(request, harness.apiUrl, sessionId);
    });
  });
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

/** Open a chat in the agent's folder whose next turn asks for Gmail, and send it. */
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
  await chat.sendAndLand('Summarise my inbox from today.');
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
