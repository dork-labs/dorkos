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
 * So this module never asserts that the cache is cold. It ASKS again: the same
 * `holdOnCacheImpact` call that held the reload in the first place is the only
 * thing that knows, and `held: false` from it means the CLI just applied the
 * reload because nothing was left to disturb. {@link PLUGIN_RELOAD_RECHECK_MS}
 * is therefore only how often to ask, not a claim about anything, and
 * {@link PLUGIN_RELOAD_CEILING_MS} bounds how long the asking may go on before
 * the reload is applied and paid for regardless.
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
 * warm" a few more times before its hour is up or the ceiling below arrives.
 * Each ask is one control round trip and no model tokens, so being generous
 * costs a message on a pipe.
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
 * The longest a reload may be held before it is applied and paid for anyway.
 *
 * A hold is a promise that the session will be quiet soon. Some sessions never
 * are — a room agent answering messages all afternoon, a scheduled task looping
 * — and on a subscription's one-hour cache even a session that DOES go quiet
 * can stay warm far longer than anybody would wait. Without a ceiling the
 * session would run a plugin set the disk no longer matches while the
 * marketplace insists it is installed, and that failure is worse than the bill:
 * the person installed something and nothing happened.
 *
 * Fifteen minutes because it leaves room for two or three rechecks first, so a
 * session that does go cold inside the window still takes the free path — and
 * because it is short enough that the activity record this ends in reads as a
 * wait somebody would recognise rather than an unexplained charge an hour after
 * the install.
 */
export const PLUGIN_RELOAD_CEILING_MS = 15 * 60 * 1000;

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

/** Why a held reload stopped being held. */
export type PluginReloadRelease =
  /**
   * The runtime applied it on a recheck because nothing was left to disturb —
   * the free path, and the only one where the person paid nothing.
   */
  | 'cache-cold'
  /** The hold hit its ceiling and was paid rather than extended. */
  | 'ceiling'
  /** Somebody asked for the reload by hand, which never waits. */
  | 'hand-triggered';

/** One reload that changed a live session's tool list, and what it disturbed. */
export interface PaidPluginReload {
  /** The session that paid for it. */
  readonly sessionId: string;
  /** Whether it waited first, or was applied the moment it was asked for. */
  readonly deferred: boolean;
  /** How long it waited, in ms. Zero when it did not. */
  readonly heldMs: number;
  /** What ended the wait. Undefined when it never waited. */
  readonly release: PluginReloadRelease | undefined;
  /** Input-side tokens the next request re-sends — the size of the bill. */
  readonly contextTokens: number | undefined;
  /** What the CLI said applying would change. */
  readonly impact: PluginReloadCacheImpact;
}

/**
 * The session a held reload was waiting on no longer exists.
 *
 * Its own class because the scheduler must tell it apart from every other
 * failure, and the two lead opposite ways. A session that is GONE has nothing
 * left to apply — its next launch reads the plugin set off disk — so the wait is
 * dropped. A control request that merely went UNANSWERED says nothing about
 * whether the CLI is alive (`sessions/bounded-control.ts`: "which says nothing
 * about whether it ever will"), and dropping the wait on one would strand the
 * reload for the life of that warm process, which is the failure the spec's risk
 * list names first.
 */
export class PluginReloadSessionGoneError extends Error {
  /**
   * Name the session that can no longer be reached.
   *
   * @param sessionId - The session whose query is gone
   */
  constructor(readonly sessionId: string) {
    super(`session ${sessionId} no longer holds a query to reload`);
    this.name = 'PluginReloadSessionGoneError';
  }
}

/** What {@link PluginReloadScheduler} needs from the runtime around it. */
export interface PluginReloadHost {
  /**
   * Ask the runtime again, letting it apply the reload only if doing so is now
   * free.
   *
   * The same `holdOnCacheImpact` call that held it in the first place. This is
   * the ONLY thing that knows whether the cache is cold — see the module header
   * — so the scheduler asks rather than deciding.
   *
   * Rejects with {@link PluginReloadSessionGoneError} when the session can no
   * longer be reached, and with anything else — a control-request timeout, most
   * often — when the ask simply went unanswered. The scheduler drops the wait on
   * the first and keeps it on the second.
   *
   * @param sessionId - The session to ask about
   * @returns True when the runtime applied the reload, meaning it was free
   */
  recheck(sessionId: string): Promise<boolean>;
  /**
   * Apply the reload unconditionally, paying for the cache rebuild.
   *
   * Rejects on the same terms as {@link recheck}.
   *
   * @param sessionId - The session to reload
   */
  applyNow(sessionId: string): Promise<void>;
  /** Write one paid reload to the activity feed. */
  recordPaidReload(entry: PaidPluginReload): void;
}

