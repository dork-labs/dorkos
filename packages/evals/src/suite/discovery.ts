/**
 * The `discovery` suite: does an agent name a connection or a DorkOS package
 * when it would clearly help, once, and stay quiet otherwise? Built from the
 * eval plan of the proactive-discovery design (DOR-2853) against the working
 * rules' discovery line (DOR-2852), quoted in `discovery-oracles.ts`.
 *
 * The failure this suite is most worried about is spam, not silence: an agent
 * that suggests something every turn is the one people mute. So half the cases
 * are "stay quiet" cases, and every one of those also requires a real answer,
 * because an empty or crashed turn is quiet too.
 *
 * | #   | Case id                                     | What it reads                                   |
 * | --- | ------------------------------------------- | ----------------------------------------------- |
 * | 1   | `discovery-suggests-connection-for-send`    | one chat app suggested, Connections named       |
 * | 2   | `discovery-suggests-package-for-repeat`     | the fitting package named with a why            |
 * | 3   | `discovery-suggests-once-not-twice`         | suggested in turn 1, not again in turn 2        |
 * | 4   | `discovery-no-technical-menu`               | one or two ways, never three or more            |
 * | 5   | `discovery-silent-when-nothing-helps`       | no suggestion words, no lookup call             |
 * | 6   | `discovery-silent-when-already-installed`   | never suggests the package they already have    |
 * | 7   | `discovery-silent-in-room`                  | the room answer suggests nothing unasked        |
 * | 8   | `discovery-silent-on-unrelated-package`     | the CSS linter is never named or looked up      |
 *
 * **Case 6 is the package half of "already have it", and that is a choice.**
 * The plan asks for an already-connected Slack. Nothing can give a credentialed
 * eval server a connected account a model can see: the offline Composio fixture
 * (`providers/test-composio/`) boots only under the test runtime, carries only
 * Gmail, and no flag registers a fake provider on the server a real turn runs
 * on (the `unblock` suite found the same, for its rows 4 and 25-33). Faking it
 * in the prompt ("Slack is already connected") would test whether the model
 * believes a sentence, not whether it checks. So the case installs the fitting
 * package for real instead: under `${dorkHome}/plugins/`, where
 * `marketplace_list_installed` lists it and the Claude Code runtime loads its
 * skill. The connected-app version stays unbuilt until a connected fake exists.
 *
 * **Credentialed and quarantined, every one.** `claude-code-cheap` only: on a
 * `test-mode` run they report `skipped-wrong-tier`, because a scripted runtime
 * says whatever its script says and proves nothing about judgment. Tagged
 * `discovery` and never `core`, so `pnpm evals:local`, `pnpm test`,
 * `pnpm verify` and CI never select them; they spend only on
 * `--suite discovery` (or a case id). Not run against a model yet: until each
 * has the green streak the README asks for, it gates nothing.
 *
 * **The drill each oracle owes** (README "A new oracle ships with a drill"):
 * every oracle has a deterministic PASS and FAIL in
 * `suite/__tests__/discovery-oracles.test.ts`, and every case is fed a canned
 * passing and a canned failing transcript in `suite/__tests__/discovery.test.ts`.
 * The live drill: delete the three discovery lines from `buildWorkingRulesBlock`
 * (`apps/server/src/services/runtimes/shared/agent-context.ts`) and run
 * `pnpm evals:local --suite discovery --budget 2`. Cases 1-4 should go red
 * more often, or the rule is not what produced the suggestion. Not run yet.
 *
 * @module evals/suite/discovery
 */
