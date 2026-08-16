/**
 * The counts the property rows carry — how many sessions, how many schedules,
 * how many skills, how many servers (spec `profile-unification` §1.4).
 *
 * Read at the profile root rather than inside each page, for two reasons. The
 * row has to say the number BEFORE you open it — "Sessions 12 · last 2 h" is
 * most of why you would not open it — and the page you then push is a cache hit
 * rather than a second wait.
 *
 * @module features/profile/model/use-managed-agent-facts
 */
import type { TeamMember } from '@dorkos/shared/team-schemas';
import { useAgentMcpServers, useAgentToolStatus } from '@/layers/entities/agent';
import { useInstalledPackages } from '@/layers/entities/marketplace';
import { useAgentSessions } from '@/layers/entities/session';
import { useTasks } from '@/layers/entities/tasks';
import type { ProfileAgentFacts } from '../lib/profile-rows';

/** Nothing known — what a person's profile, or an agent with no folder, gets. */
const NOTHING: ProfileAgentFacts = {
  sessions: null,
  tasks: null,
  skills: null,
  tools: null,
  tasksAvailable: true,
};

/**
 * Everything the rows need that the roster row does not carry.
 *
 * **Every query is gated on there being an agent to ask about.** A person's
 * profile, and an agent whose folder the roster does not carry, ask for
 * nothing — which is what keeps opening a teammate's profile from firing five
 * requests that can only answer "not yours".
 *
 * @param member - The identity the profile is about.
 * @param enabled - False on a relationship whose rows show none of this
 *   (another person, someone else's agent), so the queries never start.
 * @returns The counts, with `null` for anything not yet known.
 */
export function useManagedAgentFacts(member: TeamMember, enabled: boolean): ProfileAgentFacts {
  const projectPath = enabled ? (member.agent?.projectPath ?? null) : null;
  const agentId = enabled ? (member.agent?.manifestId ?? null) : null;

  const { sessions } = useAgentSessions(projectPath);
  const toolStatus = useAgentToolStatus(projectPath);
  // `useTasks` takes one flag for the whole query. Off when the server has
  // tasks disabled — there is nothing to count — and off on a profile that
  // shows no tasks row at all.
  const tasksEnabled = projectPath !== null && toolStatus.tasks !== 'disabled-by-server';
  const { data: schedules } = useTasks(tasksEnabled);
  const { data: packages } = useInstalledPackages(projectPath ?? '');
  const { data: mcpServers } = useAgentMcpServers(agentId);

  if (projectPath === null) return NOTHING;

  const mine = (schedules ?? []).filter((schedule) => schedule.agentId === agentId);
  // Only a schedule that is going to run has a "next": a paused one still
  // carries the timestamp it would have fired at, and showing that as the next
  // run is a promise the scheduler is not keeping.
  const next = mine
    .filter((schedule) => schedule.enabled && schedule.status === 'active' && schedule.nextRun)
    .map((schedule) => schedule.nextRun as string)
    .sort()
    .at(0);

  return {
    sessions: {
      count: sessions.length,
      // The list arrives newest-first, so the head is the most recent — and on
      // an agent mid-turn, the live one.
      newestAt: sessions.at(0)?.updatedAt ?? null,
    },
    tasks: { count: mine.length, nextRunAt: next ?? null },
    skills: packages ? packages.filter((pkg) => pkg.type === 'skill-pack').length : null,
    tools: mcpServers ? mcpServers.filter((server) => server.enabled).length : null,
    tasksAvailable: toolStatus.tasks !== 'disabled-by-server',
  };
}