/** A reload that has been asked for, held, and not yet applied. */
interface PendingReload {
  readonly sessionId: string;
  readonly heldAt: number;
  impact: PluginReloadCacheImpact;
  contextTokens: number | undefined;
  /** When the runtime was last asked whether the cache had gone cold. */
  lastCheckAt: number;
  /** True while a recheck is in flight, so a second timer cannot double-apply. */
  checking: boolean;
  timer: NodeJS.Timeout | undefined;
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

/**
 * The waiting room for reloads that are worth holding.
 *
 * One record per session, one live timer per record, and no polling: the timer
 * is set for the earlier of "the cache goes cold" and "the hold runs out", and
 * re-arms itself when the session turns out to have kept working. A session that
 * ends takes its record with it.
 *
 * Nothing in here decides WHETHER to hold — {@link pluginReloadIsWorthHolding}
 * does, at the call site that has the numbers. This only owns the waiting.
 */
export class PluginReloadScheduler {
  private readonly pending = new Map<string, PendingReload>();

  /**
   * Build a waiting room around the runtime that owns the sessions.
   *
   * @param host - How to ask whether a reload has become free, how to apply one
   *   regardless, and where to record what was paid
   * @param now - The clock, injectable so tests do not have to wait fifteen
   *   minutes. Defaulted as a CALL of `Date.now` rather than a reference to it:
   *   a captured reference is bound to the `Date` that existed at construction,
   *   which is the real one even after a test replaces the global — the timers
   *   would then be fake while the clock they are checked against stayed real,
   *   and every deadline would look like it had not arrived.
   */
  constructor(
    private readonly host: PluginReloadHost,
    private readonly now: () => number = () => Date.now()
  ) {}

  /**
   * Hold a reload the CLI refused to apply, and start waiting for a free moment.
   *
   * A second hold on a session that is already waiting is folded into the first
   * rather than restarting its clock. The newest impact and conversation size
   * win, because they describe what applying would do now.
   *
   * @param input.sessionId - The session that held
   * @param input.impact - What the CLI said applying would change
   * @param input.contextTokens - Size of the conversation at hold time
   */
  hold(input: {
    sessionId: string;
    impact: PluginReloadCacheImpact;
    contextTokens: number | undefined;
  }): void {
    const existing = this.pending.get(input.sessionId);
    if (existing) {
      // MUTATED, never replaced. A recheck in flight holds a reference to this
      // record and compares it by identity to find out whether the session
      // ended underneath it; swapping in a new object would read as "cancelled"
      // and silently abandon the wait. The clock is not restarted either — the
      // ceiling bounds how long this session runs a stale plugin set, and
      // letting each new install push it out would make it unbounded for
      // exactly the busy sessions it exists for.
      existing.impact = input.impact;
      existing.contextTokens = input.contextTokens;
      if (!existing.checking && existing.timer === undefined) this.arm(existing);
      return;
    }
    const now = this.now();
    const record: PendingReload = {
      sessionId: input.sessionId,
      heldAt: now,
      impact: input.impact,
      contextTokens: input.contextTokens,
      lastCheckAt: now,
      checking: false,
      timer: undefined,
    };
    this.pending.set(input.sessionId, record);
    this.arm(record);
  }

  /** Whether this session is waiting on a held reload. */
  isHolding(sessionId: string): boolean {
    return this.pending.has(sessionId);
  }

  /**
   * Close the books on a session whose reload has just been applied by somebody
   * else — the hand-triggered route, which never waits.
   *
   * Disarms the timer and writes the one activity record the wait had been
   * saving up. A no-op for a session that was not waiting, so the caller does
   * not have to ask first — but it SAYS so, because a reload that was never
   * held can still be expensive enough to deserve a record of its own, and only
   * the caller knows that.
   *
   * @param sessionId - The session whose reload just landed
   * @param release - What ended the wait
   * @returns True when a wait was actually running, so the caller can tell a
   *   settled hold from a reload that was never held and decide for itself
   *   whether that one is worth recording
   */
  settle(sessionId: string, release: PluginReloadRelease): boolean {
    const record = this.take(sessionId);
    if (!record) return false;
    this.host.recordPaidReload({
      sessionId,
      deferred: true,
      heldMs: this.now() - record.heldAt,
      release,
      contextTokens: record.contextTokens,
      impact: record.impact,
    });
    return true;
  }

  /**
   * Forget a session's held reload without applying it.
   *
   * For a session that ended: its process is gone, and the next launch reads the
   * plugin set off disk, so there is nothing left to apply and nothing was paid.
   * No activity record — nothing happened.
   *
   * @param sessionId - The session that ended
   */
  cancel(sessionId: string): void {
    this.take(sessionId);
  }

  /** Forget every held reload. For shutdown and for tests. */
  cancelAll(): void {
    for (const sessionId of [...this.pending.keys()]) this.take(sessionId);
  }

  /** Lift a record out of the map, disarming its timer. */
  private take(sessionId: string): PendingReload | undefined {
    const record = this.pending.get(sessionId);
    if (!record) return undefined;
    if (record.timer) clearTimeout(record.timer);
    this.pending.delete(sessionId);
    return record;
  }

