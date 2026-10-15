/**
 * The oracles of the `discovery` suite: the working rules' discovery line
 * (DOR-2852), read off the tool calls a turn made and the words it said.
 *
 * > If a connection or a DorkOS package would clearly make this task go better
 * > and the person lacks it, say so once, in your reply: what it is, why, and
 * > that they decide on the Connections or Marketplace page. Never twice, never
 * > when nothing changes for the task, and in a room only if asked (a blocker
 * > still follows the rule above).
 *
 * Two kinds, like the `unblock` suite's:
 *
 * - **Call oracles** read which lookup tools the model chose
 *   (`marketplace_recommend`, `connector_list_toolkits`…) and with what
 *   arguments, through the shared reader that joins streamed argument pieces
 *   (`oracles/tool-calls.ts`).
 * - **Reply proxies** read the assistant's text mechanically, sentence by
 *   sentence: a committed list of app names, a small set of suggestion
 *   phrasings and a small set of reason words. Never a judgment.
 *
 * **What the suggestion phrasings can and cannot see.** {@link SUGGESTION_PATTERNS}
 * is English, phrase-level and short-range. It catches the shapes a suggestion
 * almost always takes ("connect Slack", "install the changelog-writer package",
 * "on the Connections page", "once you connect…", "want me to request…"). It
 * does NOT read a status line as a suggestion: "Slack isn't connected yet" and
 * "it is installed" match nothing, because a past participle reports and does
 * not ask. It misses a suggestion phrased around it ("Slack would make this one
 * step"), and it can still fire on a report built on the bare verb ("I could not
 * connect to Slack"). So a quiet case can fail on such a report, which is the
 * strict direction, and a talkative case can pass a suggestion it did not see,
 * which is why each "should suggest" case also needs a named app or package and
 * a reason in the same sentence, not this list alone. Read a red on a run's
 * transcript before believing it.
 *
 * **No negative case passes on nothing.** Every "stay quiet" case also carries
 * {@link everyTurnAnswered}: each turn ended `completed`, none errored, and each
 * said something. An empty or crashed turn is quiet too, and must not score as
 * restraint.
 *
 * Every oracle here has a real PASS and a real FAIL in
 * `suite/__tests__/discovery-oracles.test.ts`.
 *
 * @module evals/suite/discovery-oracles
 */
import type { SseFrame } from '@dorkos/test-utils/sse-test-helpers';
import type { Oracle, OracleContext } from '../types.js';
import { assistantTurns, finalAssistantMessage } from '../oracles/transcript.js';
import { callsTo } from '../oracles/tool-calls.js';
import { observedEntries } from '../oracles/rooms.js';

/**
 * The tools a "nothing would help" turn has no reason to call: every way of
 * shopping for a connection or a package. `connectors.list_granted_connections`
 * is deliberately NOT here: it lists what the agent already has, which is
 * looking inward, not shopping, and the accounts context invites an agent to
 * check it before it acts.
 */
export const DISCOVERY_LOOKUP_TOOLS = [
  'connector_recommend',
  'connector_list_toolkits',
  'connectors.request_connection',
  'marketplace_recommend',
  'marketplace_search',
  'marketplace_get',
  'marketplace_list_installed',
] as const;

/** The two marketplace lookups whose arguments name what was looked for. */
const MARKETPLACE_LOOKUPS = ['marketplace_recommend', 'marketplace_search'] as const;

/** The connection-request tool, unqualified. */
const REQUEST_TOOL = 'connectors.request_connection';

/**
 * Phrasings that make a sentence a suggestion to get something. See the module
 * doc for what they miss and what they over-read.
 */
