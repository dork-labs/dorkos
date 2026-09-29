/**
 * The approval lifecycle of a scheduled task: recording a person's approval,
 * withdrawing it, settling it when the approved work changes, carrying it across
 * a file move, and upgrading grants written in an older key format.
 *
 * The grant is `pulse_schedules.approved_content_key`: the content key of the
 * work a person approved (`scheduleContentKey`), and `previous_approval_key`
 * keeps the one a park withdrew so the card can say what changed (DOR-2323).
 * Moved out of `task-store.ts` (DOR-2329) so the store keeps persistence and
 * this module keeps the rules about who approved what. The store owns one
 * instance, `TaskStore.approvals`, on the same database handle, and calls it
 * when a status write is itself the approval.
 *
 * Its own directory because `services/tasks` is past the file-count ceiling;
 * `timing/` and `execution/` set the precedent.
 *
 * @module services/tasks/approvals/task-approvals
 */
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { pulseSchedules, type Db } from '@dorkos/db';
import { fileProvenance } from '../file-sync-gates.js';
import {
  AGENT_DEFAULTS_CHANGED_OUTSIDE_REASON,
  mergeFollowedAgentChanges,
  parseFollowedAgentChanges,
  type FollowedAgentChange,
  scheduleContentKey,
  scheduleSettingsOf,
  upgradeLegacyContentKey,
  type IncomingTaskContent,
} from '../schedule-permission-clamp.js';
import {
  agentChangeReason,
  effectiveContentKey,
  effectiveTiming,
  effectiveWork,
} from '../timing/effective-timing.js';

/**
 * What {@link TaskApprovals.rekeyMigratedFile} did with one migrated row.
 *
 * `no-row` is not an error — a legacy file that never synced has no row, and a
 * re-run over an already-migrated file finds none at the old path either.
 */
export type RekeyOutcome = 'rekeyed' | 'reparked' | 'moved' | 'no-row';

/**
 * Why a migrated schedule is waiting for a person again: its file no longer says
 * what the row it was approved as says.
 *
 * Only reachable when the file was edited while DorkOS was not running, since
 * the migration itself never changes a schedule's prompt or cron.
 */
const DRIFTED_DURING_MIGRATION_REASON =
  'This schedule’s file changed since it was last approved, so it is waiting for you again. ' +
  'Read what it does now, then approve it or delete it.';

/**
 * What {@link TaskApprovals.settleApprovedWorkChange} did about a schedule whose
 * approved work changed.
 */
export type WorkChangeSettlement = 'unchanged' | 'rekeyed' | 'parked';

/**
 * The approval rules for scheduled tasks, over the same database the store
 * writes. See the module TSDoc for what lives here and why.
 */
export class TaskApprovals {
  /** See {@link setOnApproved}. */
  private onApproved: ((agentId: string) => void) | null = null;

  constructor(private readonly db: Db) {}

  /**
   * Be told the agent of every schedule a person approves, or that is created
   * approved (DOR-2337). The observer of an agent's runtime, model and effort
   * looks at that agent then, so a schedule that starts following it has a
   * baseline to be compared with. Called after the write, and never allowed
   * to fail it.
   *
   * @param listener - Told the agent id; `null` stops telling anyone.
   */
  setOnApproved(listener: ((agentId: string) => void) | null): void {
    this.onApproved = listener;
  }

  /**
   * Tell the listener about a schedule's agent, when it has one.
   *
   * @param agentId - The schedule's agent, if any.
   */
  notifyApproved(agentId: string | null | undefined): void {
    if (!agentId || !this.onApproved) return;
    try {
      this.onApproved(agentId);
    } catch {
      // A listener's failure is its own; the approval stands.
    }
  }

  /**
   * Record that a person has approved this schedule's CURRENT content.
   *
   * The arm grant (`pulse_schedules.approved_content_key`). Stored positively so
   * that no amount of status-writing elsewhere can fabricate it — see
   * {@link resolveFileArmStatus} for the two writers that used to.
   *
   * @param id - The schedule a person just armed.
   */
  recordApproval(id: string): void {
    const row = this.db.select().from(pulseSchedules).where(eq(pulseSchedules.id, id)).get();
    if (!row) return;
    // The content that RUNS, a person's own timing included (DOR-2302): an
    // approval recorded against the package's cron while theirs ran would be
    // an approval of work nobody looked at.
    this.db
      .update(pulseSchedules)
      .set({
        approvedContentKey: effectiveContentKey(row),
        previousApprovalKey: null,
        followedAgentChanges: null,
      })
      .where(eq(pulseSchedules.id, id))
      .run();
    this.notifyApproved(row.agentId);
  }

