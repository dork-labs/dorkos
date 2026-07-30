import { test, expect } from '../../fixtures';
import { SERVER_ROUND_TRIP_MS } from '../../fixtures/rooms-api';

// Same shape as its siblings `room-conversation.spec.ts` and
// `room-presence.spec.ts`: one cockpit at a time, and a ceiling sized for a
// machine already running several worktrees of agents.
test.describe.configure({ mode: 'default', timeout: 90_000 });

/**
 * A message long enough that its own top leaves the window.
 *
 * Paragraphs rather than one long run, because a wrapped run is at the mercy of
 * the window's width and this has to be taller than the viewport on any of them.
 */
const TALL_MESSAGE = Array.from({ length: 80 }, (_, i) => `paragraph ${i}`).join('\n\n');

/**
 * The action surface every message carries: the toolbar, the right-click menu,
 * the touch drawer, and the reply that comes out of all three.
 *
 * **jsdom cannot see the half that matters most here.** Whether the toolbar is
 * showing is an opacity a layout engine resolves; whether it stays reachable on
 * a message taller than the window is a `sticky` box only a scroll container
 * has; and whether a reply lands under the message it answers is a round trip
 * through the room's real SSE stream, which is where every other reader — and
 * every agent the reply triggers — sees it too. The state machine underneath
 * (which destination Enter uses, what the action set holds, the tab order) is
 * pinned in jsdom, and that is deliberately the part NOT re-asserted here.
 *
 * Every seeded agent is `silent` (the fixture guarantees it), so nothing in this
 * file can start a real turn. That a thread reply IS an addressing act — it
 * triggers the agent it names, spends the room budget, and is answered inside
 * the same thread — is pinned deterministically server-side in
 * `room-service.test.ts` ("a thread reply is an addressing act"), against a
 * scripted runner rather than a real model.
 */
