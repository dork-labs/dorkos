import type { APIRequestContext } from '@playwright/test';
import { test, expect } from '../../fixtures';

/**
 * Agent permissions, phase 1 (spec `agent-permissions`, DOR-2278): the session
 * `e687427b` scenario, where DorkBot could not open a room on a Full power
 * install without a trip to Settings.
 *
 * Runs on the TEST-MODE leg (`chromium-rooms-agents`) because it acts AS
 * DorkBot with a real minted token (`POST /api/test/agent-token`), which only
 * that leg mounts. It drives no turn: the call goes through the same capability
 * invoke route every agent-facing surface ends in, so the gate it meets is the
 * gate the in-session tools meet.
 *
 * The in-chat half of Ask — the card held inline while the turn waits — needs a
 * real claude-code session, so here Ask is proved at the route (a 202 with an
 * approval, a person's yes, and the retry that runs); the hold itself is
 * covered by the capability-approval-hold unit tests.
 */

/** DorkBot's registered directory and id, read off the live registry. */
async function dorkbot(request: APIRequestContext): Promise<{ id: string; path: string }> {
  const res = await request.get('/api/mesh/agents/paths');
  expect(res.ok()).toBe(true);
  const { agents } = (await res.json()) as {
    agents: { id: string; name: string; projectPath: string }[];
  };
  const bot = agents.find((agent) => agent.name === 'dorkbot');
  if (!bot) throw new Error('DorkBot is not registered on this leg.');
  return { id: bot.id, path: bot.projectPath };
}

/** A real identity token for DorkBot. */
async function dorkbotToken(request: APIRequestContext, agentPath: string): Promise<string> {
  const res = await request.post('/api/test/agent-token', { data: { agentPath } });
  if (!res.ok()) throw new Error(`Could not mint DorkBot's token: ${await res.text()}`);
  return ((await res.json()) as { token: string }).token;
}

/** Ask for `create_room` as DorkBot, through the capability invoke route. */
function createRoomAsDorkbot(
  request: APIRequestContext,
  token: string,
  title: string,
  approvalToken?: string
) {
  return request.post('/api/capabilities/rooms.create/invoke', {
    headers: {
      'X-DorkOS-Agent': token,
      ...(approvalToken ? { 'X-DorkOS-Approval': approvalToken } : {}),
    },
    data: { kind: 'channel', title },
  });
}

/** Whether a live channel with this title exists. */
async function roomExists(request: APIRequestContext, title: string): Promise<boolean> {
  const res = await request.get('/api/rooms');
  const body = (await res.json()) as { rooms: { title: string }[] };
  return body.rooms.some((room) => room.title === title);
}

test.describe('Agent permissions @permissions', () => {
  test.beforeEach(async ({ request }) => {
    // Full power, as the first-run door leaves it; DorkBot back on the default.
    const preset = await request.put('/api/permissions/preset', {
      data: { preset: 'full', surface: 'api' },
    });
    expect(preset.ok()).toBe(true);
    const bot = await dorkbot(request);
    await request.patch(`/api/agents/${bot.id}/permissions`, {
      data: { areas: { rooms: null }, surface: 'api' },
    });
  });

  test('DorkBot opens a room on a Full power install with no settings change', async ({
    request,
  }) => {
    const bot = await dorkbot(request);
    const token = await dorkbotToken(request, bot.path);
    const title = `perm-e2e-${Date.now()}`;

    const res = await createRoomAsDorkbot(request, token, title);

    expect(res.status()).toBe(200);
    expect(JSON.stringify(await res.json())).not.toContain('tool_group_disabled');
    expect(await roomExists(request, title)).toBe(true);
  });

  test('Rooms set to Ask for DorkBot asks a person, and runs on their yes', async ({ request }) => {
    const bot = await dorkbot(request);
    const set = await request.patch(`/api/agents/${bot.id}/permissions`, {
      data: { areas: { rooms: 'ask' }, surface: 'agent-page' },
    });
    expect(set.ok()).toBe(true);
    const token = await dorkbotToken(request, bot.path);
    const title = `perm-e2e-ask-${Date.now()}`;

    const asked = await createRoomAsDorkbot(request, token, title);
    expect(asked.status()).toBe(202);
    const { approvalId, approvalToken } = (await asked.json()) as {
      approvalId: string;
      approvalToken: string;
    };
    expect(await roomExists(request, title)).toBe(false);

    const granted = await request.post(`/api/approvals/${approvalId}/grant`);
    expect(granted.ok()).toBe(true);

    const retried = await createRoomAsDorkbot(request, token, title, approvalToken);
    expect(retried.status()).toBe(200);
    expect(await roomExists(request, title)).toBe(true);
  });

  test('DorkBot cannot change its own permissions', async ({ request }) => {
    const bot = await dorkbot(request);
    const token = await dorkbotToken(request, bot.path);

    const self = await request.patch(`/api/agents/${bot.id}/permissions`, {
      headers: { 'X-DorkOS-Agent': token },
      data: { areas: { rooms: 'allowed' }, surface: 'api' },
    });
    const mesh = await request.patch(`/api/mesh/agents/${bot.id}`, {
      data: { permissions: { areas: { rooms: 'allowed' } } },
    });

    expect(self.status()).toBe(403);
    expect(mesh.status()).toBe(400);
  });

  test('changing the Rooms default while one agent differs asks first, with nothing checked', async ({
    request,
    page,
  }) => {
    const bot = await dorkbot(request);
    await request.patch(`/api/agents/${bot.id}/permissions`, {
      data: { areas: { rooms: 'blocked' }, surface: 'api' },
    });

    await page.goto('/?settings=permissions');
    await page.waitForSelector('[data-testid="settings-dialog"]');
    const rooms = page.getByTestId('permission-row-rooms');
    await expect(rooms).toBeVisible();
    await rooms.getByRole('radio', { name: 'Ask' }).click();

    const dialog = page.getByRole('dialog', { name: /Rooms will be set to Ask/ });
    await expect(dialog).toBeVisible();
    const box = dialog.getByRole('checkbox');
    await expect(box).toHaveCount(1);
    await expect(box).not.toBeChecked();
    await dialog.getByRole('button', { name: 'Keep their settings' }).click();
    await expect(dialog).toBeHidden();

    const overview = await (await request.get('/api/permissions')).json();
    expect(overview.defaults.areas.rooms).toBe('ask');
    // Kept: DorkBot is still set differently.
    expect(overview.exceptions.some((e: { agentId: string }) => e.agentId === bot.id)).toBe(true);
    await request.patch('/api/permissions/defaults', {
      data: { areas: { rooms: null }, surface: 'api' },
    });
  });
});
