/**
 * The approval primitive: ask, decide, spend (spec `agent-trust` §3.3).
 *
 * When an agent wants to do something a person should sign off on, it asks here.
 * The service records the request, hands back a one-time token, and announces the
 * pending approval on the global event stream so the cockpit can render a card.
 * The operator grants or denies; the agent retries with its token; the service
 * spends it once and never again.
 *
 * This is the one approval mechanism in DorkOS. The marketplace's confirmation
 * providers are thin wrappers over it (`services/marketplace-mcp/
 * confirmation-provider.ts`), and tier enforcement at the capability choke points
 * (spec §3.2) consumes the same tokens.
 *
 * ## Four properties make a token safe to hand an agent
 *
 * 1. **Hashed at rest.** Only the SHA-256 digest is stored, so a database read
 *    yields nothing presentable. The plaintext is returned exactly once, to the
 *    caller that asked, and is never logged or echoed in a later result.
 * 2. **Single use.** {@link ApprovalService.consume} stamps `consumedAt` on the
 *    row it honors; a replay of the same token reports `consumed`.
 * 3. **Bound to the action.** A token is scoped to `(capabilityId, inputHash)`.
 *    Consent to uninstall one package cannot be redirected at another, because
 *    the retry presents a different hash and the token stops matching.
 * 4. **Expiring, checked when spent.** Expiry is evaluated inside `consume`, not
 *    only by the periodic sweep, so a stale row can never be honored even if no
 *    cleanup has run.
 *
 * A pending token is inert: it only becomes spendable once a person grants it, so
 * handing it to the requester up front costs nothing and lets the agent resume
 * its own flow without the operator shuttling a secret around.
 *
 * ## Synchronous by design
 *
 * Every method is synchronous. The store is better-sqlite3, which is synchronous
 * anyway, and a decision must be visible to the very next read — the cockpit
 * grants, then re-lists; enforcement consumes, then acts. An unawaited promise in
 * either seam would be a race. Callers may still `await` these results harmlessly.
 *
 * @module services/core/approvals/approval-service
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ulid } from 'ulidx';
import { and, asc, eq, isNull, lt, approvals, type Db } from '@dorkos/db';
import type { CapabilityTier } from '@dorkos/shared/capabilities';
import {
  APPROVAL_DETAIL_MAX_LENGTH,
  APPROVAL_SUMMARY_MAX_LENGTH,
  type ApprovalOutcome,
  type PendingApproval,
} from '@dorkos/shared/approval-schemas';
import { broadcastApprovalPending, broadcastApprovalResolved } from './approval-events.js';
import {
  raiseCapabilityApproval,
  resolveCapabilityApproval,
} from '../../notifications/emitters/capability-approval.js';
import { eventFanOut } from '../event-fan-out.js';
import { logger } from '../../../lib/logger.js';
import { redactSecretsInText, renderRequesterLabel } from './approval-summary.js';

/**
 * How long an operator has to decide before a token stops being honored.
 *
 * Two hours, not ten minutes. The window has to survive the operator being away
 * from the screen: a meeting, an errand, an agent that asked at 3am. A request
 * nobody was present for is precisely the case this primitive exists for, and a
 * ten-minute window only ever worked for someone already watching the screen.
 *
 * It deliberately does NOT survive a night's sleep. Consent has to stay
 * contemporaneous with the request a person actually read, so an approval that
 * could still be granted the next day is its own hazard. A longer window would
 * also buy little in practice: the requester has to still be running to spend
 * its token.
 */
export const APPROVAL_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * Shortest decision window this service will run with.
 *
 * Below about a second nobody could answer in time, so a smaller window is not a
 * stricter gate — it is a gate that refuses everything, which looks identical to
 * a broken approval system and teaches an operator to distrust the mechanism.
 * `env.ts` rejects anything under this on the way in; {@link resolveApprovalTtlMs}
 * enforces it again for callers that do not come through the env schema.
 */
export const MIN_APPROVAL_TTL_MS = 1_000;

