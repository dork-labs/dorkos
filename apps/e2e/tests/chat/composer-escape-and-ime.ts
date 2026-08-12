/**
 * Two composer behaviours that only a real browser can settle (DOR-948).
 *
 * **The double-Escape clear**, on BOTH fields. The rung is written once, in
 * `use-input-keyboard`, and reaches the two fields through the `EditingSurface`
 * port — so "it works on both" is a claim, not a given, and the browser is where
 * a claim about focus, a 500 ms timer and a real keydown gets tested. It also
 * had no browser coverage at all until now, which is the gap this closes.
 *
 * **Enter during an IME composition.** Chromium's own IME protocol, driven over
 * CDP, so the renderer really composes and really fires the composition events.
 * See the test for the honest limits of that.
 *
 * ## Why this is a module and not a spec file
 *
 * Both suites flip `ui.composer.richText`, which is SERVER-global with no
 * per-tab override — so while they run, every page against this leg sees the
 * field they chose. That is only safe on `chat-mock.spec.ts`'s worker, which is
 * `mode: 'default'` (sequential, one worker) and is the single mock-server spec
 * file `playwright.config.ts` allows. Registering from there
 * ({@link registerComposerEscapeAndImeTests}) puts these tests in that file's
 * order while keeping them findable under the feature they test. Written inline
 * they would also have pushed that file further past `max-lines`, which the
 * README names as the other reason to reach for this shape.
 *
 * **The `.ts` extension is load-bearing.** Every `*.spec.ts` in this directory
 * runs on the COCKPIT leg against the real Claude Code runtime, where a driven
 * turn bills the machine's own `claude` sign-in. The IME test sends a message.
 * Renaming this file would hand that turn to the wrong leg.
 *
 * @module tests/chat/composer-escape-and-ime
 */
import { test, expect, request as apiRequest } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { ChatPage } from '../../pages/ChatPage.js';
import { expectComposerText, expectFieldFocused } from '../../pages/composer-probe.js';

/**
 * The draft both clear tests type.
 *
 * More than one word on purpose: a "clear" that only trimmed whitespace would
 * still pass on a single character.
 */
const DRAFT = 'a draft worth keeping';

/**
 * Words already committed to the draft before the IME test starts composing.
 *
 * Load-bearing — see the test for why an empty box cannot catch the bug.
 */
const PREFIX = 'hello ';

/** The romanised reading an IME shows while a candidate is being chosen. */
const READING = 'nihao';

/** The characters chosen from the candidate list. */
const CANDIDATE = '你好';

/** Messages the person has sent, as the transcript renders them. */
function userMessages(page: Page) {
  return page.locator('[data-testid="message-item"][data-role="user"]');
}

/**
 * Assert the field's text while a composition is OPEN, ignoring the editor's
 * zero-width marker.
 *
 * Lexical keeps a zero-width space (`U+200B`) in the DOM for as long as a
 * composition is live — it is how the browser is given something to anchor the
 * candidate to, and it disappears when the composition commits. It is invisible
 * to a person and it is not part of the draft, so asserting on it would be
 * asserting on an implementation detail of the editor rather than on what was
 * typed. Measured, not assumed: without this the read comes back `'nihao' + U+200B`.
 *
 * Only for assertions taken mid-composition. Everywhere else
 * {@link expectComposerText} is used unmodified, so nothing here can hide a
 * stray character in a settled draft.
 *
 * @param composer - Locator for the rich field.
 * @param text - The candidate text the field should be showing.
 * @param message - What the caller is really asserting, for the failure output.
 */
async function expectComposingText(
  composer: Locator,
  text: string,
  message: string
): Promise<void> {
  await expect
    .poll(() => composer.evaluate((el) => (el.textContent ?? '').replaceAll('\u200B', '')), {
      message,
    })
    .toBe(text);
}

/**
 * Read `ui.composer.richText`, set it, and hand back what it was.
 *
 * @param apiUrl - Base URL of the test-mode API leg.
 * @param next - The value to write.
 */
async function setRichText(apiUrl: string, next: boolean): Promise<boolean> {
  const context = await apiRequest.newContext({ baseURL: apiUrl });
  try {
    const current = await context.get('/api/config');
    const config = (await current.json()) as { ui?: { composer?: { richText?: boolean } } };
    const previous = config.ui?.composer?.richText ?? true;
    const res = await context.patch('/api/config', {
      data: { ui: { composer: { richText: next } } },
    });
    if (!res.ok()) throw new Error(`could not set richText=${next}: ${res.status()}`);
    return previous;
  } finally {
    await context.dispose();
  }
}

/**
 * Put the preference back, whatever happened.
 *
 * @param apiUrl - Base URL of the test-mode API leg.
 * @param value - The value to restore.
 */
