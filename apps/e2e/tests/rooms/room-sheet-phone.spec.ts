import type { Locator } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { SERVER_ROUND_TRIP_MS } from '../../fixtures/rooms-api';
import { openCockpit } from './open-cockpit';
import {
  expandScale,
  memberRow,
  openSheet,
  PHONE,
  rectOf,
  seedRoom,
  settled,
  touchHeight,
  TOUCH_TARGET_PX,
} from './room-sheet-helpers';

// Same shape as its siblings: one cockpit at a time, and a ceiling sized for a
// machine already running several worktrees of agents. Nothing here starts an
// agent turn — every seeded agent is silenced by the fixture.
test.describe.configure({ mode: 'default', timeout: 90_000 });

/**
 * The room details sheet under a thumb, measured.
 *
 * A separate file from `room-sheet.spec.ts` because the viewport is a
 * describe-level fixture and these are the assertions that only exist below
 * 768px: a drawer rather than a dialog, a rung list rather than a segmented
 * control, and touch targets at all. The ruler both files share, and the
 * measurement traps they both fell into, are in `room-sheet-helpers.ts`.
 *
 * **What this file cannot prove: the real safe-area insets.** `index.css` pads
 * `[data-vaul-drawer]` with `env(safe-area-inset-bottom)` so the home indicator
 * never sits under the footer, and the risk is that something else pads it too
 * and the gap doubles. Headless Chromium has no supported way to set those
 * insets — they are 0 in every browser Playwright drives — so a test asserting
 * the gap would be asserting `0 === 0` and could never fail. What IS checked
 * below is the structural half that survives a zero inset: exactly one element
 * in the drawer declares that padding, so there is nothing to double. The
 * pixel gap itself stays a device check.
 */
