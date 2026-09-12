/**
 * When a plugin reload is worth paying for, and when it is worth waiting for
 * (spec `plugin-reload-cache-cost`).
 *
 * ## What a reload costs
 *
 * Changing a live session's tool list throws away the prompt cache the
 * conversation had built up. The next turn re-reads the whole conversation, and
 * the person pays for those tokens and waits for them. Installing a plugin
 * triggers that on every open session at once, which is why an action that felt
 * free can be the most expensive moment of the day.
 *
 * Since SDK 0.3.268 the CLI will run that check for us:
 * `reloadPlugins({ holdOnCacheImpact: true })` applies nothing and answers
 * `held: true` when applying WOULD change the tool list while the cache depends
 * on it. Calling again without the option applies it anyway. So the protocol is
 * two calls: ask what it would disturb, then decide.
 *
 * ## The only free moment is a cold cache, and only the CLI knows when that is
 *
 * Waiting for "the end of this turn" saves nothing — the cost is paid on the
 * next turn whichever side of a turn boundary the reload lands on. The one
 * moment a reload is genuinely free is when the cache has ALREADY expired, so
 * the next turn re-reads the conversation regardless and changing the tool list
 * first adds nothing to the bill.
 *
 * **DorkOS cannot work out when that is, and must not try.** The cache lifetime
 * is not a constant: `Options.promptCacheTtl` is `'5m' | '1h'`, DorkOS sets
 * neither it nor `CLAUDE_CODE_PROMPT_CACHE_TTL`, and unset means AUTOMATIC —
 * one hour on a Claude subscription inside its usage limits, five minutes on an
 * API key, Bedrock, Vertex or Foundry (`sdk.d.ts`, `promptCacheTtl`). The
 * signed-in subscription is DorkOS's main path, so a rule like "idle for five
 * minutes, therefore cold" would pay for a rebuild during the other
 * fifty-five and then file an activity record calling it free.
 *
 * So nothing here may ever assert that the cache is cold. The only thing that
 * knows is the `holdOnCacheImpact` call itself, and asking it again is what a
 * later piece of work does with the answer. This module establishes the
 * question, the threshold that decides whether the answer is worth acting on,
 * and the measurement that will let that threshold stop being a guess.
 *
 * ## What the runtime does NOT tell us
 *
 * The held response carries `cache_impact` with three fields —
 * `mcp_servers_added`, `mcp_servers_removed`, `lsp_tool_change` — and **no
 * dollar figure**. (An earlier reading of the upgrade notes claimed an
 * `estimated_cache_write_usd` on this response; that field belongs to the
 * model-switch hook inputs, not to this one. Verified against the SDK's
 * `SDKControlReloadPluginsResponse` and against the CLI binary's own schema for
 * it.) Those three fields say WHAT would change; they say nothing about how
 * much it would cost, and every held reload has them set by definition.
 *
 * So the size of the bill has to come from the only thing that actually drives
 * it: how big the conversation is. A re-read of a three-message chat is
 * rounding error; a re-read of a day-long session is real money and a real
 * wait. DorkOS already knows that number for free, with no extra round trip —
 * the last main-thread request's input-side tokens
 * (`AgentSession.lastRequestUsage`, summed by `sumContextTokens`) are the
 * tokens the next request re-sends. That is the threshold this module compares,
 * and it is deliberately a token count rather than a converted price: DorkOS
 * ships no model price list, and inventing one would dress a guess up as a
 * fact.
 *
 * @module services/runtimes/claude-code/messaging/plugin-reload-policy
 */
import { logger } from '../../../../lib/logger.js';
import { sumContextTokens } from '../sdk/context-tokens.js';

/**
 * How often a held reload asks the runtime whether the cache has gone cold yet.
 *
 * **An interval, not a lifetime.** Nothing here knows how long this session's
 * prompt cache lives — see the module header: unset means automatic, which is
 * an hour on a subscription and five minutes on an API key, and DorkOS sets
 * nothing. The answer comes from asking, so this number only decides the
 * granularity of the asking.
 *
 * Five minutes because it is the SHORTEST lifetime the runtime ever chooses:
 * asking that often means an API-key session never misses its free moment by
 * more than one interval, while a subscription session simply answers "still
 * warm" a few more times. Each ask is one control round trip and no model
 * tokens, so being generous costs a message on a pipe.
 */
export const PLUGIN_RELOAD_RECHECK_MS = 5 * 60 * 1000;

/**
 * How large a conversation has to be before a reload is worth holding, measured
 * in the input-side tokens the next request would re-send.
 *
 * Below this the re-read is small enough that nobody notices it in their bill
 * or in their wait, and holding would cost more in staleness than it saves — a
 * short session should just take the new plugin and get on with it. At or above
 * it, the re-read is worth waiting for a free moment.
 *
 * **Twenty-five thousand tokens is a placeholder, and deliberately a round
 * one.** Nobody has measured the distribution of real reloads yet, which is why
 * every hold check writes its numbers to the debug log
 * ({@link logCacheImpactMeasurement}): the point of that log is to replace this
 * guess with a number read off real sessions. For scale, 25k tokens is a
 * conversation of a few dozen exchanges, and re-caching it costs single-digit
 * cents at the cache-write rates current when this was written — small enough
 * to spend without asking, large enough that ten sessions of it is a number
 * somebody would notice.
 *
 * A token count rather than a price on purpose: see this module's header. Cost
 * is monotone in tokens, so a threshold here orders reloads the same way a
 * dollar threshold would, without DorkOS having to keep a price list current.
 */