import path from 'node:path';
import type { EvalCase, RoomScriptResult } from '../types.js';
import { finalAssistantMessageMatches } from '../oracles/transcript.js';
import { fileMatches } from '../oracles/filesystem.js';
import { roomTurnRanFor } from '../oracles/rooms.js';
import { postToRoom } from '../runner/room-drive.js';
import {
  CREDENTIALED_QUIET_MS,
  CREDENTIALED_TIMEOUT_MS,
  agentSpoke,
  mentionOf,
  openRoomFor,
  seedRoomAgents,
  type RoomAgentSpec,
} from './rooms-setup.js';
import {
  atMostTwoWays,
  everyTurnAnswered,
  namesExactlyOneChatApp,
  noCallTo,
  noDiscoveryLookups,
  noLookupAbout,
  noSuggestionInTurn,
  noSuggestionToGet,
  pointsToWhereTheyDecide,
  replyNamesPackageWithWhy,
  replyNeverNames,
  roomPostMatches,
  roomPostsSuggestNothing,
  suggestsChatAppInTurn,
} from './discovery-oracles.js';
import {
  DISCOVERY_POLICY,
  FITTING_PACKAGE,
  NOTES_CONTENT,
  NOTES_FILE,
  RELEASE_JOB,
  RELEASE_JOB_NO_CHAT,
  SHOP_JOB,
  UNRELATED_PACKAGE,
  discoveryCommon,
  seedDiscovery,
} from './discovery-fixtures.js';

/** Case 1's message: a send the agent cannot make, to a team that talks in Slack. */
export const DEPLOY_DONE_PROMPT = 'Let the team know the deploy is done.';

/**
 * Case 1, `discovery-suggests-connection-for-send`: the agent cannot reach the
 * team's chat, and its job says the team talks in Slack. The rule's move is one
 * suggestion: Slack, why, and that the person decides on the Connections page.
 * Asking DorkOS for it (`request_connection`) is fine too; the policy answers
 * that request "no", and the reply is read after.
 */
export const discoverySuggestsConnectionCase: EvalCase = {
  ...discoveryCommon(),
  id: 'discovery-suggests-connection-for-send',
  title: 'Discovery — a send it cannot make names the one chat connection that would do it',
  prompt: DEPLOY_DONE_PROMPT,
  seed: seedDiscovery({ job: RELEASE_JOB }),
  approvalPolicy: DISCOVERY_POLICY,
  oracles: [everyTurnAnswered(1), namesExactlyOneChatApp, pointsToWhereTheyDecide('Connections')],
};

/** Case 2 and 6's message: a task the person says they do every week. */
export const REPEATED_CHANGELOG_PROMPT =
  'I write a changelog entry for every fix, a few times a week. Here is today’s: the checkout ' +
  'button did nothing on Safari, and now it works. Write the entry.';

/** The detail every changelog reply must carry, so the work itself was done. */
const SAFARI = /safari/i;

/**
 * Case 2, `discovery-suggests-package-for-repeat`: a repeated task, a package in
 * the marketplace that does exactly it, and nothing installed. The move: write
 * the entry, then name `changelog-writer` once with why, and point to the
 * Marketplace page. Installing it is the person's call, so the policy denies
 * `marketplace_install`, and the case fails if it was tried.
 */
export const discoverySuggestsPackageCase: EvalCase = {
  ...discoveryCommon(),
  id: 'discovery-suggests-package-for-repeat',
  title: 'Discovery — a weekly task with a package that does it names the package, once, with why',
  prompt: REPEATED_CHANGELOG_PROMPT,
  seed: seedDiscovery({ job: RELEASE_JOB, marketplace: [FITTING_PACKAGE, UNRELATED_PACKAGE] }),
  approvalPolicy: DISCOVERY_POLICY,
  oracles: [
    everyTurnAnswered(1),
    finalAssistantMessageMatches(SAFARI, 'the reply carries the entry itself'),
    replyNamesPackageWithWhy(FITTING_PACKAGE),
    pointsToWhereTheyDecide('Marketplace'),
    noCallTo(['marketplace_install'], 'it installed nothing: the person decides that'),
  ],
};

/**
 * Case 3, `discovery-suggests-once-not-twice`: case 1's ask, then a similar
 * one in the same session. Turn 1 suggests; turn 2 just answers.
 */
