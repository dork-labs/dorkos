import Database from 'better-sqlite3';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { ChatPage } from '../../pages/ChatPage.js';
import { ConnectionsPage } from '../../pages/ConnectionsPage.js';
import { RightPanelPage } from '../../pages/RightPanelPage.js';

interface SessionAccessHarness {
  apiUrl: string;
  /** The test-mode server's isolated database, where these tests arrange history. */
  databasePath: string;
  connectWorkAccountViaApi: (request: APIRequestContext) => Promise<string>;
}

/** What {@link arrangeChatWithAgentAccess} set up for one test. */
interface ChatWithAgentAccess {
  connectionId: string;
  agentId: string;
  agentDir: string;
  sessionId: string;
  /** The one read operation the seeded agent was granted account-wide. */
  readRevisionId: string;
}

/**
 * A connected "Gmail (work)", the seeded agent granted one exact read operation
 * through the same owner reconciliation boundary the Connections access dialog
 * uses, and a fresh conversation id of the test's own.
 *
 * The conversation is the test's own (DOR-2545): the seeded agent's folder is
 * shared with the chat-card cases (`chat-connect-card.ts`), and `/session?dir=` alone opens the
 * folder's newest conversation — theirs, still bound to the
 * `connection-request` scenario, whose held turn ran a whole test out of time.
 */
async function arrangeChatWithAgentAccess(
  harness: SessionAccessHarness,
  request: APIRequestContext
): Promise<ChatWithAgentAccess> {
  const connectionId = await harness.connectWorkAccountViaApi(request);

  const seed = await request.post(`${harness.apiUrl}/api/test/seed-agent`);
  const { agentDir, agentId } = (await seed.json()) as { agentDir: string; agentId: string };
  const sessionId = crypto.randomUUID();
  const scenario = await request.post(`${harness.apiUrl}/api/test/scenario`, {
    data: { name: 'simple-text', sessionId },
  });
  expect(scenario.ok()).toBe(true);

  const previewResponse = await request.post(
    `${harness.apiUrl}/api/connectors/reconciliation/previews`,
    {
      data: { connectionId },
    }
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
  const apply = await request.post(`${harness.apiUrl}/api/connectors/reconciliation/apply`, {
    data: {
      previewId: preview.previewId,
      grants: [{ agentId, operationRevisionIds: [read!.operationRevisionId] }],
    },
  });
  expect(apply.ok()).toBe(true);

  return { connectionId, agentId, agentDir, sessionId, readRevisionId: read!.operationRevisionId };
}

/**
 * Give the conversation historical chat-only access in the isolated database:
 * the agent's read operation granted to this chat alone, and the app attached.
 * The app never writes chat-only grants; real queries and rendering must still
 * explain each retained session override accurately.
 */
function insertChatOnlyAccess(db: Database.Database, chat: ChatWithAgentAccess): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO connection_operation_grants
    (id, subject_type, subject_id, agent_id, connection_id, operation_revision_id,
      created_by, created_at) VALUES (?, 'session', ?, ?, ?, ?, 'e2e-session-fixture', ?)`
  ).run(
    crypto.randomUUID(),
    chat.sessionId,
    chat.agentId,
    chat.connectionId,
    chat.readRevisionId,
    now
  );
  db.prepare(
    `INSERT INTO session_connection_overrides
    (session_id, agent_id, connection_id, state, updated_at) VALUES (?, ?, ?, 'attached', ?)`
  ).run(chat.sessionId, chat.agentId, chat.connectionId, now);
}

/** Remove this conversation's chat-only access, however far a test got. */
function removeChatOnlyAccess(db: Database.Database, chat: ChatWithAgentAccess): void {
  db.prepare(
    'DELETE FROM session_connection_overrides WHERE session_id = ? AND connection_id = ?'
  ).run(chat.sessionId, chat.connectionId);
  db.prepare(
    `DELETE FROM connection_operation_grants WHERE subject_type = 'session' AND subject_id = ?`
  ).run(chat.sessionId);
}

/**
 * Open the conversation, let its first turn end, and show its Session tab.
 *
 * The turn closes before anything else, so no later reload lands on a live
 * turn. Returns the Gmail (work) row of the chat's connector group.
 */
async function openChatAccess(page: Page, chat: ChatWithAgentAccess) {
  const chatPage = new ChatPage(page);
  await chatPage.goto(chat.sessionId, { dir: chat.agentDir });
  await chatPage.sendAndLand('Hello connectors');
  await chatPage.waitForTurnToEnd();
  await expect(page).toHaveURL(new RegExp(`session=${chat.sessionId}`));

  const rightPanel = new RightPanelPage(page);
  const showSessionTab = async () => {
    await rightPanel.open();
    await page.getByRole('tab', { name: 'Session', exact: true }).click();
  };
  await showSessionTab();
  const group = page.locator('[data-testid="session-connectors"]');
  await expect(group).toBeVisible();
  const row = group.locator('[data-testid^="session-connection-"]', { hasText: 'Gmail (work)' });
  await expect(row).toBeVisible();
  /** Reload to read state the database changed behind the app's back. */
  const reload = async () => {
    await page.reload();
    await showSessionTab();
  };
  return { group, row, reload };
}

/**
 * Arrange a pending hosted acknowledgement of this agent's own access, without
 * a live hosted account: the provider switched to managed mode and one pending
 * command in the outbox. A persistence/status fixture, not a proof of hosted
 * delivery.
 *
 * @returns The fixture command's id, for {@link removePendingHostedUpdate}.
 */
function arrangePendingHostedUpdate(db: Database.Database, chat: ChatWithAgentAccess): string {
  const commandId = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO connector_managed_authority_outbox
    (command_id, connection_id, provider_instance_id, execution_config_generation,
     owner_kind, owner_id, managed_connection_id, scope_kind, subject_id, scope_version,
     request_hash, request_json, state, next_attempt_at, created_at, updated_at)
    SELECT ?, c.id, p.id, p.execution_config_generation, p.owner_kind, p.owner_id,
      c.external_account_ref, 'agent_grants', ?, 1,
      'browser-status-fixture', '{}', 'pending', '2099-01-01T00:00:00.000Z', ?, ?
    FROM connections c JOIN connector_provider_instances p ON p.id = c.provider_instance_id
    WHERE c.id = ?`
  ).run(commandId, chat.agentId, now, now, chat.connectionId);
  db.prepare(
    `INSERT INTO connector_managed_authority_scopes
    (managed_connection_id, scope_kind, subject_id, scope_version, last_command_id,
      last_command_hash, updated_at)
    SELECT external_account_ref, 'agent_grants', ?, 1, ?,
      'browser-status-fixture', ? FROM connections WHERE id = ?`
  ).run(chat.agentId, commandId, now, chat.connectionId);
  db.prepare(
    `UPDATE connector_provider_instances SET mode = 'managed'
    WHERE id = (SELECT provider_instance_id FROM connections WHERE id = ?)`
  ).run(chat.connectionId);
  return commandId;
}

