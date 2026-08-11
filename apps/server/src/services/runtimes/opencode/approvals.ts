/**
 * OpenCode tool-approval coordination: the pending-approval store behind
 * `approveTool()`, DorkOS permission-mode enforcement (NOTES.md §2), and the
 * server-side auto-deny timer.
 *
 * The event mapper surfaces every `permission.asked` it is handed; MODE
 * enforcement lives here (the facade's job): `bypassPermissions` auto-answers
 * everything, `acceptEdits` auto-answers edit-type permissions, and anything
 * else — including unknown future modes and permission keys nobody has seen —
 * falls through to the safe default of asking the user.
 *
 * Every forwarded request arms an auto-deny timer for
 * `SESSIONS.INTERACTION_TIMEOUT_MS` — exactly the `timeoutMs` the mapper
 * advertises on `approval_required` — so the client's countdown can never end
 * on a ghost: when it hits zero the server has actually responded `reject`,
 * and OpenCode's `permission.replied` echo clears the card. This mirrors the
 * Claude adapter's interactive-handler timeouts.
 *
 * @module services/runtimes/opencode/approvals
 */
import type { PermissionMode } from '@dorkos/shared/types';
import { SESSIONS } from '../../../config/constants.js';

/** How a permission request should be resolved under a DorkOS mode. */
export type ApprovalDecision = 'ask' | 'auto-approve';

/**
 * The only OpenCode permission responses DorkOS ever sends. `always` is
 * deliberately excluded: it would persist a rule in OpenCode's own store and
 * diverge from DorkOS's approval model (NOTES.md §2).
 */
export type PermissionResponse = 'once' | 'reject';

/**
 * Permission keys `acceptEdits` auto-approves. `edit` is the exact string the
 * 1.18.15 sidecar sends when a write is gated (live-verified 2026-08-11);
 * anything not listed asks the user — the safe default.
 */
const EDIT_PERMISSION_TYPES = new Set(['edit']);

/**
 * Resolve what to do with a permission request under a session's DorkOS mode.
 * Unknown modes (`plan`, `dontAsk`, `auto`, future additions) deliberately
 * fall through to `ask` — never silently escalate.
 *
 * @param mode - The session's effective DorkOS permission mode
 * @param permissionType - The request's permission key (`bash`, `edit`, `webfetch`, …)
 */
export function resolveApprovalDecision(
  mode: PermissionMode | undefined,
  permissionType: string
): ApprovalDecision {
  if (mode === 'bypassPermissions') return 'auto-approve';
  if (mode === 'acceptEdits' && EDIT_PERMISSION_TYPES.has(permissionType)) return 'auto-approve';
  return 'ask';
}

/** One forwarded, still-unanswered permission request. */
interface PendingApproval {
  /** OpenCode-native session id — the respond endpoint's path param. */
  ocSessionId: string;
  /** Working directory for `getClient` routing. */
  cwd: string;
  /** Armed auto-deny timer. */
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Tracks forwarded approval requests per DorkOS session so `approveTool()`
 * can resolve them, and auto-denies any the user never answers.
 */
export class PendingApprovalStore {
  /** DorkOS session id → permission id → pending record. */
  private readonly pending = new Map<string, Map<string, PendingApproval>>();

  /**
   * Permission ids this store auto-denied because nobody answered, per session,
   * waiting for their echo to claim them.
   *
   * The auto-deny is answered by the sidecar exactly like a person's rejection —
   * one ordinary `permission.replied` — so the echo alone cannot say whether a
   * person decided or a timer did. That distinction is the whole difference
   * between "expired" and "withdrawn" in the transcript, and this is the only
   * place that still knows it. An id is consumed by its echo, and
   * {@link PendingApprovalStore.clearSession} drops any whose echo never came.
   */
  private readonly expired = new Map<string, Set<string>>();

  /**
   * Track a forwarded request and arm its auto-deny timer.
   *
   * @param sessionId - DorkOS session the request belongs to
   * @param permissionId - `Permission.id` (the `approval_required.toolCallId`)
   * @param entry - Respond-routing info for the request
   * @param onTimeout - Invoked once when the timer fires (after the record is removed)
   */
  register(
    sessionId: string,
    permissionId: string,
    entry: { ocSessionId: string; cwd: string },
    onTimeout: () => void
  ): void {
    // Re-registration (an upstream re-publish of the same permission) replaces
    // the record — cancel the superseded timer so it cannot double-deny, and
    // drop any expiry recorded for the PREVIOUS incarnation of this id. A
    // re-published permission is a live question again; leaving the old mark
    // set would stamp `timeout` on the echo of a person's real answer and file
    // their decision as "nobody was there".
    this.take(sessionId, permissionId);
    this.consumeExpired(sessionId, permissionId);
    const timer = setTimeout(() => {
      if (!this.take(sessionId, permissionId)) return;
      const forSession = this.expired.get(sessionId) ?? new Set<string>();
      forSession.add(permissionId);
      this.expired.set(sessionId, forSession);
      onTimeout();
    }, SESSIONS.INTERACTION_TIMEOUT_MS);
    // Never hold the event loop open for an approval countdown.
    timer.unref?.();
    let forSession = this.pending.get(sessionId);
    if (!forSession) {
      forSession = new Map();
      this.pending.set(sessionId, forSession);
    }
    forSession.set(permissionId, { ...entry, timer });
  }

  /**
   * Remove and return a pending record, disarming its timer. Returns null when
   * nothing is pending under that id (already answered, timed out, or unknown).
   */
  take(sessionId: string, permissionId: string): { ocSessionId: string; cwd: string } | null {
    const forSession = this.pending.get(sessionId);
    const entry = forSession?.get(permissionId);
    if (!forSession || !entry) return null;
    clearTimeout(entry.timer);
    forSession.delete(permissionId);
    if (forSession.size === 0) this.pending.delete(sessionId);
    return { ocSessionId: entry.ocSessionId, cwd: entry.cwd };
  }

  /**
   * Whether this permission was auto-denied by its timer rather than by a
   * person, consuming the fact. Answered once: the echo that clears the card is
   * the one event that needs to carry the reason.
   *
   * @param sessionId - DorkOS session the request belonged to
   * @param permissionId - `Permission.id` from the resolution echo
   */
  consumeExpired(sessionId: string, permissionId: string): boolean {
    const forSession = this.expired.get(sessionId);
    if (!forSession?.delete(permissionId)) return false;
    if (forSession.size === 0) this.expired.delete(sessionId);
    return true;
  }

  /**
   * Drop every pending record for a session (turn teardown) — timers are
   * disarmed; nothing is responded (the turn ending already resolved them
   * upstream, or the sidecar is gone). Unclaimed expiries go with them: an echo
   * that has not arrived by teardown is never going to.
   */
  clearSession(sessionId: string): void {
    this.expired.delete(sessionId);
    const forSession = this.pending.get(sessionId);
    if (!forSession) return;
    for (const entry of forSession.values()) clearTimeout(entry.timer);
    this.pending.delete(sessionId);
  }
}