/**
 * Resolve a configured decision window into a usable one: SHORTENABLE, never
 * lengthenable, never nonsensical.
 *
 * `DORKOS_APPROVAL_TTL_MS` exists so the eval harness can watch an unanswered
 * approval actually run out of time, which is otherwise unobservable: waiting two
 * hours is impossible, and a harness that gave up early would be reporting its own
 * timeout as a governance outcome (DOR-498).
 *
 * The UPPER bound is the security property. Shortening the window makes the gate
 * stricter — consent that has run out is refused rather than honored — while
 * lengthening it would let a "yes" stay spendable long after the moment a person
 * actually meant it, which is the one thing {@link APPROVAL_TTL_MS} is written to
 * prevent. That direction is enforced here rather than trusted to whoever sets the
 * variable.
 *
 * The LOWER bound and the finiteness check are here because this function is
 * exported API, not only a boot-time helper for one env var. `env.ts` already
 * refuses a value below {@link MIN_APPROVAL_TTL_MS}, so today nothing can reach
 * this with `0` or `NaN` — but relying on a validator one layer away would mean a
 * future caller could hand over `0` and get a deny-all gate, or `NaN` and get a
 * `RangeError` out of `new Date(...)` on every destructive capability. A
 * non-finite value takes the safe default rather than throwing, because a
 * malformed setting must not be able to break the gate open OR shut.
 *
 * @param requested - The configured window in ms, or undefined when unset.
 * @returns The window to use, clamped to
 *   `[MIN_APPROVAL_TTL_MS, APPROVAL_TTL_MS]`, or undefined to take the default.
 */
export function resolveApprovalTtlMs(requested: number | undefined): number | undefined {
  if (requested === undefined || !Number.isFinite(requested)) return undefined;
  return Math.min(Math.max(requested, MIN_APPROVAL_TTL_MS), APPROVAL_TTL_MS);
}

/** Bytes of CSPRNG randomness behind an approval token (128 bits). */
const TOKEN_BYTES = 16;

/** What {@link ApprovalService.request} needs to describe a pending action. */
export interface ApprovalRequestInput {
  /** Capability the request would invoke, e.g. `marketplace.uninstall`. */
  capabilityId: string;
  /** Canonical hash of the invocation input (see `hashApprovalInput`). */
  inputHash: string;
  /** One plain sentence describing what the operator is about to allow. */
  summary: string;
  /**
   * The one argument a person has to read IN FULL before answering, verbatim.
   *
   * Supplied only for a capability that declares `approvalDetailField`. It is
   * NOT part of the summary and must not be duplicated into it: the summary is
   * a glanceable sentence with every value capped at 80 characters, which is the
   * bound this field exists to escape (DOR-1698).
   */
  detail?: string;
  /**
   * Opaque label for who asked — an agent path, a display name, whatever the
   * caller has. Never interpreted here, only shown on the card.
   */
  requestedBy?: string;
  /**
   * The stable agent path of whoever asked, when the caller identified itself.
   *
   * Recorded alongside `requestedBy` rather than instead of it, because the two
   * are different things: `requestedBy` is a display label built from a name and
   * swept for secrets, and a label is not a key. A standing permission keys on
   * the agent path, so the card has to carry the real one. Never rendered.
   */
  requestedByPath?: string;
}

/**
 * How the service learns a capability's human-facing title and permission tier.
 *
 * Deliberately NOT part of {@link ApprovalRequestInput}: if a requester could
 * state its own tier, an `act` operation could dress itself as `destructive` to
 * scare an operator, or a `destructive` one could soften itself to look routine.
 * The card's identity region is derived from the capability registry, which is
 * the single source of truth every other agent-facing surface is generated from,
 * so it cannot be spoofed by whoever is asking.
 *
 * Injected as a function rather than a registry import because the registry is
 * composed from the very domains that request approvals — a static import would
 * close a cycle, and the registry is composed later in boot than this service.
 *
 * Deliberately not exported: it is the shape of one option, and no consumer needs
 * to name it.
 *
 * @param capabilityId - The capability id to describe.
 * @returns Its title and tier, or `undefined` when the registry has no such id.
 */
