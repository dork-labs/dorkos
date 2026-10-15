import type { Page } from '@playwright/test';
import { API_URL, type Theme } from './config.js';
import type { RunRecorder } from './library.js';
import { patch, post, shoot, sleep, url, waitForAppShell, WAIT_MS } from './lib.js';

/**
 * The `team-room` drive: #team, the room the app opens on, holding a short
 * conversation between the person and three agents.
 *
 * **Every message is real.** The person's question goes in through the same
 * `POST /api/rooms/:id/entries` the composer sends. Each answer is the output
 * of a room turn the dispatcher ran for that agent, on the test-mode runtime's
 * `demo-team-room` scenario, which posts through the real `rooms.post`
 * capability under the agent's own identity
 * (`apps/server/src/services/runtimes/test-mode/demo-team-room-scenario.ts`).
 * Nothing is written into the room's log from outside, and nothing on screen is
 * edited.
 *
 * Split out of `surfaces-desktop.ts` like the power, fleet and rooms drives:
 * it owns its own setup (a scenario, a post, a wait for three turns) and nothing
 * else reads it.
 *
 * @module capture/surfaces-desktop-team
 */

/** The name the person's messages carry, the same one the `room-files` shot uses. */
const PERSON_NAME = 'Dorian';

/** The scenario every agent's room turn runs while this drive is in charge. */
const TEAM_ROOM_SCENARIO = 'demo-team-room';

/** The scenario the stack goes back to afterwards, the test-mode default. */
const DEFAULT_SCENARIO = 'simple-text';

/**
 * The agents asked, by display name, in the order their answers land. Their
 * words are pinned in the server scenario, keyed by the same names.
 */
const ASKED_AGENTS: readonly string[] = ['Lens', 'Forge', 'Sentinel'];

/** What the person asks. The `@` handles are read from the room's roster and put in front. */
const QUESTION = 'Morning! Are we still on track to launch on Friday?';

/** How long to wait for all three answers. Each one is a real turn, paced a beat apart. */
const ANSWERS_WAIT_MS = 45_000;

/** One member of a room, as the roster reports it. */
interface RosterMember {
  author: { id: string; kind: string; displayName: string; handle: string | null };
}

/** One entry in a room's history. */
interface RoomEntry {
  seq: number;
  authorId: string;
  kind: string;
  body: { text?: string };
}

/** GET JSON from the capture server, throwing on a non-2xx response. */
async function getJson<T>(pathname: string): Promise<T> {
  const res = await fetch(`${API_URL}${pathname}`);
  if (!res.ok) throw new Error(`GET ${pathname} → ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

/** The id of #team, found by its well-known key rather than its name. */
async function teamRoomId(): Promise<string> {
  const { rooms } = await getJson<{ rooms: { id: string; wellKnown?: string | null }[] }>(
    '/api/rooms'
  );
  const team = rooms.find((room) => room.wellKnown === 'team');
  if (!team) throw new Error('#team is not on this install');
  return team.id;
}

/** Every entry in a room, posts and notices, oldest first. */
async function roomEntries(roomId: string): Promise<RoomEntry[]> {
  const { entries } = await getJson<{ entries: RoomEntry[] }>(
    `/api/rooms/${roomId}/entries?limit=200`
  );
  return entries;
}

/** The posts in a room, oldest first. */
async function roomPosts(roomId: string): Promise<RoomEntry[]> {
  return (await roomEntries(roomId)).filter((entry) => entry.kind === 'post');
}

/**
 * The asked agents' author ids and `@` handles, in {@link ASKED_AGENTS} order.
 * Fails loudly when one is missing from the roster or cannot be addressed.
 */
async function askedMembers(roomId: string): Promise<{ id: string; handle: string }[]> {
  const room = await getJson<{ members: RosterMember[] }>(`/api/rooms/${roomId}`);
  return ASKED_AGENTS.map((name) => {
    const member = room.members.find(
      (m) => m.author.kind === 'agent' && m.author.displayName === name
    );
    if (!member?.author.handle) {
      throw new Error(`${name} is not an addressable member of #team`);
    }
    return { id: member.author.id, handle: member.author.handle };
  });
}

/**
 * How long the room must stay unchanged, with nobody working, before the
 * conversation counts as over. One agent's answer can open a short follow-up
 * turn for an agent who was just talking (the engaged window); the scenario
 * keeps those quiet, and this waits them out before the scenario is put back.
 */
const QUIET_MS = 4_000;

/**
 * What the room on screen says is still going on, or `null` when nobody is
 * working here: no "… working on it" line, and the run chip (when there is
 * one) idle. The chip is always mounted and only faded while idle, so it is
 * read from `data-idle`, not visibility.
 */
async function roomActivity(page: Page): Promise<string | null> {
  const presence = page.getByTestId('room-presence');
  if (await presence.isVisible()) return `the room says "${await presence.innerText()}"`;
  const runState = page.getByTestId('room-run-state').first();
  if ((await runState.count()) === 0) return null;
  if ((await runState.getAttribute('data-idle')) === 'true') return null;
  return `the run chip counts ${(await runState.innerText()).replace(/\D+/g, ' ').trim()} working`;
}

/**
 * Wait until every asked agent has answered and the room has then stayed
 * quiet for {@link QUIET_MS}: no new entry, nobody working. On a timeout the
 * error names what was still going on, so a skipped shot says why.
 */
