/**
 * Rung 1 of a beat's triage on DorkOS credits (spec `heartbeats` §6.3; ADR
 * `261001-000811` as amended by `261010-092116`), and where checks run right
 * now.
 *
 * ## When it exists
 *
 * Only when every one of these holds, read fresh on each beat:
 *
 * - a person answered the offer with **Use credits** (`heartbeats.triageOnCredits`
 *   is `true`; `null` and `false` spend nothing);
 * - credits are not switched off on this computer (`DORKOS_CLOUD_CREDITS`, the
 *   existing kill switch, read once at module scope by `credits-availability`);
 * - this computer is linked to a DorkOS account;
 * - a live held token lists `openaiChat` in `served`;
 * - the service names a model it recommends on `openaiChat`;
 * - the endpoint has not refused this token (401, 402 or 403) in the last
 *   {@link REFUSED_HOLD_MS};
 * - the daily fuse ({@link TRIAGE_FUSE} requests per server per UTC day, an
 *   ask-twice counting two, seeded at startup from the beat record) has not
 *   blown. Past it nothing more is sent, not even the second half of a call.
 *
 * Otherwise rung 1 is absent: the rules decide what they can and the rest goes
 * to a turn on the agent's own runtime.
 *
 * ## The token is a credential
 *
 * It is read per request through the `token` port (`heldCreditsToken()` in
 * production), so a re-minted token is picked up by the next call without a new
 * bridge. It is never stored here, never logged, and never put in an error, a
 * record line or a beat row: the only thing that sees it is the request header.
 *
 * ## The switch is recorded once
 *
 * When where checks run changes (credits drop out mid-day because the choice,
 * the link or the token went away, the endpoint refused the token, or the fuse
 * blew; or they come back), one
 * `heartbeat.triage_source_changed` row says so. Not on every beat.
 *
 * @module services/decisions/triage-credits
 */
import {
  createOpenAiCompatibleModel,
  type DailyCallCounter,
  type FetchLike,
} from '@dorkos/decisions';
import type { DecisionModel } from '@dorkos/shared/decision-model';
import { TRIAGE_FUSE } from './heartbeat-triage.js';

/** The output limit of one check: a forced JSON answer naming one label. */
export const TRIAGE_MAX_TOKENS = 64;

/** Why checks run where they do. */
export type TriageSourceReason =
  | 'credits'
  | 'not-chosen'
  | 'switched-off'
  | 'not-linked'
  | 'no-token'
  | 'not-served'
  | 'no-model'
  | 'refused'
  | 'fuse';

/** Where checks run right now, and why. */
export interface TriageSource {
  /** On DorkOS credits, or on each agent's own runtime. */
  runsOn: 'credits' | 'runtime';
  /** Why. */
  reason: TriageSourceReason;
}

/** The held token, as much of it as this module reads. */
export interface HeldToken {
  /** The token's id: not a secret, and what tells a re-minted token from a refused one. */
  tokenId?: string;
  /** The credential. Read only to build one request's header. */
  token: string;
  /** Where each request format goes. */
  endpoints: { openaiChat: string };
  /** The formats it may be used for; absent means `anthropicMessages` only. */
  served?: readonly string[];
}

/** What rung 1 reads from the rest of the server. Injected so tests never reach the network. */
export interface CreditsTriagePorts {
  /** `heartbeats.triageOnCredits`: `true` only after a person said **Use credits**. */
  choice(): boolean | null;
  /** Whether `DORKOS_CLOUD_CREDITS` switched credits off. */
  killed(): boolean;
  /** Whether this computer is linked to a DorkOS account. */
  linked(): boolean;
  /** The live held token, or null. Read on every request; never kept. */
  token(): HeldToken | null;
  /** The model the service recommends on `openaiChat`, or null. */
  recommendedModel(): Promise<string | null>;
  /** The fetch the bridge calls. */
  fetch: FetchLike;
  /** Record that where checks run changed. */
  recordSourceChange(from: TriageSource, to: TriageSource): void;
}

/** How long a refusal by the endpoint keeps checks off credits, for the same token. */
export const REFUSED_HOLD_MS = 15 * 60 * 1000;

/** Statuses that mean the endpoint refused this token, not that it was briefly down. */
const REFUSAL_STATUSES: ReadonlySet<number> = new Set([401, 402, 403]);

/** One beat's credits bridge, and how many requests it sent. */
export interface CreditsCheck {
  /** The decision model for rung 1. */
  model: DecisionModel;
  /** Requests this beat's checks sent to the endpoint so far. */
  requests(): number;
}

/** Rung 1 on credits, with the fuse and the once-per-change record. */
export class CreditsTriage {
  private last: TriageSource | undefined;
  private readonly requestsByDay = new Map<string, number>();
  private refused: { tokenId: string | null; at: number } | undefined;

