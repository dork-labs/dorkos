/**
 * Message search, end to end (spec `specs/message-search/` §8, DOR-685).
 *
 * **Why this can be deterministic at all.** The room write-through indexes an
 * entry inside `RoomService.publishEntry`, synchronously, before the POST
 * returns — so `postEntries` resolving is a hard barrier and there is no
 * five-minute reconciler wait to poll around. No agent is ever seeded here, so
 * no model is reached and nothing is billed.
 *
 * **What this spec deliberately does NOT assert**, per `apps/e2e/GOTCHAS.md`:
 * result counts, "the first result", or emptiness. The suite shares one server
 * and the operator's search scope is every room on it, so a neighbouring test's
 * channel may legitimately be in any list. Every seeded entry therefore carries
 * this run's `runId`, and the query IS that token — which makes the assertions
 * about rows nobody else could have produced.
 *
 * **What this run's index contains, and what it therefore cannot cover.** Only
 * `rooms`. Every leg of this suite boots with
 * `DORKOS_SEARCH_NO_EXTERNAL_HISTORY=true` (DOR-1551), so the three transcript
 * sources — `claude-code`, `codex`, `opencode` — are dropped from the sweep
 * before it starts. That flag exists because they resolve their roots through
 * the `os.homedir()` carve-outs rather than through `DORK_HOME`, so a throwaway
 * data directory never isolated them: this suite used to full-text-copy the
 * operator's real corpus into `/tmp` on every run, and this spec's own header
 * used to record that as a fact of life.
 *
 * The transcript half was never coverable here anyway, and the gate did not take
 * anything away. It could not be SEEDED: adding a transcript would mean writing
 * JSONL into the operator's own `~/.claude/projects`, which this suite must
 * never do, and asserting against whatever is already there is asserting against
 * a corpus that differs per machine and per day. So it is covered by the
 * client's tests
 * (`apps/client/src/layers/features/command-palette/__tests__/message-search-dialog.test.tsx`)
 * and the server's (`services/search/__tests__/`, which sweeps real fixture
 * trees), not here. **Do not "restore coverage" by dropping the flag** — that
 * indexes a person's history, it does not make anything testable.
 *
 * What IS covered here is the whole room half, end to end through a real
 * browser: the seeded entry is findable the moment `postEntries` resolves, and
 * every assertion is scoped to this run's `runId` token, which nothing else on
 * the server could have produced.
 */
import { test, expect } from '../../fixtures';
import { SERVER_ROUND_TRIP_MS } from '../../fixtures/rooms-api';
import { openCockpit } from '../rooms/open-cockpit';

// One at a time, with a ceiling sized for a machine several worktrees deep in
// concurrent agents — the same posture the rooms specs take for the same reason.
test.describe.configure({ mode: 'default', timeout: 90_000 });

test.describe('Message search', () => {
  test('finds what was said, and opens the channel it was said in', async ({
    page,
    basePage,
    request,
    roomsApi,
  }) => {
    // The one word in the whole index that belongs to this test.
    const token = `zarquon${roomsApi.runId}`;

    const hit = await roomsApi.createChannel(`search-hit-${roomsApi.runId}`);
    const miss = await roomsApi.createChannel(`search-miss-${roomsApi.runId}`);

    await roomsApi.postEntries(hit.id, [`we agreed the ${token} approach would do`]);
    await roomsApi.postEntries(miss.id, ['nothing about that subject in here at all']);

    // The route agrees the index holds it, before the UI is asked anything.
    // Without this, a UI failure and an indexing failure look identical.
    const answer = await request.get(`/api/search?q=${token}&source=rooms`);
    expect(answer.ok()).toBe(true);
    const body = (await answer.json()) as {
      results: { container: string; excerpt: string }[];
    };
    expect(body.results.map((r) => r.container)).toContain(hit.id);
    expect(body.results.map((r) => r.container)).not.toContain(miss.id);

    // Load AFTER seeding: the sidebar learns of a room made while the page is
    // up only from a live event, which would make this a test about a race.
    await openCockpit(basePage);

    // The key a person presses, not a store poke.
    await page.keyboard.press('ControlOrMeta+Shift+F');
    const input = page.getByTestId('message-search-input');
    await expect(input).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });

    await input.fill(token);

    // The row for THIS test's message, found by this test's token. Scoped to
    // the dialog so a neighbour's row cannot satisfy it.
    const dialog = page.getByTestId('message-search-dialog');
    const row = dialog.getByRole('option').filter({ hasText: token });
    await expect(row).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });

    // The match is drawn as a highlight, which is the whole reason the excerpt
    // carries markers rather than plain text.
    await expect(row.locator('mark').filter({ hasText: token })).toBeVisible();

    await row.click();

    // The destination, asserted as a URL — "a navigation happened" is also true
    // of a navigation that went nowhere. Paired with a visible element, because
    // `toHaveURL` races the client router.
    await expect(page).toHaveURL(new RegExp(`/channels\\?id=${hit.id}`), {
      timeout: SERVER_ROUND_TRIP_MS,
    });
    await expect(page.getByTestId('message-search-dialog')).toBeHidden();
  });

  test('says what it cannot see, in one line, before anything is typed', async ({
    page,
    basePage,
  }) => {
    // G4 in the product rather than in the spec: a person must be able to LEARN
    // what search does not cover without reading one. That is a reachability
    // promise, not a reading assignment (DOR-1757) — so the gist is on screen
    // and the rest is one click down. The literal wording is pinned by the
    // client's own test; this asserts only that both halves are really there in
    // a real browser, which a unit test cannot.
    await openCockpit(basePage);

    await page.keyboard.press('ControlOrMeta+Shift+F');
    const dialog = page.getByTestId('message-search-dialog');
    await expect(dialog).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });

    const scopeLine = dialog.getByRole('button', { name: /Searches what was said/ });
    await expect(scopeLine).toBeVisible();
    await expect(dialog.getByText(/Tool output is never searched/)).toBeHidden();

    await scopeLine.click();
    // A fragment the one-line summary does not also carry, so this can only be
    // the revealed detail.
    await expect(dialog.getByText(/take up to five minutes/)).toBeVisible();
    await expect(dialog.getByText(/Tool output is never searched/)).toBeVisible();
  });
});
