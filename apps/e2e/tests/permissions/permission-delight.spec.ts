import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from '../../fixtures';

/**
 * Agent permissions, phase 4 (spec `agent-permissions`, DOR-2278): Undo from
 * the history, with its "changed since" question, and the gentle Always allow
 * suggestion on the request card, in a real browser against the real routes.
 *
 * Runs on the TEST-MODE leg (`chromium-rooms-agents`) with the other
 * permission specs, because the suggestion half acts as an agent with a real
 * minted token (`POST /api/test/agent-token`), which only that leg mounts. The
 * agent is its own seeded slot, so the suggestion's count and its "Not now"
 * never touch the request-card spec's requester, whose answers would count
 * toward the same agent and action. The tests run in order: the first changes
 * the Rooms default for everyone and puts it back.
 */

/** Read the Rooms default for everyone, `undefined` when it follows the preset. */
async function roomsDefault(request: APIRequestContext): Promise<string | undefined> {
  const res = await request.get('/api/permissions');
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { defaults: { areas: Record<string, string> } }).defaults.areas
    .rooms;
}

/** Change the Rooms default the way the Settings row does. */
async function setRoomsDefault(request: APIRequestContext, state: string | null) {
  const res = await request.patch('/api/permissions/defaults', {
    data: { areas: { rooms: state }, surface: 'settings' },
  });
  expect(res.ok()).toBe(true);
}

/** Open Settings → Permissions and return its history list. */
async function openHistory(page: Page) {
  await page.goto('/?settings=permissions');
  await page.waitForSelector('[data-testid="settings-dialog"]');
  const history = page.getByRole('list', { name: 'Permission history' });
  await history.scrollIntoViewIfNeeded();
  await expect(history).toBeVisible();
  return history;
}

/** The newest history row whose summary says this. */
function newestRow(history: ReturnType<Page['getByRole']>, summary: string) {
  return history.getByTestId('permission-history-row').filter({ hasText: summary }).first();
}

/**
 * The spec's own requester: a fresh agent per attempt, because the suggestion
 * counts a week of answers and keeps a "Not now", so a retry or a rerun on the
 * same server would otherwise start where the last attempt stopped.
 *
 * @param instance - This attempt's own name, or none for the slot's base agent.
 */
async function requester(
  request: APIRequestContext,
  instance?: string
): Promise<{ id: string; path: string }> {
  const res = await request.post('/api/test/seed-agent', {
    data: { slot: 'suggestion-requester', ...(instance ? { instance } : {}) },
  });
  if (!res.ok()) throw new Error(`Could not seed the requester: ${await res.text()}`);
  const { agentId, agentDir } = (await res.json()) as { agentId: string; agentDir: string };
  return { id: agentId, path: agentDir };
}

/** Ask to open a room as the requester; returns the approval its card is for. */
async function askForRoom(request: APIRequestContext, token: string): Promise<string> {
  const res = await request.post('/api/capabilities/rooms.create/invoke', {
    headers: { 'X-DorkOS-Agent': token },
    data: { kind: 'channel', title: `perm-suggest-${Date.now()}-${Math.random()}` },
  });
  expect(res.status()).toBe(202);
  return ((await res.json()) as { approvalId: string }).approvalId;
}

/** Open the Inbox and return the card for one approval. */
async function openCard(page: Page, approvalId: string) {
  await page.goto('/activity');
  await page.getByTestId('inbox-bell').click();
  const card = page.locator(`[data-approval-id="${approvalId}"]`);
  await expect(card).toBeVisible();
  return card;
}

test.describe('Undo and the Always allow suggestion @permissions', () => {
  test.describe.configure({ mode: 'serial' });

  test.afterAll(async ({ playwright }, testInfo) => {
    const request = await playwright.request.newContext({ baseURL: testInfo.project.use.baseURL });
    await setRoomsDefault(request, null);
    await request.dispose();
  });

  test('Undo puts a default back, and asks before overwriting a change made since', async ({
    request,
    page,
  }) => {
    await setRoomsDefault(request, null);
    await setRoomsDefault(request, 'ask');

    const history = await openHistory(page);
    await newestRow(history, 'Rooms set to Ask for everyone')
      .getByRole('button', { name: /^Undo: Rooms set to Ask for everyone/ })
      .click();
    await expect.poll(() => roomsDefault(request)).toBeUndefined();
    // The Undo is a change of its own, and the line it undid says so.
    await expect(newestRow(history, 'Undo: Rooms set back to the preset')).toBeVisible();
    await expect(newestRow(history, 'Rooms set to Ask for everyone')).toContainText('Undone');

    // Change it, then change it again elsewhere: undoing the first would also
    // take back the second, so Undo asks first, with the value it would write.
    await setRoomsDefault(request, 'ask');
    await setRoomsDefault(request, 'blocked');
    const reopened = await openHistory(page);
    await newestRow(reopened, 'Rooms set to Ask for everyone')
      .getByRole('button', { name: /^Undo: Rooms set to Ask for everyone/ })
      .click();
    const conflict = reopened.getByRole('group', { name: 'Undo conflict' });
    await expect(conflict).toContainText(
      'This has changed since. Set it back to the preset anyway?'
    );
    expect(await roomsDefault(request)).toBe('blocked');
    await conflict.getByRole('button', { name: 'Set it back' }).click();
    await expect.poll(() => roomsDefault(request)).toBeUndefined();
  });

  test('three Allows in a week suggest Always allow on the fourth card, until Not now', async ({
    request,
    page,
  }, testInfo) => {
    const bot = await requester(request, `a${Date.now()}-r${testInfo.retry}`);
    const set = await request.patch(`/api/agents/${bot.id}/permissions`, {
      data: { areas: { rooms: 'ask' }, surface: 'agent-page' },
    });
    expect(set.ok()).toBe(true);
    const minted = await request.post('/api/test/agent-token', { data: { agentPath: bot.path } });
    const { token } = (await minted.json()) as { token: string };

    // Three one-time Allows, answered as a person answers them.
    for (let i = 0; i < 3; i++) {
      const approvalId = await askForRoom(request, token);
      if (i === 2) {
        // The third card does not suggest anything yet.
        const third = await openCard(page, approvalId);
        await expect(third.getByText(/You've allowed this/)).toHaveCount(0);
      }
      const granted = await request.post(`/api/approvals/${approvalId}/grant`);
      expect(granted.ok()).toBe(true);
    }

    // The fourth card highlights Always allow, and says why.
    const fourthId = await askForRoom(request, token);
    const fourth = await openCard(page, fourthId);
    await expect(fourth.getByText("You've allowed this 3 times this week.")).toBeVisible();
    await expect(fourth.locator('[data-slot="approval-always"]')).toHaveAttribute(
      'data-suggested',
      'true'
    );
    await fourth.getByRole('button', { name: /^Not now/ }).click();
    await expect(fourth.getByText(/You've allowed this/)).toHaveCount(0);
    await fourth.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(fourth.getByText('Allowed once')).toBeVisible();

    // Quiet for good: the fifth card has no suggestion.
    const fifthId = await askForRoom(request, token);
    const fifth = await openCard(page, fifthId);
    await expect(fifth.getByRole('button', { name: 'Always allow' })).toBeVisible();
    await expect(fifth.getByText(/You've allowed this/)).toHaveCount(0);
    await fifth.getByRole('button', { name: 'Deny' }).click();
    await expect(fifth.getByText('Not allowed')).toBeVisible();
  });
});