  /**
   * Re-ask for the approved schedules that follow an agent, after its runtime,
   * model or effort changed outside DorkOS (DOR-2337).
   *
   * A schedule follows its agent for each of those it leaves unset, and its
   * approval records "follow the agent" rather than the agent's value, so this
   * is the only place the change can meet the approval.
   *
   * - An `active` schedule that follows a changed field is parked, whatever
   *   `enabled` says: a switched-off schedule that kept its approval would run
   *   the changed agent the moment somebody switched it on. Its approval is kept
   *   for the card (`previous_approval_key`), and the change is recorded
   *   (`followed_agent_changes`) so the card can say old → new.
   * - Any other schedule that still holds an approval (a schedule paused
   *   because its file went away keeps one, and would arm on it when the file
   *   came back) loses it the same way, with the change recorded, and keeps
   *   its status.
   * - A schedule already waiting since an approval (or since an earlier change
   *   like this) has the change folded into what it records, with no status
   *   change: the first value is kept and the latest wins, and a field changed
   *   back stays listed, so the card can say it was changed and changed back.
   *   It stays waiting; only a person switches anything on.
   * - A proposal nobody approved is left alone: there is no approved value to
   *   measure from.
   *
   * One transaction, so a read never sees half of an agent's schedules parked.
   * Never touches `enabled`.
   *
   * @param agentId - The agent whose defaults changed.
   * @param changes - What changed, old → new, as seen.
   * @returns The ids it parked, the ids it only took an approval from, and the
   *   ids whose record it only updated.
   */
  parkAgentFollowers(
    agentId: string,
    changes: readonly FollowedAgentChange[]
  ): { parked: string[]; withdrawn: string[]; updated: string[] } {
    return this.db.transaction((tx) => {
      const parked: string[] = [];
      const withdrawn: string[] = [];
      const updated: string[] = [];
      const rows = tx
        .select()
        .from(pulseSchedules)
        .where(eq(pulseSchedules.agentId, agentId))
        .all();
      for (const row of rows) {
        // The fields this schedule takes from its agent.
        const followed = changes.filter((change) => row[change.field] === null);
        if (followed.length === 0) continue;
        const recorded = parseFollowedAgentChanges(row.followedAgentChanges);
        const merged = JSON.stringify(mergeFollowedAgentChanges(recorded, followed));
        const now = new Date().toISOString();
        if (row.status === 'active') {
          tx.update(pulseSchedules)
            .set({
              status: 'pending_approval',
              approvedContentKey: null,
              previousApprovalKey: row.approvedContentKey ?? row.previousApprovalKey,
              followedAgentChanges: merged,
              reason: AGENT_DEFAULTS_CHANGED_OUTSIDE_REASON,
              reasonSource: 'dorkos',
              updatedAt: now,
            })
            .where(eq(pulseSchedules.id, row.id))
            .run();
          parked.push(row.id);
        } else if (row.approvedContentKey !== null) {
          tx.update(pulseSchedules)
            .set({
              approvedContentKey: null,
              previousApprovalKey: row.approvedContentKey,
              followedAgentChanges: merged,
              updatedAt: now,
            })
            .where(eq(pulseSchedules.id, row.id))
            .run();
          withdrawn.push(row.id);
        } else if (row.previousApprovalKey !== null || row.followedAgentChanges !== null) {
          tx.update(pulseSchedules)
            .set({ followedAgentChanges: merged, updatedAt: now })
            .where(eq(pulseSchedules.id, row.id))
            .run();
          updated.push(row.id);
        }
      }
      return { parked, withdrawn, updated };
    });
  }

