import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from '../../../fixtures';
import { SERVER_ROUND_TRIP_MS, type SeededRoom } from '../../../fixtures/rooms-api';
import { RoomsPage } from '../../../pages/RoomsPage';
import { BasePage } from '../../../pages/BasePage';

/**
 * Reviewing an agent's work on a room's canvas, and merging it (spec
 * `canvas-agent-seat` §8, task 3.2).
 *
 * **This is the leg nothing below it can stand in for.** The unit suites cover
 * which rows qualify, who is offered the merge and what the write does. What
 * only a browser can show is the flow: a real diff of a real working copy
 * against a real `main`, rendered by the real CodeMirror merge view, with a real
 * merge behind the button — and one line in the room afterwards, with nobody's
 * turn started by it.
 *
 * **Why the test-mode leg.** The diff document has to be opened from INSIDE a
 * turn, because that is the only path that labels a document with the tree the
 * turn was standing in. On the cockpit leg that turn would be a billable
 * claude-code turn on whatever `claude` sign-in the machine has, so
 * {@link requireTestModeLeg} makes the leg a check rather than a hope.
 *
 * **And why the commit comes through a test route.** An agent's working copy is
 * written by the agent, with its own shell, and the test-mode runtime has no
 * shell — so without `POST /api/test/room-worktree-commit` there is no work to
 * review, and the surface this spec is about never appears.
 */

/** The scenario that opens a review of one of the room's files from inside a turn. */
const OPENS_DIFF = 'rooms-open-diff';

/** The file the scenario reviews. Must match `ROOM_DIFF_PATH` in the scenario. */
const DIFF_PATH = 'src/app.txt';

/** What the room's own copy holds. */
const ROOM_TEXT = 'one\ntwo\nthree\n';

/** What the agent's copy holds — one line different, so there is one hunk. */
const AGENT_TEXT = 'one\ntwo and a half\nthree\n';

/**
 * Refuse to run anywhere but the test-mode leg, and put the runtime back to a
 * known state.
 *
 * @param request - The test's API context.
 */
async function requireTestModeLeg(request: APIRequestContext): Promise<void> {
  const res = await request.post('/api/test/reset');
  if (res.status() === 404) {
    throw new Error(
      'This spec is running against a leg with no TestModeRuntime. It un-silences a room agent, ' +
        'so on the cockpit leg it would start a real, billable claude-code turn. ' +
        'Run it in the `chromium-rooms-agents` project.'
    );
  }
  if (!res.ok()) throw new Error(`Could not reset the test-mode runtime: ${await res.text()}`);
}

/**
 * Install a scenario and prove it took — the scenario store is server-global.
 *
 * @param request - The test's API context.
 * @param name - The scenario to install.
 */
async function useScenario(request: APIRequestContext, name: string): Promise<void> {
  const res = await request.post('/api/test/scenario', { data: { name } });
  if (!res.ok()) throw new Error(`Could not set the scenario to ${name}: ${await res.text()}`);
  const { scenario } = (await res.json()) as { scenario?: string };
  if (scenario !== name) {
    throw new Error(`Asked for '${name}' and the server acknowledged '${scenario}'.`);
  }
}

/**
 * The author id of a room's one agent seat, with that seat set to answer.
 *
 * @param roomsApi - The seeding fixture, which owns the membership write.
 * @param room - The room whose roster to read.
 * @param name - The agent's display name.
 */
async function seatThatAnswers(
  roomsApi: { setResponseMode: (r: string, a: string, m: string) => Promise<void> },
  room: SeededRoom,
  name: string
): Promise<string> {
  const seat = room.members.find((member) => member.author.displayName === name);
  if (!seat) throw new Error(`${name} is not on ${room.id}'s roster`);
  await roomsApi.setResponseMode(room.id, seat.author.id, 'always');
  return seat.author.id;
}

/**
 * Open a room and wait until it is really on screen.
 *
 * @param page - The browser page.
 * @param basePage - The app-ready barrier.
 * @param roomsPage - The room page object.
 * @param roomId - The room to open.
 */
async function openRoom(
  page: Page,
  basePage: BasePage,
  roomsPage: RoomsPage,
  roomId: string
): Promise<void> {
  await page.goto(`/channels?id=${roomId}`);
  await basePage.waitForAppReady();
  await expect(roomsPage.roomHeader).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });
}

// Serial: this writes the server-global scenario store, and a neighbour running
// beside it would answer with a runtime it did not choose.
test.describe.configure({ mode: 'serial', timeout: 180_000 });

test.describe('Reviewing an agent’s work from the room’s canvas', () => {
  test.beforeEach(async ({ request }) => {
    await requireTestModeLeg(request);
  });

  test.afterEach(async ({ request }) => {
    await request.post('/api/test/finish-turn').catch(() => {});
    await useScenario(request, 'simple-text').catch(() => {});
  });

  test('the operator merges an agent’s work from the diff, and the room gets one line', async ({
    page,
    basePage,
    roomsApi,
    roomsPage,
    request,
  }) => {
    const tag = roomsApi.runId;
    const name = `Builder${tag}`;
    const agent = await roomsApi.registerAgent(name, '🔧', '#7c3aed');
    const room = await roomsApi.createChannel(`merge-${tag}`, `Merge ${tag}`, [agent]);
    const seat = await seatThatAnswers(roomsApi, room, name);
    await roomsApi.enableRepo(room.id, { [DIFF_PATH]: ROOM_TEXT });

    // The work to review: one commit in the agent's OWN copy, so the room's
    // repo status reports it one ahead and the document lands labelled as such.
    const committed = await request.post('/api/test/room-worktree-commit', {
      data: {
        roomId: room.id,
        agentPath: agent.path,
        path: DIFF_PATH,
        text: AGENT_TEXT,
        message: 'Rewrite the middle line',
      },
    });
    expect(committed.ok(), await committed.text()).toBe(true);

    // Now the turn that puts the review on the table. It runs in that same copy,
    // which is what labels the document with it.
    await useScenario(request, OPENS_DIFF);
    await roomsApi.postEntries(room.id, [`take a look ${tag}`]);
    await roomsApi.waitForEntry(
      room.id,
      (entry) => entry.authorId === seat,
      `an answer from ${name}`
    );

    await openRoom(page, basePage, roomsPage, room.id);
    await roomsPage.openCanvasTab();

    // The review surface, not the "this file is somewhere you cannot read" card.
    const merge = page.getByRole('button', { name: /merge into the room/i });
    await expect(merge).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });

    await merge.click();
    const summary = page.getByRole('textbox', { name: /what this work does/i });
    await expect(summary).toBeVisible();
    await summary.fill(`Rewrite the middle line ${tag}`);
    await page.getByRole('button', { name: /^merge$/i }).click();

    // One line in the room's log, saying what landed.
    await roomsApi.waitForEntry(
      room.id,
      (entry) => entry.body.text.includes(`Rewrite the middle line ${tag}`),
      'the merge line'
    );
    const merged = await roomsApi.readRoomFile(room.id, DIFF_PATH);
    expect(merged, 'the room’s own copy now holds the agent’s work').toBe(AGENT_TEXT);

    // **And nobody was woken.** A merge is news about files, not a question, so
    // the only entries after it are the one line itself.
    const entries = await roomsApi.listEntries(room.id, 50);
    const afterMerge = entries.filter((entry) =>
      entry.body.text.includes(`Rewrite the middle line ${tag}`)
    );
    expect(afterMerge).toHaveLength(1);
    expect(
      entries.filter((entry) => entry.authorId === seat && entry.body.text.includes('Put the diff'))
    ).toHaveLength(1);
  });
});