async function waitForConversationToSettle(
  page: Page,
  roomId: string,
  askedIds: ReadonlySet<string>
): Promise<void> {
  const deadline = Date.now() + ANSWERS_WAIT_MS;
  let lastCount = -1;
  let quietSince = Date.now();
  for (;;) {
    const entries = await roomEntries(roomId);
    const answered = new Set(
      entries.filter((e) => e.kind === 'post' && askedIds.has(e.authorId)).map((e) => e.authorId)
    );
    const activity = await roomActivity(page);
    if (entries.length !== lastCount || activity !== null) {
      lastCount = entries.length;
      quietSince = Date.now();
    }
    if (answered.size === askedIds.size && Date.now() - quietSince >= QUIET_MS) return;
    if (Date.now() > deadline) {
      const still =
        activity ?? `the room changed ${Math.round((Date.now() - quietSince) / 1000)}s ago`;
      throw new Error(
        `#team did not settle: ${answered.size} of ${askedIds.size} agents answered, and ${still}`
      );
    }
    await sleep(250);
  }
}

/**
 * Check the conversation that will be on film: after the question, exactly one
 * post from each asked agent, in {@link ASKED_AGENTS} order, and nothing else —
 * no notice (a failed or refused turn), no second answer. Throws otherwise, so
 * the shot is skipped and reported rather than shipped.
 */
async function assertConversation(
  roomId: string,
  question: string,
  members: readonly { id: string; handle: string }[]
): Promise<void> {
  const entries = await roomEntries(roomId);
  const asked = entries.find((e) => e.kind === 'post' && e.body.text === question);
  if (!asked) throw new Error('#team: the question is not in the room');
  const after = entries.filter((e) => e.seq > asked.seq);
  const notices = after.filter((e) => e.kind !== 'post');
  if (notices.length > 0) {
    throw new Error(
      `#team: ${notices.length} notice(s) after the question: ${notices.map((e) => JSON.stringify(e.body.text ?? '')).join(', ')}`
    );
  }
  const authors = after.map((e) => e.authorId);
  const expected = members.map((m) => m.id);
  if (authors.join(',') !== expected.join(',')) {
    const names = new Map(members.map((m, i) => [m.id, ASKED_AGENTS[i]!]));
    const said = authors.map((id) => names.get(id) ?? id).join(' → ') || 'nobody';
    throw new Error(`#team: expected ${ASKED_AGENTS.join(' → ')} to answer once each, got ${said}`);
  }
}

/**
 * Hold the conversation in #team once per stack: the person asks, and each
 * asked agent answers through its own room turn. The scenario stays selected
 * until the room has settled, so any follow-up turn still runs it (and stays
 * quiet) rather than the default. A second call finds the question already
 * there, checks the conversation, and returns.
 */
async function holdTeamConversation(page: Page, roomId: string): Promise<void> {
  const members = await askedMembers(roomId);
  const question = `${members.map((m) => `@${m.handle}`).join(' ')} ${QUESTION}`;
  // A second call films what the first one left, so it checks that too: a
  // conversation a failed first attempt broke is never shot.
  if ((await roomPosts(roomId)).some((entry) => entry.body.text === question)) {
    await assertConversation(roomId, question, members);
    return;
  }

  await patch('/api/config', { profile: { displayName: PERSON_NAME } });
  const selected = await post('/api/test/scenario', { name: TEAM_ROOM_SCENARIO });
  if (!selected.ok) throw new Error(`Could not select ${TEAM_ROOM_SCENARIO}`);
  try {
    const posted = await post(`/api/rooms/${roomId}/entries`, { text: question });
    if (posted.status !== 202) {
      throw new Error(`Posting in #team answered ${posted.status}: ${await posted.text()}`);
    }
    await waitForConversationToSettle(page, roomId, new Set(members.map((m) => m.id)));
  } finally {
    await post('/api/test/scenario', { name: DEFAULT_SCENARIO });
  }
  await assertConversation(roomId, question, members);
}

/**
 * Capture #team: the person's question and three agents' answers, settled,
 * with nothing still working.
 */
export async function shootTeamRoom(page: Page, theme: Theme, rec: RunRecorder): Promise<void> {
  const roomId = await teamRoomId();
  await page.goto(url('/'));
  await waitForAppShell(page);
  await page.waitForSelector('[data-testid="home-composer"]', { timeout: WAIT_MS });
  await holdTeamConversation(page, roomId);

  const posts = await roomPosts(roomId);
  const lastAnswer = posts[posts.length - 1]?.body.text;
  if (!lastAnswer) throw new Error('#team has no messages to show');
  await page.getByText(lastAnswer, { exact: false }).first().waitFor({ timeout: WAIT_MS });
  // The "while you were away" card reports the seeded sessions, not this
  // conversation. Dismissed the way a person would, so the room is in view.
  const awayCard = page.getByText(/^While you were away/).first();
  if (await awayCard.isVisible()) {
    // The innermost box holding both the card's title and its own Dismiss, so
    // no other card's close button is the one pressed.
    const dismiss = page.getByRole('button', { name: 'Dismiss' });
    await page
      .locator('div')
      .filter({ has: awayCard })
      .filter({ has: dismiss })
      .last()
      .getByRole('button', { name: 'Dismiss' })
      .click({ timeout: WAIT_MS });
    await awayCard.waitFor({ state: 'hidden', timeout: WAIT_MS });
  }
  // Nobody still working: the conversation is over, not mid-reply. And the
  // lane's past-tense "finished, nothing to add" line, left by a follow-up turn
  // that rightly stayed quiet, has faded on its own clock (8s), so the room's
  // last word on screen is the answers.
  await page.getByTestId('room-presence').waitFor({ state: 'hidden', timeout: WAIT_MS });
  await page.getByTestId('lane-silent-finish').waitFor({ state: 'hidden', timeout: WAIT_MS });
  await shoot(page, 'team-room', theme, rec);
}