type CapabilityDescriptorLookup = (
  capabilityId: string
) => { title: string; tier: CapabilityTier } | undefined;

/** Construction options for {@link ApprovalService}. */
export interface ApprovalServiceOptions {
  /** How long an operator has to decide. Defaults to {@link APPROVAL_TTL_MS}. */
  ttlMs?: number;
  /**
   * Resolves a capability's title and tier for the card. Omitted in tests and in
   * boots without a registry, where an unknown id falls back to its own id and
   * the most cautious tier.
   */
  describeCapability?: CapabilityDescriptorLookup;
}

/** What a requester gets back: an id to watch, and a token to retry with. */
export interface ApprovalTicket {
  /** ULID of the new approval. Safe to show a person or log. */
  approvalId: string;
  /**
   * The one-time token. This is the ONLY time it is available — it is not stored
   * in recoverable form and must never be logged or returned again.
   */
  token: string;
  /** When the token stops being honored. ISO 8601 UTC. */
  expiresAt: string;
}

/** The action a token must match to be spent. */
export interface ApprovalBinding {
  /** Capability the caller is about to invoke. */
  capabilityId: string;
  /** Canonical hash of the input the caller is about to invoke it with. */
  inputHash: string;
}

/**
 * The outcome of presenting a token, discriminated by `outcome`.
 *
 * - `granted` — the operator said yes and this call spent the token.
 * - `pending` — nobody has decided yet; present the token again later.
 * - `denied` — the operator said no; the token is spent either way.
 * - `expired` — the decision window closed; the token is written off.
 * - `consumed` — already spent (or written off) by an earlier call.
 * - `unknown` — no such token.
 * - `mismatched` — a real, live token for a DIFFERENT action. Deliberately not
 *   spent: the approval stays available for the action it was granted for.
 */
export type ApprovalConsumeResult =
  | { outcome: 'granted'; approvalId: string; capabilityId: string; requestedBy?: string }
  | { outcome: 'pending'; approvalId: string; expiresAt: string }
  | { outcome: 'denied'; approvalId: string; reason?: string }
  | { outcome: 'expired'; approvalId: string }
  | { outcome: 'consumed'; approvalId: string }
  | { outcome: 'unknown' }
  | { outcome: 'mismatched'; approvalId: string };

/**
 * How a hold on {@link ApprovalService.awaitDecision} ended.
 *
 * `granted`/`denied` are an operator decision the caller can resume on; `expired`
 * and `timeout` are the no-decision paths that must degrade a held call back to
 * today's `approval_required` poll payload (`expired`: the token's own window
 * closed; `timeout`: the hold's own cap elapsed or its abort signal fired first).
 */
export type ApprovalDecisionOutcome = 'granted' | 'denied' | 'expired' | 'timeout';

/** Options for {@link ApprovalService.awaitDecision}. */
export interface AwaitDecisionOptions {
  /** Longest the hold waits before it resolves `timeout`. Required — a hold with no cap could outlive the tool call it blocks. */
  timeoutMs: number;
  /** Abort the wait (the SDK aborted the held tool call); resolves `timeout`. */
  signal?: AbortSignal;
}

/**
 * Translate a broadcast {@link ApprovalOutcome} into the caller-facing hold
 * outcome. `consumed` — the token was spent elsewhere while the hold waited —
 * degrades to `expired`: there is nothing left for the caller to resume on, so it
 * falls back to the poll payload exactly as a real expiry would.
 */
function toDecisionOutcome(outcome: ApprovalOutcome | undefined): ApprovalDecisionOutcome {
  switch (outcome) {
    case 'granted':
      return 'granted';
    case 'denied':
      return 'denied';
    case 'expired':
    case 'consumed':
      return 'expired';
    default:
      return 'timeout';
  }
}