export const PLUGIN_RELOAD_SILENT_TOKENS = 25_000;

/**
 * What applying a held reload would change in the session's tool list, as the
 * CLI reported it.
 *
 * Plugin-authored strings, per the SDK's own warning on the field — recorded and
 * logged, never rendered.
 */
export interface PluginReloadCacheImpact {
  /** Scoped `plugin:<plugin>:<server>` names the reload would register. */
  readonly mcpServersAdded: readonly string[];
  /** Scoped `plugin:<plugin>:<server>` names the reload would drop. */
  readonly mcpServersRemoved: readonly string[];
  /** Whether the LSP tool would come or go; `may-` means the preview could not be sure. */
  readonly lspToolChange: 'adds' | 'may-add' | 'removes' | 'may-remove' | null;
}

/** Enough of a session to read its conversation's size from. */
export interface ConversationSized {
  /** Input-side usage of the last main-thread request (`AgentSession`). */
  readonly lastRequestUsage?:
    | {
        inputTokens?: number | null;
        cacheReadTokens?: number | null;
        cacheCreationTokens?: number | null;
      }
    | undefined;
}

/**
 * How many tokens the next request on this session would re-send.
 *
 * The one place the threshold's input is read, so the fan-out, the warm-process
 * pin and the hand-triggered route cannot disagree about how big a conversation
 * is.
 *
 * **Input-side only, which is deliberately NOT what the SDK means by
 * `context_tokens`.** The SDK's own figure (the model-switch hook input) adds
 * the last response's OUTPUT tokens to the same three input terms. This uses
 * `sumContextTokens`, the repo's single definition of context-window occupancy,
 * which omits them — so the number here is a little smaller than the SDK's on
 * the same conversation. That is the right trade for a threshold: it is the
 * figure every other context read in this runtime already shows, and being
 * consistent with them matters more than matching a hook DorkOS does not
 * register. It also errs towards applying rather than holding, which is the
 * cheaper mistake.
 *
 * @param session - The session to size up
 * @returns The token count, or undefined when no request has completed yet
 */
export function conversationTokens(session: ConversationSized): number | undefined {
  return session.lastRequestUsage ? sumContextTokens(session.lastRequestUsage) : undefined;
}

/**
 * Is this conversation big enough that re-reading it is worth waiting for?
 *
 * The whole of the threshold, kept as one exported function so the comparison
 * has exactly one home and a test can pin both sides of it.
 *
 * An UNKNOWN size answers no. A session with no completed request yet has
 * nothing cached worth protecting, and guessing "expensive" from an absence
 * would hold reloads on brand-new sessions — the cheapest case there is. When
 * DorkOS cannot tell, it does what it has always done and applies at once.
 *
 * @param contextTokens - Input-side tokens the next request re-sends, or
 *   undefined when the session has not completed a request yet
 * @returns True to hold the reload, false to apply it now
 */
export function pluginReloadIsWorthHolding(contextTokens: number | undefined): boolean {
  if (contextTokens === undefined) return false;
  return contextTokens >= PLUGIN_RELOAD_SILENT_TOKENS;
}

/**
 * Write one hold check's numbers to the debug log.
 *
 * Every reload that asks the cache-impact question is logged, whether it was
 * held or waved through, because the measurement is the point: the threshold
 * above is a guess until somebody reads a week of these and replaces it. Debug
 * rather than info — this fires on every open session for every install, and
 * nothing here is news to a person who did not go looking.
 *
 * @param entry.sessionId - The session the check ran on
 * @param entry.held - What the CLI decided
 * @param entry.contextTokens - Size of the conversation at that moment
 * @param entry.impact - The three cache-impact fields, when the CLI sent them
 */
export function logCacheImpactMeasurement(entry: {
  sessionId: string;
  held: boolean;
  contextTokens: number | undefined;
  impact: PluginReloadCacheImpact | undefined;
}): void {
  logger.debug('[plugin-reload] cache-impact check', {
    sessionId: entry.sessionId,
    held: entry.held,
    contextTokens: entry.contextTokens,
    threshold: PLUGIN_RELOAD_SILENT_TOKENS,
    mcpServersAdded: entry.impact?.mcpServersAdded ?? [],
    mcpServersRemoved: entry.impact?.mcpServersRemoved ?? [],
    lspToolChange: entry.impact?.lspToolChange ?? null,
  });
}

/**
 * Read the CLI's `cache_impact` into the shape this module records.
 *
 * Tolerant of a missing or partial object rather than trusting the response:
 * `held: true` without `cache_impact` is a shape the SDK's own types allow, and
 * a hold is still a hold when the CLI declined to say what it would disturb.
 *
 * @param raw - The `cache_impact` field of a held reload response
 * @returns The three fields, with empty lists and a null change for anything absent
 */
export function readCacheImpact(raw: unknown): PluginReloadCacheImpact {
  const source = (raw ?? {}) as {
    mcp_servers_added?: unknown;
    mcp_servers_removed?: unknown;
    lsp_tool_change?: unknown;
  };
  const names = (value: unknown): readonly string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  const change = source.lsp_tool_change;
  return {
    mcpServersAdded: names(source.mcp_servers_added),
    mcpServersRemoved: names(source.mcp_servers_removed),
    lspToolChange:
      change === 'adds' || change === 'may-add' || change === 'removes' || change === 'may-remove'
        ? change
        : null,
  };
}
