/**
 * What the space side hands the session-list stream: who may hear about a
 * session, and which project a folder belongs to (spec
 * `computer-side-starts-alone` §5.12, I7's resolvers).
 *
 * The stream (`session-list-broadcaster.ts`) produces every session event
 * unfiltered; who may hear about a session is the space side's rule
 * (`startup/space-views.ts`), handed in at startup through
 * {@link setSessionListSpaceView}, the way `setQueuedChatView` hands the queue
 * its view. The audience it returns is asked as each frame is written.
 *
 * **Fail-closed.** Until the view is set, every session's audience is the
 * operator alone ({@link ownerOnlyAudience}): no agent, program or relayed
 * connection hears about any session, and the operator hears what they always
 * did. Every audience the space side hands in lets the operator hear, so the
 * unset answer is never wider than the set one. A folder's project is left out
 * until then, as it is whenever the registry does not know it yet.
 *
 * @module services/session/catalog/session-list-space-view
 */
import type { ProjectRef } from '@dorkos/shared/project-schemas';
import type { BroadcastAudience } from '../../core/event-fan-out.js';
import { ownerOnlyAudience } from '../../../lib/caller-principal.js';

/** The space side's answers the session-list stream reads. */
export interface SessionListSpaceView {
  /**
   * Which stream connections may hear about one session: the space side's
   * rule, asked as each frame is written.
   */
  audience: (sessionId: string) => BroadcastAudience;
  /**
   * The project a folder belongs to, when the registry already knows it: a
   * peek, never a git call. `null` for no project, `undefined` when not known yet.
   */
  projectOf: (cwd: string) => ProjectRef | null | undefined;
}

let view: SessionListSpaceView | undefined;

/**
 * Register (or clear) what the space side hands the session-list stream.
 *
 * @param next - The view, or `undefined` to clear it.
 */
export function setSessionListSpaceView(next: SessionListSpaceView | undefined): void {
  view = next;
}

/**
 * Which connections may hear about a session: the space side's answer, or the
 * operator alone before it has handed one over.
 *
 * @param sessionId - The session the frame is about.
 */
export function sessionListAudience(sessionId: string): BroadcastAudience {
  return view?.audience(sessionId) ?? ownerOnlyAudience;
}

/**
 * The project a folder belongs to, as the space side knows it; `undefined`
 * before it has handed its view over.
 *
 * @param cwd - The session's folder.
 */
export function sessionListProjectOf(cwd: string): ProjectRef | null | undefined {
  return view?.projectOf(cwd);
}