async function restoreRichText(apiUrl: string, value: boolean): Promise<void> {
  const context = await apiRequest.newContext({ baseURL: apiUrl });
  try {
    await context.patch('/api/config', { data: { ui: { composer: { richText: value } } } });
  } finally {
    await context.dispose();
  }
}

/**
 * Type a draft, prove one Escape only arms, and prove two clear.
 *
 * Shared by both fields because it is the same rung; what differs is only which
 * field the caller hands over. The waits are structural rather than
 * decorative — see the comments inline.
 *
 * @param page - The page under test.
 * @param chatPage - The opened chat, whose `input` is the settled field.
 */
async function expectDoubleEscapeClears(page: Page, chatPage: ChatPage): Promise<void> {
  const composer = chatPage.input;
  await composer.click();
  await composer.fill(DRAFT);
  await expectComposerText(composer, DRAFT);

  // THE TRAP THIS ASSERTION EXISTS FOR. A probe that pressed keys without
  // checking focus first made this shortcut look broken once: the keys landed
  // on `document.body`, the draft stayed put, and the reading was "double
  // Escape does not clear" when the truth was "nothing was listening". Escape
  // is handled ON THE FIELD, so without this the whole test measures the wrong
  // thing — and stays green if the ladder is deleted.
  await expectFieldFocused(composer);

  // One Escape ARMS. Nothing clears, and the box says what the next one does.
  await composer.press('Escape');
  await expect(page.getByTestId('clear-armed-hint')).toBeVisible();
  await expectComposerText(composer, DRAFT, 'one Escape must never clear the box');

  // Let the window shut, and watch it shut. The pill and the disarm timer are
  // the same clock, so the hint going away IS the window closing — observed
  // rather than assumed, and a `waitForTimeout` would assume it.
  await expect(page.getByTestId('clear-armed-hint')).toBeHidden({ timeout: 5_000 });
  await expectComposerText(composer, DRAFT, 'a lapsed arm must leave the draft alone');

  // Two taps with NOTHING between them: an assertion here would spend the very
  // window it is measuring.
  await composer.press('Escape');
  await composer.press('Escape');

  await expectComposerText(composer, '', 'two Escapes inside the window clear the box');
}

/**
 * Register both suites onto the calling spec file's worker.
 *
 * @param options - The test-mode API URL, and a getter for the agent directory
 *   the caller's `beforeEach` seeds (read late, because it is re-seeded per
 *   test).
 */
