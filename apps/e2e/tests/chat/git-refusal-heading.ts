/** Test-mode only: a typed error card survives normal rendering and durable reload. */
import { test, expect } from '@playwright/test';
import { ChatPage } from '../../pages/ChatPage.js';

/** Register on the shared, serial chromium-mock harness; never a real-runtime spec. */
export function registerGitRefusalHeadingTests(options: {
  apiUrl: string;
  agentDir: () => string;
}) {
  for (const viewport of [
    { name: 'phone', width: 390, height: 844 },
    { name: 'desktop', width: 1280, height: 900 },
  ]) {
    test(`known Git refusal names the next step live and after replay on ${viewport.name}`, async ({
      page,
      request,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const scenario = await request.post(`${options.apiUrl}/api/test/scenario`, {
        data: { name: 'codex-git-refusal' },
      });
      expect(scenario.ok()).toBe(true);
      const chat = new ChatPage(page);
      await chat.goto(undefined, { dir: options.agentDir() });
      await chat.sendAndLand('Show the folder refusal');
      await chat.waitForTurnToEnd();
      await expect(page).toHaveURL(/session=/);
      const card = page.getByTestId('error-message-block');
      for (const state of ['live', 'replay'] as const) {
        if (state === 'replay') await page.reload();
        await expect(card).toHaveCount(1);
        await expect(card.getByText('Choose another folder', { exact: true })).toBeVisible();
        await expect(
          card.getByText('Codex can’t protect this folder’s Git files. Choose another folder.', {
            exact: true,
          })
        ).toBeVisible();
        await expect(
          card.getByRole('button', { name: /retry|sign in|choose.*model/i })
        ).toHaveCount(0);
        const box = await card.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
        await card.getByRole('button', { name: 'Details' }).click();
        await expect(
          card.getByText(
            '[codex_git_metadata_unavailable] Synthetic Git metadata refusal details',
            { exact: true }
          )
        ).toBeVisible();
      }
    });
  }
}
