import { test, expect } from '../../fixtures';

/**
 * "Capture app view" must not cost the person their focus (DOR-1956).
 *
 * The capture hides everything floating above the app for two frames so the
 * dialog is not in its own screenshot. The first implementation did that with
 * `visibility: hidden`, and a real Chromium showed what jsdom cannot: hiding a
 * focused subtree blurs `document.activeElement` all the way to `<body>`, and it
 * does NOT come back when the style is undone. Two things break at once — the
 * caret disappears mid-sentence, and the paste path dies, because React's
 * `onPaste` sits on the portaled dialog and never sees an event delivered to the
 * body. `opacity: 0` paints nothing while keeping focus and hit-testing intact.
 *
 * This is the regression check for that, and it can only live in a browser: the
 * unit tests next to the module (`shared/lib/__tests__/app-capture.test.ts`) pin
 * the property name, but jsdom has no focus semantics to break in the first
 * place.
 *
 * The Dev Playground is the host, because it is the one page that mounts a
 * feedback dialog with no server state behind it — and the capture really runs
 * here, snapdom and all, against the playground's own DOM.
 */

/** Where the feedback dialog showcase lives. */
const PLAYGROUND_PATH = '/dev/components';

/**
 * How long the whole capture may take before this spec calls it a failure.
 *
 * Generously above what a re-draw of this (very long) page costs, and well under
 * the app's own 20s bound: the point of the wait is to reach the RESTORED state,
 * and the app reaches it whether the capture worked or gave up.
 */
const CAPTURE_SETTLE_MS = 30_000;

test.describe('Dev Playground — capturing the app view keeps the dialog focused', () => {
  test('leaves focus inside the dialog and the typed report intact', async ({ page }) => {
    await page.goto(PLAYGROUND_PATH);

    const section = page.locator('section', {
      has: page.getByRole('heading', { name: 'Feedback dialog' }),
    });
    await expect(section, 'the components page must render the feedback showcase').toBeVisible({
      timeout: 15_000,
    });

    await section.getByRole('button', { name: 'Open (Feedback)' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // A half-written report, so losing focus is losing something.
    const message = dialog.getByPlaceholder(/what works, what does not/i);
    await message.click();
    await message.fill('the sidebar looks wrong');
    await expect(message).toBeFocused();

    await dialog.getByRole('button', { name: /attachments & details/i }).click();
    const capture = dialog.getByRole('button', { name: 'Capture app view' });
    await expect(capture).toBeEnabled();

    // Watch focus WHILE the capture runs, not after it. Radix's focus scope
    // pulls focus back into the dialog the moment it escapes, so the end state
    // heals itself and says nothing — measured: this spec passed with
    // `visibility: hidden` restored until it started sampling. The damage is in
    // the window where the chrome is hidden, and it is what the person feels:
    // the caret vanishes, and any paste in that window is delivered to the body
    // instead of to the dialog React is listening on.
    await page.evaluate(() => {
      const seen: string[] = [];
      (window as unknown as { __focusSamples: string[] }).__focusSamples = seen;
      const sample = () => {
        const active = document.activeElement;
        const panel = document.querySelector('[role="dialog"]');
        const inside = Boolean(active && panel?.contains(active));
        seen.push(inside ? 'inside' : (active?.tagName.toLowerCase() ?? 'none'));
      };
      const timer = window.setInterval(sample, 10);
      // Stopped from the test once the capture is over, so a runaway interval
      // cannot outlive the page it samples.
      (window as unknown as { __stopFocusSamples: () => void }).__stopFocusSamples = () =>
        window.clearInterval(timer);
    });

    await capture.click();

    // Both halves, in this order. Waiting only for "enabled again" passes on the
    // very first poll — before React has even re-rendered the click — and every
    // assertion below then runs mid-capture, with the app still faded out
    // (measured: this spec failed exactly that way before the disabled wait was
    // added). The capture is over once the button has gone away and come back,
    // which happens whether it produced a picture or gave up.
    await expect(capture, 'clicking must put the capture in flight').toBeDisabled();
    await expect(capture, 'the capture must finish and hand the button back').toBeEnabled({
      timeout: CAPTURE_SETTLE_MS,
    });

    // The DOM engine really ran here, on this page, in a real browser — the one
    // claim no unit test can make, since jsdom has no rasterizer. What it
    // produced is a compressed `data:` URL in the thumbnail.
    const thumbnail = dialog.getByAltText('The screenshot you attached');
    await expect(thumbnail, 'the capture must attach a picture of the app').toBeVisible();
    await expect(thumbnail).toHaveAttribute('src', /^data:image\/(webp|jpeg|png);base64,/);

    // THE regression assertion, over the whole life of the capture. Not "the
    // textarea is still focused" — clicking a button focuses the button in a
    // real browser, so that could never pass, in either implementation.
    const samples = await page.evaluate(() => {
      (window as unknown as { __stopFocusSamples: () => void }).__stopFocusSamples();
      return (window as unknown as { __focusSamples: string[] }).__focusSamples;
    });
    expect(samples.length, 'the sampler must actually have run during the capture').toBeGreaterThan(
      5
    );
    expect(
      [...new Set(samples)].sort(),
      'focus must stay inside the feedback dialog for every moment of the capture. A `body` here ' +
        'is the `visibility: hidden` defect: hiding a focused subtree blurs it, the caret goes, ' +
        'and a paste in that window is delivered to the body instead of to the portaled dialog ' +
        'React listens on'
    ).toEqual(['inside']);

    // Nothing was hidden and left hidden: the dialog is on screen, its text is
    // where the person left it, and the app behind it is visible again.
    await expect(dialog).toBeVisible();
    await expect(message).toHaveValue('the sidebar looks wrong');
    // Asked of the dialog's own portal wrapper rather than of every body child,
    // and that is a finding rather than a convenience: Radix keeps two focus
    // guards on the body which IT sets to `opacity: 0`, so "nothing on the body
    // is faded" is false while any dialog is open and would fail here forever.
    // It is also the live proof that restoring the PREVIOUS value — instead of
    // blanking the property — is the correct half of the hide: blanking would
    // hand Radix back its guards in a state it did not leave them in.
    const wrapperOpacity = await page.evaluate(() => {
      const panel = document.querySelector('[role="dialog"]');
      const wrapper = Array.from(document.body.children).find((child) =>
        panel ? child.contains(panel) : false
      );
      return wrapper instanceof HTMLElement ? wrapper.style.opacity : null;
    });
    expect(
      wrapperOpacity,
      'the dialog’s portal wrapper must be back to its own opacity once the capture is over'
    ).toBe('');

    // And typing still lands in the report, which is the practical form of
    // "the dialog is still usable".
    await message.click();
    await message.pressSequentially(' — after the capture');
    await expect(message).toHaveValue('the sidebar looks wrong — after the capture');
  });
});
