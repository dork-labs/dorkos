import { test, expect } from '../../fixtures';
import { SERVER_ROUND_TRIP_MS } from '../../fixtures/rooms-api';
import { openCockpit } from './open-cockpit';

// Opted out of the project-wide `fullyParallel`, and given a longer budget than
// the 30s the lighter specs run under.
//
// These tests share one server and one room list, and eleven cockpits loading at
// once is load the product never sees. They stay independent (`default`, not
// `serial`) — each seeds its own rooms, so a failure never cascades — but they
// run one at a time.
//
// The budget is a ceiling, not a wait: on an idle machine each of these finishes
// in three to eight seconds. It is sized for the machine this repo actually runs
// on, which AGENTS.md describes as routinely several worktrees of concurrent
// agents; measured against a load average north of 200, seeding two agents and
// loading a cockpit does not fit in 30s.
test.describe.configure({ mode: 'default', timeout: 90_000 });

/**
 * Saying something in a room, and reading one while it changes underneath you.
 *
 * The phase that shipped rooms cut the composer, so for a while `/channels` read
 * "You can read this room, but not post to it yet" over an endpoint that had
 * worked the whole time (spec `rooms` §12.1). Two things landed with the
 * composer, both of which only matter once somebody can post, and neither of
 * which jsdom can see:
 *
 * - **The stream reconnects.** A dropped socket used to be a lost message.
 * - **The scroll guard.** Every arrival scrolled to the bottom unconditionally,
 *   so reading history while an agent replied yanked you away from it.
 *
 * No Claude SDK or API key: a channel seeded here has no agent members, so a
 * post triggers nobody.
 */