  /**
   * Set the one timer this record gets: the earlier of its next recheck and its
   * ceiling.
   *
   * Unreffed, because a held reload is never a reason to keep the process alive.
   */
  private arm(record: PendingReload): void {
    if (record.timer) clearTimeout(record.timer);
    const wait = Math.max(0, this.nextCheckAt(record) - this.now());
    const timer = setTimeout(() => {
      void this.onDeadline(record.sessionId);
    }, wait);
    timer.unref?.();
    record.timer = timer;
  }

  /** The earlier of the next recheck and the ceiling, as an absolute time. */
  private nextCheckAt(record: PendingReload): number {
    return Math.min(
      record.heldAt + PLUGIN_RELOAD_CEILING_MS,
      record.lastCheckAt + PLUGIN_RELOAD_RECHECK_MS
    );
  }

  /**
   * The timer fired: at the ceiling pay for it, otherwise ASK whether it is
   * free yet.
   *
   * The asking is the whole point, and it is why nothing here consults a clock
   * to decide whether the cache is cold. Only the runtime knows — the lifetime
   * is an hour on a subscription and five minutes on an API key, and DorkOS
   * chose neither (module header). `held: false` means the runtime just applied
   * the reload BECAUSE there was nothing left to disturb, which is both the
   * answer and the action in one round trip. `held: true` means still warm, and
   * the wait resumes.
   *
   * The record stays in the map across the round trip, marked `checking`, so a
   * session that ends mid-flight is still found by {@link cancel} and a second
   * timer cannot start a second call.
   */
  private async onDeadline(sessionId: string): Promise<void> {
    const record = this.pending.get(sessionId);
    if (!record || record.checking) return;
    if (record.timer) clearTimeout(record.timer);
    record.timer = undefined;
    record.checking = true;
    const atCeiling = this.now() - record.heldAt >= PLUGIN_RELOAD_CEILING_MS;
    let release: PluginReloadRelease;
    try {
      if (atCeiling) {
        await this.host.applyNow(sessionId);
        release = 'ceiling';
      } else if (await this.host.recheck(sessionId)) {
        release = 'cache-cold';
      } else {
        this.waitAgain(record);
        return;
      }
    } catch (err) {
      this.afterFailedAttempt(record, atCeiling, err);
      return;
    }
    // Only the OWNER of this record accounts for it. A hand trigger or an
    // eviction that landed while the round trip was in the air has already
    // taken it and decided — recorded the reload itself, or deliberately not
    // recorded it — and a second entry here would bill one reload twice.
    if (this.take(sessionId) !== record) return;
    this.host.recordPaidReload({
      sessionId,
      deferred: true,
      heldMs: this.now() - record.heldAt,
      release,
      contextTokens: record.contextTokens,
      impact: record.impact,
    });
  }

  /**
   * The runtime says the cache is still warm: wait out another interval.
   *
   * Unless the session ended while the round trip was in the air, in which case
   * there is nothing left to put back — the record was taken, and re-arming
   * would resurrect a wait somebody cancelled.
   */
  private waitAgain(record: PendingReload): void {
    if (this.pending.get(record.sessionId) !== record) return;
    record.checking = false;
    record.lastCheckAt = this.now();
    this.arm(record);
  }

  /**
   * An attempt threw. Decide whether the wait survives it.
   *
   * The two failures are opposite, and treating them alike is how a reload gets
   * stranded. A session that is GONE has nothing left to apply, so the wait is
   * dropped and nothing is recorded — nothing was paid, and the next launch
   * reads the plugin set off disk. A control request that went UNANSWERED says
   * nothing about whether the CLI is alive; giving up on one would leave this
   * warm process on a stale plugin set for the rest of its life with nothing
   * scheduled to try again. So the wait is kept and asked again next interval,
   * still bounded by the ceiling.
   *
   * At the ceiling a failure is terminal either way: that attempt WAS the
   * bound, and re-arming past it would make the ceiling unbounded — which is
   * the one thing it exists to prevent.
   *
   * **What that costs, deliberately.** A ceiling apply that merely went
   * unanswered — the CLI alive but not answering inside the bound — drops the
   * wait with nothing applied and nothing recorded, so recovery falls to the
   * warm-process pin re-asking on the session's next dispatch. A session that
   * then never dispatches again keeps its stale plugin set until its process is
   * replaced. That is accepted rather than overlooked: the alternative is a
   * retry loop with no bound at all, and the cost is confined to a session
   * nobody is using, where a stale plugin set changes nothing anybody sees. The
   * debug line above is the trace, and the next launch reads plugins off disk.
   */
  private afterFailedAttempt(record: PendingReload, atCeiling: boolean, err: unknown): void {
    const gone = err instanceof PluginReloadSessionGoneError;
    logger.debug('[plugin-reload] a held reload attempt failed', {
      sessionId: record.sessionId,
      atCeiling,
      gone,
      error: err instanceof Error ? err.message : String(err),
    });
    if (gone || atCeiling) {
      this.take(record.sessionId);
      return;
    }
    this.waitAgain(record);
  }
}
