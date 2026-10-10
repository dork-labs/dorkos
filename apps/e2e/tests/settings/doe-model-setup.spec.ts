import { test, expect } from '../../fixtures';

test.use({ video: 'on' });

/** Real setup writes only metadata; no model request or credential is needed. */
test.describe('DorkOS model setup @smoke', () => {
  test.afterEach(async ({ request }) => {
    const restored = await request.patch('/api/config', {
      data: { runtimes: { doe: { inference: null } } },
    });
    expect(restored.ok()).toBe(true);
  });
  test('saves a local model, fits a phone, and chooses DorkOS for an agent', async ({
    basePage,
    page,
    request,
    settingsPage,
    roomsApi,
  }, testInfo) => {
    await basePage.goto();
    await basePage.waitForAppReady();
    await settingsPage.open();
    await settingsPage.switchTab('Runtimes');
    const card = settingsPage.runtimeCard('doe');
    await expect(card).toBeVisible();
    await expect(card.getByLabel('Runs on', { exact: true })).toBeVisible();
    await card.getByLabel('Runs on', { exact: true }).selectOption('local');
    await card
      .getByLabel('Model protocol', { exact: true })
      .selectOption('openai-chat-completions');
    await card.getByLabel('Service name', { exact: true }).fill('Local test model');
    await card.getByLabel('Model endpoint', { exact: true }).fill('http://127.0.0.1:19999/v1');
    await card.getByLabel('Model ID', { exact: true }).fill('local-browser-fixture');
    await card.getByLabel('Context tokens', { exact: true }).fill('32768');
    await card.getByLabel('Output tokens', { exact: true }).fill('4096');
    await expect(card.getByLabel('API key', { exact: true })).toHaveCount(0);
    const saved = page.waitForResponse(
      (response) =>
        response.url().includes('/api/runtimes/doe/inference') &&
        response.request().method() === 'PUT'
    );
    await card.getByRole('button', { name: 'Save model settings', exact: true }).click();
    expect((await saved).ok()).toBe(true);
    const metadata = await request.get('/api/runtimes/doe/inference');
    expect(metadata.ok()).toBe(true);
    expect(await metadata.json()).toMatchObject({
      hasKey: false,
      inference: {
        source: 'local',
        protocol: 'openai-chat-completions',
        model: 'local-browser-fixture',
      },
    });
    await settingsPage.close();
    await page.reload();
    await basePage.waitForAppReady();
    await settingsPage.open();
    await settingsPage.switchTab('Runtimes');
    await settingsPage.runtimeCardToggle('doe').click();
    await settingsPage
      .runtimeCard('doe')
      .getByRole('button', { name: 'Change', exact: true })
      .click();
    await expect(
      settingsPage.runtimeCard('doe').getByLabel('Model ID', { exact: true })
    ).toHaveValue('local-browser-fixture');
    await expect(
      settingsPage.runtimeCard('doe').getByLabel('Runs on', { exact: true })
    ).toHaveValue('local');
    await page.setViewportSize({ width: 390, height: 844 });
    await settingsPage.dialog.getByRole('button', { name: 'Runtimes', exact: true }).click();
    const phoneDialog = page.getByRole('dialog');
    const phoneCard = phoneDialog.getByTestId('runtime-card-doe');
    await phoneCard.getByTestId('runtime-card-toggle-doe').click();
    await phoneCard.getByRole('button', { name: 'Change', exact: true }).click();
    await expect(phoneCard.getByLabel('Model ID', { exact: true })).toHaveValue(
      'local-browser-fixture'
    );
    await phoneCard.getByLabel('Model endpoint', { exact: true }).scrollIntoViewIfNeeded();
    await expect(phoneCard.getByLabel('Model endpoint', { exact: true })).toBeVisible();
    const width = await phoneDialog.evaluate((element) => ({
      scroll: element.scrollWidth,
      client: element.clientWidth,
    }));
    expect(width.scroll).toBeLessThanOrEqual(width.client + 1);
    await testInfo.attach('doe-local-model-phone', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
    await phoneDialog.getByRole('button', { name: 'Close', exact: true }).click();
    await page.setViewportSize({ width: 1280, height: 900 });
    const agent = await roomsApi.registerAgent('Runtime choice fixture', '🧪', '#2563eb');
    await basePage.goto(`/?profile=${encodeURIComponent(agent.id)}`);
    await basePage.waitForAppReady();
    await page.getByRole('button', { name: /^Runs on:/ }).click();
    const source = page.locator('[data-slot="profile-runs-on"]');
    await source.getByRole('combobox').click();
    const changed = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/agents/current' &&
        response.request().method() === 'PATCH'
    );
    await page.getByRole('option', { name: 'DorkOS', exact: true }).click();
    expect((await changed).ok()).toBe(true);
    const persisted = await request.get(`/api/mesh/agents/${agent.id}`);
    expect(persisted.ok()).toBe(true);
    expect(await persisted.json()).toMatchObject({ runtime: 'doe' });
    await expect(source.getByRole('combobox')).toHaveText('DorkOS');
  });
});
