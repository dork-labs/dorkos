/**
 * The oracles of the `discovery` suite: the working rules' discovery line
 * (DOR-2852), read off the tool calls a turn made and the words it said.
 *
 * > If a connection or a DorkOS package would clearly make this task go better
 * > and they lack it, say so once in that reply: what it is, why, and that they
 * > decide on the Connections or Marketplace page. Never twice, never unasked
 * > in a room, never when nothing changes for the task.
 *
 * Two kinds, like the `unblock` suite's:
 *
 * - **Call oracles** read which lookup tools the model chose
 *   (`marketplace_recommend`, `connector_list_toolkits`…) and with what
 *   arguments, through the shared reader that joins streamed argument pieces
 *   (`oracles/tool-calls.ts`).
 * - **Reply proxies** read the assistant's text mechanically: a committed list
 *   of app names and a small set of suggestion phrasings. Never a judgment.
 *
 * **What the suggestion phrasings can and cannot see.** {@link SUGGESTION_PATTERNS}
 * is English, phrase-level and short-range. It catches the shapes a suggestion
 * almost always takes ("connect Slack", "install the changelog-writer package",
 * "on the Connections page", "once you connect…", "want me to request…"). It
 * misses a suggestion phrased around it ("Slack would make this one step"), and
 * it can fire on a sentence that only reports ("I could not connect to Slack"
 * reads as "connect … Slack"). So a silent case can fail on a report that was
 * not a suggestion, which is the strict direction, and a talkative case can pass
 * a suggestion it did not see, which is why each "should suggest" case also
 * needs a named app or package, not this list alone. Read a red on a run's
 * transcript before believing it.
 *
 * **No negative case passes on nothing.** Every "stay quiet" case also carries
 * {@link everyTurnAnswered}: each turn ended, none errored, and each said
 * something. An empty or crashed turn is quiet too, and must not score as
 * restraint.
 *
 * Every oracle here has a real PASS and a real FAIL in
 * `suite/__tests__/discovery-oracles.test.ts`.
 *
 * @module evals/suite/discovery-oracles
 */
import type { SseFrame } from '@dorkos/test-utils/sse-test-helpers';
import type { Oracle } from '../types.js';
import { assistantTurns, finalAssistantMessage } from '../oracles/transcript.js';
import { callsTo } from '../oracles/tool-calls.js';
import { observedEntries } from '../oracles/rooms.js';

/** The lookup tools an unprompted suggestion starts from. */
export const DISCOVERY_LOOKUP_TOOLS = [
  'connector_recommend',
  'connector_list_toolkits',
  'marketplace_recommend',
  'marketplace_search',
  'connectors.request_connection',
] as const;

/** The two marketplace lookups whose arguments name what was looked for. */
const MARKETPLACE_LOOKUPS = ['marketplace_recommend', 'marketplace_search'] as const;

/**
 * Phrasings that make a sentence a suggestion to get something. See the module
 * doc for what they miss and what they over-read.
 */
