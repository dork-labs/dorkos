import { expect, type Locator } from '@playwright/test';

/**
 * Read a composer's text and caret without caring which field is rendered.
 *
 * ## Why these exist
 *
 * The composer has two fields behind one preference (`ui.composer.richText`,
 * DOR-948): a `<textarea>` and a Lexical `contenteditable`. They are the same
 * control to a person and to a screen reader — same `role="combobox"`, same
 * accessible name, so every locator in the page objects keeps working — but
 * they are not the same DOM node, and two ways of interrogating a field stopped
 * working when the second one arrived:
 *
 * - `el.selectionStart` is a property of `HTMLTextAreaElement`. A
 *   contenteditable has no such thing; the caret lives in a `Selection`.
 * - Playwright's `toHaveValue` requires an `<input>`, `<textarea>` or
 *   `<select>` and THROWS on anything else, so it does not merely fail on a
 *   contenteditable — it errors.
 *
 * These helpers answer the same two questions on either field, so ONE spec
 * covers both paths and the suite never forks. Typing needs no helper: `.fill()`
 * and `.pressSequentially()` already work on a contenteditable.
 */

/**
 * The caret's offset into the field's text, counted the way a person would.
 *
 * For a textarea this is `selectionStart` verbatim. For a contenteditable it is
 * the length of the text between the element's start and the caret, measured
 * with a `Range`, which is the same number: both count characters of visible
 * text preceding the caret.
 *
 * Returns `null` when the field does not hold the selection at all, so a caller
 * can tell "the caret is at 0" apart from "nothing is focused here" — a
 * distinction `selectionStart` cannot make and which silently reads as 0.
 *
 * @param composer - Locator for the composer field, either shape.
 */
export async function caretOffset(composer: Locator): Promise<number | null> {
  return composer.evaluate((el) => {
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      return el.selectionStart;
    }
    const selection = el.ownerDocument.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const caret = selection.getRangeAt(0);
    if (!el.contains(caret.startContainer)) return null;
    const toCaret = el.ownerDocument.createRange();
    toCaret.selectNodeContents(el);
    toCaret.setEnd(caret.startContainer, caret.startOffset);
    return toCaret.toString().length;
  });
}

/**
 * The field's text, as markdown source on either path.
 *
 * A textarea answers with `value`. A contenteditable answers with `textContent`
 * — which is the RENDERED text, so `**bold**` reads back as `bold`. That is the
 * honest answer for this field: the syntax characters are consumed as they are
 * typed, and asserting on what is on screen is what a spec should be doing. A
 * spec that needs the markdown SOURCE should assert on the sent message body
 * instead, which is where the wire format is actually visible.
 *
 * @param composer - Locator for the composer field, either shape.
 */
export async function composerText(composer: Locator): Promise<string> {
  return composer.evaluate((el) =>
    el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement
      ? el.value
      : (el.textContent ?? '')
  );
}

/**
 * Assert the composer's text, retrying like a web-first assertion.
 *
 * The drop-in for `await expect(composer).toHaveValue(x)`. `expect.poll` is what
 * keeps the retry semantics: the plain `expect(await composerText(…))` form
 * reads once and fails on the first render that has not caught up, which is
 * exactly the flake `toHaveValue` existed to avoid.
 *
 * @param composer - Locator for the composer field, either shape.
 * @param text - The text the field should settle on.
 * @param message - What the caller is really asserting, for the failure output.
 */
export async function expectComposerText(
  composer: Locator,
  text: string,
  message?: string
): Promise<void> {
  await expect
    .poll(() => composerText(composer), message === undefined ? undefined : { message })
    .toBe(text);
}

/**
 * Assert the composer field itself holds focus — the check to make BEFORE
 * pressing any key at it.
 *
 * Every rung of the composer's keyboard ladder is handled on the FIELD, so a
 * key pressed while focus sits on `document.body` does nothing and proves
 * nothing. A test that skips this reads a real shortcut as broken, and stays
 * green if the shortcut is deleted — which is how the double-Escape clear was
 * once written off as not working.
 *
 * Field-shape agnostic like the rest of this module: `activeElement` answers
 * the same for a `<textarea>` and for a `contenteditable`, so one assertion
 * covers both paths.
 *
 * @param composer - Locator for the composer field, either shape.
 */
export async function expectFieldFocused(composer: Locator): Promise<void> {
  await expect
    .poll(() => composer.evaluate((el) => el === el.ownerDocument.activeElement), {
      message: 'the composer field must hold focus before any key is pressed at it',
    })
    .toBe(true);
}

/**
 * Assert where the caret sits, retrying for the same reason as
 * {@link expectComposerText}.
 *
 * @param composer - Locator for the composer field, either shape.
 * @param offset - The offset the caret should settle on.
 * @param message - What the caller is really asserting, for the failure output.
 */
export async function expectCaretAt(
  composer: Locator,
  offset: number,
  message?: string
): Promise<void> {
  await expect
    .poll(() => caretOffset(composer), message === undefined ? undefined : { message })
    .toBe(offset);
}