/** Hash a token exactly as it is stored: SHA-256, lowercase hex. */
function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Make a summary safe to store: strip anything token-shaped, then shorten it to
 * what a card can hold.
 *
 * Both happen on the way IN rather than at render time. The length cap is because
 * the cockpit parses stored rows against a schema that caps it, so a long sentence
 * has to become a short one here or the card would be dropped instead of shown.
 * The redaction is because this string is broadcast on the global event stream and
 * returned by `GET /api/approvals/pending`, which agents can read — so it is the
 * one place every producer of a summary passes through, including the marketplace
 * confirmation provider, which writes its own sentences.
 */
function storableSummary(summary: string): string {
  return clampForStorage(redactSecretsInText(summary), APPROVAL_SUMMARY_MAX_LENGTH);
}

/**
 * Make a detail safe to store: the same sweep the summary gets, against the
 * detail's own, much larger bound.
 *
 * Same two reasons, in the same order. The sweep is because this string is
 * broadcast on the global event stream and returned by
 * `GET /api/approvals/pending`, which agents can read. The cap is because the
 * cockpit parses stored rows against a schema that caps it, so an over-long
 * value has to shorten here or the whole card is dropped rather than shown —
 * and a dropped card is worse than a shortened one for exactly the reason this
 * field exists.
 *
 * @param detail - The verbatim argument the capability declared.
 * @returns The swept, capped value to store.
 */
function storableDetail(detail: string): string {
  return clampForStorage(redactSecretsInText(detail), APPROVAL_DETAIL_MAX_LENGTH);
}

/**
 * Shorten a value to what its column's schema will parse, marking the cut.
 *
 * @param value - The already-swept string.
 * @param max - The schema's bound for that field.
 * @returns The value, at most `max` characters.
 */