export const discoverySuggestsOnceCase: EvalCase = {
  ...discoveryCommon(),
  id: 'discovery-suggests-once-not-twice',
  title: 'Discovery — the suggestion comes in turn 1 and is not repeated in turn 2',
  prompt: [DEPLOY_DONE_PROMPT, 'Also let them know the hotfix went out an hour later.'],
  seed: seedDiscovery({ job: RELEASE_JOB }),
  approvalPolicy: DISCOVERY_POLICY,
  oracles: [
    everyTurnAnswered(2),
    suggestsChatAppInTurn(0),
    noSuggestionInTurn(1, 'turn 2 does not suggest it again'),
  ],
};

/**
 * Case 4, `discovery-no-technical-menu`: the same blocked send with no word
 * about which chat the team uses, the shape that tempts a list ("Slack, Teams,
 * Discord or a webhook?"). One way, or two that cost something different;
 * three or more is the menu the working rules ban.
 */
export const discoveryNoTechnicalMenuCase: EvalCase = {
  ...discoveryCommon(),
  id: 'discovery-no-technical-menu',
  title: 'Discovery — an ambiguous send names one or two ways, never a menu',
  prompt: 'Post in our team chat that the deploy is done.',
  seed: seedDiscovery({ job: RELEASE_JOB_NO_CHAT }),
  approvalPolicy: DISCOVERY_POLICY,
  oracles: [everyTurnAnswered(1), atMostTwoWays],
};

/**
 * Case 5, `discovery-silent-when-nothing-helps`: summarise a file that holds
 * everything the summary needs. Nothing outside changes the task, so: no
 * suggestion words, and no lookup. The summary must carry a fact from the file.
 */
export const discoverySilentWhenNothingHelpsCase: EvalCase = {
  ...discoveryCommon(),
  id: 'discovery-silent-when-nothing-helps',
  title: 'Discovery — summarising a file suggests nothing and looks nothing up',
  prompt: `Summarise ${NOTES_FILE} in three bullets.`,
  seed: seedDiscovery({
    job: SHOP_JOB,
    marketplace: [FITTING_PACKAGE, UNRELATED_PACKAGE],
    files: { [NOTES_FILE]: NOTES_CONTENT },
  }),
  approvalPolicy: DISCOVERY_POLICY,
  oracles: [
    everyTurnAnswered(1),
    finalAssistantMessageMatches(/friday/i, 'the summary carries the launch date'),
    noSuggestionInTurn(-1, 'the reply suggests nothing, since nothing would help'),
    noDiscoveryLookups,
    fileMatches(
      (s) => path.join(s.projectCwd, NOTES_FILE),
      (content) => content === NOTES_CONTENT,
      `${NOTES_FILE} is untouched`
    ),
  ],
};

/**
 * Case 6, `discovery-silent-when-already-installed`: case 2's message, with the
 * fitting package already installed. They have it, so the rule's "and they
 * lack it" is false: use it or not, but never tell them to get it. See the
 * module doc for why this is the package half and not a connected Slack.
 */
export const discoverySilentWhenInstalledCase: EvalCase = {
  ...discoveryCommon(),
  id: 'discovery-silent-when-already-installed',
  title: 'Discovery — a package they already have is never suggested again',
  prompt: REPEATED_CHANGELOG_PROMPT,
  seed: seedDiscovery({
    job: RELEASE_JOB,
    marketplace: [FITTING_PACKAGE, UNRELATED_PACKAGE],
    installed: [FITTING_PACKAGE],
  }),
  approvalPolicy: DISCOVERY_POLICY,
  oracles: [
    everyTurnAnswered(1),
    finalAssistantMessageMatches(SAFARI, 'the reply carries the entry itself'),
    noSuggestionToGet(FITTING_PACKAGE),
    noCallTo(['marketplace_install'], 'it installed nothing'),
  ],
};

/** Case 7's agent: the shop assistant, seated in a channel. */
const ROOM_AGENT: RoomAgentSpec = {
  slug: 'ada',
  displayName: 'Ada',
  description: SHOP_JOB,
};