test.describe('Room sheet on a phone — 390×844 @smoke', () => {
  test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

  test('the sheet stays on the screen, and its middle is the part that scrolls', async ({
    page,
    basePage,
    roomsApi,
  }) => {
    // Eight agents, because the failure this is about is a roster too long for
    // the screen — a sheet that fits has nothing to cap and nothing to scroll.
    const { roomId } = await seedRoom(roomsApi, 'phone-fit', 6);
    await openCockpit(basePage);
    const sheet = await openSheet(page, roomId);

    const box = await rectOf(sheet);
    // On screen at both ends. A drawer is `bottom-0` with `h-auto`, so a roster
    // of eight grows its TOP off the screen and takes the room's name with it —
    // the failure is at the top edge, which is why both are asserted.
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.bottom).toBeLessThanOrEqual(PHONE.height + 1);
    // And capped, so the cap is what makes the body a scrolling region at all.
    expect(box.height).toBeLessThanOrEqual(PHONE.height * 0.85 + 1);

    const body = sheet.locator('[data-slot="responsive-dialog-body"]');
    const header = sheet.getByRole('heading').first();
    const footer = sheet.getByRole('button', { name: 'Archive room' });
    await expect(footer).toBeVisible();

    const headerBefore = await rectOf(header);
    const footerBefore = await rectOf(footer);

    const scrolled = await body.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      return el.scrollTop;
    });
    expect(scrolled, 'the sheet body has nothing to scroll').toBeGreaterThan(0);

    // Pinned: the room's name and the way out of the room do not scroll away.
    // A pixel of tolerance is sub-pixel layout; a scrolled-away header moves by
    // its own height or more.
    expect((await rectOf(header)).top).toBeCloseTo(headerBefore.top, 0);
    expect((await rectOf(footer)).top).toBeCloseTo(footerBefore.top, 0);
  });

  test('exactly one element carries the home-indicator padding, so it cannot double', async ({
    page,
    basePage,
    roomsApi,
  }) => {
    const { roomId } = await seedRoom(roomsApi, 'safe-area');
    await openCockpit(basePage);
    const sheet = await openSheet(page, roomId);

    // The inset itself is 0 in every browser Playwright drives, so the GAP is
    // not assertable here (see this file's header). What is assertable is the
    // shape of the rule: `index.css` pads `[data-vaul-drawer]` and nothing
    // inside it may pad again. A second declaration is how the gap doubles on
    // a real phone, and it is visible from here even at a zero inset.
    const declarations = await sheet.evaluate((root) => {
      const found: string[] = [];
      const walk = (rules: CSSRuleList) => {
        for (const rule of [...rules]) {
          // A rule is judged on its selector and recursed into for its
          // children, and it can be both. Two traps here, each of which cost a
          // run: `@supports` wraps the rule that matters and has no selector of
          // its own, so counting its `cssText` is how this first "found" one
          // declaration that was the wrong one — and since CSS nesting shipped,
          // an ordinary `CSSStyleRule` ALSO carries a (usually empty)
          // `cssRules`, so treating "has cssRules" as "is a wrapper" skipped
          // every real rule and found none at all.
          const selector = (rule as CSSStyleRule).selectorText;
          if (typeof selector === 'string' && selector !== '') {
            if (
              rule.cssText.includes('safe-area-inset-bottom') &&
              (root.matches(selector) || root.querySelector(selector) !== null)
            ) {
              found.push(selector);
            }
          }
          const nested = (rule as CSSRule & { cssRules?: CSSRuleList }).cssRules;
          if (nested !== undefined && nested.length > 0) walk(nested);
        }
      };
      for (const styleSheet of [...document.styleSheets]) {
        try {
          walk(styleSheet.cssRules);
        } catch {
          continue; // cross-origin stylesheet; none of ours are
        }
      }
      return found;
    });

    expect(
      declarations,
      `more than one rule pads for the home indicator inside the drawer: ${declarations.join(', ')}`
    ).toHaveLength(1);
    expect(declarations[0]).toContain('data-vaul-drawer');
  });

  test('every control a thumb has to hit is at least 44px tall', async ({
    page,
    basePage,
    roomsApi,
  }) => {
    const { roomId, ana } = await seedRoom(roomsApi, 'targets');
    // One agent deliberately left OUT of the room, because the picker offers
    // only agents that are not in it already. Searched for by its own unique
    // name rather than by a shared prefix: the suite shares a server, so
    // "whatever the fleet happens to hold" is another test's business.
    const spare = await roomsApi.registerAgent(`E2E Spare ${roomsApi.runId}`, '🧰', '#15803d');
    await openCockpit(basePage);
    const sheet = await openSheet(page, roomId);

    /**
     * Measure one control and say which it was when it is too small.
     *
     * **Scrolled into view first, and that is not politeness.**
     * `document.elementFromPoint` works in VIEWPORT coordinates, so a control
     * sitting below the fold of the sheet's scrolling body answers for whatever
     * is painted at that point instead — which reads as a hit area truncated to
     * exactly the visible band. The third rung in an open scale measured 32px
     * that way, and it is 48.
     */
    const assertTouchable = async (label: string, locator: Locator) => {
      await expect(locator, `${label} is not on screen`).toBeVisible();
      await locator.scrollIntoViewIfNeeded();
      await settled(locator);
      const height = await touchHeight(locator);
      expect(height, `${label} is ${height}px tall`).toBeGreaterThanOrEqual(TOUCH_TARGET_PX);
    };

    // **A member row is measured differently, because it is not a control.**
    // The row carries a face and two lines of text and nothing about it is
    // pressable — the pill and the "…" are, and they are measured as controls
    // below. Its 56px is a reading measure, so the honest assertion is on the
    // laid-out box. Probing it as a hit area answers ~43px, because the row's
    // own padding belongs to the wrapper rather than to the row, and reading
    // that as a failed touch target would be measuring the wrong thing with the
    // wrong ruler.
    const row = await rectOf(memberRow(sheet, ana.name));
    expect(row.height, `a member row is ${row.height}px tall`).toBeGreaterThanOrEqual(
      TOUCH_TARGET_PX
    );

    await assertTouchable(
      'the loudness pill',
      sheet.getByRole('button', { name: `How loud ${ana.name} is here` })
    );
    // The "…" menu is deliberately absent here — it is `!isMobile`, and a
    // dropdown is a poor verb list under a thumb. Removal on touch is a plain
    // button inside the expanded row, measured with the rungs below.
    await expect(sheet.getByRole('button', { name: `${ana.name} actions` })).toHaveCount(0);
    await assertTouchable('the add row', sheet.getByRole('button', { name: 'Add agents' }));

    // The rung list, which on a phone replaces the segmented control.
    const scale = await expandScale(sheet, ana.name);
    for (const rung of await scale.getByRole('radio').all()) {
      await assertTouchable(`the "${await rung.getAttribute('aria-label')}" rung`, rung);
    }
    // The touch path's own removal verb, which stands in for the "…" menu.
    await assertTouchable(
      'the in-row Remove button',
      sheet.getByRole('button', { name: 'Remove from this room' })
    );

    // The picker's own rows, and the chip that takes one back off again.
    await sheet.getByRole('button', { name: 'Add agents' }).click();
    const search = sheet.getByRole('combobox', { name: 'Search agents' });
    await search.fill(spare.name);
    const option = page.getByRole('option', { name: spare.name, exact: true });
    await assertTouchable('a picker row', option);
    await option.click();
    await assertTouchable(
      'a chip’s remove button',
      sheet.getByRole('button', { name: `Remove ${spare.name}` })
    );
  });

  test('dragging the roster scrolls it; dragging the sheet itself puts it away', async ({
    page,
    basePage,
    roomsApi,
  }) => {
    const { roomId, ana } = await seedRoom(roomsApi, 'drag', 6);
    await openCockpit(basePage);
    const sheet = await openSheet(page, roomId);

    // A scale open and the list scrolled is the state where the two gestures
    // are most confusable: vaul listens for a downward drag to dismiss, and the
    // roster wants the same drag to scroll back up through it.
    await expandScale(sheet, ana.name);

    const body = sheet.locator('[data-slot="responsive-dialog-body"]');
    await body.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    const scrolledTo = await body.evaluate((el) => el.scrollTop);
    expect(scrolledTo, 'nothing to scroll, so this test proves nothing').toBeGreaterThan(0);

    // Two separate claims, because one gesture cannot carry both here.
    //
    // **The roster is the scrolling region.** Driven with the wheel, which is a
    // real scroll gesture the browser handles natively. A mouse drag is not:
    // click-and-drag inside a `overflow-y: auto` box scrolls nothing in any
    // browser, so an assertion that it did would be asserting against the
    // platform rather than against this sheet.
    const box = await rectOf(body);
    const x = box.left + box.width / 2;
    const y = box.top + box.height * 0.6;
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, -200);
    await expect.poll(() => body.evaluate((el) => el.scrollTop)).toBeLessThan(scrolledTo);

    // **And a downward drag over it does not throw the sheet away.** This is
    // vaul's own gesture, and it reaches it through pointer events, which
    // Playwright's mouse does generate — so this half is a real test of the
    // guard. A drawer that dismissed here would discard the reader's place in a
    // list they were part-way through, with an expanded row open in it.
    const heldAt = await body.evaluate((el) => el.scrollTop);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + 160, { steps: 12 });
    await page.mouse.up();

    await expect(sheet).toBeVisible();
    // And it did not silently jump somewhere else either.
    expect(await body.evaluate((el) => el.scrollTop)).toBe(heldAt);

    // The drawer's own handle is where dismissal lives, and it still works —
    // otherwise the assertion above would pass on a drawer nobody can close.
    const grip = await rectOf(sheet);
    await page.mouse.move(grip.left + grip.width / 2, grip.top + 8);
    await page.mouse.down();
    await page.mouse.move(grip.left + grip.width / 2, PHONE.height - 10, { steps: 16 });
    await page.mouse.up();
    await expect(sheet).toBeHidden({ timeout: SERVER_ROUND_TRIP_MS });
  });

  test("a long agent description truncates rather than pushing the picker's button away", async ({
    page,
    basePage,
    roomsApi,
    request,
  }) => {
    const ana = await roomsApi.registerAgent(`E2E Ana ${roomsApi.runId}`, '🦊', '#e07b39');
    const wordy = await roomsApi.registerAgent(`E2E Wordy ${roomsApi.runId}`, '📚', '#2563eb');
    // The second line is the agent's own words, and an operator can write as
    // many of them as they like. At 390px this is the line that wraps a picker
    // row to three and pushes the commit button under the keyboard.
    const long =
      'Reviews every pull request against the house style, writes the release notes, ' +
      'chases the flaky tests, and answers questions about the build system all day long.';
    const patched = await request.patch(`/api/mesh/agents/${wordy.id}`, {
      data: { description: long },
    });
    expect(patched.ok(), `could not give the agent a description: ${await patched.text()}`).toBe(
      true
    );

    const slug = `e2e-wordy-${roomsApi.runId}`;
    const room = await roomsApi.createChannel(slug, slug, [ana]);
    await openCockpit(basePage);
    const sheet = await openSheet(page, room.id);

    await sheet.getByRole('button', { name: 'Add agents' }).click();
    await sheet.getByRole('combobox', { name: 'Search agents' }).fill(wordy.name);
    const option = page.getByRole('option', { name: wordy.name, exact: true });
    await expect(option).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });

    const description = option.locator('[data-slot="candidate-description"]');
    await expect(description).toBeVisible();
    // One line, clipped — not three lines of somebody's prose reflowing the
    // list. `truncate` is the claim; `scrollWidth > clientWidth` is the proof
    // that it is actually doing something to this string.
    const line = await description.evaluate((el) => ({
      lines: Math.round(
        el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)
      ),
      overflowing: el.scrollWidth > el.clientWidth,
    }));
    expect(line.lines).toBe(1);
    expect(line.overflowing, 'the description is short enough that this proves nothing').toBe(true);

    // And the row it lives in is still inside the sheet.
    const rowBox = await rectOf(option);
    const sheetBox = await rectOf(sheet);
    expect(rowBox.right).toBeLessThanOrEqual(sheetBox.right + 1);

    // The commit button is reachable from the keyboard while the field has
    // focus — which is the state a phone is in, keyboard up, when somebody has
    // just typed a name.
    await option.click();
    const commit = sheet.getByRole('button', { name: 'Add agent' });
    await expect(commit).toBeVisible();
    const commitBox = await rectOf(commit);
    expect(commitBox.bottom).toBeLessThanOrEqual(sheetBox.bottom + 1);
    expect(commitBox.top).toBeGreaterThanOrEqual(sheetBox.top);
  });

  test('the header lines up with itself and stays inside the sheet', async ({
    page,
    basePage,
    roomsApi,
  }) => {
    const { roomId } = await seedRoom(roomsApi, 'header');
    await openCockpit(basePage);
    const sheet = await openSheet(page, roomId);

    // Both are the inline fields, named by what pressing them does — `Room
    // name: #slug` and `Topic: Add a topic`. The heading role belongs to the
    // sheet's own label, which is not the control being measured.
    const name = sheet.getByRole('button', { name: /^Room name:/ });
    const topic = sheet.getByRole('button', { name: /^Topic:/ });
    await expect(name).toBeVisible();
    await expect(topic).toBeVisible();

    const sheetBox = await rectOf(sheet);
    const nameBox = await rectOf(name);
    const topicBox = await rectOf(topic);

    // The name and the topic are one block, read top to bottom. A half-pixel of
    // rounding is layout; anything more is one of them indented against the
    // other, which is what a stacked header looks like when it is wrong.
    expect(Math.abs(nameBox.left - topicBox.left)).toBeLessThanOrEqual(1);
    // Both inside the sheet at 390px, where there is no room to spare.
    expect(nameBox.left).toBeGreaterThanOrEqual(sheetBox.left);
    expect(nameBox.right).toBeLessThanOrEqual(sheetBox.right + 1);
    expect(topicBox.right).toBeLessThanOrEqual(sheetBox.right + 1);
    // And the topic is under the name, not beside it.
    expect(topicBox.top).toBeGreaterThanOrEqual(nameBox.bottom - 1);
  });
});
