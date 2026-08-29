/**
 * The `rooms` suite's tool-only tier — what a room DOES when a turn's own words
 * are not the room's message (spec `tool-only-room-replies` §D13).
 *
 * Six structural cases on `test-mode`. No model, no spend, seconds, and they
 * GATE, exactly like the five in `rooms.ts` beside them. Run them with
 * `pnpm --filter @dorkos/evals run evals -- --suite rooms --tier test-mode`.
 *
 * ## Why these are a file of their own rather than five more in `rooms.ts`
 *
 * Every case here mutates INSTALL-WIDE state before it drives: it turns
 * `rooms.toolOnlyReplies` on, and it selects a scenario that declares itself
 * tool-capable. The in-process tier boots every eval inside one runner process,
 * so both are singletons other cases can see — which is a real hazard rather
 * than a tidiness argument, and it is measured: after the halt case picked
 * `long-turn`, every later case in the run got that scenario's text. Grouping
 * them makes the reset obligation one rule for one file instead of a habit.
 *
 * **Every case here resets both**, in a `finally`, whatever it asserted.
 *
 * ## How a scripted turn "calls the tool"
 *
 * It does not, and it deliberately cannot: a test-mode scenario is handed the
 * message it is answering and nothing else — no room id, no entry id, no
 * capability registry. So the scenarios here HOLD the turn open
 * (`rooms-hold-then-narrate`, `rooms-hold-then-quiet`) and the DRIVER makes the
 * call the injected `dorkos` MCP server would make: a real agent token, the real
 * `rooms.post` capability, the real `RoomService.postFromTool`. What is faked is
 * the model's decision to call it. What is exercised is everything that happens
 * because it did — the claim marks, the mode-conditional DM refusal, the
 * delivery branch, the notice.
 *
 * ## The drill
 *
 * Every oracle here owes a recipe that makes it red. This is the end-to-end one,
 * and it costs nothing:
 *
 * 1. **the seed**: in `apps/server/src/services/rooms/room-trigger.ts`, delete
 *    the `if (reply.replyMode === 'tool-only') return this.deliverToolOnly(opts);`
 *    branch from `deliver` — the flip's whole surface;
 * 2. **the command**:
 *
 *    ```bash
 *    pnpm --filter @dorkos/evals run evals -- --suite rooms --tier test-mode
 *    ```
 *
 * 3. **what to expect**, measured on 2026-08-29 rather than predicted. THREE go
 *    red — `rooms-addressed-silence-writes-one-notice`,
 *    `rooms-ambient-silence-writes-nothing` and
 *    `rooms-reaction-discharges-the-answer` — each on the oracle that says the
 *    turn's own narration never reached the room, and the first of them on its
 *    notice oracle as well. `rooms-text-fallback-when-not-wired` stays GREEN,
 *    which is the half of the result that says these oracles discriminate rather
 *    than failing together: it is the case that asserts the path the seed
 *    restores.
 *
 * **The first run of this drill reddened ONE case, and the other three were
 * fixed because of it.** Two shapes could not fail and both are worth knowing:
 * `agentPostedInRoom` passes when ANY post matches, so "a post without the
 * narration in it" was satisfied by the tool post while the narration landed
 * beside it; and a scenario that produces NO TEXT asserts silence against a path
 * that is silent in both modes. The fixes are `noRoomEntryContains` and the
 * narrating scenario, and they are why every case here drives a turn that WOULD
 * have posted.
 *
 * **Two cases own their own drill, because this seed cannot reach them**, and
 * both are worth stating rather than leaving for a reader to wonder about:
 *
 * - `rooms-dm-tool-post-lands-and-triggers-nobody`. The delivery branch is not
 *   what lets an agent post into a DM — the mode-conditional refusal in
 *   `RoomService.postFromTool` is. Revert `turn?.replyMode !== 'tool-only' &&`
 *   in that guard and re-run; this is the only case that goes red, on its post
 *   oracle, which is §2.6's reversal reproduced end to end.
 * - `rooms-tool-post-is-the-only-reply`. Measured green under the seed above,
 *   and that is CORRECT rather than a hole: a turn that posts through the tool
 *   AND narrates already had its narration suppressed before the flip existed,
 *   by `ActiveClaim.spokeViaTool` (room-participation §10.2, DOR-1202). What the
 *   flip changes for that shape is nothing observable — which is exactly why the
 *   three cases above drive turns that narrate WITHOUT posting. Its own seed is
 *   deleting the `takeSpokeViaTool` consumption from `deliver`; it then fails on
 *   the narration oracle, with two entries where the room should have one.
 *
 * @module evals/suite/rooms-tool-only
 */