  /**
   * Keep a schedule's approval honest after the work it approved changed: its
   * prompt, timing or settings (`scheduleContentKey`), in the request that
   * changed it rather than at the next sync.
   *
   * - **A person** (the caller cleared the agent bar) changing the timing of a
   *   schedule they approved re-approves it in the same act: the grant moves to
   *   the new timing. Keyed on the grant covering the OLD content rather than on
   *   `status`, so a switched-off or paused schedule the person approved is
   *   still approved when it comes back, and a schedule nobody approved yet is
   *   not approved by an edit. Routes only ask this for a change no file carried
   *   (a package's row-only timing, DOR-2302); a person's file-backed edit is
   *   re-approved by the route itself.
   * - **An agent** gets an `active` schedule parked at once, with DorkOS's own
   *   sentence saying what it changed (`agentChangeReason`: the prompt, how it
   *   runs, or when), and keeps the approval it withdrew for the card
   *   (`previousApprovalKey`, DOR-2323). Left to
   *   the sync, the agent's new work would run on an approved schedule until
   *   the watcher or the five-minute sweep caught up (DOR-2313), and the sync
   *   would say the FILE changed. A sync that landed mid-request, between the
   *   file write and this call, has already parked the row with its own
   *   sentence; the schedule was active before this request, so the agent's
   *   sentence replaces it. A schedule that was not active keeps its status; its
   *   grant no longer matches what would run, so nothing can arm it again
   *   without a person.
   *
   * It never touches `enabled`: a park stops a schedule, it never starts one.
   *
   * @param id - The schedule whose approved work may just have changed.
   * @param before - What would have run before the update, and the status the
   *   schedule had then.
   * @param caller - Whether the caller cleared the agent bar.
   * @returns What was done, so a caller can tell the agent or raise the park.
   */
  settleApprovedWorkChange(
    id: string,
    before: IncomingTaskContent & { status: string },
    caller: { trusted: boolean }
  ): WorkChangeSettlement {
    const row = this.db.select().from(pulseSchedules).where(eq(pulseSchedules.id, id)).get();
    if (!row) return 'unchanged';
    const previousKey = scheduleContentKey(before);
    const key = effectiveContentKey(row);
    if (key === previousKey) return 'unchanged';

    if (caller.trusted) {
      if (row.approvedContentKey !== previousKey) return 'unchanged';
      this.db
        .update(pulseSchedules)
        .set({ approvedContentKey: key, previousApprovalKey: null })
        .where(eq(pulseSchedules.id, id))
        .run();
      return 'rekeyed';
    }

    const parkedMidRequest = before.status === 'active' && row.status === 'pending_approval';
    if (row.status !== 'active' && !parkedMidRequest) return 'unchanged';
    this.db
      .update(pulseSchedules)
      .set({
        status: 'pending_approval',
        approvedContentKey: null,
        // What was approved, so the card can say what the agent changed. A sync
        // that parked mid-request already moved it here; keep that.
        previousApprovalKey: row.approvedContentKey ?? row.previousApprovalKey,
        reason: agentChangeReason(before, effectiveWork(row)),
        reasonSource: 'dorkos',
        updatedAt: new Date().toISOString(),
      })
      .where(eq(pulseSchedules.id, id))
      .run();
    return 'parked';
  }

  /**
   * Drop the arm grant, because this schedule is no longer approved.
   *
   * Called whenever a row leaves `active` through the API — parking it, pausing
   * it — so an approval can never outlive the decision that made it.
   *
   * @param id - The schedule to withdraw approval from.
   */
  withdrawApproval(id: string): void {
    this.db
      .update(pulseSchedules)
      .set({ approvedContentKey: null })
      .where(eq(pulseSchedules.id, id))
      .run();
  }

  /**
   * Move a row onto its file's new home, keeping any approval it holds — the DB
   * half of the legacy migration (DOR-1486).
   *
   * One transaction, because the two writes are one fact: a row whose path moved
   * without its grant re-keying is a schedule an operator approved that quietly
   * asks to be approved again, and a grant re-keyed without the path moving is a
   * grant for a file nothing reads. Either half alone is worse than neither.
   *
   * ## Why the key is compared against the ROW, not just taken from the file
   *
   * The migration rewrites frontmatter and never touches the body or the cron
   * line, so the content key it produces is the key the row already had. That is
   * the ordinary case, and it is why an approved schedule survives the upgrade
   * without anyone re-approving it.
   *
   * The case worth writing code for is the other one: the file was edited while
   * the server was down. Then the row's `(prompt, cron)` and the file's are
   * DIFFERENT pieces of work, and stamping the file's key onto an active row
   * would hand a person's approval to content nobody has read — grant without
   * review, the one outcome this whole gate exists to prevent. So the two keys
   * are compared, and a mismatch parks the row instead of re-keying it. That is
   * the same answer the first sync after boot would reach on its own; reaching it
   * here just means the schedule never fires the unread content in between.
   *
   * A row that is not `active` migrates exactly as it is — parked stays parked,
   * paused stays paused, and whatever grant it holds is left alone, because
   * moving a file is not a decision about it. Provenance follows the same rules
   * every discovery write follows ({@link fileProvenance}): DorkOS never
   * overwrites an agent's proposal reason with its own prose.
   *
   * @param from - The path the row is keyed on now.
   * @param to - The path its file lives at after the move, symlinks resolved.
   * @param rewritten - The migrated file's material content.
   * @param park - A reason to park the row regardless (the name-collision case),
   *   or `null` to let the comparison above decide.
   * @returns What happened, for the caller's log and counters.
   */
  rekeyMigratedFile(
    from: string,
    to: string,
    rewritten: Pick<IncomingTaskContent, 'prompt' | 'cron' | 'timezone'>,
    park: string | null = null
  ): RekeyOutcome {
    return this.db.transaction((tx) => {
      const existing = tx
        .select()
        .from(pulseSchedules)
        .where(eq(pulseSchedules.filePath, from))
        .get();
      // No row is an ordinary outcome, not a failure: a legacy file DorkOS never
      // managed to sync has none, and a re-run after a crash finds the row
      // already moved.
      if (!existing) return 'no-row';

      const now = new Date().toISOString();
      // Both sides as they would RUN: the row's own timing override applies to
      // the migrated file exactly as it applied to the file it came from
      // (DOR-2302), so a person's timing neither passes for drift nor is lost
      // from the grant.
      const fileKey = effectiveContentKey({
        ...existing,
        prompt: rewritten.prompt,
        cron: rewritten.cron,
        timezone: rewritten.timezone,
      });
      const agrees = effectiveContentKey(existing) === fileKey;

      if (existing.status === 'active' && park === null && agrees) {
        tx.update(pulseSchedules)
          .set({ filePath: to, approvedContentKey: fileKey, updatedAt: now })
          .where(eq(pulseSchedules.id, existing.id))
          .run();
        return 'rekeyed';
      }

      if (existing.status === 'active') {
        const reason = park ?? DRIFTED_DURING_MIGRATION_REASON;
        tx.update(pulseSchedules)
          .set({
            filePath: to,
            status: 'pending_approval',
            approvedContentKey: null,
            // Kept for the card's "what changed" (DOR-2323).
            previousApprovalKey: existing.approvedContentKey ?? existing.previousApprovalKey,
            ...fileProvenance(existing, { reason }),
            updatedAt: now,
          })
          .where(eq(pulseSchedules.id, existing.id))
          .run();
        return 'reparked';
      }

      tx.update(pulseSchedules)
        .set({ filePath: to, updatedAt: now })
        .where(eq(pulseSchedules.id, existing.id))
        .run();
      return 'moved';
    });
  }

