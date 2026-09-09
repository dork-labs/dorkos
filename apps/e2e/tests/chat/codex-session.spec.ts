import { randomUUID } from 'node:crypto';
import { test, expect } from '../../fixtures';
import { ChatPage } from '../../pages/ChatPage';

/**
 * Opt-in proof across the real Codex executable, account catalog, browser and
 * durable transcript. No model is hardcoded: the current account chooses it.
 * Run with E2E_INTEGRATION=1 and a connected Codex on an isolated test server.
 */
test.describe('Codex — account models and session resume @integration', () => {
  test.describe.configure({ timeout: 120_000 });

  test('answers with an available model and remembers the conversation after reload', async ({
    page,
    request,
    roomsApi,
  }, testInfo) => {
    test.skip(process.env.E2E_INTEGRATION !== '1', 'Real Codex turns require E2E_INTEGRATION=1.');
    const requirements = await request.get('/api/system/requirements');
    expect(requirements.ok()).toBe(true);
    const status = await requirements.json();
    test.skip(
      status.runtimes?.codex?.state !== 'ready',
      'Codex must be connected on this machine.'
    );

    const catalogResponse = await request.get('/api/models?runtime=codex');
    expect(catalogResponse.ok()).toBe(true);
    const { models } = await catalogResponse.json();
    expect(models.length).toBeGreaterThan(0);

    const agent = await roomsApi.registerAgent('Codex session proof', '🧪', '#2563eb', {
      runtime: 'codex',
    });
    const chat = new ChatPage(page);
    await chat.goto(undefined, { dir: agent.projectPath, runtime: 'codex' });
    const modelControl = page.getByTestId('model-config-trigger');
    await expect(modelControl).toBeVisible();
    await modelControl.click();
    // At least one actual catalog choice must reach the user-facing picker.
    const availableModel = page.getByRole('radio', {
      name: new RegExp(models[0].displayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    });
    await expect(availableModel).toBeVisible();
    await page.keyboard.press('Escape');

    const readContextMeter = async () => {
      await page.getByRole('button', { name: /^Session details/ }).click();
      const contextRow = page.getByTestId('session-row-context');
      await expect(contextRow).toContainText(/\d+% full/, { timeout: 10_000 });
      const reading = (await contextRow.innerText()).match(/(\d+)% full/)?.[0];
      expect(reading).toBeTruthy();
      expect(Number.parseInt(reading!, 10)).toBeLessThanOrEqual(100);
      await page.keyboard.press('Escape');
      return reading;
    };

    const marker = `cedar-${randomUUID()}`;
    await chat.sendAndLand(
      `Remember this marker for our conversation: ${marker}. Reply with only the marker.`,
      60_000
    );
    const replies = page.locator('[data-testid="message-item"][data-role="assistant"]');
    await expect(replies).toHaveCount(1);
    await expect(replies.last()).toContainText(marker, { timeout: 60_000 });
    await expect(chat.inferenceStreaming).toBeHidden({ timeout: 60_000 });
    const sessionId = await chat.getSessionId();
    expect(sessionId).toBeTruthy();
    const contextBeforeReload = await readContextMeter();

    await page.reload();
    await expect(replies).toHaveCount(1, { timeout: 30_000 });
    await expect(replies.last()).toContainText(marker);
    // The meter must come back from the durable snapshot, not only live events.
    expect(await readContextMeter()).toBe(contextBeforeReload);
    await chat.sendAndLand(
      'What marker did I ask you to remember? Reply with only the marker.',
      60_000
    );
    await expect(replies).toHaveCount(2);
    await expect(replies.last()).toContainText(marker, { timeout: 60_000 });
    await expect(chat.inferenceStreaming).toBeHidden({ timeout: 60_000 });
    expect(await chat.getSessionId()).toBe(sessionId);
    await readContextMeter();

    await page.getByRole('button', { name: /^Session details/ }).click();
    await testInfo.attach('codex-resumed-session', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
  });
});