import type { EvalCase, RoomScriptResult } from '../types.js';
import {
  finishTestTurns,
  postAsAgent,
  postToRoom,
  reactAsAgent,
  resetTestMode,
  selectTestScenario,
  setToolOnlyReplies,
} from '../runner/room-drive.js';
import {
  agentPostedInRoom,
  agentStayedQuietInRoom,
  noRoomEntryContains,
  observedTurns,
  roomNoticeCount,
  roomTurnRanFor,
} from '../oracles/rooms.js';
import { agentDir, mentionOf, openRoomFor, seedRoomAgents } from './rooms-setup.js';
import type { RoomAgentSpec } from './rooms-setup.js';

/**
 * The one agent every case here seats.
 *
 * `mention-only` for one case and `always` for the ambient one, so each case's
 * trigger is unambiguous — see `rooms.ts` for the full argument.
 */
const ADA: RoomAgentSpec = {
  slug: 'ada',
  displayName: 'Ada',
  description: 'Answers questions about this project in the team channel.',
  responseMode: 'mention-only',
};

/** The same agent, seated to answer everything — the ambient case's shape. */
const ADA_ALWAYS: RoomAgentSpec = { ...ADA, responseMode: 'always' };

/** The scenario that holds a turn open and then narrates a line at the end. */
const NARRATING = 'rooms-hold-then-narrate';

/** The scenario that holds a turn open and then ends having said nothing. */
const QUIET = 'rooms-hold-then-quiet';

/** What {@link NARRATING} says back to its own session. Must never reach a room. */
const NARRATION = 'I looked at it and here is what I think.';

/** How long these cases give the room to settle after the turn is landed. */
const QUIET_MS = 2_500;

/** Hard ceiling on one drive here — a guard against a hang, not a target. */
const TIMEOUT_MS = 60_000;

/**
 * Put the install back the way every other case expects to find it.
 *
 * Both halves matter and both are singletons in the in-process runner: the flag
 * is install-wide config, and the scenario store is a module singleton.
 *
 * @param baseUrl - The running harness server.
 */
async function restore(baseUrl: string): Promise<void> {
  await finishTestTurns({ baseUrl });
  await setToolOnlyReplies({ baseUrl, on: false });
  await resetTestMode({ baseUrl });
}

/**
 * Turn the flip on and select a tool-capable scenario.
 *
 * @param baseUrl - The running harness server.
 * @param scenario - Which held scenario this case drives.
 */
async function arm(baseUrl: string, scenario: string): Promise<void> {
  await setToolOnlyReplies({ baseUrl, on: true });
  await selectTestScenario({ baseUrl, scenario });
}

/**
 * `rooms-tool-post-is-the-only-reply` — the turn posts through the tool AND
 * narrates, and exactly one entry lands.
 *
 * Acceptance criterion 2. The narration is a distinctive sentence, so the
 * assertion is that THAT string is absent rather than that a count is right —
 * a count alone would pass on the wrong entry.
 */
export const roomsToolPostIsTheOnlyReplyCase: EvalCase = {
  id: 'rooms-tool-post-is-the-only-reply',
  title: 'Rooms — a tool-only turn answers with its tool call, and its narration stays private',
  prompt: '',
  runtimeTier: 'test-mode',
  costClass: 'free',
  tags: ['rooms'],
  seed: (sandbox) => seedRoomAgents(sandbox, [ADA]),
  roomScript: async (ctx): Promise<RoomScriptResult> => {
    await arm(ctx.baseUrl, NARRATING);
    const { room, stream } = await openRoomFor(ctx, {
      slug: 'tool-only-reply',
      title: 'Tool only reply',
      agents: [ADA],
      timeoutMs: TIMEOUT_MS,
    });
    try {
      await postToRoom({
        baseUrl: ctx.baseUrl,
        roomId: room.roomId,
        text: `${mentionOf(room, 'ada')} are the release notes ready?`,
      });
      // The turn is held open, so this is mid-turn — exactly where an injected
      // `dorkos` server would make the call.
      // Wait for the working indicator, so the post below is genuinely MID-TURN:
      // that is the whole shape under test, and a post that raced ahead of the
      // claim would carry no turn and exercise none of the marks.
      await stream.settle({
        settleWhen: (collected) => observedTurns(collected).length >= 1,
        quietMs: 500,
      });
      await postAsAgent({
        baseUrl: ctx.baseUrl,
        roomId: room.roomId,
        agentPath: agentDir(ctx.sandbox, 'ada'),
        text: 'Yes — they are ready and I have linked them.',
      });
      await finishTestTurns({ baseUrl: ctx.baseUrl });
      const frames = await stream.settle({ quietMs: QUIET_MS });
      return { frames, room };
    } finally {
      await restore(ctx.baseUrl);
      stream.close();
    }
  },
  oracles: [
    roomTurnRanFor('ada', 'the mentioned agent ran a turn'),
    agentPostedInRoom('ada', {
      matches: (text) => text.includes('they are ready'),
      label: 'the tool post is what landed',
    }),
    // **`agentPostedInRoom` passes when ANY post matches, so it cannot express
    // this**: with the flip removed BOTH the tool post and the narration land,
    // and the tool post satisfies "a post without the narration in it". Measured
    // in the drill — the case stayed green with `deliverToolOnly` deleted. What
    // discriminates is the absence across every entry.
    noRoomEntryContains(NARRATION, 'the turn’s own narration never reached the room'),
    roomNoticeCount('agent_declined', 0, 'a turn that answered earned no "did not reply" line'),
  ],
};

