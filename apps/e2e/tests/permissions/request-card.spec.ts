import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from '../../fixtures';

/**
 * The request card, phase 2 of agent permissions (spec `agent-permissions` D7,
 * D8, DOR-2278): Allow, Always allow and Deny, answered in a real browser, on
 * the real card, against the real gate.
 *
 * Runs on the TEST-MODE leg (`chromium-rooms-agents`) because it acts as an
 * agent with a real minted token (`POST /api/test/agent-token`), which only
 * that leg mounts, the same way the phase-1 spec does. The agent is its own
 * seeded one, and the tests run in order, because each changes that agent's
 * permissions and the request limits count per agent. The agent side goes
 * through the capability invoke route every agent-facing surface ends in, so
 * the gate it meets is the gate the in-session tools meet; the person side is
 * the card in the Inbox.
 *
 * What this does not drive is the in-chat HOLD, where a Claude Code turn waits
 * on the card and carries on in the same reply: that needs a real claude-code
 * session. It is covered by `capability-approval-hold.test.ts` and
 * `permission-capabilities.test.ts`, which drive the real hold against the
 * real approval service. Here the agent retries with its token, which is what
 * a Codex or OpenCode agent does after DorkOS tells it the answer.
 */

/**
 * The spec's own agent, seeded into a fixed slot: its permission changes and
 * its per-agent request limits never touch DorkBot, which the phase-1 spec
 * drives beside this one.
 */
async function requester(request: APIRequestContext): Promise<{ id: string; path: string }> {
  const res = await request.post('/api/test/seed-agent', {
    data: { slot: 'permission-requester' },
  });
  if (!res.ok()) throw new Error(`Could not seed the requester: ${await res.text()}`);
  const { agentId, agentDir } = (await res.json()) as { agentId: string; agentDir: string };
  return { id: agentId, path: agentDir };
}

/** A real identity token for the requester. */
async function requesterToken(request: APIRequestContext, agentPath: string): Promise<string> {
  const res = await request.post('/api/test/agent-token', { data: { agentPath } });
  if (!res.ok()) throw new Error(`Could not mint the requester's token: ${await res.text()}`);
  return ((await res.json()) as { token: string }).token;
}

/** Invoke one capability as the requester, optionally retrying with a granted token. */
function invokeAsAgent(
  request: APIRequestContext,
  token: string,
  capabilityId: string,
  input: unknown,
  approvalToken?: string
) {
  return request.post(`/api/capabilities/${capabilityId}/invoke`, {
    headers: {
      'X-DorkOS-Agent': token,
      ...(approvalToken ? { 'X-DorkOS-Approval': approvalToken } : {}),
    },
    data: input,
  });
}

/** Whether a live channel with this title exists. */
async function roomExists(request: APIRequestContext, title: string): Promise<boolean> {
  const res = await request.get('/api/rooms');
  const body = (await res.json()) as { rooms: { title: string }[] };
  return body.rooms.some((room) => room.title === title);
}

/**
 * Open the Inbox and return the card for one approval.
 *
 * From Activity rather than Home: Home draws the same card in its own
 * "Waiting on you" header, and answering there is proved by the home tests.
 */
async function openCard(page: Page, approvalId: string) {
  await page.getByTestId('inbox-bell').click();
  const card = page.locator(`[data-approval-id="${approvalId}"]`);
  await expect(card).toBeVisible();
  return card;
}

/** Load a route with no card of its own, so the Inbox holds the only copy. */
async function gotoActivity(basePage: { page: Page; waitForAppReady(): Promise<void> }) {
  await basePage.page.goto('/activity');
  await basePage.waitForAppReady();
}

