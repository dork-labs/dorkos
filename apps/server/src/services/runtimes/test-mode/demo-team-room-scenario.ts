/**
 * The #team conversation the product-capture pipeline films for the
 * `team-room` shot (`apps/e2e/capture/surfaces-desktop-team.ts`).
 *
 * The capture posts one question in #team as the person, addressed to three
 * agents; each of them answers through a real room turn running this scenario.
 * Nothing is written into the room from outside: an agent-authored entry can
 * only exist as the output of a turn the room dispatcher ran, and every answer
 * here goes through {@link sayInRoom}, the real `rooms.post` capability, under
 * the turn's own agent identity.
 *
 * **What each agent says is chosen by who is answering**, read from the room's
 * author registry for `MessageOpts.roomTurn.authorId` — never guessed. An agent
 * this scenario has no line for says nothing, which in a turn nobody directly
 * asked leaves the room unchanged.
 *
 * **Answers land in a fixed order.** Each agent's turn runs at the same time
 * (the dispatcher claims per room and agent), so a reply waits until the one
 * before it is in the room, then posts after a short beat. The wait is bounded:
 * if the earlier reply never comes, this one still posts, rather than leaving a
 * person who asked with nothing.
 *
 * **A refused answer fails the turn.** {@link sayInRoom} reports a refusal
 * rather than throwing; this scenario throws it, so the turn ends in an error
 * the room reports, and nothing claims an answer that never landed.
 *
 * **Each agent answers once.** One agent's post can open another turn for an
 * agent who was just talking (the engaged window). A turn that finds its own
 * line already in the room stays quiet, so the conversation never repeats.
 *
 * Reachable only when `DORKOS_TEST_RUNTIME=true` registers the test-mode
 * runtime, and only by selecting it through `POST /api/test/scenario`.
 *
 * @module services/runtimes/test-mode/demo-team-room-scenario
 */
import type { StreamEvent } from '@dorkos/shared/types';
import { getRoomService } from '../../rooms/index.js';
import { DEMO_MODEL, DEMO_SESSION_ID } from './demo-scenario-shared.js';
import { sayInRoom } from './room-reply-scenarios.js';
import type { ScenarioFn } from './scenario-store.js';

/** The scenario key the capture selects. */
export const DEMO_TEAM_ROOM_SCENARIO = 'demo-team-room';

/**
 * Who answers, in the order their replies land, and what each one says.
 *
 * Keyed by the agent's display name, the one stable thing a room author carries
 * that the capture fleet also pins (`FLEET` in `apps/e2e/capture/config.ts`).
 */
export const TEAM_ROOM_REPLIES: readonly { agent: string; text: string }[] = [
  {
    agent: 'Lens',
    text: 'Mostly. I reviewed the checkout changes and both fixes are in. All 214 tests pass.',
  },
  {
    agent: 'Forge',
    text: 'The release build is ready, and the download page is set up in preview.',
  },
  {
    agent: 'Sentinel',
    text: 'One blocker: the payment webhook accepts unsigned requests. My fix is ready for your review.',
  },
];

/** Pause before an answer posts, so replies arrive like people typing, not a burst. */
const REPLY_BEAT_MS = 900;

/** How often a reply checks whether the one before it has landed. */
const ORDER_POLL_MS = 250;

/** How many checks a reply makes before posting anyway (about 15 seconds). */
const ORDER_POLL_LIMIT = 60;

/**
 * Whether the room already holds a post with exactly this text, optionally from
 * one author.
 *
 * @param roomId - The room to read.
 * @param text - The exact text to look for.
 * @param authorId - Only count posts by this author, when given.
 */
function roomHasPost(roomId: string, text: string, authorId?: string): boolean {
  return getRoomService()
    .entriesAfter(roomId, 0)
    .some(
      (entry) =>
        entry.kind === 'post' &&
        entry.body.text === text &&
        (authorId === undefined || entry.authorId === authorId)
    );
}

/**
 * One agent's answer in the #team conversation.
 *
 * Outside a room turn it ends at once, having said nothing.
 */
const demoTeamRoom: ScenarioFn = async function* (_content, ctx, opts) {
  yield {
    type: 'session_status',
    data: { sessionId: DEMO_SESSION_ID, model: DEMO_MODEL },
  } as StreamEvent;

  const roomTurn = opts?.roomTurn;
  const author = roomTurn ? getRoomService().authorRegistry.getById(roomTurn.authorId) : null;
  const index = TEAM_ROOM_REPLIES.findIndex((reply) => reply.agent === author?.displayName);
  const reply = index === -1 ? undefined : TEAM_ROOM_REPLIES[index];

  if (roomTurn && reply && !roomHasPost(roomTurn.roomId, reply.text, roomTurn.authorId)) {
    const before = index > 0 ? TEAM_ROOM_REPLIES[index - 1] : undefined;
    for (let poll = 0; before && poll < ORDER_POLL_LIMIT && !ctx.signal.aborted; poll += 1) {
      if (roomHasPost(roomTurn.roomId, before.text)) break;
      await ctx.delay(ORDER_POLL_MS);
    }
    await ctx.delay(REPLY_BEAT_MS);
    const said = await sayInRoom(opts, reply.text);
    // A refused post must not read as an answer: the turn fails, the room
    // reports it, and the capture's check of the conversation skips the shot.
    if (said !== true) {
      throw new Error(
        `${reply.agent} could not answer in the room: ${said === false ? 'not a room turn' : said}`
      );
    }
    yield { type: 'text_delta', data: { text: reply.text } } as StreamEvent;
  }

  yield { type: 'done', data: { sessionId: DEMO_SESSION_ID } } as StreamEvent;
};

/** The #team conversation scenario, keyed by the name `POST /api/test/scenario` accepts. */
export const DEMO_TEAM_ROOM_SCENARIOS: Record<string, ScenarioFn> = {
  [DEMO_TEAM_ROOM_SCENARIO]: demoTeamRoom,
};
