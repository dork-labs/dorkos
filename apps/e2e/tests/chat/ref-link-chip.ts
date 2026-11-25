/**
 * A `/r/dork:chat:` link in a reply draws the chat's live chip (DOR-5202).
 *
 * The agent tools hand agents this form, so it has to read in the transcript
 * exactly as a `/session?session=` link does: the chat's name and status, not
 * the link's own words. The unit tests pin the parsing against a mock
 * transport; this proves the real reply renderer, the real session read and
 * the real `/r/` route meet. The test-mode runtime echoes what it is sent, so
 * the link it writes back is the one the test typed.
 */
import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { test } from '../../fixtures/base';
import { ChatPage } from '../../pages/ChatPage.js';

/** Register on the shared, serial chromium-mock harness; never a real-runtime spec. */
export function registerRefLinkChipTests(options: { agentDir: () => string }) {
  for (const viewport of [
    { name: 'phone', width: 390, height: 844 },
    { name: 'desktop', width: 1280, height: 900 },
  ]) {
    test(`a /r/ chat link in a reply draws that chat's chip and opens it on ${viewport.name}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const chat = new ChatPage(page);

      // The chat the link will name: it needs a row on the server to resolve.
      await chat.goto(undefined, { dir: options.agentDir() });
      await chat.sendAndLand('Draft the launch notes');
      await chat.waitForTurnToEnd();
      await expect(page).toHaveURL(/session=/);
      const linked = await chat.getSessionId();
      expect(linked).not.toBeNull();

      // A second chat, whose reply links the first. Its id is minted here: with
      // none, the loader opens the agent's latest chat, the first one again.
      const second = randomUUID();
      await chat.goto(second, { dir: options.agentDir(), draft: true });
      await chat.sendMessage(`Picking up from [the notes chat](/r/dork:chat:${linked})`);
      const chip = page
        .getByTestId('transcript-feed')
        .locator(`[data-role="assistant"] a[href="/r/dork:chat:${linked}"]`);
      await expect(chip).toHaveAttribute('data-chip', 'ready', { timeout: 30_000 });
      // Resolved: the chip names the chat, never the words the link was written with.
      await expect(chip).not.toHaveText('the notes chat');
      await chat.waitForTurnToEnd();
      // The whole reply has drawn, not just its first words.
      const reply = chip.locator('xpath=ancestor::*[@data-testid="message-item"][1]');
      await expect(reply).toContainText('Echo: Picking up from');
      expect(await chat.getSessionId()).toBe(second);

      const box = await chip.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
      const shot = testInfo.outputPath(`ref-link-chip-${viewport.name}.png`);
      await page.screenshot({ path: shot, animations: 'disabled' });
      await testInfo.attach(`ref-link-chip-${viewport.name}`, {
        path: shot,
        contentType: 'image/png',
      });

      // One click goes through the `/r/` route to the chat it names, with no confirm.
      await chip.click();
      await expect(page).toHaveURL(new RegExp(`/session\\?session=${linked}$`), {
        timeout: 30_000,
      });
      await expect(page.getByRole('dialog')).toHaveCount(0);
    });
  }
}
