import { test, expect } from '../../fixtures';

/**
 * `BarTabStrip` never yields below one readable tab (DOR-1748, DOR-1816).
 *
 * Audit finding 2.3: `flex-initial` gives space away to everything beside it,
 * and with nothing to stop it the strip gave away all of it — on a 768px window
 * with the sidebar and the right panel both docked, the four home tabs measured
 * **16px wide**, with no label on them and not even the fade that says there is
 * more. `min-w-28` is the floor that fixed it.
 *
 * **The unit suite could not test that, and for a while pretended to.**
 * `bar-tab-strip.test.tsx` asserted `expect(wrapper).toHaveClass('min-w-28')`,
 * which is a restatement of the line above it: it can only fail if somebody
 * edits the class the assertion reads, and it passes just as happily against a
 * build where the floor is overridden, or where the strip has been moved
 * somewhere the floor cannot bind. PR #1522's own review named it as a
 * tautology and left it as a follow-up. jsdom is why — it lays nothing out, so
 * a rendered width is not a thing it has.
 *
 * So this measures. The Dev Playground's One Bar page renders the strip inside
 * a 236px frame — the width the page really has at 768px with both panels
 * docked, which is the exact configuration the finding was measured in — and
 * every number below is read off that laid-out box.
 *
 * **Four readings, because the floor alone is not the promise.** A strip that
 * is 112px wide because it happens to fit is not a strip at its floor; a strip
 * at its floor with no fade is the "not even the fade" half of the finding
 * still broken; and a strip whose first tab has no readable label is 2.3 again
 * at a different number. So the spec reads the width, whether the strip is
 * genuinely overflowing, whether the end fade is drawn, and how wide the first
 * tab's own box is.
 */

/**
 * `min-w-28` in pixels — the floor `bar-tab-strip.tsx` sets, and the number
 * this spec exists to observe rather than restate.
 */
const FLOOR_PX = 112;

/** Sub-pixel layout rounding is not a strip below its floor. */
const SLACK_PX = 1;

/**
 * The narrowest a tab may be and still be one this strip was worth keeping.
 *
 * "Home" at `text-sm` plus `px-2.5` measures ~53px. Forty is comfortably under
 * that and comfortably over the 16px the whole four-tab strip collapsed to,
 * so it fails on the defect and not on a font that renders a pixel differently.
 */
const LEGIBLE_TAB_PX = 40;

/** How the showcase names the squeezed strip — see `OneBarShowcases.tsx`. */
const STRIP = 'playground-squeezed-tabs';

test.describe('One Bar — the tab strip keeps one readable tab @smoke', () => {
  test('the strip holds its floor in a 236px bar instead of collapsing', async ({ page }) => {
    await page.goto('/dev/one-bar');

    const strip = page.getByTestId(STRIP);
    await expect(
      strip,
      'the One Bar playground page must render the squeezed strip showcase'
    ).toBeVisible({ timeout: 15_000 });

    /**
     * Every reading in ONE evaluation, so no two of them describe the strip at
     * different moments — the fades are toggled by the app's own scroll handler
     * and lag the geometry they belong to under load (DOR-1414).
     */
    const read = () =>
      strip.evaluate((scroller) => {
        const wrapper = scroller.parentElement!;
        const firstTab = scroller.querySelector('a');
        const id = scroller.dataset.testid;
        return {
          wrapperWidth: wrapper.getBoundingClientRect().width,
          deficit: scroller.scrollWidth - scroller.clientWidth,
          firstTabWidth: firstTab === null ? 0 : firstTab.getBoundingClientRect().width,
          firstTabLabel: (firstTab?.textContent ?? '').trim(),
          tabs: scroller.querySelectorAll('a').length,
          scrollLeft: scroller.scrollLeft,
          fadeStart: document.querySelectorAll(`[data-testid="${id}-fade-start"]`).length,
          fadeEnd: document.querySelectorAll(`[data-testid="${id}-fade-end"]`).length,
        };
      });

    // The strip reveals its active tab on mount and again on every resize, and
    // the font it measures with lands asynchronously — so the first reading is
    // of a strip still moving. Polled until the fades agree with the scroll
    // position they were read beside; the assertions below then judge a
    // reading that has stopped changing.
    let measured = await read();
    await expect
      .poll(
        async () => {
          measured = await read();
          const wantStart = measured.scrollLeft > SLACK_PX ? 1 : 0;
          const wantEnd = measured.scrollLeft < measured.deficit - SLACK_PX ? 1 : 0;
          return measured.fadeStart === wantStart && measured.fadeEnd === wantEnd;
        },
        { message: 'the strip never settled with its fades agreeing with its scroll position' }
      )
      .toBe(true);

    // The floor, measured. 16.0px is what the defect rendered.
    expect(
      measured.wrapperWidth,
      `the strip is ${measured.wrapperWidth.toFixed(1)}px wide in a 236px bar and must be at ` +
        `least ${FLOOR_PX}px — 16px is what finding 2.3 measured before the floor existed`
    ).toBeGreaterThanOrEqual(FLOOR_PX - SLACK_PX);

    // …and it is at the floor because the frame is squeezing it, not because
    // the frame turned out to be roomy. Without this the reading above passes
    // in a bar wide enough that no floor was ever consulted.
    expect(
      measured.deficit,
      `the 236px frame must actually squeeze the strip for the floor to mean anything — its ` +
        `${measured.tabs} tabs overflow by ${measured.deficit}px, and anything at or below 0 ` +
        `means they all fit and this case is measuring nothing`
    ).toBeGreaterThan(0);

    // The other half of the finding: "no label, and not even the fade". WHICH
    // edge carries it is decided by where the strip is scrolled and not by this
    // spec — the showcase marks the LAST tab active, so the strip reveals it and
    // sits at its end, where a fade over the end edge would be a cue pointing at
    // nothing (ADR 260725-004456). The poll above already pinned the agreement;
    // this is the part it cannot say, and the part the finding is about: an
    // overflowing strip has to advertise it SOMEWHERE.
    expect(
      measured.fadeStart + measured.fadeEnd,
      `${measured.deficit}px of tabs are off the ends of this strip and no edge says so ` +
        `(start:${measured.fadeStart} end:${measured.fadeEnd}, scrolled ` +
        `${measured.scrollLeft.toFixed(1)}px)`
    ).toBeGreaterThan(0);

    expect(
      measured.firstTabWidth,
      `the first tab ("${measured.firstTabLabel}") is ${measured.firstTabWidth.toFixed(1)}px ` +
        `wide and must be at least ${LEGIBLE_TAB_PX}px — a strip at its floor with unreadable ` +
        `tabs is finding 2.3 at a different number`
    ).toBeGreaterThanOrEqual(LEGIBLE_TAB_PX);
  });
});
