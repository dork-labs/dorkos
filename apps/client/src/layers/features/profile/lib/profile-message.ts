/**
 * Where the profile's "Open session" button would go — and, most of the time,
 * that it goes nowhere yet (spec `profile-unification` §1.2, non-goal §8).
 *
 * @module features/profile/lib/profile-message
 */
import type { TeamMember } from '@dorkos/shared/team-schemas';

/** Somewhere a message to this identity can actually be written. */
export interface ProfileMessageTarget {
  /** The only kind of target that exists today: an agent's own project directory. */
  kind: 'agent-session';
  /** The directory `/session` opens on. */
  projectPath: string;
}

/**
 * Resolve where the "Open session" button would send you, or `null` when
 * nowhere.
 *
 * **`null` is the common answer and the honest one.** There is no route that
 * DMs a person on this machine, and none that sends a message back out over
 * Telegram, so those buttons are not drawn rather than drawn dead — the spec's
 * own non-goal (§8). An agent has a destination exactly when the roster knows
 * where it lives, which is why W1.1 unstrips `projectPath` for local agents.
 *
 * @param member - The identity the profile is about.
 * @returns The target, or `null` when this identity cannot be messaged yet.
 */
export function messageTarget(member: TeamMember): ProfileMessageTarget | null {
  const projectPath = member.agent?.projectPath;
  if (!projectPath) return null;
  return { kind: 'agent-session', projectPath };
}