export function registerComposerEscapeAndImeTests(options: {
  apiUrl: string;
  agentDir: () => string;
}): void {
  const { apiUrl } = options;

  test.describe('clearing the message box with two Escapes — formatting ON', () => {
    let previousRichText = true;

    test.beforeAll(async () => {
      previousRichText = await setRichText(apiUrl, true);
    });

    test.afterAll(async () => {
      await restoreRichText(apiUrl, previousRichText);
    });

    test('two Escapes clear the rich field and one never does', async ({ page }) => {
      const chatPage = new ChatPage(page);
      await chatPage.goto(undefined, { dir: options.agentDir() });
      // Wait for the RICH field, not merely for a composer: the editor is lazy,
      // so the composer is briefly the plain textarea and a test that did not
      // wait could assert against the wrong field and pass for the wrong reason.
      await expect(chatPage.input).toHaveAttribute('contenteditable', 'true', {
        timeout: 20_000,
      });

      await expectDoubleEscapeClears(page, chatPage);
    });

    test('Enter during an IME composition commits the candidate and sends nothing', async ({
      page,
      context,
    }) => {
      // ## What this proves, and what it does NOT
      //
      // It drives Chromium's own IME protocol (`Input.imeSetComposition`), so
      // the renderer really enters composition, really fires
      // `compositionstart` / `compositionupdate` at the field, and really
      // delivers the Enter below as `{ key: 'Enter', keyCode: 13,
      // isComposing: true }` — read off the live event, not assumed.
      //
      // It is NOT a real IME. No candidate window opens, no platform input
      // method is involved, and nothing here says a person typing Japanese on
      // macOS gets the right characters. Graduation criterion 4 in
      // `specs/composer-rich-text/02-specification.md` still wants a person and
      // a real browser — this closes the regression half of that gap, not the
      // acceptance half.
      //
      // ## Which guard is actually holding, because it is not the obvious one
      //
      // On THIS field the composition guard in `use-input-keyboard` never runs.
      // The rich field has no React `onKeyDown` at all (its own comment says
      // why: the ladder arrives through Lexical's commands, and a second
      // handler would run every rung twice), and Lexical does not dispatch
      // `KEY_ENTER_COMMAND` while it is composing. So the key is stopped one
      // level below us, and disabling our guard leaves this test green.
      //
      // That is defence in depth rather than dead code, and the mutation run
      // separates the two cleanly. Attach the forbidden React `onKeyDown` so the
      // key DOES reach the ladder, and: with our guard removed the composer
      // sends `hello ` mid-composition and this test fails on
      // `toHaveCount(0)` — received 1; with our guard restored it passes again.
      // So what this test defends is the assembled behaviour, and our guard is
      // what catches the key if anything ever routes one past Lexical.
      const chatPage = new ChatPage(page);
      await chatPage.goto(undefined, { dir: options.agentDir() });
      await expect(chatPage.input).toHaveAttribute('contenteditable', 'true', {
        timeout: 20_000,
      });

      const composer = chatPage.input;
      await composer.click();
      await expectFieldFocused(composer);

      const client = await context.newCDPSession(page);
      try {
        // A COMMITTED word before the composition starts, and it is what gives
        // this test teeth.
        //
        // Lexical does not push composing text into React state until the
        // composition ends, so with an empty box the send would be refused for
        // emptiness whether or not the guard existed — the test would pass
        // against a deleted guard. Measured, not reasoned: removing the guard
        // left the empty-box version green.
        //
        // With `hello ` already in the draft the box IS sendable, so an Enter
        // that reaches the send path sends `hello ` — the half-typed message the
        // guard exists to prevent. That is the failure this now catches, and it
        // is also what really happens to a person: you type some words, then
        // start composing a name.
        await composer.pressSequentially(PREFIX);
        await expectComposerText(composer, PREFIX);

        await client.send('Input.imeSetComposition', {
          text: READING,
          selectionStart: READING.length,
          selectionEnd: READING.length,
        });
        await expectComposingText(
          composer,
          `${PREFIX}${READING}`,
          'the composition reaches the field'
        );

        await composer.press('Enter');

        // THE WHOLE POINT: mid-composition, Enter belongs to the IME. Nothing is
        // sent — not the composition, and not the sendable words in front of it.
        await expect(userMessages(page)).toHaveCount(0);
        await expectComposerText(
          composer,
          `${PREFIX}${READING}`,
          'the half-typed reading survives Enter'
        );

        // Accept the candidate the way an IME does: a composition that REPLACES
        // the reading, then a commit.
        //
        // Both halves were measured rather than guessed, because the obvious
        // spellings do not work. `Input.insertText` alone is not a commit — it
        // appends, giving `nihao你好`. An `imeSetComposition` with empty text
        // does not retract the reading either, because by this point there is no
        // live composition to retract: the Enter above ENDED it, which is
        // visible in the field losing its zero-width composition marker. So the
        // reading is replaced BY RANGE, and then committed.
        await client.send('Input.imeSetComposition', {
          text: CANDIDATE,
          selectionStart: CANDIDATE.length,
          selectionEnd: CANDIDATE.length,
          replacementStart: PREFIX.length,
          replacementEnd: PREFIX.length + READING.length,
        });
        await client.send('Input.insertText', { text: CANDIDATE });
        await expectComposerText(
          composer,
          `${PREFIX}${CANDIDATE}`,
          'the committed candidate replaces the reading'
        );

        await composer.press('Enter');

        // Exactly one, not "at least one": the claim is that the FIRST Enter was
        // absorbed, and only `toHaveCount(1)` can fail if it was not.
        await expect(userMessages(page)).toHaveCount(1, { timeout: 20_000 });
        await expect(userMessages(page).first()).toContainText(`${PREFIX}${CANDIDATE}`);
        await expectComposerText(composer, '');
      } finally {
        await client.detach();
      }
    });
  });

  /**
   * The same rung on the plain `<textarea>`.
   *
   * Formatting as you type is the shipped default since 2026-08-12, so this is
   * the path a person reaches by turning the switch OFF — which makes it the one
   * more likely to rot unnoticed, and the reason it is covered here rather than
   * assumed to follow from the rich case.
   */
  test.describe('clearing the message box with two Escapes — formatting OFF', () => {
    let previousRichText = true;

    test.beforeAll(async () => {
      previousRichText = await setRichText(apiUrl, false);
    });

    test.afterAll(async () => {
      await restoreRichText(apiUrl, previousRichText);
    });

    test('two Escapes clear the plain field and one never does', async ({ page }) => {
      const chatPage = new ChatPage(page);
      await chatPage.goto(undefined, { dir: options.agentDir() });
      // Wait for the TEXTAREA specifically, for the mirror of the reason above:
      // the preference arrives from an async config read, so the composer
      // settles on a field a beat after the shell renders.
      await expect(chatPage.input).toHaveJSProperty('tagName', 'TEXTAREA');

      await expectDoubleEscapeClears(page, chatPage);
    });
  });
}
