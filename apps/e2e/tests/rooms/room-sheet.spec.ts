import type { Locator } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { SERVER_ROUND_TRIP_MS } from '../../fixtures/rooms-api';
import { publishPresence, tapRoomStream } from './room-signals';
import { openCockpit } from './open-cockpit';
import {
  clipOverflow,
  memberRow,
  openSheet,
  ringBleed,
  seedRoom,
  settled,
  tabTo,
  transitionMs,
} from './room-sheet-helpers';

// Same shape as its siblings: one cockpit at a time, and a ceiling sized for a
// machine already running several worktrees of agents. Nothing here starts an
// agent turn — every seeded agent is silenced by the fixture.
test.describe.configure({ mode: 'default', timeout: 90_000 });

/**
 * The room details sheet at a pointer, measured.
 *
 * Its phone half is `room-sheet-phone.spec.ts` — one subject split by viewport,
 * sharing one ruler in `room-sheet-helpers.ts`, which is also where the three
 * measurement traps these tests fell into are written down.
 */
test.describe('Room panel — what only a laid-out page can show @smoke', () => {
  test('the room meter and the pointed-at member move as one, and slide rather than jump', async ({
    page,
    basePage,
    roomsApi,
  }) => {
    const { roomId, ana } = await seedRoom(roomsApi, 'preview');
    await openCockpit(basePage);
    const sheet = await openSheet(page, roomId);

    const roomLine = sheet.locator('[data-slot="room-loudness-line"]');
    await expect(roomLine).toBeVisible();
    // The fixture silences every agent it seeds, so this is the room's real
    // resting answer and the preview below has somewhere to move to.
    await expect(roomLine).toContainText('Nobody here will answer you');
    await expect(roomLine).not.toHaveAttribute('data-preview', 'true');

    const pill = sheet.getByRole('button', { name: `How loud ${ana.name} is here` });
    await pill.click();
    const scale = sheet.getByRole('radiogroup', { name: `How loud is ${ana.name} here?` });
    await expect(scale).toBeVisible();

    const roomMeter = roomLine.locator('[data-slot="loudness-meter"]');
    const pillMeter = pill.locator('[data-slot="loudness-meter"]');

    // **As one system, or not at all.** Both meters are the same mark saying the
    // same thing at two scales, and the point of the preview is that a person
    // sees one cause the other. Two different durations would be two gestures
    // that happen to be near each other. Dropping `BAR_TRANSITION` from either
    // meter reddens this.
    const roomBar = roomMeter.locator('span').first();
    const pillBar = pillMeter.locator('span').first();
    const roomMs = await transitionMs(roomBar);
    const pillMs = await transitionMs(pillBar);
    expect(roomMs).toBeGreaterThan(0);
    expect(roomMs).toBe(pillMs);

    // Point at the loudest rung — with the mouse, which is the interaction the
    // phone cannot have — and the whole room restates itself as a hypothetical.
    await scale.getByRole('radio', { name: 'Everything' }).hover();
    await expect(roomLine).toHaveAttribute('data-preview', 'true');
    await expect(roomLine).toContainText('answers every message here');
    // And it says so in words too, for a reader who cannot see the tint.
    await expect(roomLine.getByText('If you make that change:')).toBeAttached();

    // Nothing was written: the sentence is a proposal until a rung is pressed.
    await expect(scale.getByRole('radio', { name: 'Silent' })).toHaveAttribute(
      'aria-checked',
      'true'
    );

    // Stop pointing and the room goes back to the truth. The pointer is moved
    // rather than hovered onto something else: the loudness line is repainting
    // as the preview clears, so Playwright's "visible and stable" check on a
    // hover target waits for an element that is mid-transition by construction.
    await page.mouse.move(4, 4);
    await expect(roomLine).not.toHaveAttribute('data-preview', 'true');
    await expect(roomLine).toContainText('Nobody here will answer you');
  });

  test('a rung committed moves the member meter and the room meter to the same answer', async ({
    page,
    basePage,
    roomsApi,
  }) => {
    const { roomId, ana } = await seedRoom(roomsApi, 'commit');
    await openCockpit(basePage);
    const sheet = await openSheet(page, roomId);

    const roomLine = sheet.locator('[data-slot="room-loudness-line"]');
    const pill = sheet.getByRole('button', { name: `How loud ${ana.name} is here` });
    await expect(pill).toHaveText('Silent');

    await pill.click();
    await sheet
      .getByRole('radiogroup', { name: `How loud is ${ana.name} here?` })
      .getByRole('radio', { name: 'Everything' })
      .click();

    // The pill is the member's answer; the line is the room's. One press moves
    // both, which is the claim — a member meter that moved alone would be a
    // setting with no stated consequence.
    await expect(pill).toHaveText('Everything');
    await expect(roomLine).toContainText('One agent answers every message here');

    // Counted in bars, not in words: the meter is the part a person reads at a
    // glance, and a lit-bar count that disagreed with the sentence would be the
    // two halves of one line contradicting each other. A lit bar is opaque
    // brand; an unlit one is the muted foreground at 30%, so the alpha channel
    // tells them apart without this test knowing either colour.
    const litBars = async (meter: Locator) =>
      meter.evaluate(
        (el) =>
          [...el.children].filter((bar) => {
            const rgba = getComputedStyle(bar).backgroundColor;
            const alpha = /rgba?\([^)]*,\s*([\d.]+)\s*\)/.exec(rgba);
            return alpha === null || parseFloat(alpha[1]!) > 0.5;
          }).length
      );
    expect(await litBars(roomLine.locator('[data-slot="loudness-meter"]'))).toBe(4);
    expect(await litBars(pill.locator('[data-slot="loudness-meter"]'))).toBe(4);
  });

  test('the roster you open the sheet on does not perform, and an agent you add does', async ({
    page,
    basePage,
    roomsApi,
  }) => {
    // Seeded with one agent, so there is a second to add through the UI.
    const ana = await roomsApi.registerAgent(`E2E Ana ${roomsApi.runId}`, '🦊', '#e07b39');
    const kai = await roomsApi.registerAgent(`E2E Kai ${roomsApi.runId}`, '🐙', '#7c3aed');
    const slug = `e2e-arrive-${roomsApi.runId}`;
    const room = await roomsApi.createChannel(slug, slug, [ana]);
    await openCockpit(basePage);
    const sheet = await openSheet(page, room.id);

    /**
     * How brand-washed a row is right now — the arrival glow, 0 once settled.
     *
     * The wash is the row's own preceding sibling inside the padded wrapper the
     * list gives each member, and it is the only `pointer-events-none` brand
     * fill in there — the radio dot inside an open scale is the other brand
     * span, and it is neither absolute nor inert.
     */
    const washOf = (name: string) =>
      memberRow(sheet, name)
        .locator('xpath=preceding-sibling::span[contains(@class, "pointer-events-none")]')
        .first()
        .evaluate((el) => parseFloat(getComputedStyle(el).opacity));

    // **The roster that was already there did not just arrive.** This is what
    // `AnimatePresence initial={false}` buys, and it has to propagate through
    // React context to reach the wash INSIDE each row as well as the row
    // itself — confirmed by reading framer-motion's source and never once
    // executed until now. Remove `initial={false}` and every row on open
    // glows, which is the sheet claiming four agents just walked in.
    await expect(memberRow(sheet, ana.name)).toBeVisible();
    expect(await washOf(ana.name)).toBe(0);

    // Now add one for real, through the row at the foot of the list.
    await sheet.getByRole('button', { name: 'Add agents' }).click();
    const search = sheet.getByRole('combobox', { name: 'Search agents' });
    await search.fill(kai.name);
    await page.getByRole('option', { name: kai.name, exact: true }).click();
    await sheet.getByRole('button', { name: 'Add agent' }).click();

    const arrival = memberRow(sheet, kai.name);
    await expect(arrival).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    // It glows on arrival — caught while the 0.9s fade is still running — and
    // the one that was already there still does not.
    await expect.poll(() => washOf(kai.name), { timeout: 2000 }).toBeGreaterThan(0);
    expect(await washOf(ana.name)).toBe(0);
    // And it settles rather than staying lit.
    await expect.poll(() => washOf(kai.name), { timeout: 4000 }).toBe(0);
  });

  test('a removed row collapses to nothing while the Undo is still on offer', async ({
    page,
    basePage,
    roomsApi,
  }) => {
    const { roomId, ana, kai } = await seedRoom(roomsApi, 'remove');
    await openCockpit(basePage);
    const sheet = await openSheet(page, roomId);
    await expect(memberRow(sheet, kai.name)).toBeVisible();

    const rowsBefore = await sheet.locator('[data-slot="room-member-row"]').count();

    await sheet.getByRole('button', { name: `${kai.name} actions` }).click();
    await page.getByRole('menuitem', { name: /^Remove from/ }).click();
    await sheet.getByRole('button', { name: 'Remove', exact: true }).click();

    // The offer, and the thing it refers to. A row that simply vanished would
    // leave "Undo" pointing at something nobody watched happen — which is the
    // defect the collapse exists to fix, and the reason both halves are one
    // assertion rather than two tests.
    const toast = page.getByText(`${kai.name} removed from`);
    await expect(toast).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();

    // Collapsed to zero, not merely hidden: the list closes the gap it left.
    await expect
      .poll(() => sheet.locator('[data-slot="room-member-row"]').count(), {
        timeout: SERVER_ROUND_TRIP_MS,
      })
      .toBe(rowsBefore - 1);
    await expect(memberRow(sheet, ana.name)).toBeVisible();
  });

  test('nothing shaves a focus ring against the row and list clips', async ({
    page,
    basePage,
    roomsApi,
  }) => {
    const { roomId, ana } = await seedRoom(roomsApi, 'ring');
    await openCockpit(basePage);
    const sheet = await openSheet(page, roomId);

    // Two `overflow-hidden` clips are new on this surface: the list item whose
    // height animates as a row arrives or leaves, and the disclosure whose
    // height animates as a scale opens. Both hold slack for exactly this, and
    // slack is the kind of thing that is correct in a comment and wrong in the
    // stylesheet.
    const pill = sheet.getByRole('button', { name: `How loud ${ana.name} is here` });
    // Tabbed to, not `focus()`ed. A ring is `focus-visible`, and Chromium only
    // paints one once the focus arrived by keyboard — a programmatic focus
    // leaves `box-shadow: none`, and a test measuring the clip around a ring
    // nobody drew passes whatever the stylesheet says.
    //
    // `locator.press` is not the way to do it either: it focuses the element
    // first and then sends the key, so `Tab` walks straight back off it.
    await tabTo(page, pill);
    await expect(pill).toBeFocused();

    const pillBleed = await ringBleed(pill);
    expect(pillBleed, 'the pill is drawing no focus ring, so this proves nothing').not.toBeNull();
    expect(pillBleed!).toBeGreaterThan(0);
    expect(await clipOverflow(pill, pillBleed!)).toMatchObject({ clipped: false });

    await pill.press('Enter');
    const scale = sheet.getByRole('radiogroup', { name: `How loud is ${ana.name} here?` });
    await expect(scale).toBeVisible();
    // The disclosure opens its own height, so the clip this test measures
    // against is still growing for 150ms after the group is "visible" — and it
    // is the ROW that is still moving, not the group. See `expandScale`.
    await settled(memberRow(sheet, ana.name));

    // The last rung is the one nearest the clip's bottom edge, so it is the one
    // that would find a short slack. Its ring is declared `ring-inset`, which
    // `ringBleed` reports as 0 — that is the answer, not a missing measurement:
    // an inset ring is painted inside the border box and no clip can reach it.
    //
    // The key goes to the group through a rung, not to the group itself: the
    // radiogroup is a plain `div` with no tabindex, so `scale.press('End')`
    // leaves focus wherever it was — on the pill, outside the group — and the
    // handler never sees it.
    await tabTo(page, scale.getByRole('radio').first());
    await page.keyboard.press('End');
    const last = scale.getByRole('radio').last();
    await expect(last).toBeFocused();
    const lastBleed = await ringBleed(last);
    expect(lastBleed, 'the rung is drawing no focus ring at all').not.toBeNull();
    expect(await clipOverflow(last, lastBleed!)).toMatchObject({ clipped: false });

    // And the control as a whole sits inside the disclosure that clips it —
    // the assertion that catches a slack that is one line short.
    expect(await clipOverflow(scale, 0)).toMatchObject({ clipped: false });
  });

  test("a working agent's pulse is not shaved by the row's clip", async ({
    page,
    basePage,
    roomsApi,
    request,
  }) => {
    const { roomId, slug, ana } = await seedRoom(roomsApi, 'ping');
    await roomsApi.postEntries(roomId, ['can someone look at this']);

    const roster = await roomsApi.getRoom(roomId);
    const anaAuthorId = roster.members.find(
      (member) => member.author.kind === 'agent' && member.author.displayName === ana.name
    )!.author.id;
    const entries = await request.get(`/api/rooms/${roomId}/entries`);
    const { entries: stored } = (await entries.json()) as { entries: { id: string }[] };

    await openCockpit(basePage);
    // The signal rides the room's REAL stream — the sheet reads presence only
    // for the room that is on screen, so the tap has to be in place first.
    await tapRoomStream(page);
    const sheet = await openSheet(page, roomId);
    expect(slug).toContain('e2e-ping');

    await publishPresence(page, {
      authorId: anaAuthorId,
      state: 'working',
      entryId: stored[0]!.id,
      since: new Date().toISOString(),
    });

    const row = memberRow(sheet, ana.name);
    await expect(row.getByText('working now')).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });

    // `animate-ping` scales the dot to 2×, so an 8px dot paints 4px past itself
    // on every side. The list item that animates a row's height clips, and the
    // row carries top slack for precisely this — a comment saying so is not
    // evidence, and a shaved pulse reads as a rendering bug rather than as a
    // signal.
    const ping = row.locator('span.animate-ping');
    await expect(ping).toBeAttached();
    const shave = await clipOverflow(ping, 4);
    expect(shave, `ping shaved by ${shave.clipper}`).toMatchObject({ clipped: false });
  });

  test('the segmented control fits its indent without ellipsising a rung', async ({
    page,
    basePage,
    roomsApi,
  }) => {
    const { roomId, ana } = await seedRoom(roomsApi, 'segments');
    await openCockpit(basePage);
    const sheet = await openSheet(page, roomId);

    const pill = sheet.getByRole('button', { name: `How loud ${ana.name} is here` });
    // The pill grew a caret when it stopped being a word and became a control
    // that opens something, and the caret is width the label used to have.
    const pillOverflow = await pill.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(pillOverflow).toBeLessThanOrEqual(1);

    await pill.click();
    const scale = sheet.getByRole('radiogroup', { name: `How loud is ${ana.name} here?` });
    await expect(scale).toBeVisible();

    // Four segments inside a panel column, indented under the disc. The labels
    // are the ONLY thing telling the rungs apart, so an ellipsis here removes
    // the meaning rather than the polish — which is the measured reason the
    // phone gets a list instead.
    const rungs = await scale.getByRole('radio').all();
    expect(rungs).toHaveLength(4);
    for (const rung of rungs) {
      const label = await rung.textContent();
      const overflow = await rung.evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(overflow, `"${label}" is truncated in its segment`).toBeLessThanOrEqual(1);
    }
  });
});

