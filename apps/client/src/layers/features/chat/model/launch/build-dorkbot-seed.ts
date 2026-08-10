/**
 * The hidden preamble Ask DorkBot attaches to its first turn (BC-48).
 *
 * Pressing ✦ Ask DorkBot opens a fresh DorkBot conversation that already knows
 * the situation: which page the operator was on, how big their fleet is, which
 * version they are running, and which conversations just failed. None of that is typed
 * — the composer stays empty and focused, and this string rides the send as
 * `seedContext`, which the server renders into a `<seed_context>` block the
 * person never sees.
 *
 * **It is context, not privilege.** Everything here is composed from state the
 * client can already see on screen, so it tells the agent nothing the operator
 * could not have typed themselves, and it rides the same untrusted-content
 * fence every other context block does.
 *
 * **Omission, never a guess.** A fact the client cannot establish (no origin
 * after a reload, a config query that has not answered) contributes no line at
 * all. A seed that invents the page somebody came from is worse than a seed
 * that does not mention one.
 *
 * @module features/chat/model/launch/build-dorkbot-seed
 */
import { SEED_CONTEXT_MAX_LENGTH } from '@dorkos/shared/schemas';

/**
 * How much of the bound the seed may spend.
 *
 * Below `SEED_CONTEXT_MAX_LENGTH` rather than at it: the server rejects a
 * `seedContext` longer than the bound outright (`SendMessageRequestSchema`), so
 * a seed that lands exactly on it has no margin for the trailing marker, and a
 * turn refused by schema validation is a worse outcome than a roster that ends
 * in an ellipsis.
 */
export const DORKBOT_SEED_MAX_LENGTH = SEED_CONTEXT_MAX_LENGTH - 256;

/** The marker a truncated seed ends with, so the agent can see it was cut. */
const TRUNCATION_MARKER = '\n…(context truncated)';

/** What a page's route is called in the seed, for the routes with real names. */
const PAGE_NAMES: Record<string, string> = {
  '/': 'the home team room',
  '/activity': 'the activity feed',
  '/team': 'the team page',
  '/session': 'a chat session',
  '/tasks': 'the scheduled-work page',
  '/channels': 'a channel',
  '/workspaces': 'the workspaces page',
  '/connections': 'the connections page',
  '/marketplace': 'the marketplace',
  '/feedback-requests': 'the feedback requests page',
};

/** Everything the seed is composed from. Each field may be unknown. */
export interface DorkBotSeedFacts {
  /** The route the operator pressed Ask DorkBot on, or `null` if unrecorded. */
  originPath: string | null;
  /** Display names of every registered agent, newest resolution order. */
  agentNames: readonly string[];
  /** The running DorkOS version (`0.58.0`), or `null` before config answers. */
  version: string | null;
  /** True when a newer version is downloaded or published (BC-44's pill state). */
  updateReady: boolean;
  /** Sessions the fleet stream reports as errored — the honest "recent errors". */
  erroredSessionIds: readonly string[];
}

/**
 * Name a route in the language a person would use.
 *
 * @param path - A pathname from the router.
 * @returns A phrase for the page, falling back to the raw path so an unmapped
 *   route still says something true.
 */
function pageName(path: string): string {
  const base = `/${path.split('/').filter(Boolean)[0] ?? ''}`;
  return PAGE_NAMES[path] ?? PAGE_NAMES[base] ?? `the ${path} page`;
}

/**
 * Compose the Ask DorkBot seed.
 *
 * @param facts - What the client knows right now.
 * @returns The seed text, always at most {@link DORKBOT_SEED_MAX_LENGTH}
 *   characters. Never empty: the framing sentence stands on its own, so an
 *   install that knows nothing else still opens a DorkBot who knows why.
 */
export function buildDorkBotSeed(facts: DorkBotSeedFacts): string {
  const lines: string[] = [
    'The person opened this conversation by pressing "Ask DorkBot" in the DorkOS sidebar, so they are asking for help with DorkOS itself. Greet them with what you can see below and offer the next step; do not repeat this back to them.',
  ];

  if (facts.originPath !== null) {
    lines.push(`They were on ${pageName(facts.originPath)} (${facts.originPath}).`);
  }

  lines.push(
    facts.agentNames.length === 1
      ? 'They have 1 agent registered.'
      : `They have ${facts.agentNames.length} agents registered.`
  );
  if (facts.agentNames.length > 0) {
    lines.push(`Their agents: ${facts.agentNames.join(', ')}.`);
  }

  if (facts.version !== null) {
    lines.push(
      facts.updateReady
        ? `They are running DorkOS v${facts.version}, and a newer version is ready to install.`
        : `They are running DorkOS v${facts.version}.`
    );
  }

  if (facts.erroredSessionIds.length > 0) {
    lines.push(
      `These conversations ended in an error and may be what they want help with: ${facts.erroredSessionIds.join(', ')}.`
    );
  }

  const seed = lines.join('\n');
  if (seed.length <= DORKBOT_SEED_MAX_LENGTH) return seed;
  return seed.slice(0, DORKBOT_SEED_MAX_LENGTH - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}