  /**
   * The fuse as the ladder reads it: today's requests, never incremented by
   * the ladder, because one call may send two requests (an ask-twice).
   */
  readonly counter: DailyCallCounter = {
    count: (_useCase, rung, day) => (rung === 1 ? (this.requestsByDay.get(day) ?? 0) : 0),
    increment: () => undefined,
  };

  /**
   * Build it.
   *
   * @param ports - What it reads.
   * @param opts - The clock, and requests already sent today (read from the
   *   beat record at startup, so a restart does not reset the fuse).
   * @param opts.now - The clock.
   * @param opts.requestsToday - Requests sent earlier today (UTC).
   */
  constructor(
    private readonly ports: CreditsTriagePorts,
    opts: { now?: () => number; requestsToday?: number } = {}
  ) {
    this.now = opts.now ?? Date.now;
    if (opts.requestsToday) this.requestsByDay.set(this.day(), opts.requestsToday);
  }

  private readonly now: () => number;

  /** Requests sent to the endpoint today (UTC), across every agent on this server. */
  requestsToday(): number {
    return this.requestsByDay.get(this.day()) ?? 0;
  }

  /**
   * Where checks run right now, and why. Reads only local state and the cached
   * model list; spends nothing.
   */
  async source(): Promise<TriageSource & { endpoint?: string; model?: string }> {
    const runtime = (reason: TriageSourceReason) => ({ runsOn: 'runtime' as const, reason });
    if (this.ports.choice() !== true) return runtime('not-chosen');
    if (this.ports.killed()) return runtime('switched-off');
    if (!this.ports.linked()) return runtime('not-linked');
    const token = this.ports.token();
    if (!token) return runtime('no-token');
    if (!(token.served ?? []).includes('openaiChat')) return runtime('not-served');
    if (this.refusedFor(token)) return runtime('refused');
    const model = await this.ports.recommendedModel();
    if (!model) return runtime('no-model');
    if (this.requestsToday() >= TRIAGE_FUSE) return runtime('fuse');
    return { runsOn: 'credits', reason: 'credits', endpoint: token.endpoints.openaiChat, model };
  }

  /**
   * This beat's credits bridge, or undefined when checks do not run on credits
   * right now. Notes a change of source once.
   */
  async bridge(): Promise<CreditsCheck | undefined> {
    const found = await this.source();
    this.note({ runsOn: found.runsOn, reason: found.reason });
    if (found.runsOn !== 'credits' || !found.endpoint || !found.model) return undefined;
    let sent = 0;
    const fetch: FetchLike = async (url, init) => {
      // The fuse holds per request: past it nothing more is sent today.
      if (this.requestsToday() >= TRIAGE_FUSE) {
        return { ok: false, status: 429, json: async () => ({}) };
      }
      const tokenId = this.ports.token()?.tokenId ?? null;
      this.requestsByDay.set(this.day(), this.requestsToday() + 1);
      sent += 1;
      const res = await this.ports.fetch(url, init);
      if (REFUSAL_STATUSES.has(res.status)) this.refuse(tokenId);
      return res;
    };
    const model = createOpenAiCompatibleModel({
      baseUrl: found.endpoint,
      model: found.model,
      id: `dorkos-credits:${found.model}`,
      // Read on every request, so a re-minted token is used at once and
      // a dropped one sends nothing (the ask is an outage, so unsure).
      apiKey: () => {
        const held = this.ports.token();
        if (!held) throw new Error('No credits token is held.');
        return held.token;
      },
      maxTokens: TRIAGE_MAX_TOKENS,
      fetch,
      // One beat's check is one or two requests; a refusal is held across
      // beats above, so a breaker per beat would add nothing.
      circuitBreaker: false,
    });
    return { model, requests: () => sent };
  }

  /** The endpoint refused this token: checks leave credits, recorded once. */
  private refuse(tokenId: string | null): void {
    this.refused = { tokenId, at: this.now() };
    this.note({ runsOn: 'runtime', reason: 'refused' });
  }

  /** Whether the endpoint refused this same token recently. A new token gets a fresh try. */
  private refusedFor(token: HeldToken): boolean {
    const refused = this.refused;
    if (!refused) return false;
    if (refused.tokenId !== (token.tokenId ?? null) || this.now() - refused.at >= REFUSED_HOLD_MS) {
      this.refused = undefined;
      return false;
    }
    return true;
  }

  /** Record a change of source once; the first look is not a change. */
  private note(next: TriageSource): void {
    const before = this.last;
    this.last = next;
    if (before && before.runsOn !== next.runsOn) this.ports.recordSourceChange(before, next);
  }

  /** Today's UTC day key, as the ladder counts it. */
  private day(): string {
    return new Date(this.now()).toISOString().slice(0, 10);
  }
}