test.describe('Rooms — every message gets a menu', () => {
  test('the toolbar appears on hover and offers what can be done to the message', async ({
    page,
    roomsApi,
    roomsPage,
  }) => {
    const slug = `e2e-actions-${roomsApi.runId}`;
    const room = await roomsApi.createChannel(slug, slug);
    await roomsApi.postEntries(room.id, ['the deploy is stuck']);

    await page.goto(`/channels?id=${room.id}`);
    await expect(roomsPage.entries).toHaveCount(1, { timeout: SERVER_ROUND_TRIP_MS });

    const entry = roomsPage.entries.first();
    const toolbar = roomsPage.actionsIn(entry);

    // Present but not showing. Asserted as opacity because Playwright's own
    // visibility check does not read it — `toBeVisible` passes on both states.
    await expect(toolbar).toHaveCSS('opacity', '0');

    await entry.hover();
    await expect(toolbar).toHaveCSS('opacity', '1');

    // The action set, read off the accessibility tree rather than off icons.
    // This message is the reader's own, so it does not offer to mention them —
    // the picker leaves the reader out for the same reason.
    await expect(toolbar.getByRole('button')).toHaveCount(2);
    await expect(toolbar.getByRole('button', { name: 'Reply in thread' })).toBeVisible();
    await expect(toolbar.getByRole('button', { name: 'Copy text' })).toBeVisible();
  });

  test('the toolbar encloses the buttons it is drawn around', async ({
    page,
    roomsApi,
    roomsPage,
  }) => {
    // The defect this pins shipped once. The toolbar was in the right place,
    // fully clickable, and named correctly — every assertion above passed —
    // while it rendered as a 6px capsule with 24px buttons hanging out of it
    // top and bottom, reading as a strikethrough line ruled through the icons.
    // Its sticky rail is a zero-height flex row, and a flex row's default
    // `align-items: stretch` had squashed the pill to the line's cross size.
    //
    // Position and clickability cannot catch that: an overflowing child is
    // still at the right coordinates and still takes a click. Only the
    // relationship between the two boxes can, so that is what is asserted —
    // the container holds its contents, with its own padding still visible on
    // every side.
    const slug = `e2e-actions-encloses-${roomsApi.runId}`;
    const room = await roomsApi.createChannel(slug, slug);
    await roomsApi.postEntries(room.id, ['the deploy is stuck']);

    await page.goto(`/channels?id=${room.id}`);
    await expect(roomsPage.entries).toHaveCount(1, { timeout: SERVER_ROUND_TRIP_MS });

    const entry = roomsPage.entries.first();
    const toolbar = roomsPage.actionsIn(entry);

    await entry.hover();
    await expect(toolbar).toHaveCSS('opacity', '1');

    const insets = await toolbar.evaluate((bar) => {
      const pill = bar.getBoundingClientRect();
      return [...bar.querySelectorAll('button')].map((button) => {
        const box = button.getBoundingClientRect();
        return {
          button: button.getAttribute('aria-label') ?? '(unnamed)',
          top: Math.round(box.top - pill.top),
          bottom: Math.round(pill.bottom - box.bottom),
          left: Math.round(box.left - pill.left),
          right: Math.round(pill.right - box.right),
        };
      });
    });

    // The pill is `p-0.5` inside a 1px border, so every real inset is 3px. Two
    // is the floor: enough to fail on any overflow or on padding collapsing
    // away, loose enough to survive a sub-pixel layout or a rounding change.
    const MIN_INSET_PX = 2;
    expect(insets.length).toBeGreaterThan(0);
    // Filtered rather than asserted one at a time, so a failure names every
    // button that escaped and by how far, instead of only the first.
    expect(
      insets.filter(
        (inset) => Math.min(inset.top, inset.bottom, inset.left, inset.right) < MIN_INSET_PX
      )
    ).toEqual([]);
  });

  test('the toolbar rides the viewport edge on a message taller than the window', async ({
    page,
    roomsApi,
    roomsPage,
  }) => {
    // Slack anchors its toolbar to the top of the message, which puts it off
    // screen for exactly this message. Ours is `sticky` inside the row.
    const slug = `e2e-actions-tall-${roomsApi.runId}`;
    const room = await roomsApi.createChannel(slug, slug);
    await roomsApi.postEntries(room.id, [TALL_MESSAGE]);

    await page.goto(`/channels?id=${room.id}`);
    await expect(roomsPage.entries).toHaveCount(1, { timeout: SERVER_ROUND_TRIP_MS });

    const entry = roomsPage.entries.first();
    const toolbar = roomsPage.actionsIn(entry);

    // The room opens at its newest, which for a single tall message means its
    // top is already above the window. Assert that rather than assume it: with
    // the message's top on screen the toolbar sits there and this test would
    // pass without proving anything.
    const scrollerBox = (await roomsPage.scroller.boundingBox())!;
    const entryBox = (await entry.boundingBox())!;
    expect(entryBox.y).toBeLessThan(scrollerBox.y);

    await entry.hover();
    await expect(toolbar).toHaveCSS('opacity', '1');

    const toolbarBox = (await toolbar.boundingBox())!;
    // Clamped near the top of the scrolling region — not left behind at the
    // message's own top, which is `entryBox.y` and well above.
    expect(toolbarBox.y).toBeGreaterThanOrEqual(scrollerBox.y - 1);
    expect(toolbarBox.y).toBeLessThan(scrollerBox.y + 24);

    // And still operable where it landed.
    await toolbar.getByRole('button', { name: 'Reply in thread' }).click();
    await expect(roomsPage.replyBanner).toBeVisible();
  });

  test('right-click offers the same actions as the toolbar', async ({
    page,
    roomsApi,
    roomsPage,
  }) => {
    // One dialect: the menu is the same action set the toolbar draws, in the
    // same order, through the component the sidebar rows already use.
    const slug = `e2e-actions-menu-${roomsApi.runId}`;
    const room = await roomsApi.createChannel(slug, slug);
    await roomsApi.postEntries(room.id, ['the deploy is stuck']);

    await page.goto(`/channels?id=${room.id}`);
    await expect(roomsPage.entries).toHaveCount(1, { timeout: SERVER_ROUND_TRIP_MS });

    await roomsPage.entries.first().click({ button: 'right' });

    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem')).toHaveText(['Reply in thread', 'Copy text']);

    await menu.getByRole('menuitem', { name: 'Reply in thread' }).click();
    await expect(roomsPage.replyBanner).toBeVisible();
  });

  test('the keyboard alone reaches the actions and lands in the composer', async ({
    page,
    roomsApi,
    roomsPage,
  }) => {
    const slug = `e2e-actions-kbd-${roomsApi.runId}`;
    const room = await roomsApi.createChannel(slug, slug);
    await roomsApi.postEntries(room.id, ['the deploy is stuck']);

    await page.goto(`/channels?id=${room.id}`);
    await expect(roomsPage.entries).toHaveCount(1, { timeout: SERVER_ROUND_TRIP_MS });

    const entry = roomsPage.entries.first();
    const toolbar = roomsPage.actionsIn(entry);

    // The message is the tab stop; focusing it is what shows its actions, so the
    // keyboard can see what it is about to step into. No pointer at any point.
    await entry.focus();
    await expect(toolbar).toHaveCSS('opacity', '1');

    // Into the toolbar with an arrow, along it with another, and back out with
    // Escape — roving tabindex, so Tab is never spent inside a message.
    await page.keyboard.press('ArrowRight');
    await expect(toolbar.getByRole('button', { name: 'Reply in thread' })).toBeFocused();

    await page.keyboard.press('ArrowRight');
    await expect(toolbar.getByRole('button', { name: 'Copy text' })).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(entry).toBeFocused();

    // Back in, and take the first action.
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');

    await expect(roomsPage.replyBanner).toBeVisible();
    // The caret went with it: the point of pressing Reply is to type.
    await expect(roomsPage.threadComposer).toBeFocused();
  });

  test('a room costs one Tab per message, not one per action', async ({
    page,
    roomsApi,
    roomsPage,
  }) => {
    // The whole reason the actions are `tabIndex={-1}`. With them in the tab
    // order, these two presses would land on the first message's Copy and
    // Mention buttons and a three-message room would cost nine presses to cross.
    const slug = `e2e-actions-trail-${roomsApi.runId}`;
    const room = await roomsApi.createChannel(slug, slug);
    await roomsApi.postEntries(room.id, ['first', 'second', 'third']);

    await page.goto(`/channels?id=${room.id}`);
    await expect(roomsPage.entries).toHaveCount(3, { timeout: SERVER_ROUND_TRIP_MS });

    await roomsPage.entries.nth(0).focus();
    await page.keyboard.press('Tab');
    await expect(roomsPage.entries.nth(1)).toBeFocused();

    await page.keyboard.press('Tab');
    await expect(roomsPage.entries.nth(2)).toBeFocused();
  });

  test('a message is announced before the things you can do to it', async ({
    page,
    roomsApi,
    roomsPage,
  }) => {
    // The toolbar is drawn at the message's top-right but written LAST, so a
    // screen reader is told who spoke and what they said before it is offered a
    // menu — the order session chat already has, and the order a room lost when
    // the sticky rail went in as the first child.
    const slug = `e2e-actions-order-${roomsApi.runId}`;
    const room = await roomsApi.createChannel(slug, slug);
    await roomsApi.postEntries(room.id, ['the deploy is stuck']);

    await page.goto(`/channels?id=${room.id}`);
    await expect(roomsPage.entries).toHaveCount(1, { timeout: SERVER_ROUND_TRIP_MS });

    const snapshot = await roomsPage.entries.first().ariaSnapshot();

    expect(snapshot).toContain('the deploy is stuck');
    expect(snapshot).toContain('toolbar');
    expect(snapshot.indexOf('the deploy is stuck')).toBeLessThan(snapshot.indexOf('toolbar'));

    // And the author is spoken once. Naming the article "Message from You" over
    // a row that visibly says "You" is the DOR-583 double-announcement.
    expect(snapshot.split('You').length - 1).toBe(1);
  });

  test('a reply gathers under the message it answers, and a reply to a reply joins it', async ({
    page,
    roomsApi,
    roomsPage,
  }) => {
    const slug = `e2e-actions-reply-${roomsApi.runId}`;
    const room = await roomsApi.createChannel(slug, slug);
    await roomsApi.postEntries(room.id, ['why is the build slow?']);

    await page.goto(`/channels?id=${room.id}`);
    await expect(roomsPage.entries).toHaveCount(1, { timeout: SERVER_ROUND_TRIP_MS });

    const root = roomsPage.entries.first();
    await root.hover();
    await roomsPage.actionsIn(root).getByRole('button', { name: 'Reply in thread' }).click();

    await expect(roomsPage.replyBanner).toBeVisible();
    await roomsPage.threadComposer.fill('the cache is cold');
    await roomsPage.threadComposer.press('Enter');

    // Nothing is drawn until the server's own copy arrives on the room's stream
    // — the same path a second reader, and every agent the reply triggers, sees
    // it on. So this assertion is the round trip, not an optimistic insert.
    const thread = roomsPage.threadUnder(root);
    await expect(thread).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    await expect(thread).toContainText('the cache is cold');
    await expect(thread).toContainText('1 reply');
    // Under the root, not loose beside it: two rows on screen, one of them
    // inside the group.
    await expect(roomsPage.entries).toHaveCount(2);
    await expect(thread.getByTestId('room-entry')).toHaveCount(1);

    // Now answer the REPLY. The server refuses a reply to a reply, so the
    // client aims at the root instead — and the reader is never shown an error
    // about it, because there is nothing here they did wrong.
    const firstReply = thread.getByTestId('room-entry').first();
    await firstReply.hover();
    await roomsPage.actionsIn(firstReply).getByRole('button', { name: 'Reply in thread' }).click();
    await roomsPage.threadComposer.fill('warming it now');
    await roomsPage.threadComposer.press('Enter');

    await expect(thread).toContainText('warming it now', { timeout: SERVER_ROUND_TRIP_MS });
    await expect(thread).toContainText('2 replies');
    // One thread, not a second one hanging off the first reply.
    await expect(roomsPage.threads).toHaveCount(1);
    // And no refusal reached the reader.
    await expect(page.getByText("Couldn't send your reply")).toHaveCount(0);

    // The aim survives sending, so the exchange can continue — and it says so
    // the whole time rather than quietly going back to addressing the room.
    await expect(roomsPage.replyBanner).toBeVisible();
    await roomsPage.replyBanner.getByRole('button', { name: /^Stop replying/ }).click();
    await expect(roomsPage.replyBanner).toHaveCount(0);
    await expect(roomsPage.composer(`#${slug}`)).toBeVisible();
  });
});