test.describe('Rooms — posting, switching and staying live @smoke', () => {
  // Rooms are seeded inside each test and BEFORE the cockpit loads, so the
  // sidebar's first read of the room list already holds them — seeding after the
  // page was up made the test depend on catching a live `room_created` signal, a
  // race it does not exist to exercise.

  test('create a channel from the sidebar, post to it, and read the post back', async ({
    page,
    basePage,
    roomsApi,
    roomsPage,
  }) => {
    await openCockpit(basePage);

    // Typed the way a person types it — a name, not punctuation. The server
    // derives the `#slug`, and this asserts the exact slug it derives.
    const name = `E2E Compose ${roomsApi.runId}`;
    const slug = `e2e-compose-${roomsApi.runId}`;
    await roomsPage.createChannel(name);

    // Creating it opens it, and the new room is in the Channels section.
    await expect(page).toHaveURL(/\/channels\?.*id=/, { timeout: SERVER_ROUND_TRIP_MS });
    const roomId = new URL(page.url()).searchParams.get('id')!;
    roomsApi.track(roomId);
    await expect(roomsPage.rowIn(roomsPage.channels, `#${slug}`)).toBeVisible({
      timeout: SERVER_ROUND_TRIP_MS,
    });
    await expect(roomsPage.roomHeading).toHaveAccessibleName(`#${slug}`);
    // The empty state, not `toHaveCount(0)` — a room still loading its history
    // has no entry rows either, so counting zero proves nothing.
    await expect(page.getByText('Nothing said here yet')).toBeVisible({
      timeout: SERVER_ROUND_TRIP_MS,
    });

    // A new channel is not a room you may only read (DOR-569). The proof is the
    // post below, not a `toBeEnabled()` on the field: `canSubmit` gates the
    // submit action, so the textarea stays enabled either way and asserting on
    // it passes just as happily against the bug. Reverting the fix reddens the
    // `toHaveCount(1)`, which is the assertion that earns its place here.
    const composer = roomsPage.composer(`#${slug}`);
    await roomsPage.post(`#${slug}`, 'The first thing anyone said here.');

    // Nothing is drawn until the server's copy arrives back on the room's
    // stream, so this asserts the round trip, not an optimistic echo.
    await expect(roomsPage.entries).toHaveCount(1, { timeout: SERVER_ROUND_TRIP_MS });
    const entry = roomsPage.entries.first();
    await expect(entry).toContainText('The first thing anyone said here.');
    await expect(entry).toContainText('You');
    // The box empties on Enter so the next sentence can be typed straight away.
    await expect(composer).toHaveValue('');

    // And it is durable: it came from the room's own log, not the page's memory.
    const posted = await roomsApi.getRoom(roomId);
    expect(posted.slug).toBe(slug);
  });

  test('a channel is born with its agents in it, and the panel says so (DOR-599, DOR-600)', async ({
    page,
    basePage,
    roomsApi,
    roomsPage,
  }) => {
    // A channel with nobody in it does nothing, so naming it and filling it are
    // one step. jsdom cannot see any of this: the picker sits inside a
    // responsive modal, and the roster it produces is read back off the server.
    const ana = await roomsApi.registerAgent(`E2E Ana ${roomsApi.runId}`, '🦊', '#e07b39');
    const kai = await roomsApi.registerAgent(`E2E Kai ${roomsApi.runId}`, '🐙', '#7c3aed');
    await openCockpit(basePage);

    const name = `E2E Born ${roomsApi.runId}`;
    const slug = `e2e-born-${roomsApi.runId}`;
    await roomsPage.createChannel(name, [ana.name, kai.name]);

    await expect(page).toHaveURL(/\/channels\?.*id=/, { timeout: SERVER_ROUND_TRIP_MS });
    const roomId = new URL(page.url()).searchParams.get('id')!;
    roomsApi.track(roomId);

    // The server, first: BOTH memberships exist, on the one call that made the
    // room. Named agents, not a count — `toHaveLength(3)` passes for a roster
    // holding the wrong two.
    const roster = await roomsApi.getRoom(roomId);
    expect(roster.slug).toBe(slug);
    const agentNames = roster.members
      .filter((m) => m.author.kind === 'agent')
      .map((m) => m.author.displayName)
      .sort();
    expect(agentNames).toEqual([ana.name, kai.name].sort());

    // Then the panel's own state, which is a different claim: a roster the
    // server holds and the panel does not draw is still a bug the person sees.
    await roomsPage.membersButton.click();
    const panel = page.getByRole('dialog');
    await expect(panel).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    // The sheet is named by the ROOM. Its visible name is a control — press it
    // and it becomes the rename field — and a control's accessible name says
    // what pressing it does, so it cannot also be the sheet's.
    await expect(panel).toHaveAccessibleName(`#${slug}`);
    // Both agents have a row, each with its verbs behind its own "…".
    await expect(panel.getByRole('button', { name: `${ana.name} actions` })).toBeVisible();
    await expect(panel.getByRole('button', { name: `${kai.name} actions` })).toBeVisible();
    // The per-room override this sheet is the first UI ever to touch. This
    // channel was made through the UI, not through the fixture, so it carries
    // the shipped channel seed — `engaged` (room-participation spec §9.4) —
    // rather than whatever `roomsApi.createChannel` silences its rooms to.
    const pill = panel.getByRole('button', { name: `How loud ${ana.name} is here` });
    await expect(pill).toHaveText('Engaged');

    // The pill is the glance; the scale under it is the task. And the sentence
    // there has to carry the REAL numbers, which only a real server can prove.
    // They come from `rooms.engagedWindowMinutes` and `rooms.engagedWindowPosts`
    // over `GET /api/config`; with that plumbing broken the copy degrades to a
    // numberless sentence and every unit test still passes, because a mock
    // transport can be told anything. These are the shipped ceilings, and this
    // cockpit has not changed them.
    await pill.click();
    await expect(
      panel.getByText('keeps answering for 10 more minutes or 5 more messages', { exact: false })
    ).toBeVisible();
  });

  test('an empty channel says it is empty and hands you the button (DOR-600)', async ({
    page,
    basePage,
    roomsApi,
    roomsPage,
  }) => {
    // The deliberate empty path. Its empty state used to promise an affordance
    // that existed nowhere in the product.
    await openCockpit(basePage);
    const name = `E2E Nobody ${roomsApi.runId}`;
    await roomsPage.createChannel(name);
    await expect(page).toHaveURL(/\/channels\?.*id=/, { timeout: SERVER_ROUND_TRIP_MS });
    roomsApi.track(new URL(page.url()).searchParams.get('id')!);

    await expect(page.getByText(/no agents in here, so nothing will answer/i)).toBeVisible({
      timeout: SERVER_ROUND_TRIP_MS,
    });
    await roomsPage.emptyStateAddAgents.click();

    // Lands on the picker, because "Add agents" is what was asked for — the
    // next keystroke is a search rather than a hunt for the field.
    const panel = page.getByRole('dialog');
    await expect(panel).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    await expect(panel.getByRole('combobox', { name: 'Search agents' })).toBeFocused();
  });

  test('switching rooms swaps the history, the masthead and the browser tab', async ({
    page,
    basePage,
    roomsApi,
    roomsPage,
  }) => {
    const alphaSlug = `e2e-switch-a-${roomsApi.runId}`;
    const bravoSlug = `e2e-switch-b-${roomsApi.runId}`;
    const alpha = await roomsApi.createChannel(alphaSlug);
    const bravo = await roomsApi.createChannel(bravoSlug);
    await roomsApi.postEntries(alpha.id, ['alpha one', 'alpha two']);
    await roomsApi.postEntries(bravo.id, ['bravo one']);
    await openCockpit(basePage);

    await roomsPage.rowIn(roomsPage.channels, `#${alphaSlug}`).click();
    await expect(roomsPage.entries).toHaveCount(2, { timeout: SERVER_ROUND_TRIP_MS });
    await expect(roomsPage.entry('alpha one')).toBeVisible();
    await expect(roomsPage.entry('alpha two')).toBeVisible();
    // The tab named the working directory of a session you were not looking at
    // until DOR-583; on `/channels` it now names the room you are reading.
    await expect(page).toHaveTitle(`#${alphaSlug} — DorkOS`);

    await roomsPage.rowIn(roomsPage.channels, `#${bravoSlug}`).click();
    await expect(page).toHaveURL(new RegExp(`id=${bravo.id}`), {
      timeout: SERVER_ROUND_TRIP_MS,
    });
    await expect(roomsPage.entries).toHaveCount(1, { timeout: SERVER_ROUND_TRIP_MS });
    await expect(roomsPage.entry('bravo one')).toBeVisible();
    // The first room's history is gone, not merely scrolled off.
    await expect(roomsPage.entry('alpha one')).toHaveCount(0);
    await expect(roomsPage.roomHeading).toHaveAccessibleName(`#${bravoSlug}`);
    await expect(page).toHaveTitle(`#${bravoSlug} — DorkOS`);
    // The composer follows too, so a sentence cannot land in the room you left.
    await expect(roomsPage.composer(`#${bravoSlug}`)).toBeVisible();
    await expect(roomsPage.composer(`#${alphaSlug}`)).toHaveCount(0);
  });

  test('an arriving message does not yank a reader back from history', async ({
    page,
    roomsApi,
    roomsPage,
  }) => {
    const slug = `e2e-scroll-${roomsApi.runId}`;
    const room = await roomsApi.createChannel(slug);
    // Enough history to scroll through. The room view has no virtualizer, so
    // every one of these is a real laid-out row.
    await roomsApi.postEntries(
      room.id,
      Array.from({ length: 30 }, (_, i) => `history line ${i + 1}`)
    );

    await page.goto(`/channels?id=${room.id}`);
    await expect(roomsPage.entries).toHaveCount(30, { timeout: SERVER_ROUND_TRIP_MS });
    // A room opens at its newest message, the way every chat surface does. The
    // scroll runs in an effect after the rows commit, so this polls rather than
    // reading once and racing it.
    await expect.poll(() => roomsPage.isAtBottom()).toBe(true);

    // Now read back through it.
    await roomsPage.scroller.evaluate((el) => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event('scroll'));
    });
    expect(await roomsPage.scrollTop()).toBe(0);

    // A message arrives on the live stream while the reader is up here.
    await roomsApi.postEntries(room.id, ['arrived while reading history']);
    await expect(roomsPage.entries).toHaveCount(31, { timeout: SERVER_ROUND_TRIP_MS });
    await expect(roomsPage.entry('arrived while reading history')).toBeAttached();
    // The whole point: the view did not move. Asserting `scrollTop === 0` names
    // the subject — "still near the top" would pass on a jump of a screenful.
    expect(await roomsPage.scrollTop()).toBe(0);

    // Back at the bottom, the room follows again — the guard suppresses the
    // scroll for a reader who left, not for one who is caught up.
    await roomsPage.scroller.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      el.dispatchEvent(new Event('scroll'));
    });
    await roomsApi.postEntries(room.id, ['arrived while caught up']);
    await expect(roomsPage.entries).toHaveCount(32, { timeout: SERVER_ROUND_TRIP_MS });
    await expect.poll(() => roomsPage.isAtBottom()).toBe(true);
  });

  test('a room whose stream has died says so, and Reconnect brings it back', async ({
    page,
    roomsApi,
    roomsPage,
  }) => {
    // The one deliberately slow test in the suite. The hook retries a dropped
    // stream five times on jittered exponential backoff before it gives up, so
    // reaching the notice takes up to ~15s of real waiting even on an idle
    // machine — and that wait is the behaviour, not overhead to be tuned away.
    test.setTimeout(120_000);

    const slug = `e2e-stall-${roomsApi.runId}`;
    const room = await roomsApi.createChannel(slug);
    await roomsApi.postEntries(room.id, ['said before the stream died']);

    // Every attempt to open the room's stream fails from here on. History still
    // loads: only the live subscription is cut.
    await page.route(`**/api/rooms/${room.id}/events**`, (route) => route.abort());

    await page.goto(`/channels?id=${room.id}`);
    await expect(roomsPage.entries).toHaveCount(1, { timeout: SERVER_ROUND_TRIP_MS });

    // A room that has stopped listening looks exactly like a quiet one, so it
    // has to say so — this is the only place in the product that reports it.
    await expect(roomsPage.stalledNotice).toBeVisible({ timeout: 45_000 });
    // Still readable, still postable: the notice is about delivery, not access.
    await expect(roomsPage.composer(`#${slug}`)).toBeEnabled();

    // Something lands while the room is deaf to it. `postEntries` resolves on
    // the 202, which the server only sends once the entry is committed AND fanned
    // out — so a live stream would already have drawn it, and finding it absent
    // here is a real observation rather than a snapshot taken too early.
    await roomsApi.postEntries(room.id, ['said while the stream was down']);
    await expect(roomsPage.entry('said while the stream was down')).toHaveCount(0);

    // Let the stream through and ask the room to try again. The resume is
    // gap-free — the message posted during the outage arrives too, which is the
    // whole reason the retry recomputes its cursor from what the reader holds.
    await page.unroute(`**/api/rooms/${room.id}/events**`);
    await roomsPage.reconnectButton.click();
    await expect(roomsPage.stalledNotice).toBeHidden();
    await expect(roomsPage.entry('said while the stream was down')).toBeVisible({
      timeout: SERVER_ROUND_TRIP_MS,
    });

    // And the room is live again for anything posted after the reconnect.
    await roomsApi.postEntries(room.id, ['said after reconnecting']);
    await expect(roomsPage.entries).toHaveCount(3, { timeout: SERVER_ROUND_TRIP_MS });
    await expect(roomsPage.entry('said after reconnecting')).toBeVisible();
  });
});