  /**
   * Move every approval recorded in an older key format onto today's key: the
   * timezone joined it in DOR-2307, the settings in DOR-2323.
   *
   * Runs once at boot, before any watcher starts, and before
   * {@link backfillApprovalGrants} would have anything to say about these rows.
   * Without it, every approved schedule's stored key would stop matching the
   * key the gates now compute, and the first sync of each would park it — an
   * upgrade that silently takes every schedule a person approved off the clock.
   *
   * What each grant is extended with, and why that widens nothing, is
   * {@link upgradeLegacyContentKey}'s to explain: the timezone the row runs in
   * now, the only one the old grant was ever checked against. Every row with a
   * grant is upgraded, whatever its status — a paused or switched-off schedule a
   * person approved is still approved when it comes back.
   *
   * Idempotent: a key already in today's format is left alone, so a second
   * boot changes nothing. Computed in JS row by row for the reason
   * {@link backfillApprovalGrants} gives.
   *
   * @returns How many grants were upgraded.
   */
  upgradeLegacyApprovalKeys(): number {
    const rows = this.db
      .select()
      .from(pulseSchedules)
      .where(isNotNull(pulseSchedules.approvedContentKey))
      .all();

    let upgraded = 0;
    for (const row of rows) {
      const key = upgradeLegacyContentKey(row.approvedContentKey!, {
        ...scheduleSettingsOf(row),
        timezone: effectiveTiming(row).timezone,
      });
      if (key === null) continue;
      this.db
        .update(pulseSchedules)
        .set({ approvedContentKey: key })
        .where(eq(pulseSchedules.id, row.id))
        .run();
      upgraded++;
    }
    return upgraded;
  }

  /**
   * Give every already-live schedule a grant for the content it is already
   * running (DOR-1485).
   *
   * Runs once at boot, before any watcher starts. Every alpha user has `active`
   * rows that predate the grant column, and without this the first sync of each
   * would find no key, park it, and confront them with a list of schedules they
   * approved months ago. The row being `active` before this build existed IS the
   * historical approval; this writes it down in the form the gate now reads.
   *
   * Idempotent and cheap: it only touches rows whose key is NULL, so a second
   * boot matches nothing. Deliberately narrow, too — a `paused` or
   * `pending_approval` row is not evidence of anything and gets no key, which is
   * exactly the laundering the positive grant exists to stop.
   *
   * The keys are computed in JS, one row at a time, rather than by a single
   * `UPDATE ... json_array(prompt, cron)`. SQLite's JSON writer and
   * `JSON.stringify` agree on ordinary text and are not guaranteed to agree on
   * escaping — a newline or an emoji in a prompt would be enough — and a key
   * that differs by one byte from the one the gate computes is a grant that
   * silently never matches. There are tens of these rows, not thousands.
   *
   * @returns How many rows were back-filled.
   */
  backfillApprovalGrants(): number {
    const rows = this.db
      .select()
      .from(pulseSchedules)
      .where(and(eq(pulseSchedules.status, 'active'), isNull(pulseSchedules.approvedContentKey)))
      .all();

    for (const row of rows) {
      this.db
        .update(pulseSchedules)
        .set({ approvedContentKey: effectiveContentKey(row) })
        .where(eq(pulseSchedules.id, row.id))
        .run();
    }
    return rows.length;
  }
}