test.describe('Room panel with motion turned down @smoke', () => {
  test('the preview snaps to its answer instead of sliding, and loses nothing', async ({
    page,
    basePage,
    roomsApi,
  }) => {
    // Set on the page rather than through `test.use`, which this project's
    // extended `test` does not accept the option on. Same media query either
    // way — `index.css` keys its global cut on `prefers-reduced-motion`.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const { roomId, ana } = await seedRoom(roomsApi, 'reduced');
    await openCockpit(basePage);
    const sheet = await openSheet(page, roomId);

    const roomLine = sheet.locator('[data-slot="room-loudness-line"]');
    const pill = sheet.getByRole('button', { name: `How loud ${ana.name} is here` });
    await pill.click();
    const scale = sheet.getByRole('radiogroup', { name: `How loud is ${ana.name} here?` });

    // The global rule in `index.css` cuts every transition to 0.01ms under this
    // preference. The meter snaps to the same place — a motion preference must
    // not remove information, and this is the assertion that says the meter
    // still gets there.
    const bar = roomLine.locator('[data-slot="loudness-meter"] span').first();
    expect(await transitionMs(bar)).toBeLessThan(1);

    await scale.getByRole('radio', { name: 'Everything' }).hover();
    await expect(roomLine).toHaveAttribute('data-preview', 'true');
    await expect(roomLine).toContainText('answers every message here');
  });
});