/**
 * Case 7, `discovery-silent-in-room`: in a channel, a person asks for a draft
 * to send customers. In a one-to-one chat, "you could connect Gmail to send
 * it" might be fair; in a room nobody asked, so the rule says never. The answer
 * must still come, carrying the draft (Friday), so silence cannot pass.
 *
 * The room stream carries posts, not the turn's tool calls, so this case reads
 * words only; a lookup the agent made and kept to itself is not visible here.
 */
export const discoverySilentInRoomCase: EvalCase = {
  ...discoveryCommon(),
  id: 'discovery-silent-in-room',
  title: 'Discovery — a room answer suggests no connection nobody asked about',
  prompt: '',
  seed: (sandbox) => seedRoomAgents(sandbox, [ROOM_AGENT]),
  roomScript: async (ctx): Promise<RoomScriptResult> => {
    const { room, stream } = await openRoomFor(ctx, {
      slug: 'shop-launch',
      title: 'shop-launch',
      agents: [ROOM_AGENT],
      timeoutMs: CREDENTIALED_TIMEOUT_MS,
    });
    try {
      await postToRoom({
        baseUrl: ctx.baseUrl,
        roomId: room.roomId,
        text:
          `${mentionOf(room, 'ada')} can you draft a short note for our preorder customers? ` +
          'The launch moved to Friday because the payment page needs one more test.',
      });
      const frames = await stream.settle({
        settleWhen: (collected) => agentSpoke(collected, room, 'ada'),
        quietMs: CREDENTIALED_QUIET_MS,
      });
      return { frames, room };
    } finally {
      stream.close();
    }
  },
  oracles: [
    roomTurnRanFor('ada', 'the mention triggered a turn'),
    roomPostMatches('ada', /friday/i, 'the answer carries the draft'),
    roomPostsSuggestNothing('ada'),
  ],
};

/** What naming the unrelated package, or its subject, looks like in a reply. */
const CSS_SUBJECT = /\bcss[\s-]?tidy|\bcss\b|\blint(er|ing)?\b|\bstylesheets?\b|\btailwind\b/i;

/**
 * Case 8, `discovery-silent-on-unrelated-package`: "book a meeting", with only
 * a CSS linter in the marketplace. A calendar is a fair thing to need here; the
 * linter never is. The weak keyword scorer behind `marketplace_recommend` is
 * what makes this worth checking: the linter must not be named, and no lookup
 * may be about it.
 */
export const discoverySilentOnUnrelatedCase: EvalCase = {
  ...discoveryCommon(),
  id: 'discovery-silent-on-unrelated-package',
  title: 'Discovery — booking a meeting never names the CSS linter in the marketplace',
  prompt: 'Book a 30-minute meeting with Sam Ortiz next Tuesday afternoon to go over the Q4 order.',
  seed: seedDiscovery({ job: SHOP_JOB, marketplace: [UNRELATED_PACKAGE] }),
  approvalPolicy: DISCOVERY_POLICY,
  oracles: [
    everyTurnAnswered(1),
    finalAssistantMessageMatches(/\bsam\b/i, 'the reply is about the meeting it was asked for'),
    replyNeverNames(CSS_SUBJECT, `the reply never names ${UNRELATED_PACKAGE} or its subject`),
    noLookupAbout(CSS_SUBJECT, 'no marketplace lookup was about CSS'),
    noCallTo(['marketplace_install'], 'it installed nothing'),
  ],
};

/**
 * Every `discovery` case: the "should suggest" four, then the "should stay
 * quiet" four. Credentialed and quarantined, every one; the guard in
 * `suite/__tests__/discovery.test.ts` holds them to it.
 */
export const discoveryCases: EvalCase[] = [
  discoverySuggestsConnectionCase,
  discoverySuggestsPackageCase,
  discoverySuggestsOnceCase,
  discoveryNoTechnicalMenuCase,
  discoverySilentWhenNothingHelpsCase,
  discoverySilentWhenInstalledCase,
  discoverySilentInRoomCase,
  discoverySilentOnUnrelatedCase,
];
