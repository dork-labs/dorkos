import type { Locator } from '@playwright/test';
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
 * How many ordinary messages sit above the tall one.
 *
 * Enough that the virtualizer's drawn window starts below the top of the
 * scroller — see the comment at the call site for why a zero offset is the one
 * case this test must not measure.
 */
const FILLER_BEFORE_TALL = 30;

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
    // Seven: three quick reactions and the picker, then the commands — and this
    // message is the reader's own, so it does not offer to mention them, the
    // same way the mention picker leaves the reader out. It DOES offer their
    // profile: a person's roster row is their author row, so the id is always
    // resolvable for a human, including the reader (DOR-1251).
    await expect(toolbar.getByRole('button')).toHaveCount(7);
    // Three quick reactions, counted rather than named: which three they are is
    // the reader's own history across every room on this shared server, so a
    // sibling spec's reaction changes them (see `GOTCHAS.md`).
    await expect(roomsPage.quickReactionsIn(entry)).toHaveCount(3);
    await expect(toolbar.getByRole('button', { name: 'Pick a reaction' })).toBeVisible();
    await expect(toolbar.getByRole('button', { name: 'Reply in thread' })).toBeVisible();
    await expect(toolbar.getByRole('button', { name: 'Copy text' })).toBeVisible();
    await expect(toolbar.getByRole('button', { name: 'View profile' })).toBeVisible();
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
    //
    // Unchanged by the reaction slots, and that is the point of re-reading it
    // here: the quick row made the capsule WIDER, not taller, so every button
    // still sits inside the same padding and `--msg-actions-height` still
    // describes the box. A reaction button that rendered taller than an icon one
    // would break the straddle promise next door, and this is where it shows.
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

  test('the toolbar straddles a message, and covers no word of one at rest', async ({
    page,
    roomsApi,
    roomsPage,
  }) => {
    // The position the design record chose, made mechanical. The toolbar used
    // to be drawn INSIDE the message's own column, over its first line — the
    // deeper of the two defects the capsule had, and one no assertion could
    // see: a toolbar covering the author's name is at exactly the coordinates
    // a "top-right" assertion would ask for.
    //
    // So what is asserted is the relationship between the capsule and the words
    // underneath it. Its bottom edge must land ON the top of the message's own
    // content column — the line the author's name sits on — and never below it,
    // and it must cross the message block's top edge rather than float free
    // above it. Both halves matter: the first is the promise (it covers
    // nothing), the second is the design (it straddles, it does not hover).
    //
    // AT REST, which is the whole of what this pins. Scrolled past its own top,
    // a message hands the capsule to the sticky clamp, and a clamped capsule
    // does sit over the first line or two — the regime the next test pins the
    // position of. The promise is about where the capsule lives, not about
    // every scroll offset it can be looked at from.
    //
    // Both grouping regimes, because they are the two different geometries the
    // one rule has to serve: a group start has 16px of top padding to hang the
    // capsule in, and a continuation has 6px — the tight case, where the
    // documented trade (reach up over the line above rather than down over this
    // message's own) actually lives.
    const slug = `e2e-actions-straddle-${roomsApi.runId}`;
    const room = await roomsApi.createChannel(slug, slug);
    await roomsApi.postEntries(room.id, ['the deploy is stuck', 'the last step never returned']);

    await page.goto(`/channels?id=${room.id}`);
    await expect(roomsPage.entries).toHaveCount(2, { timeout: SERVER_ROUND_TRIP_MS });

    /** Measure one row's capsule against the words it is drawn beside. */
    const measure = (entry: Locator) =>
      entry.evaluate((row) => {
        const bar = row.querySelector('[data-testid="entry-actions"]')!;
        // The message's own content column: its top is the first thing the row
        // draws — the author's name on a group start, the words themselves on a
        // continuation. Reached through the content slot rather than by class,
        // because that is the one part of the row with a stable hook.
        const body = row.querySelector('[data-slot="message-content"]')!.parentElement!;
        const barBox = bar.getBoundingClientRect();
        return {
          barTop: barBox.top,
          barBottom: barBox.bottom,
          rowTop: row.getBoundingClientRect().top,
          bodyTop: body.getBoundingClientRect().top,
        };
      });

    const rows: { row: string; overText: number; aboveEdge: number; belowEdge: number }[] = [];

    for (const [index, row] of [
      [0, 'group start'],
      [1, 'continuation'],
    ] as const) {
      const entry = roomsPage.entries.nth(index);
      const toolbar = roomsPage.actionsIn(entry);

      await entry.hover();
      await expect(toolbar).toHaveCSS('opacity', '1');
      // The capsule ARRIVES with a rise that overshoots and settles, so its box
      // means nothing until that is over. `translate` returns to `none` when the
      // animation ends — which is the moment the geometry below is the geometry
      // a reader is looking at, and a gate that does not presuppose the answer.
      await expect(toolbar).toHaveCSS('translate', 'none');

      const box = await measure(entry);
      rows.push({
        row,
        // How far the capsule's bottom edge reaches PAST the first thing the
        // message draws. Zero or less is the promise; anything positive is a
        // covered word.
        overText: Math.round(box.barBottom - box.bodyTop),
        aboveEdge: Math.round(box.rowTop - box.barTop),
        belowEdge: Math.round(box.barBottom - box.rowTop),
      });
    }

    // Reported together rather than asserted one row at a time, the same way
    // the containment test names every button that escaped: the two grouping
    // regimes fail for different reasons, and seeing only the first would hide
    // whichever one is not being worked on.
    //
    // One pixel of slack for sub-pixel layout, which is not enough for a line
    // of text to hide in.
    expect(rows.filter((r) => r.overText > 1)).toEqual([]);
    // Straddling: some of it above the block's top edge, some below. A capsule
    // floating entirely clear of the message would pass the test above while
    // being a different design.
    expect(rows.filter((r) => r.aboveEdge <= 0 || r.belowEdge <= 0)).toEqual([]);

    // And the second row really is the tight case: less room above its words
    // than the group start has. Without this, a change to the grouping rules
    // could quietly turn both rows into group starts and the 6px geometry — the
    // one the documented trade is about — would stop being tested at all, with
    // everything above still green.
    expect(rows[1]!.belowEdge).toBeLessThan(rows[0]!.belowEdge);
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
    // Filler BEFORE the tall one, and it is the point of the test rather than
    // scenery. The list is virtualized: the drawn window is one box offset from
    // the top of the scroller, and with a single entry that offset is 0 — the
    // one value at which a broken offset (a `transform`, which kills `sticky`
    // for everything inside it) is indistinguishable from a working one. Thirty
    // entries put the tall message far enough down that the window it is drawn
    // in has a real offset, so the assertion below can tell them apart.
    await roomsApi.postEntries(room.id, [
      ...Array.from({ length: FILLER_BEFORE_TALL }, (_, i) => `filler ${i}`),
      TALL_MESSAGE,
    ]);

    await page.goto(`/channels?id=${room.id}`);
    await expect(roomsPage.entries.last()).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });

    const entry = roomsPage.entries.last();
    // The drawn window really is offset from the top of the list — otherwise
    // this test is back to measuring the only case that cannot fail. Read as a
    // RENDERED distance rather than off the `top` property, so the probe says
    // nothing about how the offset is written and the assertion below is what
    // has to catch a broken one.
    const windowOffset = await page.evaluate(() => {
      const row = document.querySelector('[data-index]');
      const box = row?.parentElement;
      const list = box?.parentElement;
      if (box == null || list == null) return 0;
      return box.getBoundingClientRect().top - list.getBoundingClientRect().top;
    });
    expect(windowOffset).toBeGreaterThan(0);
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
    await expect(roomsPage.threadPanel).toBeVisible();
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
    await expect(menu.getByRole('menuitem')).toHaveText([
      'Reply in thread',
      'Copy text',
      'View profile',
    ]);

    await menu.getByRole('menuitem', { name: 'Reply in thread' }).click();
    await expect(roomsPage.threadPanel).toBeVisible();
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

    // Into the toolbar with an arrow, along it with more, and back out with
    // Escape — roving tabindex, so Tab is never spent inside a message however
    // many slots the capsule grew.
    await page.keyboard.press('ArrowRight');
    await expect(roomsPage.quickReactionsIn(entry).first()).toBeFocused();

    // Past the three quick reactions and the picker, onto the first command.
    for (let i = 0; i < 4; i += 1) await page.keyboard.press('ArrowRight');
    await expect(toolbar.getByRole('button', { name: 'Reply in thread' })).toBeFocused();

    await page.keyboard.press('ArrowRight');
    await expect(toolbar.getByRole('button', { name: 'Copy text' })).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(entry).toBeFocused();

    // Back in, along to Reply, and take it.
    await page.keyboard.press('ArrowRight');
    for (let i = 0; i < 4; i += 1) await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');

    await expect(roomsPage.threadPanel).toBeVisible();
    // The caret went with it: the point of pressing Reply is to type. The panel
    // opened from the capsule asks for the composer rather than taking focus
    // itself — the two ways in mean different things (`OpenThread.focusComposer`).
    await expect(roomsPage.threadComposer).toBeFocused();
  });

  test('a room costs one Tab per message, not one per action', async ({
    page,
    roomsApi,
    roomsPage,
  }) => {
    // The whole reason the actions are `tabIndex={-1}`. With them in the tab
    // order, these two presses would land inside the first message's capsule and
    // a three-message room would cost eighteen presses to cross — six slots
    // each, now that reactions are in there. The pill row is closed the same way
    // and for the same reason (`room-reactions.spec.ts` walks it with arrows).
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

    // The author is spoken as the article's NAME and as the line that name
    // points at — twice, and no more (DOR-757).
    //
    // This is the one thing the feed pattern costs, and it is worth saying why
    // it is accepted. A row shipped unnamed because "Message from You" over a
    // row that visibly says "You" is a second sentence invented for screen
    // readers — the DOR-583 shape. A feed cannot work that way: moving article
    // to article means being told WHICH article you landed on, so an unnamed
    // one is a wall of anonymous boxes. The APG's own feed example resolves it
    // the same way — the article is labelled BY the heading already inside it —
    // so what repeats is the visible line, never a string written for the
    // purpose. A third occurrence would mean somebody added one.
    expect(snapshot).toMatch(/article "You/);
    expect(snapshot.split('You').length - 1).toBe(2);
  });

  test('Page Down crosses the room a message at a time, whatever each one carries', async ({
    page,
    roomsApi,
    roomsPage,
  }) => {
    // The room timeline is a WAI-ARIA feed, and this is what that buys: Tab
    // still costs a stop per message and a second one per thread row, so a busy
    // room is dozens of presses deep before the composer. Page Down moves
    // between ARTICLES, so the buttons, pills and reply rows inside a message
    // cost nothing to pass.
    const slug = `e2e-feed-nav-${roomsApi.runId}`;
    const room = await roomsApi.createChannel(slug, slug);
    await roomsApi.postEntries(room.id, ['first', 'second', 'third']);

    await page.goto(`/channels?id=${room.id}`);
    await expect(roomsPage.entries).toHaveCount(3, { timeout: SERVER_ROUND_TRIP_MS });

    const feed = page.getByRole('feed');
    await expect(feed).toHaveAttribute('aria-busy', 'false');
    // The room feed loads a trailing page, so it cannot know the true size or
    // any message's true position — it says so (`aria-setsize: -1`) and claims
    // no position at all, rather than announcing "item 1" for the 471st
    // message. Exact positions live in the thread panel, where the set is
    // complete.
    await expect(roomsPage.entries.nth(1)).toHaveAttribute('aria-setsize', '-1');
    await expect(roomsPage.entries.nth(1)).not.toHaveAttribute('aria-posinset');

    await roomsPage.entries.first().focus();
    await page.keyboard.press('PageDown');
    await expect(roomsPage.entries.nth(1)).toBeFocused();

    // From inside a message's own toolbar it is still a feed command — the
    // roving group leaves Page Down alone so it can reach the feed.
    await page.keyboard.press('ArrowRight');
    await expect(roomsPage.quickReactionsIn(roomsPage.entries.nth(1)).first()).toBeFocused();
    await page.keyboard.press('PageDown');
    await expect(roomsPage.entries.nth(2)).toBeFocused();

    // The end of the history is the end of it — no wrap round to the top, which
    // would tell a reader they had arrived somewhere they had not.
    await page.keyboard.press('PageDown');
    await expect(roomsPage.entries.nth(2)).toBeFocused();

    await page.keyboard.press('PageUp');
    await expect(roomsPage.entries.nth(1)).toBeFocused();

    // And the way out: Ctrl+End leaves the feed for the first thing after it,
    // which on this page is the composer.
    await page.keyboard.press('Control+End');
    await expect(roomsPage.composer(`#${slug}`)).toBeFocused();
  });

  test('a reply lands in the panel beside the room, and a reply to a reply joins it', async ({
    page,
    roomsApi,
    roomsPage,
  }) => {
    // The rewrite of the retired inline-gathering test. What it pins is
    // unchanged in substance — a reply reaches the thread it answers, and
    // answering a reply joins that same thread rather than nesting — but the
    // PLACE moved: replies are no longer drawn in the room's own scroll, so the
    // room keeps exactly one quiet line per thread and the thread has a panel.
    const slug = `e2e-actions-reply-${roomsApi.runId}`;
    const room = await roomsApi.createChannel(slug, slug);
    await roomsApi.postEntries(room.id, ['why is the build slow?']);

    await page.goto(`/channels?id=${room.id}`);
    await expect(roomsPage.entries).toHaveCount(1, { timeout: SERVER_ROUND_TRIP_MS });

    const root = roomsPage.entries.first();
    // A thread nobody has replied to has no row at all — the room stays clean.
    await expect(roomsPage.replyRow(root)).toHaveCount(0);

    await roomsPage.replyInThreadFrom(root);
    await expect(roomsPage.threadPanel).toBeVisible();
    // The root is IN the panel, so the thread reads as a conversation rather
    // than as a list of answers to something you have to scroll back for.
    await expect(roomsPage.threadEntries).toHaveCount(1);
    await expect(roomsPage.threadEntries.first()).toContainText('why is the build slow?');

    await roomsPage.replyInThread('the cache is cold');

    // Nothing is drawn until the server's own copy arrives on the room's stream
    // — the same path a second reader, and every agent the reply triggers, sees
    // it on. So this assertion is the round trip, not an optimistic insert.
    await expect(roomsPage.threadEntries).toHaveCount(2, { timeout: SERVER_ROUND_TRIP_MS });
    await expect(roomsPage.threadEntries.nth(1)).toContainText('the cache is cold');
    // One connector per reply, and none for the root: the root is the thing the
    // replies hang off, not one of them.
    await expect(roomsPage.threadConnectors).toHaveCount(1);

    // The room did NOT grow a message. It grew a line saying there is a thread,
    // which is the whole of what the room pays for an aside of any length.
    await expect(roomsPage.entries).toHaveCount(1);
    await expect(roomsPage.replyCount(root)).toHaveText('1');
    await expect(roomsPage.replyRow(root)).toContainText('1 reply');
    // The row says which thread the panel is showing, in the tree a screen
    // reader reads rather than in a colour.
    await expect(roomsPage.replyRow(root)).toHaveAttribute('aria-expanded', 'true');

    // Now answer the REPLY, from inside the panel. The server refuses a reply
    // to a reply, so the client aims at the root instead — and the reader is
    // never shown an error about it, because there is nothing here they did
    // wrong.
    await roomsPage.replyInThreadFrom(roomsPage.threadEntries.nth(1));
    await roomsPage.replyInThread('warming it now');

    await expect(roomsPage.threadEntries).toHaveCount(3, { timeout: SERVER_ROUND_TRIP_MS });
    await expect(roomsPage.threadEntries.nth(2)).toContainText('warming it now');
    await expect(roomsPage.replyCount(root)).toHaveText('2');
    // One thread, not a second one hanging off the first reply — asserted on
    // the room, where a second thread would have to show as a second row.
    await expect(roomsPage.replyRows).toHaveCount(1);
    // And no refusal reached the reader.
    await expect(page.getByText("Couldn't send your reply")).toHaveCount(0);

    // The panel is a place, not an aim: it stays open and its composer keeps
    // writing here, so the exchange continues without being re-pointed. There
    // is no banner to dismiss any more — the room's own composer is untouched
    // beside it, still addressing the room.
    await expect(roomsPage.threadComposer).toBeVisible();
    await expect(roomsPage.composer(`#${slug}`)).toBeVisible();
  });

  test('a reply row opens the thread it counts, and Escape closes it again', async ({
    page,
    roomsApi,
    roomsPage,
  }) => {
    // The reader's other way in, and the one the design is really about: you
    // are scrolling a room, you see there were three answers, you open them.
    // Seeded server-side so the panel is opening onto a thread it did not
    // watch arrive — which is also the only way to reach the "already there,
    // drawn at rest" branch of `useThreadArrivals`.
    const slug = `e2e-actions-row-${roomsApi.runId}`;
    const room = await roomsApi.createChannel(slug, slug);
    await roomsApi.postEntries(room.id, [
      'why is the build slow?',
      'unrelated, but the disk is full',
    ]);
    const [rootId] = await roomsApi.entryIds(room.id);
    await roomsApi.postThreadReply(room.id, rootId!, 'the cache is cold');
    await roomsApi.postThreadReply(room.id, rootId!, 'warming it now');

    await page.goto(`/channels?id=${room.id}`);
    await expect(roomsPage.entries).toHaveCount(2, { timeout: SERVER_ROUND_TRIP_MS });

    const root = roomsPage.entries.first();
    const row = roomsPage.replyRow(root);
    // Two replies, one row, and it hangs off the ROOT rather than off the
    // unrelated message below it — which is what the positional locator is for.
    await expect(row).toContainText('2 replies');
    await expect(roomsPage.replyRows).toHaveCount(1);
    await expect(row).toHaveAttribute('aria-expanded', 'false');
    await expect(roomsPage.threadPanel).toHaveCount(0);

    await row.click();
    await expect(roomsPage.threadPanel).toBeVisible();
    await expect(row).toHaveAttribute('aria-expanded', 'true');
    // Root first, then its replies in the order they were written.
    await expect(roomsPage.threadEntries).toHaveCount(3);
    await expect(roomsPage.threadEntries.nth(0)).toContainText('why is the build slow?');
    await expect(roomsPage.threadEntries.nth(1)).toContainText('the cache is cold');
    await expect(roomsPage.threadEntries.nth(2)).toContainText('warming it now');

    // Opened to READ, so the keyboard stays shut and the panel itself holds
    // focus. That is not politeness: Escape only reaches the panel's handler
    // from inside it, so a panel opened this way that did not take focus could
    // be opened by keyboard and not closed by one.
    await expect(roomsPage.threadPanel).toBeFocused();
    await expect(roomsPage.threadComposer).not.toBeFocused();

    await page.keyboard.press('Escape');
    await expect(roomsPage.threadPanel).toHaveCount(0);
    await expect(row).toHaveAttribute('aria-expanded', 'false');

    // And the close button is the same way out, under a name that says where it
    // goes rather than what it looks like.
    await row.click();
    await expect(roomsPage.closeThread).toBeVisible();
    await roomsPage.closeThread.click();
    await expect(roomsPage.threadPanel).toHaveCount(0);
  });

  test('Page Down crosses the thread, and Ctrl+End lands in the thread’s own composer', async ({
    page,
    roomsApi,
    roomsPage,
  }) => {
    // The panel is a feed of its own, and the part worth pinning in a real
    // browser is where its edges are: leaving it lands on the panel's close
    // button and the panel's composer, never in the room still on screen
    // behind it.
    const slug = `e2e-thread-feed-${roomsApi.runId}`;
    const room = await roomsApi.createChannel(slug, slug);
    await roomsApi.postEntries(room.id, ['why is the build slow?']);
    const [rootId] = await roomsApi.entryIds(room.id);
    await roomsApi.postThreadReply(room.id, rootId!, 'the cache is cold');
    await roomsApi.postThreadReply(room.id, rootId!, 'warming it now');

    await page.goto(`/channels?id=${room.id}`);
    await expect(roomsPage.entries).toHaveCount(1, { timeout: SERVER_ROUND_TRIP_MS });
    await roomsPage.replyRow(roomsPage.entries.first()).click();
    await expect(roomsPage.threadEntries).toHaveCount(3);

    // Two feeds on screen, named apart — which is the whole reason a feed is
    // named at all.
    const threadFeed = page.getByRole('feed', { name: `Thread in #${slug}` });
    await expect(threadFeed).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByRole('feed', { name: `Messages in #${slug}` })).toBeVisible();

    // The root and its replies are one set of three, counted over the panel
    // rather than over the room.
    await expect(roomsPage.threadEntries.nth(1)).toHaveAttribute('aria-posinset', '2');
    await expect(roomsPage.threadEntries.nth(1)).toHaveAttribute('aria-setsize', '3');

    await roomsPage.threadEntries.first().focus();
    await page.keyboard.press('PageDown');
    await expect(roomsPage.threadEntries.nth(1)).toBeFocused();
    await page.keyboard.press('PageDown');
    await expect(roomsPage.threadEntries.nth(2)).toBeFocused();
    await page.keyboard.press('PageUp');
    await expect(roomsPage.threadEntries.nth(1)).toBeFocused();

    // Out of the feed on either side, and both stops are the panel's own.
    await page.keyboard.press('Control+End');
    await expect(roomsPage.threadComposer).toBeFocused();

    await roomsPage.threadEntries.nth(1).focus();
    await page.keyboard.press('Control+Home');
    await expect(roomsPage.closeThread).toBeFocused();

    // Escape still closes from wherever the feed left the reader.
    await roomsPage.threadEntries.nth(2).focus();
    await page.keyboard.press('Escape');
    await expect(roomsPage.threadPanel).toHaveCount(0);
  });

  test('a reply that arrives after you last looked wears the accent', async ({
    page,
    roomsApi,
    roomsPage,
  }) => {
    // Unread is DERIVED from the reader's frozen read cursor, not stored — so
    // the only honest way to test it is to give the reader a real cursor and
    // then land a reply above it. Two loads is what buys that: the first marks
    // the room read, the second opens with a cursor at the room's newest.
    const slug = `e2e-actions-unread-${roomsApi.runId}`;
    const room = await roomsApi.createChannel(slug, slug);
    await roomsApi.postEntries(room.id, ['why is the build slow?']);
    const [rootId] = await roomsApi.entryIds(room.id);
    await roomsApi.postThreadReply(room.id, rootId!, 'the cache is cold');

    await page.goto(`/channels?id=${room.id}`);
    await expect(roomsPage.entries).toHaveCount(1, { timeout: SERVER_ROUND_TRIP_MS });
    // Reading a room is what marks it read, and the cursor moves past thread
    // replies too. Waiting on that rather than reloading straight away is what
    // makes the reload deterministic.
    await roomsApi.waitForUnread(room.id, 0);

    await page.reload();
    const root = roomsPage.entries.first();
    const row = roomsPage.replyRow(root);
    // Everything in this thread is behind the cursor, so the row is quiet: no
    // accent, no count of new ones, just what is there.
    await expect(row).toContainText('1 reply');
    await expect(row).not.toHaveAttribute('data-unread', '');
    await expect(row).not.toContainText('new');

    // Now one arrives, from outside this reader's cursor, over the live stream.
    await roomsApi.postThreadReply(room.id, rootId!, 'warming it now');

    await expect(row).toHaveAttribute('data-unread', '', { timeout: SERVER_ROUND_TRIP_MS });
    await expect(row).toContainText('2 replies');
    // The count the colour is ABOUT, said out loud — a screen reader gets no
    // accent, so the words have to carry it.
    await expect(row).toContainText('1 new');
  });

  test('a thread has an address, and following it lands the reader and the keyboard on it', async ({
    page,
    roomsApi,
    roomsPage,
  }) => {
    const slug = `e2e-actions-link-${roomsApi.runId}`;
    const room = await roomsApi.createChannel(slug, slug);
    await roomsApi.postEntries(room.id, ['why is the build slow?']);
    const [rootId] = await roomsApi.entryIds(room.id);
    await roomsApi.postThreadReply(room.id, rootId!, 'the cache is cold');

    // Straight to the thread's own address, with no click to open it: a panel
    // you cannot link to is a panel you lose on every refresh.
    await page.goto(`/channels?id=${room.id}&thread=${rootId}`);
    await expect(roomsPage.threadPanel).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    await expect(roomsPage.threadEntries).toHaveCount(2);
    await expect(roomsPage.threadEntries.first()).toContainText('why is the build slow?');

    // And the keyboard arrives WITH it. A link is followed to read, so the
    // panel itself takes focus and the composer does not — the same landing
    // the reply-row route gets, and load-bearing for the same reason: Escape
    // only reaches the panel's handler from inside it, so a linked-to panel
    // that took no focus could be opened from the address bar and never closed
    // by a keyboard. The panel mounts before its entries arrive, so this is
    // asserted after the history above rather than racing it (DOR-1215).
    await expect(roomsPage.threadPanel).toBeFocused();
    await expect(roomsPage.threadComposer).not.toBeFocused();

    // Proof that the focus is real and not merely reported: Escape closes from
    // where the link left the reader, with nothing clicked in between.
    await page.keyboard.press('Escape');
    await expect(roomsPage.threadPanel).toHaveCount(0);
    await expect(page).not.toHaveURL(/thread=/);

    // Re-open by address for the close-button half below.
    await page.goto(`/channels?id=${room.id}&thread=${rootId}`);
    await expect(roomsPage.threadPanel).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });

    // Closing writes the address back, so the URL and the screen never disagree
    // — and it REPLACES rather than pushes, so Back leaves the room instead of
    // walking through every thread that was glanced at.
    await roomsPage.closeThread.click();
    await expect(roomsPage.threadPanel).toHaveCount(0);
    await expect(page).not.toHaveURL(/thread=/);
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
    await expect(roomsPage.threadPanel).toBeVisible();
  });
});

