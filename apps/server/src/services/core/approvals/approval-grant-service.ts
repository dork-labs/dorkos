/**
 * Standing permissions: create, look up, revoke (spec `agent-approval-settings`
 * §3.2).
 *
 * A standing permission is one operator's answer to "stop asking about this
 * agent doing this thing", scoped to exactly one agent and exactly one
 * capability, and bounded by a clock. This service owns the rows; who is allowed
 * to create one is decided at the routes, by `resolveDecisionAuthority` plus a
 * session cookie, and is deliberately not re-litigated here.
 *
 * ## Three behaviors are load-bearing
 *
 * 1. **Expiry is evaluated on READ**, inside {@link ApprovalGrantService.findLive},
 *    not only by the sweep. Same property the approval token already commits to,
 *    for the same reason: a stale row must never be honored just because no
 *    cleanup has run.
 * 2. **The posture floor is evaluated on READ too**, for the same reason and in
 *    the same two places. A permission granted at or before the moment the
 *    settings last stopped licensing permissions is void, and stays invisible
 *    whether or not anything has swept it (DOR-520 — see `readVoidFloor` below).
 * 3. **At most one live permission per (agentPath, capabilityId).**
 *    {@link ApprovalGrantService.create} revokes any existing live row for the
 *    pair before inserting, so answering the same question again EXTENDS rather
 *    than accumulating, and the list a person reads never has duplicates in it.
 *
 * ## The window is absolute
 *
 * `expiresAt` is computed once, from the moment of the grant, and nothing here
 * ever moves it. A sliding window would hand the agent control of its own
 * expiry — the agent that acts most often would be the one that never has to ask
 * again. Re-granting is a fresh human decision, which is why it may reset the
 * clock and why using a permission may not.
 *
 * ## Every change is broadcast from HERE, not from the callers
 *
 * Three different things end permissions — the Stop-trusting button, turning the
 * master switch off, and turning login off — and two of them run nowhere near a
 * route. Announcing from the store means a cockpit showing a permission that no
 * longer exists is impossible to arrange by adding a fourth caller, which is the
 * property a list of trust has to have. Same placement, and the same reason, as
 * `ApprovalService`'s own broadcasts.
 *
 * ## Synchronous by design
 *
 * Same contract as `ApprovalService`: better-sqlite3 is synchronous, and a
 * decision has to be visible to the very next read — the cockpit grants, then
 * re-lists; the gate looks up, then acts.
 *
 * @module services/core/approvals/approval-grant-service
 */
import { ulid } from 'ulidx';
import { and, asc, eq, gt, isNull, lt, lte, approvalGrants, type Db } from '@dorkos/db';

import { broadcastStandingPermissionsChanged } from './approval-events.js';
import { readStandingGrantVoidFloor } from './standing-grant-settings.js';

/** A stored standing-permission row, as Drizzle infers it. */
export type ApprovalGrantRow = typeof approvalGrants.$inferSelect;

/** The posture a standing permission was created under. */
export type ApprovalGrantPosture = ApprovalGrantRow['posture'];

/** What {@link ApprovalGrantService.create} needs to record one permission. */
export interface ApprovalGrantInput {
  /** Absolute path to the agent's project directory — the stable agent identity. */
  agentPath: string;
  /** The one capability this covers. */
  capabilityId: string;
  /** The `decidedBy` label from `resolveDecisionAuthority`. */
  grantedBy: string;
  /** The posture the decision rested on, recorded rather than inferred later. */
  posture: ApprovalGrantPosture;
  /** How long it lasts, in minutes, counted from now and never extended by use. */
  windowMinutes: number;
  /** The approval card it came from, when it came from one. */
  sourceApprovalId?: string;
}

/**
 * Own the standing-permission rows. See the module TSDoc for the two behaviors
 * callers depend on.
 */
export class ApprovalGrantService {
  /**
   * Build the service over a database handle.
   *
   * @param db - The DorkOS database handle.
   * @param readVoidFloor - Reads the posture floor FRESH on every lookup: the
   *   moment the settings last stopped licensing standing permissions, or `null`
   *   when they never have. Defaults to the live user config, so the invariant
   *   holds without anybody remembering to wire it; the seam exists so a test can
   *   supply a floor without a config file. Never captured — a floor read once at
   *   construction would be a stale answer to a question that has to be current,
   *   which is the same reason the tier gate reads the master switch per call.
   */
  constructor(
    private readonly db: Db,
    private readonly readVoidFloor: () => string | null = readStandingGrantVoidFloor
  ) {}

