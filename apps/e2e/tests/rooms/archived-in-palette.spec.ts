import { test, expect } from '../../fixtures';
import { visibleText } from '../../pages/RoomsPage';
import { SERVER_ROUND_TRIP_MS } from '../../fixtures/rooms-api';
import { openCommandPalette } from '../../pages/command-palette';
import { openCockpit } from './open-cockpit';

// Shares one server and one room list with its neighbours, like every spec in
// this folder, so it runs one at a time with a ceiling sized for a machine
// several worktrees deep in concurrent agents.
test.describe.configure({ mode: 'default', timeout: 90_000 });

/**
 * Archived rows in the command palette (P3 AC-5), in a browser.
 *
 * The unit tests settle the rule and the ordering. Two things here cannot be
 * settled anywhere else. **What the row is CALLED** is a claim about the
 * accessibility tree, and this programme has shipped two defects that were
 * green in jsdom and obvious the moment a browser computed a name (`# #general`
 * and a doubled unread count, DOR-583). **Position** is a claim about a painted
 * list, and jsdom paints nothing — every element there is 0×0.
 *
 * The archived channel is seeded SECOND and posted into LAST, so it is the more
 * recently active of the two AND the one with something unread. Recency and
 * unread would both put it on top; only the archived rule can put it under.
 *
 * No Claude SDK or API key: rooms are seeded over REST and every seeded agent
 * is silent, so nothing here can trigger an agent turn.
 */
test.describe('Archived rows in the command palette @smoke', () => {
  test('labels a closed channel, names it once, and keeps it under a live one', async ({
    page,
    basePage,
    roomsApi,
  }) => {
    const liveSlug = `arc-live-${roomsApi.runId}`;
    const shutSlug = `arc-shut-${roomsApi.runId}`;

    const live = await roomsApi.createChannel(liveSlug);
    await roomsApi.postEntries(live.id, ['still going']);

    // Louder and fresher than the live one on every signal the ranker reads.
    const shut = await roomsApi.createChannel(shutSlug);
    await roomsApi.postEntries(shut.id, ['one', 'two', 'three']);
    await roomsApi.archive(shut.id);

    await openCockpit(basePage);
    const palette = await openCommandPalette(page);

    // Scoped to this run's channels, so neighbouring specs' rooms cannot decide
    // what is on screen. `#` alone would list the whole shared server.
    await palette.input.fill(`#arc-`);

    const shutRow = palette.options.filter({ hasText: shutSlug }).first();
    const liveRow = palette.options.filter({ hasText: liveSlug }).first();
    await expect(shutRow).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    await expect(liveRow).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });

    // 1. Exactly one row in the whole palette carries the mark, and the live
    //    channel beside it is not it. `toHaveCount(1)` rather than "the shut
    //    row has one": a mark stamped on every row would satisfy the positive
    //    on its own, and the list is filtered to this run's two channels so the
    //    count is this test's to own. Assertion 2 below names WHICH row it is.
    //    Through the page object's locator, so the mark has one handle.
    await expect(palette.archivedMarks).toHaveCount(1);
    await expect(liveRow).not.toContainText('Archived');

    // 2. The whole announced name, not a substring: `toContainText` would be
    //    satisfied by "#slug Archived in #slug", which is the DOR-583 shape.
    //    The `#` is drawn as a mark, so the visible run must not repeat it.
    await expect(shutRow).toHaveAccessibleName(`#${shutSlug} Archived 3 unread`);
    expect(await visibleText(shutRow)).toBe(`${shutSlug} Archived 3`);

    // 3. Under the live channel, though it is both fresher and unread.
    const [shutTop, liveTop] = await shutRow.evaluate(
      (shutEl, liveEl) => [shutEl.getBoundingClientRect().y, liveEl!.getBoundingClientRect().y],
      await liveRow.elementHandle()
    );
    expect(shutTop).toBeGreaterThan(liveTop!);
  });

  test('hands the words to message search, from a closed channel like any other', async ({
    page,
    basePage,
    roomsApi,
  }) => {
    // P3 AC-6, in the shipping app. This case used to assert the hand-off row
    // was ABSENT — "there is no surface to hand off to" — and that premise held
    // only while nothing answered ⌘⇧F. `MessageSearchDialog` answers it now
    // (DOR-685), so the claim inverts rather than relaxes: the row is offered,
    // it says what it would look for, and it carries the words across. What the
    // old assertion was really guarding is still guarded below — a row that
    // opened an empty box, or lost the query on the way, is the same dead end.
    //
    // The channel is ARCHIVED because that is this file's subject. Closing a
    // channel does not close the question of what was said in it, and the
    // search box includes archived rooms for exactly that reason
    // (`MessageSearchDialog`) — so the hand-off must be offered here too.
    const slug = `arc-hand-${roomsApi.runId}`;
    const room = await roomsApi.createChannel(slug);
    await roomsApi.postEntries(room.id, ['hello']);
    await roomsApi.archive(room.id);

    await openCockpit(basePage);
    const palette = await openCommandPalette(page);
    await palette.input.fill(slug);

    // The positive anchor: this query DID answer, and what it answered with is
    // the closed channel — so everything below is about the hand-off rather
    // than about a palette that never rendered.
    //
    // Taken from `results` rather than `options`, and that is the difference
    // between an anchor and a tautology: the input holds the bare slug, so the
    // hand-off row draws the slug too. On `options` this `.first()` would match
    // the hand-off the day the channel stopped being findable, and the anchor
    // would go on passing while the thing it anchors had vanished.
    const archivedRow = palette.results.filter({ hasText: slug }).first();
    await expect(archivedRow).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
    await expect(archivedRow).toContainText('Archived');

    // 1. One row, saying what it would go and look for.
    await expect(palette.searchHandoff).toHaveCount(1);
    await expect(palette.searchHandoff).toContainText(slug);

    // 2. Under the channel, because it is not a result and is never promoted.
    //    Measured as painted position — this file's whole reason for being in a
    //    browser — and both tops come out of ONE evaluate so a re-render
    //    between two reads cannot invert the comparison.
    const [handoffTop, rowTop] = await palette.searchHandoff.evaluate(
      (handoffEl, rowEl) => [handoffEl.getBoundingClientRect().y, rowEl!.getBoundingClientRect().y],
      await archivedRow.elementHandle()
    );
    expect(handoffTop).toBeGreaterThan(rowTop!);

    // 3. And it goes somewhere: the palette leaves, the search box arrives
    //    HOLDING the words. Asserted as the box's value rather than as "a
    //    dialog opened", because a hand-off that dropped the query on the way
    //    would open the same dialog and answer nobody.
    await palette.searchHandoff.click();
    // The palette is gone, asserted through its own input rather than through
    // `[cmdk-root]`: the search box that replaces it is a cmdk root too, so a
    // count on the root can never reach zero and would fail a hand-off that
    // worked perfectly.
    await expect(palette.input).toHaveCount(0);
    await expect(page.getByTestId('message-search-dialog')).toBeVisible({
      timeout: SERVER_ROUND_TRIP_MS,
    });
    await expect(page.getByTestId('message-search-input')).toHaveValue(slug);
  });
});
