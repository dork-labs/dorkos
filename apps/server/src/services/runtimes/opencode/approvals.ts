/**
 * OpenCode tool-approval coordination: the pending-approval store behind
 * `approveTool()`, DorkOS permission-mode enforcement (NOTES.md §2), the
 * server-side auto-deny timer, and the sidecar call that answers a request.
 *
 * The event mapper surfaces every `permission.asked` it is handed; MODE
 * enforcement lives here — {@link enforceApprovals} is the pass the runtime
 * facade runs every mapped turn event through: `bypassPermissions` auto-answers
 * everything, `acceptEdits` auto-answers edit-type permissions, and anything
 * else — including unknown future modes and permission keys nobody has seen —
 * falls through to the safe default of asking the user.
 *
 * Every forwarded request waits in two stages, exactly as the Claude adapter's
 * prompts do (spec `ask-parks-on-timeout`). The card counts down for
 * `SESSIONS.INTERACTION_TIMEOUT_MS`, which is the `timeoutMs` the mapper
 * advertises on `approval_required` and is left there deliberately: it is the
 * number a person is counting down against, not the number the sidecar is
 * answered at. Past it the card PARKS — `listPendingInteractions` derives that
 * from the same two numbers, so OpenCode gets it without a line of its own —
 * and the auto-deny timer here fires only at
 * `SESSIONS.INTERACTION_PARK_CEILING_MS`, so the countdown can never end on a
 * ghost either way.
 *
 * **What OpenCode does NOT get: a park notice.** The Claude adapter pushes a
 * `system_status` line at ten minutes through its own event queue. This pass is
 * a generator over the sidecar's stream with no seam to inject a DorkOS-authored
 * event, so the card and the room lane park identically and the "I am waiting
 * here" sentence is claude-code's only. Named here rather than discovered later.
 *
 * @module services/runtimes/opencode/approvals
 */
import type { ApprovalEvent, PermissionMode, StreamEvent } from '@dorkos/shared/types';
import { SESSIONS } from '../../../config/constants.js';
import { logger, logError } from '../../../lib/logger.js';
import type { OpenCodePermissionState } from './session-event-mapper.js';
import type { OpenCodeClientProvider } from './session-mapper.js';
import type { OpenCodeSessionRegistry } from './session-registry.js';

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
  /** Armed auto-deny timer, which fires at the park ceiling. */
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
   * The timer fires at {@link SESSIONS.INTERACTION_PARK_CEILING_MS}: the card
   * counts down for ten minutes, then parks and says the agent is waiting, and
   * only four hours in does the sidecar hear a `reject`.
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
    // The PARK CEILING, not the countdown: past ten minutes the card says the
    // agent is waiting, and this is when the agent actually gives up (spec
    // `ask-parks-on-timeout` §6). The mapper still advertises the countdown,
    // which is what the person watches.
    const timer = setTimeout(() => {
      if (!this.take(sessionId, permissionId)) return;
      const forSession = this.expired.get(sessionId) ?? new Set<string>();
      forSession.add(permissionId);
      this.expired.set(sessionId, forSession);
      onTimeout();
    }, SESSIONS.INTERACTION_PARK_CEILING_MS);
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

/**
 * Everything one turn needs to enforce and answer its permission requests.
 *
 * `ocSessionId` is the turn's own OpenCode session; `permissions` is where the
 * mapper recorded which session each individual ask came from, because a
 * subagent raises its prompts in its own CHILD session and only that session
 * can take the answer (DOR-1126).
 */
export interface ApprovalRouting {
  sessionId: string;
  ocSessionId: string;
  cwd: string;
  permissions: OpenCodePermissionState;
}

/**
 * The runtime state {@link enforceApprovals} reads and mutates, passed as one
 * object because enforcement is a free function rather than a method on the
 * facade: the sidecar client source it answers through, the pending-approval
 * store `approveTool()` shares, and the registry the effective mode is read
 * from live.
 */
export interface ApprovalGateDeps {
  /** Sidecar client source, routed by working directory. */
  provider: OpenCodeClientProvider;
  /** The runtime's pending-approval store (auto-deny timers live in it). */
  approvals: PendingApprovalStore;
  /** Tracked sessions — the live source of a session's permission mode. */
  registry: OpenCodeSessionRegistry;
}

/**
 * Answer one permission request on the sidecar (`once` approve / `reject`
 * deny). `POST /session/{id}/permissions/{permissionID}` is the route the
 * SDK client exposes, and 1.18.15 still serves it: a live approve and a live
 * deny were both accepted (200) and both echoed back as `permission.replied`
 * (2026-08-11, DOR-1147). The sidecar has since grown a second spelling
 * (`POST /permission/{requestID}/reply`, also verified working) that the SDK
 * does not expose yet — no reason to hand-roll it while this one answers.
 *
 * @param provider - Sidecar client source, routed by `target.cwd`
 * @param target - The OpenCode session that RAISED the request, and its cwd
 * @param permissionID - `Permission.id` to answer
 * @param response - `once` to approve, `reject` to deny
 */