  /**
   * Record a standing permission, replacing any live one for the same pair.
   *
   * The replacement is what makes re-granting extend rather than accumulate. It
   * is a revoke-then-insert rather than an update so the superseded row stays in
   * the table with its own `revokedAt`, which keeps the history readable.
   *
   * @param input - The agent, the capability, who granted it, and for how long.
   * @returns The stored row.
   */
  create(input: ApprovalGrantInput): ApprovalGrantRow {
    const now = Date.now();
    this.revokeLiveFor(input.agentPath, input.capabilityId, new Date(now).toISOString());

    const row = {
      id: ulid(),
      agentPath: input.agentPath,
      capabilityId: input.capabilityId,
      grantedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + input.windowMinutes * 60_000).toISOString(),
      grantedBy: input.grantedBy,
      posture: input.posture,
      sourceApprovalId: input.sourceApprovalId ?? null,
      revokedAt: null,
    };
    this.db.insert(approvalGrants).values(row).run();
    broadcastStandingPermissionsChanged('created', row.id);
    return row;
  }

  /**
   * The live permission covering one agent doing one thing, if there is one.
   *
   * Expiry is applied here rather than trusted to the sweep, so a row whose
   * window closed is invisible to the gate the instant it closes.
   *
   * @param agentPath - The calling agent's stable path.
   * @param capabilityId - The capability about to run.
   * @returns The covering row, or `undefined`.
   */
  findLive(agentPath: string, capabilityId: string): ApprovalGrantRow | undefined {
    return this.db
      .select()
      .from(approvalGrants)
      .where(
        and(
          eq(approvalGrants.agentPath, agentPath),
          eq(approvalGrants.capabilityId, capabilityId),
          isNull(approvalGrants.revokedAt),
          gt(approvalGrants.expiresAt, new Date().toISOString()),
          this.notVoidedByPosture()
        )
      )
      .orderBy(asc(approvalGrants.expiresAt))
      .get();
  }

  /**
   * Every permission still live, soonest to expire first.
   *
   * A permission a person cannot find is a dark pattern, so this is the list the
   * cockpit shows in both places it offers to end one.
   *
   * @returns The live rows.
   */
  list(): ApprovalGrantRow[] {
    return this.db
      .select()
      .from(approvalGrants)
      .where(
        and(
          isNull(approvalGrants.revokedAt),
          gt(approvalGrants.expiresAt, new Date().toISOString()),
          this.notVoidedByPosture()
        )
      )
      .orderBy(asc(approvalGrants.expiresAt))
      .all();
  }

  /**
   * End one permission.
   *
   * Conditional on the row still being live, so a second click cannot rewrite the
   * moment a permission ended.
   *
   * @param id - ULID of the permission to end.
   * @returns True when this call ended it; false when there was nothing live to end.
   */
  revoke(id: string): boolean {
    const result = this.db
      .update(approvalGrants)
      .set({ revokedAt: new Date().toISOString() })
      .where(and(eq(approvalGrants.id, id), isNull(approvalGrants.revokedAt)))
      .run();
    // Only when this call is the one that ended it. A second click changed
    // nothing, and announcing it would tell every cockpit to re-read for news
    // that is not there.
    if (result.changes === 1) broadcastStandingPermissionsChanged('revoked', id);
    return result.changes === 1;
  }

  /**
   * End every live permission at once.
   *
   * This is what turning the master switch off does, and what turning login off
   * does. Leaving rows dormant across either change would let them wake up later
   * under a posture that can no longer justify them.
   *
   * @returns How many permissions were ended.
   */
  revokeAll(): number {
    const result = this.db
      .update(approvalGrants)
      .set({ revokedAt: new Date().toISOString() })
      .where(isNull(approvalGrants.revokedAt))
      .run();
    if (result.changes > 0) broadcastStandingPermissionsChanged('ended-all');
    return result.changes;
  }

  /**
   * Delete permissions whose window closed before `olderThan`.
   *
   * Retention is longer than the longest window a person can choose, so an
   * expired permission stays readable for a while after it stops working. Expiry
   * itself is enforced in {@link findLive}, never by this sweep.
   *
   * @param olderThan - Cutoff; rows that expired before this are deleted.
   *   Defaults to one day ago.
   * @returns How many rows were deleted.
   */
  purgeExpired(olderThan: Date = new Date(Date.now() - 24 * 60 * 60 * 1000)): number {
    const result = this.db
      .delete(approvalGrants)
      .where(lt(approvalGrants.expiresAt, olderThan.toISOString()))
      .run();
    return result.changes;
  }

  /**
   * End every permission the settings already voided, once, so the stored rows
   * say what is true rather than relying on the read filter to hide them.
   *
   * Boot calls this. It is deliberately NOT what makes the invariant hold — the
   * filter on {@link findLive} and {@link list} does that, on every read, with no
   * dependence on this having run. What it buys is an honest table: a permission a
   * settings round trip voided reads as revoked instead of as one that quietly
   * expired on its own.
   *
   * @returns How many permissions were ended. Zero when there is no floor.
   */
  revokeVoidedByPosture(): number {
    const floor = this.readVoidFloor();
    if (!floor) return 0;
    const result = this.db
      .update(approvalGrants)
      .set({ revokedAt: new Date().toISOString() })
      .where(and(isNull(approvalGrants.revokedAt), lte(approvalGrants.grantedAt, floor)))
      .run();
    return result.changes;
  }

  /**
   * The condition that hides a permission the settings voided.
   *
   * `grantedAt` and the floor are both `new Date().toISOString()`, a fixed-width
   * UTC format, so comparing them as text orders them as instants.
   *
   * The comparison is `grantedAt > floor`, and the direction is the whole thing:
   * a permission is honored only when it was granted STRICTLY AFTER the settings
   * last stopped licensing one. Reversing it would void exactly the permissions a
   * person just granted while resurrecting the ones a posture change killed, and
   * nothing about the outcome would look wrong from outside — every install that
   * never toggled the setting has no floor at all and behaves identically either
   * way. `__tests__/approval-grant-service.test.ts` pins both directions.
   *
   * @returns A Drizzle condition, or `undefined` when there is no floor (which
   *   `and()` drops, leaving the query exactly as it was before this existed).
   */
  private notVoidedByPosture() {
    const floor = this.readVoidFloor();
    return floor ? gt(approvalGrants.grantedAt, floor) : undefined;
  }

  /** Stamp every live row for one pair as revoked, so `create` can supersede it. */
  private revokeLiveFor(agentPath: string, capabilityId: string, at: string): void {
    this.db
      .update(approvalGrants)
      .set({ revokedAt: at })
      .where(
        and(
          eq(approvalGrants.agentPath, agentPath),
          eq(approvalGrants.capabilityId, capabilityId),
          isNull(approvalGrants.revokedAt)
        )
      )
      .run();
  }
}
