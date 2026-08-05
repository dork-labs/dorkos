import { test, expect } from '../../fixtures';
import { SERVER_ROUND_TRIP_MS } from '../../fixtures/rooms-api';

// Same shape as its siblings: one cockpit at a time, and a ceiling sized for a
// machine already running several worktrees of agents.
test.describe.configure({ mode: 'default', timeout: 90_000 });

/**
 * Reactions, end to end.
 *
 * **What only a browser can answer here** is everything about the round trip.
 * A reaction is drawn optimistically and then reconciled against the room's SSE
 * stream, which carries the entry's WHOLE set — so "the pill is on screen" is
 * two different claims a jsdom test cannot tell apart: the one this client
 * guessed, and the one the server actually holds. Every assertion below that
 * matters is therefore about a set that arrived over the stream, seeded through
 * the API from outside the page.
 *
 * The rules underneath (whole-set replace, the optimistic revert, the ghost +
 * threshold, the wrap at ten, the roving keyboard model) are pinned in jsdom and
 * deliberately not re-asserted here.
 *
 * Every seeded agent is `silent` (the fixture guarantees it), so nothing in this
 * file can start a real turn — and a reaction is a costless acknowledgment that
 * never triggers one anyway, which is pinned server-side.
 */
test.describe('Rooms — reacting to a message', () => {
  test('a reaction from the capsule becomes a pill, and pressing the pill takes it back', async ({
    page,
    roomsApi,
    roomsPage,
  }) => {
    const slug = `e2e-react-${roomsApi.runId}`;
    const room = await roomsApi.createChannel(slug, slug);
    await roomsApi.postEntries(room.id, ['the deploy is stuck']);

    await page.goto(`/channels?id=${room.id}`);
    await expect(roomsPage.entries).toHaveCount(1, { timeout: SERVER_ROUND_TRIP_MS });

    const entry = roomsPage.entries.first();

    // Perfectly clean before anybody reacts: no pill row in the DOM at all, and
    // therefore no ghost + either.
    await expect(roomsPage.reactionsIn(entry)).toHaveCount(0);

    await entry.hover();
    const toolbar = roomsPage.actionsIn(entry);
    await expect(toolbar).toHaveCSS('opacity', '1');

    // The row is READ rather than named. These three are the reader's own
    // most-used across every room on this shared server, so a sibling spec that
    // reacts changes them — naming one here would be a claim only one test at a
    // time can be right about.
    const quick = roomsPage.quickReactionsIn(entry).first();
    const emoji = (await quick.getAttribute('data-emoji'))!;
    await quick.click();

    const pill = roomsPage.reaction(entry, emoji);
    await expect(pill).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    // Yours, which is what the accent is for — and what makes the pill a toggle.
    await expect(pill).toHaveAttribute('data-mine', 'true');
    await expect(pill).toHaveAttribute('aria-pressed', 'true');
    // Names, not counts.
    await expect(pill).toHaveAttribute('title', `You reacted ${emoji}`);
    // And the ghost + arrived with it.
    await expect(roomsPage.reactionAdd(entry)).toBeVisible();

    // It really landed, rather than being drawn optimistically and lost: the
    // server's own copy of the set says so.
    const [entryId] = await roomsApi.entryIds(room.id);
    await expect
      .poll(async () => (await roomsApi.reactionsOn(room.id, entryId!)).map((r) => r.emoji), {
        timeout: SERVER_ROUND_TRIP_MS,
      })
      .toEqual([emoji]);

    // The pill IS the toggle. Pressing it takes the reaction back, the last
    // person off a pill takes the pill with them, and the whole row goes with it.
    await pill.click();
    await expect(roomsPage.reactionsIn(entry)).toHaveCount(0, { timeout: SERVER_ROUND_TRIP_MS });
    await expect
      .poll(async () => (await roomsApi.reactionsOn(room.id, entryId!)).length, {
        timeout: SERVER_ROUND_TRIP_MS,
      })
      .toBe(0);
  });

  test('a reaction made outside this page arrives on the stream, with no reload', async ({
    page,
    roomsApi,
    roomsPage,
  }) => {
    // The assertion the optimistic path cannot fake. Nothing in the page pressed
    // anything: the set changed on the server and reached this reader over
    // `GET /api/rooms/:id/events`, which is the one delivery path reactions have.
    const slug = `e2e-react-live-${roomsApi.runId}`;
    const room = await roomsApi.createChannel(slug, slug);
    await roomsApi.postEntries(room.id, ['the last step never returned']);

    await page.goto(`/channels?id=${room.id}`);
    await expect(roomsPage.entries).toHaveCount(1, { timeout: SERVER_ROUND_TRIP_MS });

    const entry = roomsPage.entries.first();
    await expect(roomsPage.reactionsIn(entry)).toHaveCount(0);

    const [entryId] = await roomsApi.entryIds(room.id);
    await roomsApi.react(room.id, entryId!, '🎉');

    await expect(roomsPage.reaction(entry, '🎉')).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });

    // And a REMOVAL made outside the page arrives too. This is the half a delta
    // stream would lose: taking the last pill back leaves the entry unchanged,
    // so nothing replays it — only an event carrying the entry's whole (empty)
    // set can correct a reader who is looking at it.
    await roomsApi.react(room.id, entryId!, '🎉', false);
    await expect(roomsPage.reactionsIn(entry)).toHaveCount(0, { timeout: SERVER_ROUND_TRIP_MS });
  });

  test('the picker finds an emoji the quick row does not hold', async ({
    page,
    roomsApi,
    roomsPage,
  }) => {
    const slug = `e2e-react-pick-${roomsApi.runId}`;
    const room = await roomsApi.createChannel(slug, slug);
    await roomsApi.postEntries(room.id, ['warming the cache now']);

    await page.goto(`/channels?id=${room.id}`);
    await expect(roomsPage.entries).toHaveCount(1, { timeout: SERVER_ROUND_TRIP_MS });

    const entry = roomsPage.entries.first();
    await entry.hover();
    await roomsPage.actionsIn(entry).getByRole('button', { name: 'Pick a reaction' }).click();

    const picker = roomsPage.reactionPicker;
    await expect(picker).toBeVisible();
    // Search, because 🚀 is not one of the three the capsule offers.
    await picker.getByRole('textbox', { name: 'Search emoji' }).fill('rocket');
    await picker.getByRole('button', { name: 'rocket' }).click();

    // Closed on the pick: the pill that appears IS the confirmation, and a
    // picker left open over it hides the thing it just did.
    await expect(picker).toHaveCount(0);
    await expect(roomsPage.reaction(entry, '🚀')).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
  });

  test('the keyboard alone reaches the quick row, reacts, and then reaches the pill', async ({
    page,
    roomsApi,
    roomsPage,
  }) => {
    const slug = `e2e-react-kbd-${roomsApi.runId}`;
    const room = await roomsApi.createChannel(slug, slug);
    await roomsApi.postEntries(room.id, ['the lockfile changed under us']);

    await page.goto(`/channels?id=${room.id}`);
    await expect(roomsPage.entries).toHaveCount(1, { timeout: SERVER_ROUND_TRIP_MS });

    const entry = roomsPage.entries.first();
    const toolbar = roomsPage.actionsIn(entry);

    // No pointer at any point. The message is the tab stop; focusing it shows
    // its actions, and an arrow steps into them — onto a reaction, which is now
    // the capsule's first tenant.
    await entry.focus();
    await expect(toolbar).toHaveCSS('opacity', '1');

    await page.keyboard.press('ArrowRight');
    const quick = roomsPage.quickReactionsIn(entry).first();
    await expect(quick).toBeFocused();
    const emoji = (await quick.getAttribute('data-emoji'))!;
    await page.keyboard.press('Enter');

    const pill = roomsPage.reaction(entry, emoji);
    await expect(pill).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });

    // The pills are BELOW the message, so ArrowDown from the row reaches them —
    // and they are not tab stops, which is what keeps a room one Tab per message
    // however many reactions it collects.
    await entry.focus();
    await page.keyboard.press('ArrowDown');
    await expect(pill).toBeFocused();
    await expect(pill).toHaveAttribute('tabindex', '-1');

    // Enter on the focused pill takes the reaction back.
    await page.keyboard.press('Enter');
    await expect(roomsPage.reactionsIn(entry)).toHaveCount(0, { timeout: SERVER_ROUND_TRIP_MS });
  });

  test('a room that has stopped listening stops offering reactions', async ({
    page,
    roomsApi,
    roomsPage,
  }) => {
    // Reactions go with the composer (design record §4). A write whose answer
    // would never come back is worse than a control that says it cannot be used.
    // The one deliberately slow test here, for the same reason its sibling in
    // `room-conversation.spec.ts` is: the retry budget is five attempts on
    // jittered backoff before the room admits it has gone deaf.
    test.setTimeout(120_000);

    const slug = `e2e-react-stalled-${roomsApi.runId}`;
    const room = await roomsApi.createChannel(slug, slug);
    await roomsApi.postEntries(room.id, ['is anybody there']);
    // Seeded BEFORE the page opens, so the pill arrives with the history read
    // rather than over the stream this test is about to cut. Aborting the route
    // after a stream is already open does nothing to the open one.
    const [entryId] = await roomsApi.entryIds(room.id);
    await roomsApi.react(room.id, entryId!, '👀');

    // The room stream is a WebSocket (ADR 260805-041016), so `page.route` cannot
    // touch it — that intercepts HTTP requests only, and routing the path had
    // silently stopped cutting anything. `routeWebSocket` is the equivalent, and
    // closing without `connectToServer()` is a stream that never opens.
    await page.routeWebSocket(new RegExp(`/api/rooms/${room.id}/events`), (ws) => ws.close());

    await page.goto(`/channels?id=${room.id}`);
    await expect(roomsPage.entries).toHaveCount(1, { timeout: SERVER_ROUND_TRIP_MS });

    const entry = roomsPage.entries.first();
    await expect(roomsPage.reaction(entry, '👀')).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });

    // A room that has stopped listening looks exactly like a quiet one, so the
    // notice is the only thing that reports it — and reaching it takes the
    // hook's whole retry budget on jittered backoff, which is the behaviour
    // rather than overhead (the same wait `room-conversation.spec.ts` names).
    await expect(roomsPage.stalledNotice).toBeVisible({ timeout: 45_000 });

    await expect(roomsPage.reaction(entry, '👀')).toBeDisabled();
    await expect(roomsPage.reactionAdd(entry)).toBeDisabled();
    await expect(roomsPage.quickReactionsIn(entry).first()).toBeDisabled();
  });
});