test.describe('Rooms — a thread on a phone', () => {
  // The same iPhone the room-sheet phone spec measures on (`PHONE`), with touch
  // emulation, because both halves matter here too: under 768px `useIsMobile`
  // chooses the push over the side panel, and the pointer decides how it is
  // reached.
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('the thread takes the whole screen, and Back returns to the room', async ({
    page,
    roomsApi,
    roomsPage,
  }) => {
    // A phone has no room for a column beside a column, so the thread IS the
    // screen — a real drill-in push, not a sheet over a room you cannot use.
    // What makes that a claim rather than a class name is geometry plus
    // absence: the panel fills the viewport, and the room is genuinely gone.
    const slug = `e2e-thread-phone-${roomsApi.runId}`;
    const room = await roomsApi.createChannel(slug, slug);
    await roomsApi.postEntries(room.id, ['why is the build slow?']);
    const [rootId] = await roomsApi.entryIds(room.id);
    await roomsApi.postThreadReply(room.id, rootId!, 'the cache is cold');

    await page.goto(`/channels?id=${room.id}`);
    await expect(roomsPage.entries).toHaveCount(1, { timeout: SERVER_ROUND_TRIP_MS });

    const root = roomsPage.entries.first();
    await roomsPage.replyRow(root).click();
    await expect(roomsPage.threadPanel).toBeVisible();

    // The room is unmounted, which is the honest reading of a push: there is
    // one screen, and this is it. A drawer would have left the timeline behind
    // it and this assertion is what tells the two apart.
    await expect(roomsPage.entries).toHaveCount(0);
    await expect(roomsPage.composer(`#${slug}`)).toHaveCount(0);

    // Full width, and reaching the bottom of the window. Measured against the
    // viewport rather than against a class.
    //
    // Polled to its resting place first: the push really slides in now (it
    // enters from 16px to the right), so a single measurement taken on the way
    // catches it mid-travel — this read 14px before the poll was added. What is
    // being asserted is where the panel COMES TO REST, not where it passes
    // through.
    await expect
      .poll(async () => (await roomsPage.threadPanel.boundingBox())!.x)
      .toBeLessThanOrEqual(1);
    const panel = (await roomsPage.threadPanel.boundingBox())!;
    expect(panel.width).toBeGreaterThanOrEqual(389);

    // **Down to the bottom of the screen, which now has chrome at the bottom of
    // it.** P4 gave the phone four permanent destinations along the bottom
    // (`MobileTabsLayout`), so the routed page — and the push inside it — ends
    // 56px up. The claim is unchanged: nothing between the thread and the
    // bottom of the window is wasted. It is asserted as a chain rather than
    // against a bare `844 - 8`, so it still reaches the window: the panel
    // reaches the bar, and the bar reaches the window's edge. A single relative
    // assertion would have let a collapsed shell pass.
    const bar = (await page.getByTestId('mobile-tab-bar').boundingBox())!;
    expect(bar.y + bar.height).toBeGreaterThan(844 - 8);
    expect(panel.y + panel.height).toBeGreaterThan(bar.y - 8);
    // …and the two do not overlap: permanent chrome that covered the thread it
    // sits under would be worse than chrome that took the room from it.
    expect(panel.y + panel.height).toBeLessThanOrEqual(bar.y + 1);

    // Back rather than close, and it names where it goes — the difference
    // between the two shapes is a promise to the reader, not styling.
    await expect(roomsPage.closeThread).toHaveCount(0);
    const back = roomsPage.backToRoom(`#${slug}`);
    await expect(back).toBeVisible();

    await back.click();
    await expect(roomsPage.threadPanel).toHaveCount(0);
    await expect(roomsPage.entries).toHaveCount(1);
    await expect(roomsPage.composer(`#${slug}`)).toBeVisible();
  });

  test('coming back from a thread leaves the room where it was', async ({
    page,
    roomsApi,
    roomsPage,
  }) => {
    // The push UNMOUNTS the room, so coming back mounts a brand new scroller at
    // the top — and neither the room id nor its newest entry changed, so
    // nothing about the room changed, so nothing would re-pin it. Measured on
    // this exact viewport: 1148px before opening the thread, 0px after closing
    // it. The reader pressed Back and silently landed on the oldest message in
    // the room.
    const slug = `e2e-thread-scroll-${roomsApi.runId}`;
    const room = await roomsApi.createChannel(slug, slug);
    // Enough history that the room genuinely scrolls on a 844px-tall phone.
    await roomsApi.postEntries(
      room.id,
      Array.from({ length: 30 }, (_, i) => `message number ${i + 1}`)
    );
    const ids = await roomsApi.entryIds(room.id);
    // The thread hangs off the NEWEST message, so its reply row is already on
    // screen at the bottom. That matters: clicking a row that is scrolled out
    // of view would scroll the room to reach it, and the position this test is
    // about would have been changed by the test itself.
    await roomsApi.postThreadReply(room.id, ids[ids.length - 1]!, 'answering the last one');

    await page.goto(`/channels?id=${room.id}`);
    await roomsPage.waitForHistory(30, SERVER_ROUND_TRIP_MS);

    // A room opens at its newest message, so it is already scrolled down.
    await expect.poll(() => roomsPage.isAtBottom()).toBe(true);
    const before = await roomsPage.scrollTop();
    expect(before).toBeGreaterThan(0);

    await roomsPage.replyRow(roomsPage.entries.last()).click();
    await expect(roomsPage.threadPanel).toBeVisible();
    await expect(roomsPage.entries).toHaveCount(0);

    await roomsPage.backToRoom(`#${slug}`).click();
    await roomsPage.waitForHistory(30, SERVER_ROUND_TRIP_MS);

    // Back at the newest message, not thrown to the top of the history.
    await expect.poll(() => roomsPage.isAtBottom()).toBe(true);
    expect(await roomsPage.scrollTop()).toBeGreaterThan(0);
  });

  test('coming back from a thread leaves a reader who had scrolled BACK where they were', async ({
    page,
    roomsApi,
    roomsPage,
  }) => {
    // The other half, and the harder one: the test above leaves at the bottom,
    // where "put me back" and "open at the newest message" are the same answer.
    // A reader who has scrolled INTO the history has to come back to the message
    // they were reading — which the timeline can only do by remembering a ROW,
    // because its own total height is an estimate until it settles (measured on
    // this viewport: a remembered 900px offset was carried to 0 by the
    // end-anchor as the list shrank from 16 000px to 4 159px).
    const slug = `e2e-thread-resume-${roomsApi.runId}`;
    const room = await roomsApi.createChannel(slug, slug);
    await roomsApi.postEntries(
      room.id,
      Array.from({ length: 40 }, (_, i) => `resume line ${i + 1}`)
    );
    const ids = await roomsApi.entryIds(room.id);
    // The thread hangs off a message in the MIDDLE, so the reader is at neither
    // end of the room when they open it.
    const middle = ids[Math.floor(ids.length / 2)]!;
    await roomsApi.postThreadReply(room.id, middle, 'answering one from the middle');

    await page.goto(`/channels?id=${room.id}`);
    await roomsPage.waitForHistory(40, SERVER_ROUND_TRIP_MS);
    await expect.poll(() => roomsPage.isAtBottom()).toBe(true);

    // A real reader scrolls back into the history and opens a thread by tapping
    // a reply they can SEE — so the tap moves nothing. This spec reproduces
    // exactly that, because the thing under test — does coming back restore the
    // reader's row? — is only meaningful if the reader's row does not move
    // between the test recording it and the thread taking the room away.
    //
    // The old synthetic `scrollTop = scrollHeight / 2` jump broke that twice
    // over: it remembered a row against the virtualizer's pre-settle height
    // estimate, which then shifted under it (DOR-1431), and it left the reply
    // row it went on to tap only half on screen, so the tap re-centred it —
    // Chromium centres a target that is not fully visible — and moved the room
    // by about four messages AFTER the row had been recorded (DOR-1364). The
    // telemetry banner's ~150px used to paper over both; without it the test has
    // to earn its own honesty. The sibling test above dodges the same trap by
    // hanging its thread off the newest message, which is already on screen.
    const scrollerBox = (await roomsPage.scroller.boundingBox())!;
    await page.mouse.move(
      scrollerBox.x + scrollerBox.width / 2,
      scrollerBox.y + scrollerBox.height / 2
    );
    // Wheel back a notch at a time — a genuine gesture, which fires scroll
    // events at SETTLED geometry so the row the timeline remembers is the one
    // truly under the reader — until the room's thread is sitting comfortably on
    // screen, clear of both edges and off the newest message. A third of the
    // viewport per notch is far smaller than the band where the reply row is
    // fully clear, so the reader always comes to rest somewhere they can tap it
    // without the tap scrolling anything.
    await expect
      .poll(
        async () => {
          if (!(await roomsPage.isAtBottom()) && (await roomsPage.replyRowComfortablyVisible())) {
            return true;
          }
          await page.mouse.wheel(0, -Math.round(scrollerBox.height / 3));
          return false;
        },
        { timeout: 15_000 }
      )
      .toBe(true);

    // Record where the reader is standing, once the list holds still — the row
    // coming back has to return them to. A null on both sides of the final
    // comparison would be a test that passed by measuring nothing.
    const topBefore = await roomsPage.settledTopVisibleEntryText();
    expect(topBefore).not.toBeNull();

    // Tap the reply the reader can see — the room's one thread, located as what
    // is on screen rather than by a hardcoded message id. Because the wheel
    // above left it comfortably in view, this tap scrolls nothing, so the room
    // stays exactly where `topBefore` recorded it (the DOR-1364 coupling is gone
    // — there is no reposition between recording the row and leaving it).
    await roomsPage.replyRows.first().click();
    await expect(roomsPage.threadPanel).toBeVisible();
    await expect(roomsPage.entries).toHaveCount(0);

    await roomsPage.backToRoom(`#${slug}`).click();
    await roomsPage.waitForHistory(40, SERVER_ROUND_TRIP_MS);

    // The same message at the top of the viewport, and the room did NOT decide
    // to open at its newest message instead. The second assertion names the
    // mechanism: `remembered` is the landing that read the row back.
    await expect.poll(() => roomsPage.timeline.getAttribute('data-landed-on')).toBe('remembered');
    expect(await roomsPage.settledTopVisibleEntryText()).toBe(topBefore);
  });
});
