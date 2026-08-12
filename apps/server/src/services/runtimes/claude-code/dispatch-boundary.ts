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
 * Both paths call {@link validateDispatchBoundary}, which is the point of the
 * module: one rule about which directories a turn may run in, rather than two
 * definitions free to drift apart.
 *
 * {@link boundaryViolationEvent} is the matching half — one refusal a person
 * can be shown — but only the turn path yields it today. The pump path THROWS
 * the validator's `BoundaryError` instead, because a dispatch is a call that
 * fails, not a stream that emits. Whoever wires the windower into `sendMessage`
 * must catch that error and yield THIS event, or the same misconfiguration will
 * read as two different failures depending on which path a person happened to
 * be on.
 *
 * ## Which validator, and why it is the DorkHome-aware one
 *
 * {@link validateBoundaryOrDorkHome}, exactly as the turn path has always used
 * it. DorkBot and every marketplace-installed agent live under
 * `{dorkHome}/agents/*` by design, so a turn taken in an agent's own home
 * directory is legitimate work that the plain boundary would refuse. The
 * allowance stops at that subtree: dork-home's siblings — the encrypted
 * credential store among them — stay out of reach, and so does everything
 * outside both roots. Containment is judged on the RESOLVED path, so neither a
 * `..` spelled inside `agents/` nor a symlink planted there escapes it; both
 * are pinned by cases in `sessions/__tests__/session-turn-windows-boundary`.
 *
 * One known edge, inherited from `lib/boundary.ts` and shared with every other
 * caller of these validators: a path that does not exist cannot be
 * realpath'd, so `resolveCanonicalPath` falls back to a LEXICAL
 * `path.resolve` — and a non-existent child of a symlink
 * (`{dorkHome}/agents/<symlink>/nope`) is therefore judged by its spelling and
 * allowed. It is not reachable as a cwd: the directory does not exist, so the
 * launch fails, and nothing in this runtime creates a session's cwd. Fixing it
 * belongs in `lib/boundary.ts`, where it would fix every caller at once.
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