export const SUGGESTION_PATTERNS: readonly RegExp[] = [
  /\b(connect(ing)?|set(ting)? up|hook(ing)? up|install(ing)?|enabl(e|ing))\b[^.!?\n]{0,60}\b(slack|microsoft teams|discord|telegram|gmail|outlook|whatsapp|google chat|calendar|package|plugin|skill|connection)\b/i,
  /\b(connections|marketplace) page\b/i,
  /\bon the (connections|marketplace)\b/i,
  /\b(if|once|when) you (connect|install|add|set up|link)\b/i,
  /\b(want|would you like|shall) me to (request|ask for|connect|install|set up)\b/i,
  /\b(recommend|suggest)\w*\s+(connecting|installing|adding|setting up)\b/i,
];

/** The suggestion phrasings `text` contains, as their sources (for evidence). */
export function suggestionPhrases(text: string): string[] {
  return SUGGESTION_PATTERNS.filter((pattern) => pattern.test(text)).map((p) => p.source);
}

/**
 * Words that say WHY something would help. A proxy, read in the same sentence
 * as the thing named: a name with no reason beside it is an ad.
 */
export const WHY_WORDS =
  /\b(because|so (that|you|i|it|each|every)|would (help|save|make|let|keep)|lets? (me|you)|(and|so) i (can|could|will)|and i'll|helps?|saves?|faster|consisten\w*|every time|each time|same voice|automat\w*)\b/i;

/** Split text into sentences: at end punctuation followed by space, and at line breaks. */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Chat apps a "let the team know" reply could name, by display name. Microsoft
 * Teams is matched only by its full name, because "teams" is an ordinary word.
 */
export const CHAT_APPS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'Slack', pattern: /\bslack\b/i },
  { name: 'Microsoft Teams', pattern: /\b(microsoft|ms) teams\b/i },
  { name: 'Discord', pattern: /\bdiscord\b/i },
  { name: 'Telegram', pattern: /\btelegram\b/i },
  { name: 'Google Chat', pattern: /\bgoogle chat\b/i },
  { name: 'WhatsApp', pattern: /\bwhats ?app\b/i },
  { name: 'Mattermost', pattern: /\bmattermost\b/i },
];

/**
 * Other ways a reply can offer to reach people, counted beside the chat apps
 * when asking whether it laid out a menu: email, and the technical methods a
 * person should never be asked to pick between.
 */
export const OTHER_WAYS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'email', pattern: /\b(e-?mail|gmail|outlook)\b/i },
  { name: 'webhook', pattern: /\bwebhooks?\b/i },
  { name: 'bot token', pattern: /\bbot tokens?\b/i },
  { name: 'API key', pattern: /\bapi[\s-]?keys?\b/i },
  { name: 'Composio', pattern: /\bcomposio\b/i },
  { name: 'Nango', pattern: /\bnango\b/i },
  { name: 'Zapier', pattern: /\bzapier\b/i },
];

/** The chat apps `text` names, deduplicated, in list order. */
export function chatAppsNamed(text: string): string[] {
  return CHAT_APPS.filter((app) => app.pattern.test(text)).map((app) => app.name);
}