/**
 * `rooms-addressed-silence-writes-one-notice` — a person asked, the turn
 * produced nothing, and the room says so exactly once.
 *
 * Acceptance criterion 4. The floor, not the goal: an agent with nothing useful
 * to say should post one sentence in its own voice (etiquette E21), and this is
 * what happens when it does not.
 */
export const roomsAddressedSilenceWritesOneNoticeCase: EvalCase = {
  id: 'rooms-addressed-silence-writes-one-notice',
  title: 'Rooms — asked and answered with nothing, the room writes one line saying so',
  prompt: '',
  runtimeTier: 'test-mode',
  costClass: 'free',
  tags: ['rooms'],
  seed: (sandbox) => seedRoomAgents(sandbox, [ADA]),
  roomScript: async (ctx): Promise<RoomScriptResult> => {
    await arm(ctx.baseUrl, QUIET);
    const { room, stream } = await openRoomFor(ctx, {
      slug: 'addressed-silence',
      title: 'Addressed silence',
      agents: [ADA],
      timeoutMs: TIMEOUT_MS,
    });
    try {
      await postToRoom({
        baseUrl: ctx.baseUrl,
        roomId: room.roomId,
        text: `${mentionOf(room, 'ada')} are the release notes ready?`,
      });
      await finishTestTurns({ baseUrl: ctx.baseUrl });
      const frames = await stream.settle({ quietMs: QUIET_MS });
      return { frames, room };
    } finally {
      await restore(ctx.baseUrl);
      stream.close();
    }
  },
  oracles: [
    roomTurnRanFor('ada', 'the mentioned agent ran a turn'),
    agentStayedQuietInRoom('ada', { label: 'nothing the turn wrote reached the room' }),
    roomNoticeCount('agent_declined', 1, 'the room wrote exactly one "did not reply" line'),
  ],
};

/**
 * `rooms-ambient-silence-writes-nothing` — nobody asked, so silence costs
 * nothing and leaves no trace.
 *
 * Acceptance criterion 5, and the whole reason the flip is worth having:
 * etiquette E7 says silence must be free, and this is the case that would catch
 * `agent_declined` widening into the ambient half.
 */
export const roomsAmbientSilenceWritesNothingCase: EvalCase = {
  id: 'rooms-ambient-silence-writes-nothing',
  title: 'Rooms — nobody asked, so a quiet turn writes nothing at all',
  prompt: '',
  runtimeTier: 'test-mode',
  costClass: 'free',
  tags: ['rooms'],
  seed: (sandbox) => seedRoomAgents(sandbox, [ADA_ALWAYS]),
  roomScript: async (ctx): Promise<RoomScriptResult> => {
    // **The NARRATING scenario, not the quiet one**, and the difference is what
    // makes this case able to fail. A turn that produces no text posts nothing
    // with the flip on and nothing with it off, so a quiet scenario would assert
    // silence against a path that is silent either way. This turn writes a
    // sentence back to its own session, and the assertion is that the sentence
    // stays there.
    await arm(ctx.baseUrl, NARRATING);
    const { room, stream } = await openRoomFor(ctx, {
      slug: 'ambient-silence',
      title: 'Ambient silence',
      agents: [ADA_ALWAYS],
      timeoutMs: TIMEOUT_MS,
    });
    try {
      // No mention: the agent answers because its mode is `always`, which is the
      // ambient case E7 says must stay free.
      await postToRoom({
        baseUrl: ctx.baseUrl,
        roomId: room.roomId,
        text: 'the deploy finished a minute ago',
      });
      await finishTestTurns({ baseUrl: ctx.baseUrl });
      const frames = await stream.settle({ quietMs: QUIET_MS });
      return { frames, room };
    } finally {
      await restore(ctx.baseUrl);
      stream.close();
    }
  },
  oracles: [
    roomTurnRanFor('ada', 'the agent still ran a turn — it read the room'),
    agentStayedQuietInRoom('ada', { label: 'and posted nothing' }),
    noRoomEntryContains(NARRATION, 'what it wrote back to itself stayed in its own session'),
    roomNoticeCount('agent_declined', 0, 'nobody asked, so the room said nothing about it'),
  ],
};

