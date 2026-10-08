import { randomUUID } from 'node:crypto';
import { test, expect } from '../../fixtures';
import { ChatPage } from '../../pages/ChatPage';

/** Exercises the real app/server launch contract on the free scripted runtime. */
test.use({ video: 'on' });

test.describe('Private session routes @smoke', () => {
  test.describe.configure({ mode: 'default' });
  let agentDir: string;

  test.beforeEach(async ({ request }) => {
    expect((await request.post('/api/test/reset')).ok()).toBe(true);
    expect(
      (
        await request.patch('/api/config', {
          data: {
            onboarding: { dismissedAt: new Date().toISOString() },
            telemetry: { userHasDecided: true },
          },
        })
      ).ok()
    ).toBe(true);
    const response = await request.post('/api/test/seed-agent');
    expect(response.ok()).toBe(true);
    ({ agentDir } = await response.json());
  });

  test.afterEach(async ({ request }) => {
    await request.post('/api/test/reset');
  });

  test('a portable draft survives reload, starts on its chosen runtime, and reopens by ID', async ({
    page,
    request,
    browser,
  }) => {
    const draftId = randomUUID();
    const canonicalId = randomUUID();
    const response = await request.post('/api/session-locations', { data: { cwd: agentDir } });
    expect(response.ok()).toBe(true);
    const { id: launchRef } = await response.json();
    expect(
      (
        await request.post('/api/test/canonical-id', {
          data: { sessionId: draftId, canonicalId, runtime: 'test-mode-b' },
        })
      ).ok()
    ).toBe(true);
    await page.goto(
      `/session?session=${draftId}&draft=1&launchRef=${launchRef}&runtime=test-mode-b`
    );
    const chat = new ChatPage(page);
    await expect(chat.panel).toBeVisible();
    await page.reload();
    await expect(chat.input).toBeEditable();
    expect(new URL(page.url()).searchParams.has('dir')).toBe(false);

    // Changing a pre-message setting must not mistake the loose PATCH response
    // for a persisted native session or lose this portable draft's runtime.
    await page.getByRole('button', { name: /^Permissions:/ }).click();
    const settingsSaved = page.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' &&
        response.url().includes(`/api/sessions/${draftId}`)
    );
    await page
      .locator('[aria-label="Permissions"]')
      .getByRole('radio', { name: 'Ask first' })
      .click();
    expect((await settingsSaved).ok()).toBe(true);
    await page.keyboard.press('Escape');
    const defaultOffer = page
      .getByRole('status')
      .filter({ hasText: 'Start every new session in Ask first?' });
    await expect(defaultOffer).toBeVisible();
    await defaultOffer.getByRole('button', { name: 'Dismiss', exact: true }).click();
    expect(new URL(page.url()).searchParams.has('draft')).toBe(true);
    expect(new URL(page.url()).searchParams.get('launchRef')).toBe(launchRef);
    const stored = await request.get(`/api/sessions/${draftId}/settings`);
    expect(stored.ok()).toBe(true);
    expect(await stored.json()).toMatchObject({ settings: { permissionMode: 'always-deny' } });
    const creatingRequest = page.waitForRequest(
      (request) =>
        request.method() === 'POST' && request.url().includes(`/api/sessions/${draftId}/messages`)
    );
    await chat.sendAndLand('Keep this conversation in its original folder');
    expect((await creatingRequest).postDataJSON()).toMatchObject({
      create: true,
      runtime: 'test-mode-b',
    });
    await chat.waitForTurnToEnd();
    await expect(page).toHaveURL(new RegExp(`session=${canonicalId}`));
    await expect.poll(() => new URL(page.url()).searchParams.get('draft')).toBe(null);
    const detail = await request.get(`/api/sessions/${canonicalId}`);
    expect(detail.ok()).toBe(true);
    expect(await detail.json()).toMatchObject({
      cwd: agentDir,
      runtime: 'test-mode-b',
      permissionMode: 'always-deny',
    });

    // A fresh browser context has no selected-directory or session-context cache.
    const context = await browser.newContext();
    try {
      const other = await context.newPage();
      await other.goto(new URL(`/session?session=${canonicalId}`, page.url()).toString());
      await expect(other.getByTestId('transcript-feed')).toContainText('Keep this conversation');
      expect(new URL(other.url()).searchParams.has('dir')).toBe(false);
    } finally {
      await context.close();
    }
  });

  test('a legacy directory link normalizes after loading the correct session', async ({
    page,
    request,
  }) => {
    const sessionId = randomUUID();
    const created = await request.post(`/api/sessions/${sessionId}/messages`, {
      data: {
        content: 'A legacy bookmark still reaches this conversation',
        cwd: agentDir,
        create: true,
      },
    });
    expect(created.ok()).toBe(true);
    const { sessionId: canonicalId } = await created.json();
    await page.goto(`/session?session=${canonicalId}&dir=${encodeURIComponent(agentDir)}`);
    await expect(page.getByTestId('transcript-feed')).toContainText('A legacy bookmark');
    await expect.poll(() => new URL(page.url()).searchParams.get('dir')).toBe(null);
  });

  test('a missing existing session shows an error without creating a conversation', async ({
    page,
  }) => {
    const sends: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && /\/sessions\/[^/]+\/messages/.test(request.url())) {
        sends.push(request.url());
      }
    });
    await page.goto(`/session?session=${randomUUID()}`);
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(page.getByTestId('chat-panel')).toHaveCount(0);
    expect(sends).toEqual([]);
  });

  test('file routes preserve the agent alias and keep marketplace sources independent', async ({
    page,
  }) => {
    await page.goto('/agents?panel=profile');
    await expect(page).toHaveURL(/\/team\?panel=profile/);
    await page.goto('/marketplace/sources');
    await expect(
      page.getByRole('heading', { name: 'Marketplace sources', exact: true })
    ).toHaveCount(1);
    await expect(page.getByRole('heading', { name: 'Marketplace', exact: true })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Browse', exact: true })).toHaveCount(0);
    await page.reload();
    await expect(
      page.getByRole('button', { name: 'Add marketplace source' }).first()
    ).toBeVisible();
  });

  test('a legacy profile link keeps its separate subject while hiding both paths', async ({
    page,
    roomsApi,
  }) => {
    const host = await roomsApi.registerAgent(`Host ${roomsApi.runId}`, '🛠️', '#22c55e');
    const linked = await roomsApi.registerAgent(`Linked ${roomsApi.runId}`, '🔭', '#f59e0b');
    await page.goto(
      `/session?dir=${encodeURIComponent(host.projectPath)}&panel=profile&profilePage=rooms&agentPath=${encodeURIComponent(linked.projectPath)}`
    );
    await expect(page.locator('[data-slot="profile-page-title"]')).toHaveText('Rooms');
    await expect(page.locator('[data-slot="profile-strip"]')).toContainText(
      `Linked ${roomsApi.runId}`
    );
    await expect.poll(() => new URL(page.url()).searchParams.get('agentPath')).toBe(null);
    await expect.poll(() => new URL(page.url()).searchParams.get('dir')).toBe(null);
    expect(new URL(page.url()).searchParams.get('profileRef')).toBeTruthy();
    await page.reload();
    await expect(page.locator('[data-slot="profile-strip"]')).toContainText(
      `Linked ${roomsApi.runId}`
    );
  });
});
