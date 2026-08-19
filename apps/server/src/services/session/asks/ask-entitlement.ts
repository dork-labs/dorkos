/**
 * Who may see an Ask's detail, and who may act on it (spec `ask-entitlement`
 * §2, ADR 260819-022912, DOR-1356).
 *
 * An Ask's detail is the tool it wants to run, the command or file path it
 * would run against, and the session's working directory. Every surface that
 * shows one — the fleet-wide list route, the global fan-out, the bridged card —
 * reads this one predicate, so a second person (whenever DorkOS has one) is a
 * change to one function rather than to four surfaces.
 *
 * It lives under `services/session/` because an Ask is a session fact — one
 * directory down from `pending-interactions.ts` and `session-list-broadcaster.ts`
 * only because that directory is at its file-count ceiling. The room half
 * arrives as data on the subject rather than as an import, so this module never
 * reaches into `services/rooms/` or `services/relay/`.
 *
 * @module services/session/asks/ask-entitlement
 */
import { mayApprove } from '@dorkos/relay';

import type { CallerPrincipal } from '../../../lib/caller-principal.js';

/** The Ask an entitlement question is about. */
export interface AskSubject {
  /**
   * The session whose turn is parked.
   *
   * On the type and unread by the body today. It is here because it is the seam
   * a second person enters through — this is where "which sessions are yours"
   * would be asked — and because every caller already holds it. It is not a
   * leftover.
   */
  readonly sessionId: string;
  /** The room this session answers for, when it answers for one. */
  readonly roomId?: string;
  /**
   * Platform user ids allowed to authorize this room's tool calls, as the
   * bridge adapter's `approverAllowlist` holds them.
   *
   * Resolved ONLY on the bridged path (spec §5): a `bridged` principal is the
   * only one this list can ever answer for, and it cannot arrive over HTTP. The
   * cockpit surfaces therefore pass a subject without it, and that is correct
   * rather than incomplete.
   */
  readonly approvers?: readonly string[];
}

/** What a principal may do with one Ask. */
export type AskEntitlement =
  /** See the detail and act on it. */
  | 'answer'
  /** See the detail; the answer bar is somebody else's. */
  | 'see'
  /** Neither. The Ask does not exist for this caller. */
  | 'none';

/**
 * Whether this caller may see an Ask's detail, and whether they may act on it.
 *
 * **The rule, in one sentence: the detail follows the answer right.** Everything
 * that may answer may see; the one thing that may see without answering is the
 * person's own program, which can already read the identical detail off
 * `GET /api/sessions/:id/events` — withholding it here would break an
 * integration and protect nothing.
 *
 * The table, in full:
 *
 * - **`agent` → `none`.** An agent may never decide (`requirePersonToAnswer`
 *   refuses every one of them structurally), and reading every other agent's
 *   pending command across the machine is the capability this closes. True even
 *   for the session it is running in.
 * - **`operator` → `answer`.** One account owns this install, so the operator
 *   owns every session on it. With login off this is also the credential-free
 *   caller, unchanged.
 * - **`program` → `see`.** Refused at the answer routes since DOR-474; it
 *   already reads the same detail one route over.
 * - **`bridged` → `answer`** only when the Ask is room-bound AND that room's
 *   approver allowlist names this person. Otherwise `none`: absence is not
 *   consent, and a chat platform user has no standing over a session no room
 *   owns.
 *
 * Fails closed on every uncertainty, the same discipline `mayApprove` states.
 *
 * @param principal - What is calling.
 * @param subject - The Ask being asked about.
 * @returns What this caller may do with it.
 */
export function askEntitlement(principal: CallerPrincipal, subject: AskSubject): AskEntitlement {
  switch (principal.kind) {
    case 'agent':
      return 'none';
    case 'operator':
      return 'answer';
    case 'program':
      return 'see';
    case 'bridged':
      if (subject.roomId === undefined) return 'none';
      return mayApprove(subject.approvers, principal.platformUserId) ? 'answer' : 'none';
  }
}