test.describe('The request card @permissions', () => {
  test.describe.configure({ mode: 'serial' });

  // Put the requester back on the defaults afterwards, so no other spec on this
  // leg sees an agent set differently (the phase-1 spec counts them).
  test.afterAll(async ({ playwright }, testInfo) => {
    // `request` is test-scoped, so a hook that runs once opens its own context.
    const request = await playwright.request.newContext({
      baseURL: testInfo.project.use.baseURL,
    });
    const bot = await requester(request);
    await request.patch(`/api/agents/${bot.id}/permissions`, {
      data: { areas: { rooms: null }, actions: { 'rooms.create': null }, surface: 'api' },
    });
    await request.dispose();
  });

  test.beforeEach(async ({ request }) => {
    const preset = await request.put('/api/permissions/preset', {
      data: { preset: 'full', surface: 'api' },
    });
    expect(preset.ok()).toBe(true);
    const bot = await requester(request);
    // The requester back on the defaults: no area and no action of its own.
    const reset = await request.patch(`/api/agents/${bot.id}/permissions`, {
      data: { areas: { rooms: null }, actions: { 'rooms.create': null }, surface: 'api' },
    });
    expect(reset.ok()).toBe(true);
  });

  test('Rooms at Ask: Allow runs this one call, and the next one asks again', async ({
    request,
    basePage,
  }) => {
    const bot = await requester(request);
    await request.patch(`/api/agents/${bot.id}/permissions`, {
      data: { areas: { rooms: 'ask' }, surface: 'agent-page' },
    });
    const token = await requesterToken(request, bot.path);
    const title = `perm-card-once-${Date.now()}`;

    const asked = await invokeAsAgent(request, token, 'rooms.create', { kind: 'channel', title });
    expect(asked.status()).toBe(202);
    const { approvalId, approvalToken } = (await asked.json()) as {
      approvalId: string;
      approvalToken: string;
    };

    await gotoActivity(basePage);
    const card = await openCard(basePage.page, approvalId);
    await expect(card.getByRole('button', { name: 'Allow', exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Always allow' })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Deny' })).toBeVisible();
    await card.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(card.getByText('Allowed once')).toBeVisible();

    const retried = await invokeAsAgent(
      request,
      token,
      'rooms.create',
      { kind: 'channel', title },
      approvalToken
    );
    expect(retried.status()).toBe(200);
    expect(await roomExists(request, title)).toBe(true);

    // Once means once: the next room still asks.
    const again = await invokeAsAgent(request, token, 'rooms.create', {
      kind: 'channel',
      title: `${title}-2`,
    });
    expect(again.status()).toBe(202);
  });

  test('Always allow runs this call, the next one runs with no card, and the agent page shows it', async ({
    request,
    basePage,
  }) => {
    const bot = await requester(request);
    await request.patch(`/api/agents/${bot.id}/permissions`, {
      data: { areas: { rooms: 'ask' }, surface: 'agent-page' },
    });
    const token = await requesterToken(request, bot.path);
    const title = `perm-card-always-${Date.now()}`;

    const asked = await invokeAsAgent(request, token, 'rooms.create', { kind: 'channel', title });
    expect(asked.status()).toBe(202);
    const { approvalId, approvalToken } = (await asked.json()) as {
      approvalId: string;
      approvalToken: string;
    };

    await gotoActivity(basePage);
    const card = await openCard(basePage.page, approvalId);
    await card.getByRole('button', { name: 'Always allow' }).click();
    await expect(card.getByText(/^Always allowed for .*: Open a room$/)).toBeVisible();

    const retried = await invokeAsAgent(
      request,
      token,
      'rooms.create',
      { kind: 'channel', title },
      approvalToken
    );
    expect(retried.status()).toBe(200);

    const second = await invokeAsAgent(request, token, 'rooms.create', {
      kind: 'channel',
      title: `${title}-2`,
    });
    expect(second.status()).toBe(200);
    expect(await roomExists(request, `${title}-2`)).toBe(true);

    // "Rooms: Ask, except Open a room: Allowed", on the agent's own page.
    await basePage.page.goto(`/?profile=${bot.id}&profilePage=permissions`);
    await basePage.waitForAppReady();
    const rooms = basePage.page.getByTestId('permission-row-rooms');
    await expect(rooms.getByRole('radio', { name: 'Ask' })).toBeChecked();
    await expect(rooms.getByText('Except Open a room: Allowed')).toBeVisible();
  });

  test('Rooms Blocked: request_permission raises a card with the reason, and Always allow runs the original call', async ({
    request,
    basePage,
  }) => {
    const bot = await requester(request);
    await request.patch(`/api/agents/${bot.id}/permissions`, {
      data: { areas: { rooms: 'blocked' }, surface: 'agent-page' },
    });
    const token = await requesterToken(request, bot.path);
    const title = `perm-card-blocked-${Date.now()}`;
    const reason = `You asked me to set up a room for the lunar project (${Date.now()}).`;

    // A direct call is refused and raises nothing.
    const direct = await invokeAsAgent(request, token, 'rooms.create', {
      kind: 'channel',
      title,
    });
    expect(direct.status()).toBe(403);
    expect(((await direct.json()) as { message: string }).message).toContain('request_permission');

    const request_ = {
      action: 'create_room',
      arguments: { kind: 'channel', title },
      reason,
    };
    const asked = await invokeAsAgent(request, token, 'permissions.request_access', request_);
    expect(asked.status()).toBe(202);
    const { approvalId, approvalToken } = (await asked.json()) as {
      approvalId: string;
      approvalToken: string;
    };

    // A second request in the same area while this one waits: no second card.
    const second = await invokeAsAgent(request, token, 'permissions.request_access', {
      ...request_,
      arguments: { kind: 'channel', title: `${title}-other` },
    });
    expect(second.status()).toBe(403);
    expect(((await second.json()) as { reason: string }).reason).toBe('request_pending');

    await gotoActivity(basePage);
    const card = await openCard(basePage.page, approvalId);
    await expect(card.getByText(/is blocked from Rooms and is asking to be allowed/)).toBeVisible();
    await expect(card.getByText(reason)).toBeVisible();
    await card.getByRole('button', { name: 'Always allow' }).click();

    const retried = await invokeAsAgent(
      request,
      token,
      'permissions.request_access',
      request_,
      approvalToken
    );
    expect(retried.status()).toBe(200);
    expect(await roomExists(request, title)).toBe(true);

    // The action is now Allowed for the requester, so the tool comes back for it.
    const permissions = (await (await request.get(`/api/agents/${bot.id}/permissions`)).json()) as {
      overrides: { actions?: Record<string, string> };
    };
    expect(permissions.overrides.actions?.['rooms.create']).toBe('allowed');
  });

  test('Deny: the agent cannot ask for the same thing again that day, and no card appears', async ({
    request,
    basePage,
  }) => {
    const bot = await requester(request);
    await request.patch(`/api/agents/${bot.id}/permissions`, {
      data: { areas: { rooms: 'blocked' }, surface: 'agent-page' },
    });
    const token = await requesterToken(request, bot.path);
    // A different action from the Always-allow test above, so a rerun on a warm
    // server does not meet yesterday's no for `create_room`.
    const request_ = {
      action: 'update_room',
      arguments: { roomId: `room-${Date.now()}`, title: 'Renamed' },
      reason: 'I would like to rename this room.',
    };

    const asked = await invokeAsAgent(request, token, 'permissions.request_access', request_);
    expect(asked.status()).toBe(202);
    const { approvalId } = (await asked.json()) as { approvalId: string };

    await gotoActivity(basePage);
    const card = await openCard(basePage.page, approvalId);
    await card.getByRole('button', { name: 'Deny' }).click();
    await expect(card.getByText('Not allowed')).toBeVisible();

    const again = await invokeAsAgent(request, token, 'permissions.request_access', request_);
    expect(again.status()).toBe(403);
    expect(((await again.json()) as { reason: string }).reason).toBe('recently_denied');
    const pending = (await (await request.get('/api/approvals/pending')).json()) as {
      approvals: { approvalId: string }[];
    };
    expect(pending.approvals.some((a) => a.approvalId === approvalId)).toBe(false);
  });

  test('a floor-area card offers Allow and Deny only, and says why', async ({
    request,
    basePage,
  }) => {
    const bot = await requester(request);
    // No agent-reachable action sits in a floor area yet, so the card is raised
    // the way the gate would raise it, through the real approval service.
    const seeded = await request.post('/api/test/seed-approval', {
      data: {
        capabilityId: 'operator.config_patch',
        agentPath: bot.path,
        area: 'reach',
        summary:
          '"E2E Permission Requester" wants to run "Update configuration" with patch: tunnel',
      },
    });
    expect(seeded.ok()).toBe(true);
    const { approvalId } = (await seeded.json()) as { approvalId: string };

    // Always allow is refused at the server, whatever a client sends.
    const always = await request.post(`/api/approvals/${approvalId}/grant`, {
      data: { answer: 'always' },
    });
    expect(always.status()).toBe(409);
    expect(((await always.json()) as { code: string }).code).toBe('ALWAYS_NOT_OFFERED');

    await gotoActivity(basePage);
    const card = await openCard(basePage.page, approvalId);
    await expect(card.getByRole('button')).toHaveText(['Allow', 'Deny']);
    await expect(
      card.getByText("Always allow isn't offered here. Changing this needs your yes every time.")
    ).toBeVisible();
    await card.getByRole('button', { name: 'Deny' }).click();
    await expect(card.getByText('Not allowed')).toBeVisible();
  });
});
