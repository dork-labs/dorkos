/**
 * The directory boundary, asked on the path a cwd can actually change (spec
 * `persistent-session-runtime` §Security, task 3.9).
 *
 * ## Why this is a module and not a line inside `executeSdkQuery`
 *
 * On the resume-per-message path a turn IS a launch, so the check at the top of
 * `executeSdkQuery` happens once per TURN by accident of the architecture. A
 * pump launches once and then serves many turns, so the same line would run
 * once per PROCESS — and a cwd that moved between two dispatches would slip
 * past it. The relaunch pin list (`sessions/launch-fingerprint.ts`) forces a
 * relaunch when the cwd changes and would MOSTLY cover that, but "mostly" is
 * not the standard for a security boundary: it must be its own guarantee rather
 * than a side effect of a fingerprint comparison. So the pump path asks again,
 * per dispatch, in `SessionTurnWindows.dispatch`.
 *
 * Both paths call the two functions below, which is the point of the module:
 * one rule about which directories a turn may run in, and one refusal a person
 * can be shown, rather than two definitions free to drift apart.
 *
 * ## Which validator, and why it is the DorkHome-aware one
 *
 * {@link validateBoundaryOrDorkHome}, exactly as the turn path has always used
 * it. DorkBot and every marketplace-installed agent live under
 * `{dorkHome}/agents/*` by design, so a turn taken in an agent's own home
 * directory is legitimate work that the plain boundary would refuse. The
 * allowance stops at that subtree: dork-home's siblings — the encrypted
 * credential store among them — stay out of reach, and so does everything
 * outside both roots.
 *
 * @module services/runtimes/claude-code/dispatch-boundary
 */
import type { StreamEvent } from '@dorkos/shared/types';
import { validateBoundaryOrDorkHome } from '../../../lib/boundary.js';

/**
 * Refuse this turn unless its working directory is one the operator allowed.
 *
 * The resolved path the validator returns is deliberately DROPPED rather than
 * handed back to the caller: a launch runs in the cwd as the session spells it,
 * and swapping in the canonical path here would quietly change which directory
 * a turn (and its transcript slug) belongs to. Containment is the question
 * being asked; rewriting the answer is not this gate's job.
 *
 * @param cwd - The working directory this turn would run in
 * @throws BoundaryError When the directory is outside both the configured
 *   boundary and the agents subtree, contains a null byte, or cannot be read
 */
export async function validateDispatchBoundary(cwd: string): Promise<void> {
  await validateBoundaryOrDorkHome(cwd);
}

/**
 * The typed error a refused turn surfaces, on either path.
 *
 * Names the directory, because the person who set the boundary is the only one
 * who can fix this and the path is what tells them which turn tripped it. It
 * carries no `category`, matching what the turn path has always yielded here.
 *
 * @param cwd - The working directory that was refused
 */
export function boundaryViolationEvent(cwd: string): StreamEvent {
  return {
    type: 'error',
    data: { message: `Directory boundary violation: ${cwd}` },
  };
}
