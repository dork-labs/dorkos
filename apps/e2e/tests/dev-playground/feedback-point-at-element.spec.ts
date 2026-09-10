import { test, expect } from '../../fixtures';

/**
 * Pointing at one element really works, in a real browser (DOR-911).
 *
 * Almost all of this feature is unreachable from jsdom, and not by a little:
 * jsdom implements no hit-testing at all, so `document.elementFromPoint` — the
 * single call the picker is built around — does not exist there and has to be
 * stubbed. Every element measures 0x0, so a crop rectangle means nothing. There
 * is no rasterizer, so the capture cannot run and the canvas cannot draw. The
 * unit tests next door pin the arithmetic (`element-crop.test.ts`, at both pixel
 * ratios and every edge), the naming (`element-identity.test.ts`) and the wiring
 * (`PointAtElementOverlay.test.tsx`, `FeedbackDialog.test.tsx`). What only a
 * browser can answer is whether those pieces, put together over a live page,
 * produce a picture of the thing that was clicked:
 *
 * - the picker really covers the app and really finds what is underneath it;
 * - a click on a live control is swallowed by the picker instead of pressing it;
 * - snapdom really runs, the crop really draws, and a `data:` URL really comes
 *   back attached;
 * - and everything already typed is still there afterwards.
 *
 * The Dev Playground is the host for the same reason the capture spec beside it
 * uses it: it is the one page that mounts a feedback dialog with no server state
 * behind it, and the capture really runs against its own DOM.
 */

/** Where the feedback dialog showcase lives. */
const PLAYGROUND_PATH = '/dev/components';

/**
 * How long the whole capture-and-crop may take before this spec calls it a
 * failure. Generously above what a re-draw of this (very long) page costs, and
 * well under the app's own 20s bound.
 */
const CAPTURE_SETTLE_MS = 30_000;