export async function respondPermission(
  provider: OpenCodeClientProvider,
  target: { ocSessionId: string; cwd: string },
  permissionID: string,
  response: PermissionResponse
): Promise<void> {
  const client = await provider.getClient(target.cwd);
  const result = await client.postSessionIdPermissionsPermissionId({
    path: { id: target.ocSessionId, permissionID },
    body: { response },
  });
  if (result.error !== undefined) {
    throw new Error(`OpenCode permission respond failed: ${JSON.stringify(result.error)}`);
  }
}

/**
 * Permission-mode enforcement on the mapped turn stream (NOTES.md §2):
 * auto-approvable requests are answered `once` and SUPPRESSED (the user
 * never sees a card); forwarded requests are tracked with an auto-deny
 * timer; `permission.replied` echoes (`interaction_cancelled`) clear the
 * pending record so the timer cannot deny an already-answered request.
 * The mode is read live from the registry so a mid-turn PATCH applies to
 * the very next request.
 *
 * Every answer — auto-approve, auto-deny, and the record `approveTool()`
 * later resolves — is addressed to the session that ASKED, which for a
 * subagent's prompt is its child session rather than the turn's (DOR-1126).
 *
 * @param deps - The runtime state this pass reads (see {@link ApprovalGateDeps})
 * @param turn - The turn's approval routing (see {@link ApprovalRouting})
 * @param event - One mapped StreamEvent from this turn
 */
export async function* enforceApprovals(
  deps: ApprovalGateDeps,
  turn: ApprovalRouting,
  event: StreamEvent
): AsyncGenerator<StreamEvent> {
  const { sessionId, cwd } = turn;
  if (event.type === 'approval_required') {
    // StreamEvent's `type`/`data` are not a discriminated pair; the mapper
    // guarantees an ApprovalEvent body under this type.
    const approval = event.data as ApprovalEvent;
    // Cast, not proven by this file: `resolveApprovalDecision` above
    // compares `mode` against LITERAL enum names (`'bypassPermissions'`,
    // `'acceptEdits'`) to decide auto-approval, and does derive meaning from
    // the name — unlike the display-only narrowings in the runtime facade.
    // The actual invariant that keeps this registry holding only opencode's
    // own enum-shaped ids is enforced remotely, in
    // `routes/sessions.ts`'s `rejectUndeclaredPermissionMode` gate on
    // `PATCH /api/sessions/:id` — NOT by anything in this registry or this
    // adapter. `resolveApprovalDecision`'s own literal-name fallback (any
    // unmatched mode asks) is what keeps an id that gate never checked from
    // silently escalating here, so this stays safe even if the invariant
    // above is ever violated. It CAN be: the `DirectTransport` seam
    // (`apps/client/src/layers/shared/lib/direct/session-methods.ts`, used
    // by embedded hosts) calls `runtime.updateSession` straight through with
    // no equivalent server-side check — it trusts the CLIENT's own picker to
    // offer only declared ids, a materially weaker guarantee than the HTTP
    // route's.

    // The session that raised THIS ask. A subagent's prompt belongs to its
    // child session, and `POST /session/{id}/permissions/{permissionID}` is
    // per-session — the turn's own id would not find it. The fallback keeps a
    // request the mapper never recorded (a recovery path, a shape change)
    // answerable on the turn's own session rather than dropping it.
    const askedIn =
      turn.permissions.pendingPermissionSessions.get(approval.toolCallId) ?? turn.ocSessionId;
    const mode = deps.registry.get(sessionId)?.permissionMode as PermissionMode | undefined;
    if (resolveApprovalDecision(mode, approval.toolName) === 'auto-approve') {
      try {
        await respondPermission(
          deps.provider,
          { ocSessionId: askedIn, cwd },
          approval.toolCallId,
          'once'
        );
        return; // Auto-answered — never surfaces as a card.
      } catch (err) {
        // Degrade safely: a failed auto-approve falls back to asking the
        // user rather than leaving the turn blocked on a ghost permission.
        logger.warn(
          '[OpenCodeRuntime] auto-approve failed — forwarding to the user',
          logError(err)
        );
      }
    }
    deps.approvals.register(sessionId, approval.toolCallId, { ocSessionId: askedIn, cwd }, () => {
      void respondPermission(
        deps.provider,
        { ocSessionId: askedIn, cwd },
        approval.toolCallId,
        'reject'
      ).catch((err: unknown) =>
        logger.warn('[OpenCodeRuntime] approval auto-deny failed', logError(err))
      );
    });
    yield event;
    return;
  }
  if (event.type === 'interaction_cancelled') {
    const cancelled = event.data as { interactionId: string; reason?: string };
    deps.approvals.take(sessionId, cancelled.interactionId);
    // An auto-deny is answered by the sidecar exactly like a person's
    // rejection, so the echo comes back indistinguishable from one. Restore
    // the reason here, where it is still known: downstream, `timeout` is what
    // separates an interaction that EXPIRED — an answer the system gave on
    // the person's behalf, and a receipt worth keeping — from one that was
    // withdrawn before anybody could answer it.
    if (deps.approvals.consumeExpired(sessionId, cancelled.interactionId)) {
      yield { ...event, data: { ...cancelled, reason: 'timeout' } };
      return;
    }
  }
  yield event;
}
