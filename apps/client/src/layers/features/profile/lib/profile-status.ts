/**
 * The one sentence under an identity's name — what it is doing, or when it last
 * did anything (spec `profile-unification` §1.2).
 *
 * **Words, never a ring on the face.** The face says who; this line says what is
 * happening, and a 7px dot before it is the only live indicator the profile
 * spends (`plans/identity-micro-interactions/design-spec.md` §3D). The old
 * drawer's `livenessText` said "Active in the last hour" from the mesh's 60
 * minute window, which is a sentence about a cache rather than about the agent.
 *
 * @module features/profile/lib/profile-status
 */
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { platformLabel } from '@/layers/entities/room';

/** A minute, an hour and a day in milliseconds. */
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * How long something has been going on, in the fewest words that stay true.
 *
 * @param fromIso - When it started.
 * @param now - The clock, injectable so tests are not written against wall time.
 */
function durationWords(fromIso: string, now: Date): string | null {
  const started = new Date(fromIso).getTime();
  if (Number.isNaN(started)) return null;
  const elapsed = Math.max(0, now.getTime() - started);
  if (elapsed < MINUTE_MS) return 'just started';
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)} min`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)} h`;
  return `${Math.floor(elapsed / DAY_MS)} d`;
}

/**
 * How long ago something happened, in the fewest words that stay true.
 *
 * Deliberately not `formatRelativeTime` (`shared/lib/session-utils`): that one
 * answers a session list ("Yesterday, 3pm", "Mon, 9am"), and this one has to
 * finish the sentence "Last active …" without a comma in the middle of it.
 *
 * @param iso - When it happened.
 * @param now - The clock.
 */
function agoWords(iso: string, now: Date): string | null {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const elapsed = Math.max(0, now.getTime() - then);
  if (elapsed < MINUTE_MS) return 'just now';
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)} min ago`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)} h ago`;
  if (elapsed < 2 * DAY_MS) return 'yesterday';
  if (elapsed < 30 * DAY_MS) return `${Math.floor(elapsed / DAY_MS)} days ago`;
  return `on ${new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

/** The status line: what to say, and whether anything is happening as you read it. */
export interface ProfileStatus {
  /** The sentence, always present — there is no state this has nothing to say about. */
  text: string;
  /**
   * Whether a turn is running right now. The only thing that earns the green
   * dot; everything else, including "heard from four minutes ago", is muted.
   */
  live: boolean;
}

/**
 * The status sentence for any identity on the roster.
 *
 * Agents answer from their live turn first, then from when they were last
 * heard from, then from having never run. People answer with where they are:
 * bridged people are on their platform, everyone else is on this machine —
 * except when we know when they were last seen, which is a better answer than
 * a location the roster cannot verify.
 *
 * @param member - The identity being drawn.
 * @param now - The clock. Injectable so a fixture reads the same at any hour.
 * @returns The sentence and whether it is live (see {@link ProfileStatus}).
 */
export function profileStatusText(member: TeamMember, now: Date = new Date()): ProfileStatus {
  const agent = member.agent;
  if (agent) {
    const working = agent.activity.working;
    if (working) {
      const elapsed = durationWords(working.since, now);
      const where = working.roomName ? ` in #${working.roomName}` : '';
      return { text: `Working${where}${elapsed ? ` · ${elapsed}` : ''}`, live: true };
    }
    const last = agent.activity.lastActiveAt ? agoWords(agent.activity.lastActiveAt, now) : null;
    if (last) return { text: `Last active ${last}`, live: false };
    return { text: 'Hasn’t run yet', live: false };
  }

  if (member.origin !== 'local') {
    return { text: `On ${platformLabel(member.origin.platform)}`, live: false };
  }
  const seen = member.isSelf ? null : (member.person?.lastSeenAt ?? null);
  const last = seen ? agoWords(seen, now) : null;
  if (last) return { text: `Last seen ${last}`, live: false };
  return { text: 'On this machine', live: false };
}