/**
 * Undo {@link arrangePendingHostedUpdate}, so neither a retry nor a later test
 * inherits a managed-mode provider or a pending hosted update.
 */
function removePendingHostedUpdate(
  db: Database.Database,
  chat: ChatWithAgentAccess,
  commandId: string
): void {
  db.prepare(`DELETE FROM connector_managed_authority_scopes WHERE last_command_id = ?`).run(
    commandId
  );
  db.prepare(`DELETE FROM connector_managed_authority_outbox WHERE command_id = ?`).run(commandId);
  db.prepare(
    `UPDATE connector_provider_instances SET mode = 'byo'
    WHERE id = (SELECT provider_instance_id FROM connections WHERE id = ?)`
  ).run(chat.connectionId);
}

/** Register the chat (session) access tests inside the credential-sequential Connections spec. */
export function registerSessionAccessTests(harness: SessionAccessHarness): void {
  // Three tests, not one, on purpose. As one test this ran six full page
  // reloads behind a chat setup of about 6.5 s. The merge-queue traces
  // (runs 36553260921, 36568080454) put each reload at 2.2–3.7 s on a CI
  // runner, plus 1.0–1.6 s to reopen the right panel, and show every step
  // succeeding in turn until the 30 s budget ran out wherever the test
  // happened to be. So every fixture a test can arrange before the chat opens
  // is arranged then, and no test below reloads more than once.
  test.describe('Connections — session access status', () => {
    test('explains a chat’s retained chat-only access, and when it is turned off', async ({
      page,
      request,
    }) => {
      const chat = await arrangeChatWithAgentAccess(harness, request);
      const db = new Database(harness.databasePath);
      try {
        // Arranged before the chat opens, so the first read already sees it.
        insertChatOnlyAccess(db, chat);
        const { row, reload } = await openChatAccess(page, chat);
        await expect(row.getByText('Allowed only in this session')).toBeVisible();
        const scoped = await request.get(
          `${harness.apiUrl}/api/connectors/sessions/${chat.sessionId}/connections`
        );
        expect(scoped.ok()).toBe(true);
        expect(await scoped.json()).toMatchObject({
          connections: [
            expect.objectContaining({
              connectionId: chat.connectionId,
              source: 'this_chat',
              readiness: expect.objectContaining({ state: 'ready' }),
              operationRevisionIds: [chat.readRevisionId],
            }),
          ],
        });

        db.prepare(
          `UPDATE session_connection_overrides SET state = 'detached'
          WHERE session_id = ? AND connection_id = ?`
        ).run(chat.sessionId, chat.connectionId);
        await reload();
        await expect(row.getByText('Not available')).toBeVisible();
        await expect(row.getByText('Turned off for this chat.')).toBeVisible();
      } finally {
        removeChatOnlyAccess(db, chat);
        db.close();
      }
    });

    test('says a chat’s app is not available while a hosted access update is pending, and allowed once it applies', async ({
      page,
      request,
    }) => {
      const chat = await arrangeChatWithAgentAccess(harness, request);
      const db = new Database(harness.databasePath);
      let commandId: string | null = null;
      try {
        // Both arranged before the chat opens, so the first read sees them.
        insertChatOnlyAccess(db, chat);
        commandId = arrangePendingHostedUpdate(db, chat);
        const { row, reload } = await openChatAccess(page, chat);
        await expect(row.getByText('Not available')).toBeVisible();
        await expect(row.getByText('Updating who can use it…')).toBeVisible();
        await expect(row.getByText(/actions available/)).toHaveCount(0);

        db.prepare(
          `UPDATE connector_managed_authority_outbox SET state = 'applied'
          WHERE command_id = ?`
        ).run(commandId);
        await reload();
        await expect(row.getByText('Allowed only in this session')).toBeVisible();
      } finally {
        if (commandId) removePendingHostedUpdate(db, chat, commandId);
        removeChatOnlyAccess(db, chat);
        db.close();
      }
    });

    test('turns an app off and on for one chat, restoring exactly what it had, and links to the access editor', async ({
      page,
      request,
    }) => {
      const chat = await arrangeChatWithAgentAccess(harness, request);
      const db = new Database(harness.databasePath);
      try {
        const { group, row, reload } = await openChatAccess(page, chat);
        await expect(row.getByText('Inherited from agent')).toBeVisible();

        // The owner's per-chat switch (DOR-2448) is exactly reversible: off hides
        // the app from this chat's agent, and on puts back what the chat had —
        // here its own hand-picked access, never the agent's account-wide access.
        insertChatOnlyAccess(db, chat);
        await reload();
        await expect(row.getByText('Allowed only in this session')).toBeVisible();
        const toggle = row.getByRole('switch', { name: 'Gmail (work) in this chat' });
        await expect(toggle).toBeChecked();
        await toggle.click();
        await expect(row.getByText('Turned off for this chat.')).toBeVisible();
        await expect(toggle).not.toBeChecked();
        await toggle.click();
        await expect(toggle).toBeChecked();
        await expect(row.getByText('Allowed only in this session')).toBeVisible();
        const restored = await request.get(
          `${harness.apiUrl}/api/connectors/sessions/${chat.sessionId}/connections`
        );
        expect(await restored.json()).toMatchObject({
          connections: [
            expect.objectContaining({
              connectionId: chat.connectionId,
              source: 'this_chat',
              thisChat: 'on',
              operationRevisionIds: [chat.readRevisionId],
            }),
          ],
        });
        // Restore inherited state before proving the owner editor link below.
        removeChatOnlyAccess(db, chat);

        // What the agent may do account-wide is reviewed on Connections, where
        // the exact connection and named agent are reviewable rather than
        // reconstructing consent from the session.
        await group.getByRole('button', { name: 'Manage agent access' }).click();
        await expect(page).toHaveURL(/\/connections/);
        const connections = new ConnectionsPage(page);
        const access = await connections.openAccess('Gmail', 'work');
        const agentAccess = access.getByRole('group', { name: /E2E Test Agent/ });
        const dorkBotAccess = access.getByRole('group', { name: /DorkBot/ });
        await expect(agentAccess).toContainText('Read');
        await expect(dorkBotAccess).toContainText('No access');
        await agentAccess.getByRole('button', { name: 'Advanced' }).click();
        await expect(
          access.getByRole('checkbox', { name: 'List for E2E Test Agent' })
        ).toBeChecked();
      } finally {
        removeChatOnlyAccess(db, chat);
        db.close();
      }
    });
  });
}
