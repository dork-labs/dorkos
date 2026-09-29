import { test, expect, type APIRequestContext } from '@playwright/test';
import { ChatPage } from '../../pages/ChatPage.js';
import { openFromCommandPalette } from '../../pages/command-palette.js';

/**
 * Starting work in a new chat, seen in a real browser (spec `flow-multiproject`
 * §7.7, V7): the `hello-world` core extension's "Start a chat" button.
 *
 * One click starts the work in a NEW chat and changes nothing where you are:
 * the chat you were in keeps its messages and what you had typed. The new chat
 * has the extension's title, and its first line says who started it and why
 * ("Started by the Hello World extension: …"). What it was asked is folded under one quiet
 * line, so no prompt or slash command is ever the headline.
 *
 * Runs in the `chromium-extension-seams` project against the test-mode leg,
 * so neither chat can bill a model. That project runs one worker: this file
 * and the seams spec both turn `hello-world` on for their tests and back off
 * afterwards, and must not overlap.
 */

// eslint-disable-next-line no-restricted-syntax -- E2E test config; no env.ts available
const MOCK_PORT = process.env.DORKOS_MOCK_PORT || '4243';
const API_URL = `http://localhost:${MOCK_PORT}`;

/** The id the core extension ships under. */
const HELLO = 'hello-world';

/** Turn a core extension on or off through the same route Settings uses. */
async function setEnabled(request: APIRequestContext, id: string, enabled: boolean) {
  const response = await request.post(
    `${API_URL}/api/extensions/${id}/${enabled ? 'enable' : 'disable'}`
  );
  expect(response.ok(), `${enabled ? 'enable' : 'disable'} ${id}: ${await response.text()}`).toBe(
    true
  );
}

test.describe('Starting work in a new chat — hello-world’s “Start a chat”', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ request }) => {
    await setEnabled(request, HELLO, true);
  });

  test.afterAll(async ({ request }) => {
    await setEnabled(request, HELLO, false);
  });

  test('starts a new chat, leaves the current one alone, and says who started it', async ({
    page,
  }) => {
    const chat = new ChatPage(page);
    await chat.goto();
    // A chat of your own in the project first: it is what puts the app in a
    // folder, and it is the chat that must come through untouched. Unique per
    // run, because a retry reopens the same chat and the send is matched by text.
    const mine = `My own chat (${Date.now()})`;
    await chat.sendAndLand(mine);
    await chat.waitForTurnToEnd();
    const myChat = await chat.getSessionId();
    expect(myChat).not.toBeNull();
    const myMessages = await page.locator('[data-testid="message-item"]').count();
    const draft = 'Something I have not sent yet';
    await chat.input.fill(draft);

    await openFromCommandPalette(page, 'Hello');
    await expect(page).toHaveURL(/\/x\/hello-world$/);
    const start = page.getByRole('button', { name: 'Start a chat' });
    await expect(start).toBeEnabled();
    await start.click();

    // The click is the only confirmation, and it goes nowhere: the page stays,
    // and the button turns into the outcome with a way to watch it.
    await expect(page.getByText('Saying hello…')).toBeVisible();
    await expect(page).toHaveURL(/\/x\/hello-world$/);
    const watch = page.getByRole('button', { name: 'Watch' });
    await expect(watch).toBeVisible();

    await watch.click();
    await expect(page).toHaveURL(/\/session\?session=/);
    const startedChat = await chat.getSessionId();
    expect(startedChat).not.toBeNull();
    expect(startedChat).not.toBe(myChat);

    // Its first line says who started it and why, in words, never a command.
    const firstLine = page.getByTestId('started-by-line');
    await expect(firstLine).toHaveText(
      'Started by the Hello World extension: You asked for a hello from the Hello page'
    );
    await expect(firstLine).not.toContainText('/');
    // Its title is the extension's, not the prompt.
    await expect(page.getByTestId('session-title')).toHaveText(/^Saying hello in /);
    // What it was asked is there to read, folded, and never the headline.
    const asked = page.getByRole('button', { name: 'What it was asked' });
    await expect(asked).toHaveAttribute('aria-expanded', 'false');
    const prompt = 'Say hello, in one short sentence, then stop.';
    // Exact: the scripted reply on this leg echoes the prompt back.
    await expect(page.getByText(prompt, { exact: true })).toHaveCount(0);
    await asked.click();
    await expect(page.getByText(prompt, { exact: true })).toBeVisible();

    // The chat you were in: the same messages, and what you had typed. Back
    // through the app's own history rather than a reload, which is how a
    // person returns to it.
    await page.goBack();
    await expect(page).toHaveURL(/\/x\/hello-world$/);
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`session=${myChat}`));
    await expect(page.getByTestId('started-by-line')).toHaveCount(0);
    await expect(
      page.locator('[data-testid="message-item"][data-role="user"]').filter({ hasText: mine })
    ).toBeVisible();
    await expect(page.locator('[data-testid="message-item"]')).toHaveCount(myMessages);
    await expect(chat.input).toHaveText(draft);
  });
});