/**
 * `rooms-reaction-discharges-the-answer` — a reaction is a complete answer.
 *
 * Acceptance criterion 6, and the A-06 case stated as a mechanism: an
 * acknowledgment that only needs "seen" gets an emoji and nothing else, and the
 * room does not then write a line saying nobody replied.
 */
export const roomsReactionDischargesTheAnswerCase: EvalCase = {
  id: 'rooms-reaction-discharges-the-answer',
  title: 'Rooms — a reaction is the whole answer, and earns no "did not reply" line',
  prompt: '',
  runtimeTier: 'test-mode',
  costClass: 'free',
  tags: ['rooms'],
  seed: (sandbox) => seedRoomAgents(sandbox, [ADA]),
  roomScript: async (ctx): Promise<RoomScriptResult> => {
    // The NARRATING scenario for the reason the ambient case uses it: a turn
    // that says nothing would let this pass with the flip removed.
    await arm(ctx.baseUrl, NARRATING);
    const { room, stream } = await openRoomFor(ctx, {
      slug: 'reaction-answers',
      title: 'Reaction answers',
      agents: [ADA],
      timeoutMs: TIMEOUT_MS,
    });
    try {
      const asked = await postToRoom({
        baseUrl: ctx.baseUrl,
        roomId: room.roomId,
        text: `${mentionOf(room, 'ada')} no reply needed, just ack this`,
      });
      // Wait for the working indicator, so the post below is genuinely MID-TURN:
      // that is the whole shape under test, and a post that raced ahead of the
      // claim would carry no turn and exercise none of the marks.
      await stream.settle({
        settleWhen: (collected) => observedTurns(collected).length >= 1,
        quietMs: 500,
      });
      await reactAsAgent({
        baseUrl: ctx.baseUrl,
        roomId: room.roomId,
        entryId: asked.entryId,
        agentPath: agentDir(ctx.sandbox, 'ada'),
        emoji: '✅',
      });
      await finishTestTurns({ baseUrl: ctx.baseUrl });
      const frames = await stream.settle({ quietMs: QUIET_MS });
      return { frames, room };
    } finally {
      await restore(ctx.baseUrl);
      stream.close();
    }
  },
  oracles: [
    roomTurnRanFor('ada', 'the mentioned agent ran a turn'),
    agentStayedQuietInRoom('ada', { label: 'and said nothing beyond the reaction' }),
    noRoomEntryContains(
      NARRATION,
      'the "Done — acknowledged." shape is gone: nothing followed the reaction'
    ),
    roomNoticeCount('agent_declined', 0, 'the reaction discharged the obligation'),
  ],
};

/**
 * `rooms-dm-tool-post-lands-and-triggers-nobody` — the §2.6 reversal, and the
 * loop protection that makes it safe.
 *
 * Acceptance criteria 8 and 9. The post landing is the reversal; the SECOND turn
 * not running is ADR `260814-025326` holding — an agent's post outside a channel
 * addresses only the members it NAMES, and the person is filtered by kind
 * anyway, so `selectTriggerTargets` returns `[]`.
 */