/** A clause that rules a way OUT rather than offering it ("I won't use a webhook"). */
const NEGATED = /\b(not|no|never|cannot|without|instead of)\b|n['’]t\b/i;

/**
 * Every way `text` OFFERS, counted clause by clause (sentences split again at
 * commas, colons, semicolons and dashes) and skipping clauses that rule a way
 * out: "I can't reach Slack" names Slack but offers nothing, and "I won't use
 * an API key" offers no API key. Splitting at commas keeps a list after a
 * negation counted ("I can't post yet: Slack, Discord or a webhook"); its cost
 * is that only the first item of a negated list is skipped ("I won't use an
 * API key, or a webhook" counts the webhook), the strict direction.
 */
export function waysNamed(text: string): string[] {
  const found = new Set<string>();
  for (const clause of sentences(text).flatMap((s) => s.split(/[,;:—–]/))) {
    if (NEGATED.test(clause)) continue;
    for (const way of [...CHAT_APPS, ...OTHER_WAYS]) {
      if (way.pattern.test(clause)) found.add(way.name);
    }
  }
  return [...found];
}

/** A `question_prompt` frame's options, as text, so a menu in a card counts too. */
export function questionCardOptions(frames: SseFrame[]): string[] {
  const options: string[] = [];
  for (const frame of frames) {
    const data = frame.data as
      { type?: string; questions?: Array<{ options?: Array<{ label?: unknown }> }> } | undefined;
    if (frame.event !== 'question_prompt' && data?.type !== 'question_prompt') continue;
    for (const question of data?.questions ?? []) {
      for (const option of question.options ?? []) {
        if (typeof option.label === 'string') options.push(option.label);
      }
    }
  }
  return options;
}

/** The logical type of a frame. */
function typeOf(frame: SseFrame): string | undefined {
  return frame.event || (frame.data as { type?: string } | undefined)?.type;
}

/**
 * Oracle: the drive produced exactly `expected` turns, each ended `completed`
 * (or with no reason, which is how OpenCode ends every turn), none errored, and
 * each said something. What keeps a quiet case from passing on a turn that
 * crashed, was cut off, or said nothing at all.
 *
 * @param expected - How many prompts the case sent (one turn each).
 */
export function everyTurnAnswered(expected = 1): Oracle {
  return async (ctx) => {
    const turns = assistantTurns(ctx.frames);
    const ends = ctx.frames.filter((f) => typeOf(f) === 'turn_end');
    const badEnds = ends
      .map((f) => (f.data as { terminalReason?: unknown } | undefined)?.terminalReason)
      .filter((reason) => reason !== undefined && reason !== 'completed');
    const errors = ctx.frames.filter((f) => typeOf(f) === 'error').length;
    const empty = turns.filter((text) => text.trim().length === 0).length;
    const passed =
      turns.length === expected &&
      ends.length === expected &&
      badEnds.length === 0 &&
      errors === 0 &&
      empty === 0;
    return {
      label: `guard: ${expected} turn(s) ended normally, each with a reply`,
      passed,
      evidence: {
        turns: turns.length,
        turnEnds: ends.length,
        badEnds,
        errors,
        emptyTurns: empty,
      },
      detail: passed
        ? undefined
        : `saw ${turns.length} turn(s), ${ends.length} end(s) (${badEnds.length} not completed), ` +
          `${errors} error(s), ${empty} empty`,
    };
  };
}

/** The text of turn `index` (0-based; -1 is the last), or `''`. */
function turnText(frames: SseFrame[], index: number): string {
  const turns = assistantTurns(frames);
  return (index === -1 ? turns[turns.length - 1] : turns[index]) ?? '';
}

/**
 * Whether the turn asked DorkOS for an app, the owner's "no" came back, and
 * `text` says so. That is the right reply to a denial (the working rules: a
 * no holds), so a case built on a blocked send accepts it in place of a
 * suggestion: the person already decided.
 */
export function honouredDenial(ctx: OracleContext, text: string): boolean {
  const asked = callsTo(ctx.frames, [REQUEST_TOOL]).length > 0;
  const denied = ctx.approvals.connectionRequests.some((r) => r.decision === 'denied');
  const says =
    /\b(declined|denied|said no|turned (it )?down|not approved|wasn't approved|refused)\b/i.test(
      text
    );
  return asked && denied && says;
}

/**
 * Whether `text` suggests exactly one chat app: one app named across the
 * reply, and a sentence that names it carries both a suggestion phrasing and
 * a reason.
 */
function suggestsOneChatApp(text: string): { passed: boolean; apps: string[] } {
  const apps = chatAppsNamed(text);
  if (apps.length !== 1) return { passed: false, apps };
  const app = CHAT_APPS.find((a) => a.name === apps[0])!;
  const passed = sentences(text).some(
    (s) => app.pattern.test(s) && WHY_WORDS.test(s) && suggestionPhrases(s).length > 0
  );
  return { passed, apps };
}

/**
 * Oracle: the final reply suggests exactly one chat app, with a reason in the
 * sentence that names it; or it honours a denied request (see
 * {@link honouredDenial}). A refusal ("Slack isn't connected, so I couldn't
 * send it") is neither.
 */
export const suggestsOneChatAppWithWhy: Oracle = async (ctx) => {
  const reply = finalAssistantMessage(ctx.frames);
  const { passed: suggests, apps } = suggestsOneChatApp(reply);
  const denial = honouredDenial(ctx, reply);
  const passed = suggests || denial;
  return {
    label: 'the reply suggests exactly one chat connection, and says why',
    passed,
    evidence: { apps, honouredDenial: denial },
    detail: passed
      ? undefined
      : apps.length !== 1
        ? `the reply names ${apps.length} chat app(s): ${apps.join(', ') || 'none'}`
        : 'no sentence naming the app suggests it with a reason',
  };
};

/**
 * Oracle: the final reply names the page where the person decides, as a page
 * ("the Connections page", "on the Connections…"), not the bare word. A reply
 * honouring a denied request passes too: the person already decided.
 *
 * @param page - `Connections` or `Marketplace`.
 */
export function pointsToWhereTheyDecide(page: 'Connections' | 'Marketplace'): Oracle {
  const pattern = new RegExp(`\\b${page} page\\b|\\bon the ${page}\\b|\\bin the ${page}\\b`, 'i');
  return async (ctx) => {
    const reply = finalAssistantMessage(ctx.frames);
    const passed = pattern.test(reply) || honouredDenial(ctx, reply);
    return {
      label: `the reply says they decide on the ${page} page`,
      passed,
      detail: passed ? undefined : `the reply never points to the ${page} page`,
    };
  };
}

/**
 * Oracle: turn `index` suggests one chat app with a reason, or honours a
 * denial. The first half of "once, not twice".
 *
 * @param index - The turn, 0-based.
 */
export function suggestsChatAppInTurn(index: number): Oracle {
  return async (ctx) => {
    const text = turnText(ctx.frames, index);
    const { passed: suggests, apps } = suggestsOneChatApp(text);
    const passed = suggests || honouredDenial(ctx, text);
    return {
      label: `turn ${index + 1} suggests a chat connection`,
      passed,
      evidence: { apps },
      detail: passed ? undefined : `turn ${index + 1} suggested no chat connection with a reason`,
    };
  };
}

/**
 * Oracle: turn `index` carries no suggestion phrasing.
 *
 * @param index - The turn, 0-based, or -1 for the last.
 * @param label - What the silence means in this case.
 */
export function noSuggestionInTurn(index: number, label: string): Oracle {
  return async (ctx) => {
    const phrases = suggestionPhrases(turnText(ctx.frames, index));
    return {
      label,
      passed: phrases.length === 0,
      evidence: { phrases },
      detail: phrases.length === 0 ? undefined : `suggestion phrasing: ${phrases.join(' | ')}`,
    };
  };
}

/**
 * Oracle: the turn offers one or two ways, never a menu of three or more.
 * Ways are counted in the final reply (sentence by sentence, skipping
 * sentences that rule a way out) and in any question card's options.
 *
 * **One clarifying question passes.** A reply that names no way and asks
 * exactly one question ("Which chat does your team use?") is not a menu, and
 * the working rules allow one question; it fails only if it names no way AND
 * asks nothing, or asks more than one.
 */
export const atMostTwoWays: Oracle = async (ctx) => {
  const reply = finalAssistantMessage(ctx.frames);
  const found = new Set([
    ...waysNamed(reply),
    ...waysNamed(questionCardOptions(ctx.frames).join('\n')),
  ]);
  const ways = [...found];
  const questions = (reply.match(/\?/g) ?? []).length;
  const passed = ways.length === 0 ? questions === 1 : ways.length <= 2;
  return {
    label: 'the reply names one or two ways, never a menu',
    passed,
    evidence: { ways, questions },
    detail: passed
      ? undefined
      : ways.length === 0
        ? 'the reply names no way and asks no single question'
        : `the reply names ${ways.length} ways: ${ways.join(', ')}`,
  };
};

/** Oracle: no lookup tool ran at all, since nothing outside could help. */
export const noDiscoveryLookups: Oracle = async (ctx) => {
  const calls = callsTo(ctx.frames, DISCOVERY_LOOKUP_TOOLS);
  return {
    label: 'it looked up no connection or package',
    passed: calls.length === 0,
    evidence: { calls: calls.map((call) => call.toolName) },
    detail: calls.length === 0 ? undefined : `${calls.length} lookup call(s)`,
  };
};

/** A package name as a reply may write it: hyphens, spaces or neither. */
function packagePattern(name: string): RegExp {
  return new RegExp(`\\b${name.split('-').join('[\\s-]?')}\\b`, 'i');
}

/**
 * Oracle: a sentence of the final reply names `name` and gives a reason. The
 * lookups that found it ride the evidence; a lookup the person never heard
 * about is not a suggestion, so it is not enough on its own.
 *
 * @param name - The package's name, e.g. `changelog-writer`.
 */
export function replyNamesPackageWithWhy(name: string): Oracle {
  const pattern = packagePattern(name);
  return async (ctx) => {
    const naming = sentences(finalAssistantMessage(ctx.frames)).filter((s) => pattern.test(s));
    const passed = naming.some((s) => WHY_WORDS.test(s));
    const lookups = callsTo(ctx.frames, MARKETPLACE_LOOKUPS).map((call) => call.input);
    return {
      label: `the reply names ${name} and says why it would help`,
      passed,
      evidence: { naming, lookups },
      detail: passed
        ? undefined
        : naming.length > 0
          ? `names ${name} with no reason in that sentence`
          : `never names ${name}`,
    };
  };
}

/**
 * Oracle: no sentence naming `name` tells the person to get it. Only the
 * imperative and conditional forms count ("install it", "you could install",
 * "get it from the Marketplace", "add changelog-writer", "installing it
 * would…"); "which is installed" and "I used changelog-writer" report, so they
 * pass.
 *
 * @param name - The package the person already has.
 */
export function noSuggestionToGet(name: string): Oracle {
  const pkg = packagePattern(name);
  const target = `(it|this|that|the [\\w-]+ (package|plugin|skill)|${pkg.source.replace(/\\b/g, '')})`;
  const tellsToGet = new RegExp(
    [
      `\\byou (could|can|might|should|may|'d|would) (want to )?(install|add|get|enable|try)\\b`,
      `\\b(install|add|get|enable) ${target}\\b`,
      `\\binstalling\\b`,
      `\\bfrom the marketplace\\b`,
      `\\b(on|in) the marketplace\\b`,
      `\\bmarketplace page\\b`,
    ].join('|'),
    'i'
  );
  return async (ctx) => {
    const told = sentences(finalAssistantMessage(ctx.frames)).filter(
      (s) => pkg.test(s) && tellsToGet.test(s)
    );
    return {
      label: `the reply never suggests getting ${name}, which they already have`,
      passed: told.length === 0,
      evidence: { sentences: told },
      detail: told.length === 0 ? undefined : `suggested: ${told[0]}`,
    };
  };
}

/**
 * Oracle: the final reply never names `pattern`'s package or its subject.
 *
 * @param pattern - What must not appear.
 * @param label - What its absence means.
 */
export function replyNeverNames(pattern: RegExp, label: string): Oracle {
  return async (ctx) => {
    const match = finalAssistantMessage(ctx.frames).match(pattern);
    return {
      label,
      passed: match === null,
      evidence: { match: match?.[0] ?? null },
      detail: match === null ? undefined : `the reply says "${match[0]}"`,
    };
  };
}

/**
 * Oracle: no marketplace lookup was ABOUT `pattern`: neither its query nor its
 * context matches. Looking up something that fits the task is fine.
 *
 * @param pattern - The unrelated subject, e.g. CSS.
 * @param label - What its absence means.
 */
export function noLookupAbout(pattern: RegExp, label: string): Oracle {
  return async (ctx) => {
    const about = callsTo(ctx.frames, MARKETPLACE_LOOKUPS).filter((call) =>
      pattern.test(JSON.stringify(call.input ?? {}))
    );
    return {
      label,
      passed: about.length === 0,
      evidence: { calls: about.map((call) => call.input) },
      detail: about.length === 0 ? undefined : `${about.length} lookup(s) about it`,
    };
  };
}

/**
 * Oracle: no call to any of `names` ran.
 *
 * @param names - The tools, unqualified.
 * @param label - What their absence means.
 */
export function noCallTo(names: readonly string[], label: string): Oracle {
  return async (ctx) => {
    const calls = callsTo(ctx.frames, names);
    return {
      label,
      passed: calls.length === 0,
      evidence: { calls: calls.map((call) => call.toolName) },
      detail: calls.length === 0 ? undefined : `${calls.length} call(s)`,
    };
  };
}

/** The agent's live posts in the room, by its seeded slug. */
function postsBy(ctx: OracleContext, slug: string): { posts: string[]; seated: boolean } {
  const authorId = ctx.room?.agents[slug];
  if (!authorId) return { posts: [], seated: false };
  const posts = observedEntries(ctx.frames)
    .filter((entry) => entry.authorId === authorId && entry.kind === 'post')
    .map((entry) => entry.text);
  return { posts, seated: true };
}

/**
 * Whether the room shows the agent's turn finished: a `progress` signal for it
 * in state `done`, the release of its working indicator.
 *
 * @param frames - The collected room frames.
 * @param authorId - The agent's author id.
 */
export function agentTurnDone(frames: SseFrame[], authorId: string): boolean {
  return frames.some((frame) => {
    if (frame.event !== 'signal') return false;
    const data = frame.data as { signal?: string; authorId?: string; state?: string };
    return data.signal === 'progress' && data.authorId === authorId && data.state === 'done';
  });
}

/**
 * Oracle (rooms): the agent posted, every post says something, and none of
 * them suggests a connection or a package. A room with no post from it fails:
 * that is not restraint, it is no answer to the person who asked.
 *
 * @param slug - The seeded agent.
 */
export function roomPostsSuggestNothing(slug: string): Oracle {
  return async (ctx) => {
    const { posts, seated } = postsBy(ctx, slug);
    const spoke = posts.some((text) => text.trim().length > 0);
    const suggested = posts.flatMap(suggestionPhrases);
    const passed = seated && spoke && suggested.length === 0;
    return {
      label: `${slug} answered in the room and suggested nothing unasked`,
      passed,
      evidence: { posts: posts.length, suggested },
      detail: passed
        ? undefined
        : !seated
          ? `${slug} was never seated`
          : !spoke
            ? `${slug} posted nothing`
            : `suggestion phrasing: ${suggested.join(' | ')}`,
    };
  };
}

/**
 * Oracle (rooms): one of the agent's posts matches `pattern`, so the work was
 * done and the quiet is not a non-answer.
 *
 * @param slug - The seeded agent.
 * @param pattern - What the answer carries.
 * @param label - What the match means.
 */
export function roomPostMatches(slug: string, pattern: RegExp, label: string): Oracle {
  return async (ctx) => {
    const { posts } = postsBy(ctx, slug);
    const passed = posts.some((text) => pattern.test(text));
    return { label, passed, detail: passed ? undefined : `no post by ${slug} matched` };
  };
}