export const SUGGESTION_PATTERNS: readonly RegExp[] = [
  /\b(connect(ing)?|link(ing)?|add(ing)?|set(ting)? up|hook(ing)? up|install(ing)?|enabl(e|ing))\b[^.!?\n]{0,60}\b(slack|teams|discord|telegram|gmail|outlook|whatsapp|google chat|calendar|package|plugin|skill|connection|app)\b/i,
  /\b(slack|teams|discord|telegram|gmail|package|plugin|skill|app)\b[^.!?\n]{0,40}\b(connected|installed|set up)\b/i,
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

/** Every way `text` names: chat apps first, then the others. */
export function waysNamed(text: string): string[] {
  return [
    ...chatAppsNamed(text),
    ...OTHER_WAYS.filter((way) => way.pattern.test(text)).map((way) => way.name),
  ];
}

/** True when a frame is an `error` event. */
function isError(frame: SseFrame): boolean {
  return (frame.event ?? (frame.data as { type?: string } | undefined)?.type) === 'error';
}

/** How many `turn_end` frames the stream carries. */
function turnEnds(frames: SseFrame[]): number {
  return frames.filter(
    (f) => (f.event ?? (f.data as { type?: string } | undefined)?.type) === 'turn_end'
  ).length;
}

/**
 * Oracle: the drive produced exactly `expected` turns, each ended, none
 * errored, and each said something. What keeps a quiet case from passing on a
 * turn that crashed or said nothing at all.
 *
 * @param expected - How many prompts the case sent (one turn each).
 */
export function everyTurnAnswered(expected = 1): Oracle {
  return async (ctx) => {
    const turns = assistantTurns(ctx.frames);
    const ends = turnEnds(ctx.frames);
    const errors = ctx.frames.filter(isError).length;
    const empty = turns.filter((text) => text.trim().length === 0).length;
    const passed = turns.length === expected && ends === expected && errors === 0 && empty === 0;
    return {
      label: `guard: ${expected} turn(s) ended normally, each with a reply`,
      passed,
      evidence: { turns: turns.length, turnEnds: ends, errors, emptyTurns: empty },
      detail: passed
        ? undefined
        : `saw ${turns.length} turn(s), ${ends} end(s), ${errors} error(s), ${empty} empty`,
    };
  };
}

/** The text of turn `index` (0-based), or `''`. */
function turnText(frames: SseFrame[], index: number): string {
  return assistantTurns(frames)[index] ?? '';
}

/** Oracle: the final reply names exactly one chat app, and says it is theirs to connect. */
export const namesExactlyOneChatApp: Oracle = async (ctx) => {
  const reply = finalAssistantMessage(ctx.frames);
  const apps = chatAppsNamed(reply);
  const suggests = suggestionPhrases(reply).length > 0;
  const passed = apps.length === 1 && suggests;
  return {
    label: 'the reply suggests exactly one chat connection',
    passed,
    evidence: { apps, suggestionPhrases: suggestionPhrases(reply) },
    detail: passed
      ? undefined
      : apps.length !== 1
        ? `the reply names ${apps.length} chat app(s): ${apps.join(', ') || 'none'}`
        : 'the reply names an app but suggests nothing about getting it',
  };
};

/**
 * Oracle: the final reply says where the person decides, the page the rule
 * names.
 *
 * @param page - `Connections` or `Marketplace`.
 */
export function pointsToWhereTheyDecide(page: 'Connections' | 'Marketplace'): Oracle {
  const pattern = new RegExp(`\\b${page}\\b`, 'i');
  return async (ctx) => {
    const passed = pattern.test(finalAssistantMessage(ctx.frames));
    return {
      label: `the reply says they decide on the ${page} page`,
      passed,
      detail: passed ? undefined : `the reply never names ${page}`,
    };
  };
}

/**
 * Oracle: turn `index` suggests a chat connection (an app named, and a
 * suggestion phrasing). The first half of "once, not twice".
 *
 * @param index - The turn, 0-based.
 */
export function suggestsChatAppInTurn(index: number): Oracle {
  return async (ctx) => {
    const text = turnText(ctx.frames, index);
    const apps = chatAppsNamed(text);
    const phrases = suggestionPhrases(text);
    const passed = apps.length > 0 && phrases.length > 0;
    return {
      label: `turn ${index + 1} suggests a chat connection`,
      passed,
      evidence: { apps, phrases },
      detail: passed ? undefined : `turn ${index + 1} suggested no chat connection`,
    };
  };
}

/**
 * Oracle: turn `index` carries no suggestion phrasing. Pass `-1` for the final
 * turn.
 *
 * @param index - The turn, 0-based, or -1 for the last.
 * @param label - What the silence means in this case.
 */
export function noSuggestionInTurn(index: number, label: string): Oracle {
  return async (ctx) => {
    const turns = assistantTurns(ctx.frames);
    const text = index === -1 ? (turns[turns.length - 1] ?? '') : (turns[index] ?? '');
    const phrases = suggestionPhrases(text);
    return {
      label,
      passed: phrases.length === 0,
      evidence: { phrases },
      detail: phrases.length === 0 ? undefined : `suggestion phrasing: ${phrases.join(' | ')}`,
    };
  };
}

/** Oracle: the final reply offers one or two ways, never a menu of three or more. */
export const atMostTwoWays: Oracle = async (ctx) => {
  const ways = waysNamed(finalAssistantMessage(ctx.frames));
  const passed = ways.length >= 1 && ways.length <= 2;
  return {
    label: 'the reply names one or two ways, never a menu',
    passed,
    evidence: { ways },
    detail: passed
      ? undefined
      : ways.length === 0
        ? 'the reply names no way at all'
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

/**
 * Words that say WHY a package would help. A proxy: a reply that names a
 * package with none of them is an ad, not a reason.
 */
const WHY_WORDS =
  /\b(because|so (that|you|it|each|every)|would (help|save|make|let|keep)|helps?|saves?|faster|consisten\w*|every time|each time|same voice|automat\w*)\b/i;

/** A package name as a reply may write it: hyphens, spaces or neither. */
function packagePattern(name: string): RegExp {
  return new RegExp(`\\b${name.split('-').join('[\\s-]?')}\\b`, 'i');
}

/**
 * Oracle: the final reply names `name` and gives a reason. The lookups that
 * found it ride the evidence; a lookup the person never heard about is not a
 * suggestion, so it is not enough on its own.
 *
 * @param name - The package's name, e.g. `changelog-writer`.
 */
export function replyNamesPackageWithWhy(name: string): Oracle {
  return async (ctx) => {
    const reply = finalAssistantMessage(ctx.frames);
    const named = packagePattern(name).test(reply);
    const why = WHY_WORDS.test(reply);
    const lookups = callsTo(ctx.frames, MARKETPLACE_LOOKUPS).map((call) => call.input);
    return {
      label: `the reply names ${name} and says why it would help`,
      passed: named && why,
      evidence: { named, why, lookups },
      detail: named ? (why ? undefined : `names ${name} with no reason`) : `never names ${name}`,
    };
  };
}

/**
 * Oracle: no sentence of the final reply suggests getting `name`. Saying it
 * USED an installed package is fine; telling the person to install it is not.
 *
 * @param name - The package the person already has.
 */
export function noSuggestionToGet(name: string): Oracle {
  const pattern = packagePattern(name);
  return async (ctx) => {
    const sentences = finalAssistantMessage(ctx.frames)
      .split(/(?<=[.!?])\s+|\n+/)
      .filter((s) => pattern.test(s) && (/\binstall/i.test(s) || suggestionPhrases(s).length > 0));
    return {
      label: `the reply never suggests getting ${name}, which they already have`,
      passed: sentences.length === 0,
      evidence: { sentences },
      detail: sentences.length === 0 ? undefined : `suggested: ${sentences[0]}`,
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
function postsBy(ctx: Parameters<Oracle>[0], slug: string): { posts: string[]; seated: boolean } {
  const authorId = ctx.room?.agents[slug];
  if (!authorId) return { posts: [], seated: false };
  const posts = observedEntries(ctx.frames)
    .filter((entry) => entry.authorId === authorId && entry.kind === 'post')
    .map((entry) => entry.text);
  return { posts, seated: true };
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