test.describe('Rooms — the menu on a touch screen', () => {
  // Under 768px `useIsMobile` flips the surface to its drawer, and touch
  // emulation is what makes the press a real coarse-pointer gesture rather than
  // a mouse pretending. Both are needed: the breakpoint chooses the component,
  // the pointer decides how it is reached.
  test.use({ viewport: { width: 390, height: 780 }, hasTouch: true });

  test('a long press opens the drawer, and a short one or a drag does not', async ({
    page,
    roomsApi,
    roomsPage,
  }) => {
    const slug = `e2e-actions-touch-${roomsApi.runId}`;
    const room = await roomsApi.createChannel(slug, slug);
    await roomsApi.postEntries(room.id, ['the deploy is stuck']);

    await page.goto(`/channels?id=${room.id}`);
    await expect(roomsPage.entries).toHaveCount(1, { timeout: SERVER_ROUND_TRIP_MS });

    const entry = roomsPage.entries.first();

    // A tap is a tap. Opening a menu on one would make a message impossible to
    // touch without being asked what to do to it.
    await roomsPage.longPress(entry, { holdMs: 150 });
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // And the tap must not summon the HOVER toolbar either. A message is
    // focusable, so tapping focuses it — an ungated `focus-within` would paint
    // the toolbar over the message's first line and give touch a fourth,
    // undesigned way in. Touch gets the drawer and nothing else.
    await expect(entry).toBeFocused();
    await expect(roomsPage.actionsIn(entry)).toHaveCSS('opacity', '0');

    // A press that travels is a scroll or a text selection the reader has
    // already begun, and taking it away mid-motion is the failure this guards.
    await roomsPage.longPress(entry, { holdMs: 700, driftPx: 60 });
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // Held still, it opens — with the same actions, under the same names.
    await roomsPage.longPress(entry);
    const drawer = page.getByRole('dialog');
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Reply in thread' })).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Copy text' })).toBeVisible();

    await drawer.getByRole('button', { name: 'Reply in thread' }).click();
    await expect(roomsPage.replyBanner).toBeVisible();
  });
});
