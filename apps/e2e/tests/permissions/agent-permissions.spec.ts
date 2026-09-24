import type { APIRequestContext } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { chooseFullPower, readPower, restorePower, type PowerSnapshot } from './full-power-preset';

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
  // Full power moves the Files & commands stop too; put it back for the specs
  // after this one on the same leg.
  let prior: PowerSnapshot;
  test.beforeAll(async ({ playwright }, testInfo) => {
    const request = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL });
    prior = await readPower(request);
    await request.dispose();
  });
  test.afterAll(async ({ playwright }, testInfo) => {
    const request = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL });
    await restorePower(request, prior);
    await request.dispose();
  });

  test.beforeEach(async ({ request }) => {
    // Full power, as the first-run door leaves it; DorkBot back on the default.
    await chooseFullPower(request);
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

  test('each preset sets every row, and Full power asks what Full autonomy means first', async ({
    request,
    page,
  }) => {
    // No acknowledgement on file, so Full power has to ask.
    const cleared = await request.patch('/api/config', {
      data: { ui: { autonomyAcknowledgedAt: null } },
    });
    expect(cleared.ok()).toBe(true);
    await request.put('/api/permissions/preset', {
      data: { preset: 'careful', surface: 'api' },
    });

    await page.goto('/?settings=permissions');
    await page.waitForSelector('[data-testid="settings-dialog"]');
    const picker = page.getByRole('radiogroup', { name: 'Preset' });
    const row = (area: string) => page.getByTestId(`permission-row-${area}`);
    /** A differing agent on this leg turns a preset choice into a question first. */
    const keepTheirs = async () => {
      const keep = page.getByRole('button', { name: 'Keep their settings' });
      await keep.waitFor({ timeout: 1_500 }).then(
        () => keep.click(),
        () => undefined
      );
    };

    // Careful, as chosen: every row follows its table.
    await expect(picker.getByRole('radio', { name: 'Careful' })).toBeChecked();
    await expect(row('rooms').getByRole('radio', { name: 'Ask' })).toBeChecked();
    await expect(row('messages').getByRole('radio', { name: 'Allowed' })).toBeChecked();
    await expect(row('reach').getByRole('radio', { name: 'Blocked' })).toBeChecked();
    // A floor area never offers Allowed.
    await expect(row('safety').getByRole('radio', { name: 'Allowed' })).toHaveCount(0);

    // Balanced.
    await picker.getByRole('radio', { name: 'Balanced' }).click();
    await keepTheirs();
    await expect(row('rooms').getByRole('radio', { name: 'Allowed' })).toBeChecked();
    await expect(row('tasks').getByRole('radio', { name: 'Ask' })).toBeChecked();
    await expect(row('reach').getByRole('radio', { name: 'Ask' })).toBeChecked();

    // Full power goes through the consent step, and the yes is recorded with it.
    await picker.getByRole('radio', { name: 'Full power' }).click();
    await keepTheirs();
    const consent = page.getByRole('alertdialog');
    await expect(consent).toBeVisible();
    await consent.getByRole('button', { name: /Turn on|Full autonomy/ }).click();
    await expect(consent).toBeHidden();
    await expect(row('tasks').getByRole('radio', { name: 'Allowed' })).toBeChecked();
    await expect(row('packages').getByRole('radio', { name: 'Ask' })).toBeChecked();

    const power = await readPower(request);
    expect(power.trustStop).toBe('autonomy');
    expect(power.autonomyAcknowledgedAt).not.toBeNull();
    expect((await (await request.get('/api/permissions')).json()).preset).toBe('full');
  });
});