export const roomsDmToolPostLandsAndTriggersNobodyCase: EvalCase = {
  id: 'rooms-dm-tool-post-lands-and-triggers-nobody',
  title: 'Rooms — an agent answers a direct message with the tool, and nothing re-triggers',
  prompt: '',
  runtimeTier: 'test-mode',
  costClass: 'free',
  tags: ['rooms'],
  seed: (sandbox) => seedRoomAgents(sandbox, [ADA_ALWAYS]),
  roomScript: async (ctx): Promise<RoomScriptResult> => {
    await arm(ctx.baseUrl, QUIET);
    const { room, stream } = await openRoomFor(ctx, {
      slug: 'dm-tool-post',
      title: 'DM tool post',
      agents: [ADA_ALWAYS],
      kind: 'dm',
      timeoutMs: TIMEOUT_MS,
    });
    try {
      await postToRoom({
        baseUrl: ctx.baseUrl,
        roomId: room.roomId,
        text: 'are the release notes ready?',
      });
      // Wait for the working indicator, so the post below is genuinely MID-TURN:
      // that is the whole shape under test, and a post that raced ahead of the
      // claim would carry no turn and exercise none of the marks.
      await stream.settle({
        settleWhen: (collected) => observedTurns(collected).length >= 1,
        quietMs: 500,
      });
      await postAsAgent({
        baseUrl: ctx.baseUrl,
        roomId: room.roomId,
        agentPath: agentDir(ctx.sandbox, 'ada'),
        text: 'Yes — ready, and linked.',
      });
      await finishTestTurns({ baseUrl: ctx.baseUrl });
      const frames = await stream.settle({ quietMs: QUIET_MS });
      return { frames, room };
    } finally {
      await restore(ctx.baseUrl);
      stream.close();
    }
  },
  oracles: [
    agentPostedInRoom('ada', {
      matches: (text) => text.includes('ready, and linked'),
      label: 'the tool post landed in the direct message',
    }),
    roomNoticeCount('agent_declined', 0, 'the agent answered, so nothing said it had not'),
  ],
};

/**
 * `rooms-text-fallback-when-not-wired` — the flag is on and the session is NOT
 * tool-capable, so the turn's text posts exactly as it always did.
 *
 * **The discriminator, and the case that makes the other five mean something.**
 * Without it a run could go green with the flip suppressing everything
 * unconditionally, which is the mute state the whole design is arranged around:
 * `/mcp` behind `requireMcpEnabled`, and a 30-day token fuse, both reach a
 * session that cannot post, and failing closed in either would leave an agent
 * silently mute in every room.
 *
 * It selects NO tool-capable scenario, which is exactly how the six existing
 * rooms e2e specs and the five structural cases stay green with the flag on:
 * test-mode reports not-tool-capable by default.
 */
export const roomsTextFallbackWhenNotWiredCase: EvalCase = {
  id: 'rooms-text-fallback-when-not-wired',
  title: 'Rooms — the flip is on but this session has no tool, so its text posts as before',
  prompt: '',
  runtimeTier: 'test-mode',
  costClass: 'free',
  tags: ['rooms'],
  seed: (sandbox) => seedRoomAgents(sandbox, [ADA]),
  roomScript: async (ctx): Promise<RoomScriptResult> => {
    // The flag ON, and deliberately NO tool-capable scenario: the shipped
    // `simple-text` echo, which reports not-tool-capable.
    await setToolOnlyReplies({ baseUrl: ctx.baseUrl, on: true });
    const { room, stream } = await openRoomFor(ctx, {
      slug: 'text-fallback',
      title: 'Text fallback',
      agents: [ADA],
      timeoutMs: TIMEOUT_MS,
    });
    try {
      await postToRoom({
        baseUrl: ctx.baseUrl,
        roomId: room.roomId,
        text: `${mentionOf(room, 'ada')} are the release notes ready?`,
      });
      const frames = await stream.settle({ quietMs: QUIET_MS });
      return { frames, room };
    } finally {
      await restore(ctx.baseUrl);
      stream.close();
    }
  },
  oracles: [
    roomTurnRanFor('ada', 'the mentioned agent ran a turn'),
    agentPostedInRoom('ada', {
      label: 'its text posted, because nothing here can suppress a turn that cannot post',
    }),
    roomNoticeCount('agent_declined', 0, 'it answered, so no line said it had not'),
  ],
};

/** Every tool-only rooms case, in registration order. */
export const roomsToolOnlyCases: EvalCase[] = [
  roomsToolPostIsTheOnlyReplyCase,
  roomsAddressedSilenceWritesOneNoticeCase,
  roomsAmbientSilenceWritesNothingCase,
  roomsReactionDischargesTheAnswerCase,
  roomsDmToolPostLandsAndTriggersNobodyCase,
  roomsTextFallbackWhenNotWiredCase,
];