function clampForStorage(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1).trimEnd()}…`;
}

/** A stored approval row, as Drizzle infers it. */
type ApprovalRow = typeof approvals.$inferSelect;

/** Project a stored row into the cockpit-facing shape. Never includes the hash. */
function toPendingApproval(row: ApprovalRow): PendingApproval {
  return {
    approvalId: row.id,
    capabilityId: row.capabilityId,
    capabilityTitle: row.capabilityTitle,
    tier: row.tier,
    summary: row.summary,
    ...(row.detail === null ? {} : { detail: row.detail }),
    ...(row.requestedBy ? { requestedBy: row.requestedBy } : {}),
    // The raw path stays off the wire (see `requestedByPath`'s own comment); what
    // goes out is the one bit a surface needs, which is whether there is one.
    hasAgentPath: row.requestedByPath !== null,
    requestedAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

/**
 * Ask for, decide, and spend approvals. See the module TSDoc for the token
 * contract.
 */
export class ApprovalService {
  /**
   * Build the service over a database handle.
   *
   * @param db - The DorkOS database handle.
   * @param options - TTL and capability-descriptor overrides; see
   *   {@link ApprovalServiceOptions}.
   */
  constructor(
    private readonly db: Db,
    private readonly options: ApprovalServiceOptions = {}
  ) {}

  /** How long an operator has to decide on a request this service records. */
  private get ttlMs(): number {
    return this.options.ttlMs ?? APPROVAL_TTL_MS;
  }

  /**
   * Record a request for approval and announce it to the cockpit.
   *
   * The title and tier on the card come from the capability registry, never from
   * the requester (see {@link CapabilityDescriptorLookup}). An id the registry
   * does not know falls back to the id itself and the most cautious tier, so an
   * unrecognized capability over-warns rather than under-warns.
   *
   * @param input - What is being asked, and who is asking.
   * @returns The approval id and the one-time token for the retry.
   */
  request(input: ApprovalRequestInput): ApprovalTicket {
    const token = randomBytes(TOKEN_BYTES).toString('hex');
    const now = Date.now();
    const descriptor = this.options.describeCapability?.(input.capabilityId);
    const row = {
      id: ulid(),
      tokenHash: hashToken(token),
      capabilityId: input.capabilityId,
      capabilityTitle: descriptor?.title ?? input.capabilityId,
      tier: descriptor?.tier ?? ('destructive' as const),
      inputHash: input.inputHash,
      summary: storableSummary(input.summary),
      // Absent for every capability that declares no detail field, which is all
      // but one — `null` rather than `undefined` so the column is written.
      detail: input.detail === undefined ? null : storableDetail(input.detail),
      // Caller-supplied, so capped and swept for secrets exactly like the summary.
      requestedBy: input.requestedBy ? renderRequesterLabel(input.requestedBy) : null,
      // Stored raw and never rendered: this is the key a standing permission is
      // built on, so sweeping or shortening it would break the match.
      requestedByPath: input.requestedByPath ?? null,
      state: 'pending' as const,
      denyReason: null,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlMs).toISOString(),
      decidedAt: null,
      consumedAt: null,
    };
    this.db.insert(approvals).values(row).run();

    const pending = toPendingApproval(row);
    broadcastApprovalPending(pending);
    // The escalation clock starts HERE, at the write that creates the condition
    // — the same place a parked schedule arms one, and for the same reason: an
    // approval has no observer seam, so the hook belongs at the write. This is
    // also what announces the arrival to the desktop shell, which has no
    // cockpit query to derive it from (DOR-1570). Nothing is STORED at this
    // edge: `approval.pending` is a standing kind, and standing kinds write
    // nothing while they stand (ADR 260819-234828).
    //
    // The raw path rather than the card's label, because the label is display
    // text and the escalation needs the key the agent registry joins on.
    raiseCapabilityApproval(pending, input.requestedByPath);

    return { approvalId: row.id, token, expiresAt: row.expiresAt };
  }

  /**
   * Record the operator's yes.
   *
   * @param approvalId - ULID of the approval to grant.
   * @returns Why the call failed, or `undefined` when the approval is now granted.
   */
  grant(approvalId: string): ApprovalDecisionFailure | undefined {
    return this.decide(approvalId, 'granted');
  }

  /**
   * Record the operator's no.
   *
   * @param approvalId - ULID of the approval to deny.
   * @param reason - Optional note the requester sees instead of a bare refusal.
   * @returns Why the call failed, or `undefined` when the approval is now denied.
   */
  deny(approvalId: string, reason?: string): ApprovalDecisionFailure | undefined {
    return this.decide(approvalId, 'denied', reason);
  }

  /**
   * Present a token for the action it was granted for.
   *
   * Expiry is checked here — before the binding — so a stale row is written off
   * rather than honored even when no sweep has run, and a caller learns that its
   * token ran out of time instead of being sent chasing an argument mismatch. A
   * live token that resolves to a real approval for a DIFFERENT action reports
   * `mismatched` and is deliberately left unspent — the approval stays available
   * for what the operator actually allowed.
   *
   * Spending is a conditional write, so two callers presenting the same token at
   * once cannot both be told `granted`: exactly one wins the row, the other reads
   * `consumed`.
   *
   * @param token - The token the requester was handed.
   * @param binding - The capability and input hash the caller is about to run.
   * @returns What presenting the token achieved.
   */
  consume(token: string, binding: ApprovalBinding): ApprovalConsumeResult {
    const row = this.findByToken(token);
    if (!row) return { outcome: 'unknown' };
    if (row.consumedAt) return { outcome: 'consumed', approvalId: row.id };

    // Expiry is checked BEFORE the binding, so a stale token reports what is
    // actually wrong with it. Told `mismatched` first, a caller would keep
    // rebuilding its arguments to chase a token that had already run out of time.
    if (this.isExpired(row)) {
      if (!this.markConsumed(row.id)) return { outcome: 'consumed', approvalId: row.id };
      this.settle(row.id, 'expired');
      return { outcome: 'expired', approvalId: row.id };
    }

    if (row.capabilityId !== binding.capabilityId || row.inputHash !== binding.inputHash) {
      return { outcome: 'mismatched', approvalId: row.id };
    }

    if (row.state === 'pending') {
      return { outcome: 'pending', approvalId: row.id, expiresAt: row.expiresAt };
    }

    if (!this.markConsumed(row.id)) return { outcome: 'consumed', approvalId: row.id };
    this.settle(row.id, 'consumed');

    if (row.state === 'denied') {
      return {
        outcome: 'denied',
        approvalId: row.id,
        ...(row.denyReason ? { reason: row.denyReason } : {}),
      };
    }

    return {
      outcome: 'granted',
      approvalId: row.id,
      capabilityId: row.capabilityId,
      ...(row.requestedBy ? { requestedBy: row.requestedBy } : {}),
    };
  }

  /**
   * Wait for an operator to decide a pending approval, so an in-session caller
   * can HOLD its tool call and resume on the answer instead of returning a poll
   * payload and asking the model to retry (DOR-939).
   *
   * Resolves on the first of: the operator's decision (`approval_resolved` on the
   * global fan-out, which `grant`/`deny`/`consume` all emit), the token's own
   * expiry, the hold's `timeoutMs` cap, or an abort. It NEVER rejects — every
   * ending is a value the caller degrades on, because the guiding invariant is
   * that a held destructive call is never worse than the poll flow it replaces.
   * An approval store that throws is one of those endings, not an exception: it
   * degrades to `timeout` (DOR-987).
   *
   * The subscription is attached BEFORE the current state is read, so a decision
   * that lands in the gap between the two is delivered rather than missed. Every
   * ending runs through `finish`, which is what releases that subscription — so
   * nothing between the `subscribe` and the return may throw past it. The cap
   * timer is `unref`'d so a hold can never keep the process alive.
   *
   * @param approvalId - The pending approval to wait on.
   * @param options - The hold cap and an optional abort signal.
   * @returns How the wait ended.
   */
  awaitDecision(
    approvalId: string,
    options: AwaitDecisionOptions
  ): Promise<ApprovalDecisionOutcome> {
    return new Promise<ApprovalDecisionOutcome>((resolve) => {
      let done = false;
      const finish = (outcome: ApprovalDecisionOutcome): void => {
        if (done) return;
        done = true;
        unsubscribe();
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        resolve(outcome);
      };

      const unsubscribe = eventFanOut.subscribe((eventName, data) => {
        if (eventName !== 'approval_resolved') return;
        const payload = data as { approvalId?: string; outcome?: ApprovalOutcome };
        if (payload.approvalId !== approvalId) return;
        finish(toDecisionOutcome(payload.outcome));
      });

      const onAbort = (): void => finish('timeout');
      const timer = setTimeout(() => finish('timeout'), options.timeoutMs);
      // Never let a pending hold hold the event loop open.
      timer.unref?.();

      if (options.signal) {
        if (options.signal.aborted) {
          finish('timeout');
          return;
        }
        options.signal.addEventListener('abort', onAbort, { once: true });
      }

      // Close the subscribe→read race: a decision recorded before the listener
      // attached would broadcast to nobody, so read the row once and settle
      // immediately if it is already decided or spent.
      //
      // Guarded, because this runs INSIDE the promise executor: an unguarded
      // throw here rejected the promise this method's contract says never
      // rejects, and — worse — jumped past `finish`, leaving the fan-out listener
      // attached for the life of the process (DOR-987). A store that cannot be
      // read is a store nobody can decide an approval in either, so the honest
      // ending is the no-decision one: `timeout` degrades the caller to the poll
      // payload immediately instead of parking a turn on a broken database.
      let settled: ApprovalDecisionOutcome | undefined;
      try {
        settled = this.settledOutcome(approvalId);
      } catch (err) {
        logger.error('[approvals] could not read an approval while holding on it', {
          approvalId,
          err: err instanceof Error ? err.message : String(err),
        });
        settled = 'timeout';
      }
      if (settled) finish(settled);
    });
  }

  /**
   * The already-final outcome of an approval, or `undefined` when it is still
   * pending. Used to close the subscribe race in {@link awaitDecision}; expiry is
   * evaluated here so a stale row settles a hold rather than stranding it.
   *
   * @param approvalId - The approval to read.
   */
  private settledOutcome(approvalId: string): ApprovalDecisionOutcome | undefined {
    const row = this.db.select().from(approvals).where(eq(approvals.id, approvalId)).get();
    if (!row) return undefined;
    if (this.isExpired(row)) return 'expired';
    if (row.state === 'granted') return 'granted';
    if (row.state === 'denied') return 'denied';
    return undefined;
  }

  /**
   * Every approval still waiting on a person, oldest first. Expired rows are
   * excluded — a card nobody can act on any more is noise, not information.
   *
   * @returns The pending approvals, without token material.
   */
  listPending(): PendingApproval[] {
    const rows = this.db
      .select()
      .from(approvals)
      .where(and(eq(approvals.state, 'pending'), isNull(approvals.consumedAt)))
      .orderBy(asc(approvals.createdAt))
      .all();
    return rows.filter((row) => !this.isExpired(row)).map(toPendingApproval);
  }

  /**
   * The cockpit-facing card for one approval, or `undefined` when no such row
   * exists. Never includes token material.
   *
   * The in-session hold renders this exact card inline (DOR-939), so the same
   * request a person answers on the dashboard is the one they answer in the
   * transcript. Unlike {@link listPending} this does not filter on state or
   * expiry — the hold reads it immediately after {@link request}, and a caller
   * that wants only live rows already has {@link listPending}.
   *
   * @param approvalId - ULID of the approval to read.
   */
  getPending(approvalId: string): PendingApproval | undefined {
    const row = this.db.select().from(approvals).where(eq(approvals.id, approvalId)).get();
    return row ? toPendingApproval(row) : undefined;
  }

  /**
   * What a standing permission created from this approval would cover.
   *
   * The card shows a display LABEL for who asked, which is not a key — two agents
   * can share a display name, and a label is caller-supplied text. A permission has
   * to key on the agent path the gate recorded, so this reads that instead.
   *
   * `agentPath` is null for a request nobody identified themselves for, and the
   * caller must treat that as "this approval cannot become a permission" rather
   * than as an empty key. Distinguishing it from an unknown approval (`undefined`)
   * is the whole reason this returns a shape rather than a string: the two produce
   * different answers for a person, and collapsing them would report "no such
   * approval" for a card sitting in front of them.
   *
   * @param approvalId - ULID of the approval.
   * @returns The action and the agent that asked, or `undefined` when there is no
   *   such approval.
   */
  standingPermissionScope(
    approvalId: string
  ): { capabilityId: string; agentPath: string | null } | undefined {
    const row = this.db.select().from(approvals).where(eq(approvals.id, approvalId)).get();
    if (!row) return undefined;
    return { capabilityId: row.capabilityId, agentPath: row.requestedByPath };
  }

  /**
   * Delete approval rows whose window closed before `olderThan`.
   *
   * Retention is deliberately longer than the decision window so a spent or
   * expired approval stays auditable for a while after it stops working; expiry
   * itself is enforced in {@link consume}, never by this sweep.
   *
   * @param olderThan - Cutoff; rows that expired before this are deleted.
   *   Defaults to one day ago.
   * @returns How many rows were deleted.
   */
  purgeExpired(olderThan: Date = new Date(Date.now() - 24 * 60 * 60 * 1000)): number {
    const result = this.db
      .delete(approvals)
      .where(lt(approvals.expiresAt, olderThan.toISOString()))
      .run();
    return result.changes;
  }

  /**
   * Retire one approval, everywhere at once.
   *
   * The single funnel every ending passes through — granted, denied, spent, or
   * expired — and the reason it exists is that there are FIVE call sites for
   * four endings and each one has to do two things now: retire the card, and
   * stop the escalation clock the request started (DOR-1570). Written as one
   * method rather than two lines repeated five times, because the fifth copy is
   * the one somebody forgets, and a forgotten disarm is a phone buzzing about
   * an approval that was answered ten minutes ago.
   *
   * **The normal grant flow calls this TWICE for one subject, and that is
   * fine.** An operator grants (`decide('granted')` → `settle`) and then the
   * agent retries (`consume` on a `granted` row → `settle` again), so both
   * `standing_resolved` and `approval_resolved` go out twice for the same id.
   * Every consumer of both is idempotent by construction: `cancelEscalationByKey`
   * is a no-op once the timer is gone, the desktop's `retireStanding` no-ops a
   * banner already closed, and the React app re-reads the authoritative list
   * rather than replaying a transition. De-duping here would buy nothing and add
   * a "was this already settled?" read to the hot path.
   *
   * @param approvalId - ULID of the approval that ended.
   * @param outcome - How it ended.
   */
  private settle(approvalId: string, outcome: ApprovalOutcome): void {
    resolveCapabilityApproval(approvalId);
    broadcastApprovalResolved(approvalId, outcome);
  }

  /**
   * Look a token up by its digest, in constant time on the final compare.
   *
   * @param token - The presented token.
   * @returns The stored row, or `undefined`.
   */
  private findByToken(token: string): ApprovalRow | undefined {
    if (!token) return undefined;

    const digest = hashToken(token);
    const row = this.db.select().from(approvals).where(eq(approvals.tokenHash, digest)).get();
    if (!row) return undefined;

    // The index lookup already matched on equality; this constant-time compare is
    // the belt-and-braces guard so no timing signal rides on the comparison.
    const presented = Buffer.from(digest, 'hex');
    const stored = Buffer.from(row.tokenHash, 'hex');
    if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) {
      return undefined;
    }
    return row;
  }

  /** Whether a row's decision window has closed. Strict, so the boundary is live. */
  private isExpired(row: ApprovalRow): boolean {
    return Date.now() > new Date(row.expiresAt).getTime();
  }

  /**
   * Stamp a row as spent, which is what makes a token single-use.
   *
   * Conditional on the row still being unspent, so the write itself decides the
   * race between two concurrent presentations of one token.
   *
   * @param approvalId - ULID of the approval to spend.
   * @returns True when this call spent it; false when somebody already had.
   */
  private markConsumed(approvalId: string): boolean {
    const result = this.db
      .update(approvals)
      .set({ consumedAt: new Date().toISOString() })
      .where(and(eq(approvals.id, approvalId), isNull(approvals.consumedAt)))
      .run();
    return result.changes === 1;
  }

  /**
   * Record a decision on a pending, unexpired approval.
   *
   * @param approvalId - ULID of the approval.
   * @param decision - Yes or no.
   * @param reason - Optional note for a denial.
   * @returns Why the call failed, or `undefined` on success.
   */
  private decide(
    approvalId: string,
    decision: 'granted' | 'denied',
    reason?: string
  ): ApprovalDecisionFailure | undefined {
    const row = this.db.select().from(approvals).where(eq(approvals.id, approvalId)).get();
    if (!row) return 'unknown';
    if (row.consumedAt || row.state !== 'pending') return 'not_pending';
    if (this.isExpired(row)) {
      if (this.markConsumed(row.id)) this.settle(row.id, 'expired');
      return 'expired';
    }

    const result = this.db
      .update(approvals)
      .set({
        state: decision,
        decidedAt: new Date().toISOString(),
        denyReason: decision === 'denied' ? (reason ?? null) : null,
      })
      // Conditional on the row still being pending and unspent, so two operators
      // clicking at once cannot both record a decision.
      .where(
        and(
          eq(approvals.id, approvalId),
          eq(approvals.state, 'pending'),
          isNull(approvals.consumedAt)
        )
      )
      .run();
    if (result.changes !== 1) return 'not_pending';

    this.settle(approvalId, decision);
    return undefined;
  }
}

/**
 * Why a grant or deny could not be recorded.
 *
 * - `unknown` — no such approval.
 * - `not_pending` — already decided or already spent.
 * - `expired` — the decision window closed; the approval is written off.
 */
export type ApprovalDecisionFailure = 'unknown' | 'not_pending' | 'expired';
