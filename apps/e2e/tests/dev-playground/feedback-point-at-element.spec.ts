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
    await expect(dialog.getByPlaceholder(/what works, what does not/i)).toBeHidden();
    // Scoped to the picker: the playground also carries a STILL of this hint,
    // in the showcase that puts the look on the page without the live picker
    // taking it over. An unscoped query matches both.
    await expect(picker.getByText('Click the part that looks wrong. Esc to cancel.')).toBeVisible();

    // The playground's own sidebar nav, and three things make it the right
    // target. It is pinned, so it is on screen whatever the page is scrolled to
    // — which matters, because the picker swallows the wheel with everything
    // else and a target below the fold cannot be reached once aiming has
    // started. It carries a `data-slot` the app really uses, so the identity
    // block has something real to report. And pressing it NAVIGATES, so a picker
    // that let the click through would leave this spec on another page entirely.
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

    // Its own status while the picture is being taken — the one moment nothing
    // else on screen can report from, because the dialog is out of the way.
    await expect(page.getByText('Taking the picture…')).toBeVisible();

    // And the dialog comes back with the crop attached. snapdom really ran, the
    // canvas really drew, and what came out is a bounded `data:` URL — none of
    // which any unit test in this repo can claim.
    const thumbnail = dialog.getByAltText('The screenshot you attached');
    await expect(thumbnail, 'pointing must attach a picture').toBeVisible({
      timeout: CAPTURE_SETTLE_MS,
    });
    await expect(thumbnail).toHaveAttribute('src', /^data:image\/(webp|jpeg|png);base64,/);

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