test.describe('Rooms — reacting on a touch screen', () => {
  // Under 768px `useIsMobile` flips the surface to its drawer, and touch
  // emulation is what makes the press a real coarse-pointer gesture.
  test.use({ viewport: { width: 390, height: 780 }, hasTouch: true });

  test('the long-press drawer opens with a reaction row on top', async ({
    page,
    roomsApi,
    roomsPage,
  }) => {
    const slug = `e2e-react-touch-${roomsApi.runId}`;
    const room = await roomsApi.createChannel(slug, slug);
    await roomsApi.postEntries(room.id, ['the deploy is stuck']);

    await page.goto(`/channels?id=${room.id}`);
    await expect(roomsPage.entries).toHaveCount(1, { timeout: SERVER_ROUND_TRIP_MS });

    const entry = roomsPage.entries.first();
    await roomsPage.longPress(entry);

    const drawer = page.getByRole('dialog');
    await expect(drawer).toBeVisible();
    // The reaction row is ABOVE the actions — one tap to thank an agent, rather
    // than six list rows to scroll past.
    const row = drawer.getByTestId('drawer-reactions');
    await expect(row).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Reply in thread' })).toBeVisible();

    // Read, not named — the same reason the capsule's row is (see `RoomsPage`).
    const quick = row.locator('[data-entry-action="react"]').first();
    const emoji = (await quick.getAttribute('data-emoji'))!;
    await quick.click();

    // Reacting closes the drawer, because the pill it drew is the confirmation
    // and a drawer standing open over the message hides it.
    await expect(drawer).toHaveCount(0);
    await expect(roomsPage.reaction(entry, emoji)).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
  });

  test('the drawer’s 🙂+ opens the same picker inline', async ({ page, roomsApi, roomsPage }) => {
    const slug = `e2e-react-touch-pick-${roomsApi.runId}`;
    const room = await roomsApi.createChannel(slug, slug);
    await roomsApi.postEntries(room.id, ['green on the second run']);

    await page.goto(`/channels?id=${room.id}`);
    await expect(roomsPage.entries).toHaveCount(1, { timeout: SERVER_ROUND_TRIP_MS });

    const entry = roomsPage.entries.first();
    await roomsPage.longPress(entry);

    const drawer = page.getByRole('dialog');
    await drawer.getByRole('button', { name: 'Pick a reaction' }).click();

    // Inline, not a popover over a drawer: two overlays deep on the surface with
    // the least room for them is where a picker becomes unreachable.
    const picker = drawer.getByTestId('reaction-picker');
    await expect(picker).toBeVisible();
    await picker.getByRole('textbox', { name: 'Search emoji' }).fill('fire');
    await picker.getByRole('button', { name: 'fire' }).click();

    await expect(drawer).toHaveCount(0);
    await expect(roomsPage.reaction(entry, '🔥')).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
  });
});
