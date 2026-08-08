import { test, expect } from '@playwright/test';
import { ChatPage } from '../../pages/ChatPage.js';
import { caretOffset, composerText, expectComposerText } from '../../pages/composer-probe.js';

/**
 * The chat composer with formatting-as-you-type turned ON (DOR-948).
 *
 * Everything else in `apps/e2e` runs with the preference OFF — that is the
 * fallback gate, and it stays true. This file is the only place the second field
 * is exercised end to end in a browser.
 *
 * ## Why its own project, and why serial
 *
 * `ui.composer.richText` is SERVER-GLOBAL state: there is no per-tab override,
 * so turning it on turns it on for every page hitting this leg. That is the same
 * class of hazard `chat-mock.spec.ts` documents about `POST /api/test/reset`,
 * and it is handled the same way — `playwright.config.ts` gives this file its
 * own project (`chromium-composer`, beside `chromium-streams` and
 * `chromium-bridge`, which are separate for the same "shares none of chat-mock's
 * choreography" reason), and the file runs serially so its own tests cannot
 * race each other's flag.
 *
 * The one concurrent consumer of the chat composer on this leg is
 * `chat-mock.spec.ts`, and it was checked rather than assumed: its only
 * composer interaction is `chatPage.input.fill(...)`, which works on a
 * contenteditable exactly as it does on a textarea, and it never asserts with
 * `toHaveValue`. So a window where the flag is on cannot break it.
 *
 * The flag is restored in `afterAll` — including when a test fails, which is the
 * point. A spec that leaves the preference on would silently change the field
 * under every spec that ran after it, and the failure would land somewhere else
 * entirely.
 */

// eslint-disable-next-line no-restricted-syntax -- E2E test config; no env.ts available
const MOCK_PORT = process.env.DORKOS_MOCK_PORT || '4243';
const API_URL = `http://localhost:${MOCK_PORT}`;

// Serial: every test in this file shares one server-global preference.
test.describe.configure({ mode: 'serial', timeout: 90_000 });

/** Whatever the preference was before this file touched it. */
let previousRichText = false;

/** Seeded by POST /api/test/seed-agent, so the composer has an agent to send to. */
let agentDir: string;

test.beforeAll(async ({ request }) => {
  const current = await request.get(`${API_URL}/api/config`);
  if (!current.ok()) {
    throw new Error(`Could not read config at ${API_URL}: ${current.status()}`);
  }
  const config = (await current.json()) as { ui?: { composer?: { richText?: boolean } } };
  previousRichText = config.ui?.composer?.richText ?? false;

  const res = await request.patch(`${API_URL}/api/config`, {
    data: { ui: { composer: { richText: true } } },
  });
  if (!res.ok()) {
    throw new Error(`Could not turn rich text on: ${res.status()} ${await res.text()}`);
  }
});

test.afterAll(async ({ request }) => {
  await request.patch(`${API_URL}/api/config`, {
    data: { ui: { composer: { richText: previousRichText } } },
  });
});

test.beforeEach(async ({ request }) => {
  await request.post(`${API_URL}/api/test/reset`);
  await request.patch(`${API_URL}/api/config`, {
    data: { onboarding: { dismissedAt: new Date().toISOString() } },
  });
  // `reset` does not touch config, but `beforeEach` runs after `beforeAll` for
  // every test, and a failed test may have left the page mid-edit — re-asserting
  // the flag costs one request and removes a whole class of order dependence.
  await request.patch(`${API_URL}/api/config`, {
    data: { ui: { composer: { richText: true } } },
  });
  await request.post(`${API_URL}/api/test/scenario`, { data: { name: 'simple-text' } });
  const seedRes = await request.post(`${API_URL}/api/test/seed-agent`);
  if (!seedRes.ok()) {
    throw new Error(`seed-agent failed (${seedRes.status()}): ${await seedRes.text()}`);
  }
  ({ agentDir } = (await seedRes.json()) as { agentDir: string });
});

/**
 * Open chat and wait for the rich field, not merely for the composer.
 *
 * The editor is lazy and the preference arrives from an async config read, so
 * the composer is briefly the plain textarea. Asserting on the contenteditable
 * is what makes every test below about the field it claims to be about.
 *
 * @param page - The page to drive.
 */
async function openRichChat(page: import('@playwright/test').Page): Promise<ChatPage> {
  const chatPage = new ChatPage(page);
  await chatPage.goto(undefined, { dir: agentDir });
  await expect(page.locator('[contenteditable="true"]')).toBeVisible({ timeout: 20_000 });
  // The same locator every page object uses. It resolving to the rich field is
  // the proof that the swap kept one control's identity rather than adding a
  // second one — every existing spec depends on this.
  await expect(chatPage.input).toHaveAttribute('contenteditable', 'true');
  return chatPage;
}

