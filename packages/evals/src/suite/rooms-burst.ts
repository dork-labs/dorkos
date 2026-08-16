/**
 * The credentialed half of RP8's gathering: not "did three messages become one
 * turn", but "did that one turn answer all three".
 *
 * The structural suite already pins the cheap half — `rooms-burst-collects-into-one-turn`
 * proves three messages inside the collect window become one turn, charged once
 * (`suite/rooms.ts`). It cannot pin this half, because a scripted echo has no
 * comprehension to measure: a turn that answers one of three questions and a turn
 * that answers all three are the same green on `test-mode`. Only a real model can
 * be asked.
 *
 * This lives in its own module rather than beside the X-row probes in
 * `rooms-recall.ts` because it is not one of them — those ask whether an agent can
 * USE what a channel tells it, and this asks whether a gathered burst is answered
 * in full (DOR-1231). It shares that file's fixtures and its doctrine, both of
 * which live in `rooms-setup.ts`.
 *
 * @module evals/suite/rooms-burst
 */
import type { EvalCase, RoomScriptResult } from '../types.js';
import { postToRoom } from '../runner/room-drive.js';
import { agentPostedInRoom, roomTurnsRanFor } from '../oracles/rooms.js';
import {
  CREDENTIALED_CEILING_USD,
  CREDENTIALED_QUIET_MS,
  CREDENTIALED_TIMEOUT_MS,
  agentSpoke,
  hasText,
  mentionOf,
  openRoomFor,
  seedRoomAgents,
  setCollectDebounce,
} from './rooms-setup.js';
import type { RoomAgentSpec } from './rooms-setup.js';

/** The agent the burst questions. Mentioned every time, so it always answers. */
const ADA: RoomAgentSpec = {
  slug: 'ada',
  displayName: 'Ada',
  description: 'Keeps track of what the team says in this channel and answers questions about it.',
  responseMode: 'mention-only',
};

/**
 * The gathering window this case sets, in ms.
 *
 * Long enough that three real HTTP posts land inside ONE window with room to
 * spare. The shipped 500ms would make this a measurement of the harness's round
 * trip rather than of what the one turn answers, and a burst that split into two
 * turns would fail the case for the wrong reason.
 */
const BURST_WINDOW_MS = 3_000;

/**
 * The three facts the burst asks about. Each token exists nowhere else.
 *
 * Spelled out rather than numeric where a digit would be ambiguous: these are
 * matched with a bare case-insensitive `includes`, and admitting `19` alongside
 * `nineteen` would have matched a year, a dollar amount, or three characters of
 * a ULID. The history says "nineteen minutes", so the answer can too.
 */
const BURST_FACTS = {
  /** How long the deploy was up. Spelled out, so a digit guess cannot match. */
  rollback: 'nineteen',
  /** The pinned build number — four digits nothing could invent. */
  build: '4417',
  /** Who holds the checklist; a name only the channel history carries. */
  owner: 'Priya',
} as const;

/**
 * `rooms-burst-answered-in-full` — three questions asked in one breath get ONE
 * reply that answers all three (DOR-1231).
 *
 * This is the case DOR-1231 was fixed for: the gathered messages used to ride the
 * ambient "you have not read these yet" window, and a live room measured exactly
 * what that heading invites — one turn, three questions, an answer to the last.
 *
 * **Deterministic, not judged**, like every credentialed rooms case. "Did the
 * reply address all three" reads like a judgment, but it is mechanically
 * checkable when each answer has a token that exists nowhere else: a model that
 * skipped the second question cannot accidentally emit `4417`. That is a
 * stronger instrument than a rubric here, not a weaker one — and this package's
 * rubric primitive has no model scorer wired to it yet (`oracles/judge.ts`), so
 * a rubric would be an assertion that cannot fail.
 *
 * The one-turn oracle is not decoration either. Without it, three SEPARATE
 * turns would carry all three tokens between them and pass the coverage check
 * while testing nothing about gathering.
 */
export const roomsBurstAnsweredInFullCase: EvalCase = {
  id: 'rooms-burst-answered-in-full',
  title: 'Rooms — three questions in one window get one reply that answers all three',
  prompt: '',
  runtimeTier: 'claude-code-cheap',
  costClass: 'cheap',
  tags: ['rooms', 'experimental'],
  quarantined: true,
  perEvalCeilingUsd: CREDENTIALED_CEILING_USD,
  seed: (sandbox) => seedRoomAgents(sandbox, [ADA]),
  roomScript: async (ctx): Promise<RoomScriptResult> => {
    await setCollectDebounce(ctx.baseUrl, BURST_WINDOW_MS);
    const { room, stream } = await openRoomFor(ctx, {
      slug: 'burstfull',
      title: 'burstfull',
      agents: [ADA],
      timeoutMs: CREDENTIALED_TIMEOUT_MS,
    });
    try {
      // Unaddressed, so none of it triggers anything: it is the channel history
      // the three answers have to come out of.
      for (const line of [
        `The staging deploy rolled back after ${BURST_FACTS.rollback} minutes.`,
        `The importer is pinned to build ${BURST_FACTS.build} until further notice.`,
        `${BURST_FACTS.owner} is taking the release checklist this week.`,
      ]) {
        await postToRoom({ baseUrl: ctx.baseUrl, roomId: room.roomId, text: line });
      }

      // The burst. Three separate messages, no pauses — one person typing fast,
      // which is the shape RP8 gathers.
      const mention = mentionOf(room, 'ada');
      for (const question of [
        'how long was the staging deploy up before it rolled back?',
        'which build is the importer pinned to?',
        'who has the release checklist this week?',
      ]) {
        await postToRoom({
          baseUrl: ctx.baseUrl,
          roomId: room.roomId,
          text: `${mention} ${question}`,
        });
      }

      await stream.settle({
        settleWhen: (collected) => agentSpoke(collected, room, 'ada'),
        quietMs: CREDENTIALED_QUIET_MS,
      });
      // A second window before the oracles judge, so a burst that split into
      // three turns is SEEN as three rather than settled away after the first.
      const frames = await stream.settle({ quietMs: CREDENTIALED_QUIET_MS });
      return { frames, room };
    } finally {
      stream.close();
    }
  },
  oracles: [
    roomTurnsRanFor('ada', 1, 'the three questions became exactly one turn'),
    agentPostedInRoom('ada', {
      matches: (text) =>
        hasText(text, BURST_FACTS.rollback) &&
        text.includes(BURST_FACTS.build) &&
        hasText(text, BURST_FACTS.owner),
      label: 'one reply carries all three answers, not just the newest question’s',
    }),
  ],
};