test.describe('Dev Playground — pointing at one element', () => {
  test('crops the report to what was clicked and names it', async ({ page }) => {
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

    // A half-written report, so a round trip that loses it loses something.
    const message = dialog.getByPlaceholder(/what works, what does not/i);
    await message.click();
    await message.fill('this control is dead');

    await dialog.getByRole('button', { name: /attachments & details/i }).click();
    const point = dialog.getByRole('button', { name: 'Point at element' });
    await expect(
      point,
      'the affordance must be live, not a labelled-soon placeholder'
    ).toBeEnabled();
    await point.click();

    // The dialog steps aside and the picker takes its place — one thing on
    // screen, so there is nothing to aim past.
    const picker = page.getByRole('dialog', {
      name: 'Point at the part of the app that looks wrong',
    });
    await expect(picker).toBeVisible();
    // Asked of the PAGE and by count, not of `dialog` and by visibility. Two
    // traps in one line otherwise: `dialog` now resolves to the picker, so a
    // textarea query under it matches nothing at all — and `toBeHidden` is
    // satisfied by matching nothing, so the assertion passes whatever the
    // feedback dialog is doing.
    await expect(
      page.getByPlaceholder(/what works, what does not/i),
      'the dialog must be out of the way, not merely behind the picker'
    ).toHaveCount(0);
    // Scoped to the picker: the playground also carries a STILL of this hint,
    // in the showcase that puts the look on the page without the live picker
    // taking it over. An unscoped query matches both.
    await expect(picker.getByText('Click the part that looks wrong. Esc to cancel.')).toBeVisible();

    // The playground's own sidebar nav, and three things make it the right
    // target. It is pinned, so it is on screen whatever the page is scrolled to.
    // It carries a `data-slot` the app really uses, so the identity block has
    // something real to report. And pressing it NAVIGATES, so a picker that let
    // the click through would leave this spec on another page entirely.
    //
    // Measured after the picker is up, not before: closing the dialog releases
    // its scroll lock, and a box read through a modal is a box read at a
    // different moment.
    const target = page.getByRole('button', { name: 'Design Tokens' });
    const box = await target.boundingBox();
    expect(box, 'the spec needs a real, laid-out element to point at').not.toBeNull();
    if (!box) return;
    const viewportSize = page.viewportSize();
    expect(viewportSize, 'the spec needs a viewport size').not.toBeNull();
    if (!viewportSize) return;
    const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

    // Hovering lights it up, with the name from its own markup. This is the
    // whole `elementFromPoint`-through-the-overlay mechanism working: a picker
    // that failed to look past itself would highlight nothing, or highlight the
    // overlay's own box.
    await page.mouse.move(centre.x, centre.y);
    const highlight = picker.locator('div[style*="box-shadow"]');
    await expect(highlight, 'hovering must light up the element under the pointer').toBeVisible();

    await page.mouse.click(centre.x, centre.y);

    // Watch what is actually PAINTED for the length of the capture, rather than
    // what is in the DOM. Playwright's `toBeVisible` does not consider opacity,
    // so an assertion that some progress cue "is visible" passes perfectly well
    // against a cue faded to nothing — which is what happens here, and the
    // reason this spec samples instead.
    //
    // Started AFTER the click, and that is the whole reason this is reliable: a
    // sampler running before it catches the picker mid-AIM at full opacity,
    // which is correct then and says nothing about the capture. Measured — a run
    // with the sampler started early logged a `"1"` and failed. Nothing is
    // missed by starting late: the click's own task runs the hide sweep to
    // completion before the browser can paint again, so the first paint after
    // the click is already faded.
    await page.evaluate(() => {
      const seen: string[] = [];
      (window as unknown as { __pickerOpacity: string[] }).__pickerOpacity = seen;
      const timer = window.setInterval(() => {
        const picker = document.querySelector(
          '[aria-label="Point at the part of the app that looks wrong"]'
        );
        seen.push(picker instanceof HTMLElement ? getComputedStyle(picker).opacity : 'gone');
      }, 10);
      (window as unknown as { __stopPickerSamples: () => void }).__stopPickerSamples = () =>
        window.clearInterval(timer);
    });

    // And the dialog comes back with the crop attached. snapdom really ran, the
    // canvas really drew, and what came out is a bounded `data:` URL — none of
    // which any unit test in this repo can claim.
    const thumbnail = dialog.getByAltText('The screenshot you attached');
    await expect(thumbnail, 'pointing must attach a picture').toBeVisible({
      timeout: CAPTURE_SETTLE_MS,
    });
    await expect(thumbnail).toHaveAttribute('src', /^data:image\/(webp|jpeg|png);base64,/);

    // THE honest claim about the capture, measured rather than asserted: for
    // every moment of it the picker is painted at zero. The capture's own hide
    // sweep fades every child of `<body>` so the picture is of the app and
    // nothing else, and the picker is one of those children. So there is no
    // progress cue to show and none is offered — the same truth `app-capture.ts`
    // states about the dialog. A future "let's add a spinner" lands here.
    const opacities = await page.evaluate(() => {
      (window as unknown as { __stopPickerSamples: () => void }).__stopPickerSamples();
      return (window as unknown as { __pickerOpacity: string[] }).__pickerOpacity;
    });
    expect(opacities.length, 'the sampler must have run during the capture').toBeGreaterThan(5);
    // Measured up to the LAST faded sample, not to the end of the run. The
    // capture puts every opacity back in a `finally`, and React unmounts the
    // picker a tick or two later — so the tail of every run holds a frame or two
    // of the picker at full opacity, which is real and harmless: it renders
    // nothing at all while capturing, so what is at full opacity is an empty
    // transparent box. What matters is the window the hide sweep was in effect
    // for, because that window is what the photograph contains.
    const lastFaded = opacities.lastIndexOf('0');
    expect(
      lastFaded,
      'the sampler must have caught the capture itself, not only the aftermath'
    ).toBeGreaterThanOrEqual(0);
    expect(
      [...new Set(opacities.slice(0, lastFaded + 1))],
      'the picker must be painted at zero for every moment the capture was running. Anything ' +
        'else here is a cue that would also be IN the photograph'
    ).toEqual(['0']);

    // Cropped, not the whole app: the picture is of one button plus its
    // surroundings, so it is a small fraction of a full-page capture. Measured
    // on the decoded image rather than on the thumbnail's laid-out box, which is
    // whatever CSS made it.
    const shot = await thumbnail.evaluate(
      (img: HTMLImageElement) =>
        new Promise<{ width: number; height: number }>((resolve) => {
          const probe = new Image();
          probe.onload = () => resolve({ width: probe.naturalWidth, height: probe.naturalHeight });
          probe.src = img.src;
        })
    );
    expect(
      shot.height,
      'a crop of one button must be far shorter than a picture of the whole page — an ' +
        'unscaled or uncropped capture is the failure this catches'
    ).toBeLessThan(viewportSize.height / 2);
    expect(shot.width, 'and it must still be a real picture, not a 1px sliver').toBeGreaterThan(20);

    // The report says which element, in the field the person can read and edit.
    const composed = dialog.getByPlaceholder(/what happened, and what did you expect/i);
    await expect(composed).toHaveValue(/this control is dead/);
    await expect(composed, 'the report must name the element that was clicked').toHaveValue(
      /Element: /
    );
    // The real slot off the real markup — the name the codebase uses for this
    // part, which is what makes the line worth sending.
    await expect(composed).toHaveValue(/Slot: sidebar-menu-button/);

    // Pointing at something broken is a bug report.
    await expect(dialog.getByRole('radio', { name: 'Bug' })).toHaveAttribute(
      'aria-checked',
      'true'
    );

    // The click was the picker's, not the nav button's. Pressing that control
    // navigates to the Design Tokens page, which would unmount this showcase
    // and the dialog with it — so still being here IS the proof.
    //
    // Asked with the dialog CLOSED, and that is a finding rather than a tidy-up:
    // a modal puts everything behind it under `aria-hidden`, and Playwright's
    // role queries skip hidden subtrees — so `section` genuinely cannot be found
    // while the report is open, whichever page this is.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(
      section,
      'the picker must swallow the click rather than press what is under it'
    ).toBeVisible();
  });

  test('Escape puts the dialog back exactly as it was', async ({ page }) => {
    await page.goto(PLAYGROUND_PATH);

    const section = page.locator('section', {
      has: page.getByRole('heading', { name: 'Feedback dialog' }),
    });
    await expect(section).toBeVisible({ timeout: 15_000 });
    await section.getByRole('button', { name: 'Open (Feedback)' }).click();

    const dialog = page.getByRole('dialog');
    const message = dialog.getByPlaceholder(/what works, what does not/i);
    await message.click();
    await message.fill('changed my mind');
    await dialog.getByRole('button', { name: /attachments & details/i }).click();
    await dialog.getByRole('button', { name: 'Point at element' }).click();

    const picker = page.getByRole('dialog', {
      name: 'Point at the part of the app that looks wrong',
    });
    await expect(picker).toBeVisible();

    await page.keyboard.press('Escape');

    // Not a fresh dialog: the same one, with everything still in it. A round
    // trip that resets the form makes the affordance not worth pressing — and
    // Escape must not fall through to close the dialog either.
    await expect(picker).toBeHidden();
    await expect(message).toBeVisible();
    await expect(message).toHaveValue('changed my mind');
    await expect(dialog.getByAltText('The screenshot you attached')).toHaveCount(0);
  });
});