/** Messages the person has sent, as the transcript renders them. */
function userMessages(page: import('@playwright/test').Page) {
  return page.locator('[data-testid="message-item"][data-role="user"]');
}

test.describe('the chat composer with formatting on', () => {
  test('Enter builds a list and only sends once the list is done', async ({ page }) => {
    const chatPage = await openRichChat(page);
    const composer = chatPage.input;
    await composer.click();

    // `- a` ⏎ `b` ⏎ ⏎ — two items, then out of the list.
    await composer.pressSequentially('- a');
    await expect(composer.locator('li')).toHaveCount(1);
    await composer.press('Enter');
    await composer.pressSequentially('b');
    await expect(composer.locator('li')).toHaveCount(2);

    // Enter on the empty third item leaves the list rather than sending.
    await composer.press('Enter');
    await composer.press('Enter');
    await expect(composer.locator('li')).toHaveCount(2);
    await expect(composer.locator('p')).toHaveCount(1);

    // THE ASSERTION THIS FILE EXISTS FOR. Four Enters have been pressed inside a
    // list and NOTHING has been sent — locked decision 2, and the one rung with
    // no textarea equivalent to fall back on.
    await expect(userMessages(page)).toHaveCount(0);

    await composer.pressSequentially('and a sentence');
    await composer.press('Enter');

    // Exactly one. Not "at least one": the whole claim is that the four earlier
    // Enters were absorbed by the list, and `toHaveCount(1)` is what can fail if
    // any of them sent.
    await expect(userMessages(page)).toHaveCount(1, { timeout: 20_000 });
    await expectComposerText(composer, '');
  });

  test('bold renders in the field and the sent message still carries markdown', async ({
    page,
  }) => {
    const chatPage = await openRichChat(page);
    const composer = chatPage.input;
    await composer.click();

    await composer.pressSequentially('**bold** please');

    // On screen: a real <strong>, and the asterisks are gone.
    await expect(composer.locator('strong')).toHaveText('bold');
    expect(await composerText(composer)).toBe('bold please');

    await composer.press('Enter');

    // On the wire: the markdown source, unchanged. The editor is a view over
    // markdown, not a new message format — if this ever renders as HTML or as
    // the flattened text, the wire contract broke.
    const sent = userMessages(page).first();
    await expect(sent).toBeVisible({ timeout: 20_000 });
    await expect(sent).toContainText('**bold** please');
  });

  test('syntax the box does not preview stays literal', async ({ page }) => {
    const chatPage = await openRichChat(page);
    const composer = chatPage.input;
    await composer.click();

    // Backticks at the start of a line are the strongest case: recognizing a
    // fenced block would give Enter a THIRD meaning, and the locked decision
    // authorized exactly one exception.
    await composer.pressSequentially('```');
    expect(await composerText(composer)).toBe('```');
    await expect(composer.locator('pre, code')).toHaveCount(0);

    await composer.pressSequentially(' and > quote and ~~strike~~');
    expect(await composerText(composer)).toBe('``` and > quote and ~~strike~~');
    await expect(composer.locator('blockquote, s, del')).toHaveCount(0);
  });

  test('Shift+Enter is a newline and sends nothing', async ({ page }) => {
    const chatPage = await openRichChat(page);
    const composer = chatPage.input;
    await composer.click();

    await composer.pressSequentially('first');
    await composer.press('Shift+Enter');
    await composer.pressSequentially('second');

    await expect(composer.locator('br')).toHaveCount(1);
    await expect(userMessages(page)).toHaveCount(0);
    // The caret is past both words, so the line break is inside the document
    // rather than something the browser painted around it.
    expect(await caretOffset(composer)).toBe('firstsecond'.length);
  });

  test('the command palette opens over the rich field and Enter picks a row', async ({ page }) => {
    const chatPage = await openRichChat(page);

    await chatPage.openCommandPalette('/');
    await expect(chatPage.paletteOptions.first()).toBeVisible({ timeout: 10_000 });

    // Enter belongs to the palette while it has rows to pick — it must not send,
    // and it must not reach the list handler either.
    await chatPage.paletteOptions.first().waitFor();
    await chatPage.input.press('Enter');

    await expect(chatPage.commandPalette).toBeHidden({ timeout: 10_000 });
    await expect(userMessages(page)).toHaveCount(0);
  });
});
