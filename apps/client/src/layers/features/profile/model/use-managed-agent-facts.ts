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
import {
  findMatchingPreset,
  useAgentMcpServers,
  useAgentToolStatus,
  useCurrentAgent,
} from '@/layers/entities/agent';
import { useHarnessStatusCached } from '@/layers/entities/harness';
import { useAgentSessions } from '@/layers/entities/session';
import { useTasks } from '@/layers/entities/tasks';
import type { ProfileAgentFacts } from '../lib/profile-rows';

/** Nothing known — what a person's profile, or an agent with no folder, gets. */
const NOTHING: ProfileAgentFacts = {
  sessions: null,
  tasks: null,
  skills: null,
  tools: null,
  personality: null,
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

  const {
    sessions,
    isLoading: sessionsLoading,
    isError: sessionsFailed,
  } = useAgentSessions(projectPath);
  const toolStatus = useAgentToolStatus(projectPath);
  // `useTasks` takes one flag for the whole query. Off when the server has
  // tasks disabled — there is nothing to count — and off on a profile that
  // shows no tasks row at all.
  const tasksEnabled = projectPath !== null && toolStatus.tasks !== 'disabled-by-server';
  const { data: schedules } = useTasks(tasksEnabled);
  // The Skills row's number, read from whatever the Skills page has already put
  // under this folder's key — and NEVER asked for (Decision 28).
  // `buildHarnessStatus` is three synchronous filesystem walks, about 22 ms of
  // blocked event loop, and this profile opens on every `/session`: buying that
  // on every visit for a number nobody has asked to see is the wrong trade. The
  // row says nothing until the page has been opened, which is what
  // `countValue(null)` was built for. It used to count installed
  // marketplace skill-packs, which is why it said "Skills 0" about an agent
  // with thirty-one.
  const { data: harnessStatus } = useHarnessStatusCached(projectPath);
  const { data: mcpServers } = useAgentMcpServers(agentId);
  // A cache hit: the profile root reads the same manifest for the About row.
  const { data: manifest } = useCurrentAgent(projectPath);

  if (projectPath === null) return NOTHING;

  // "Custom" only once the traits are known and match no archetype — before the
  // manifest lands the row says nothing rather than guessing at one.
  const traits = manifest?.traits;
  const personality = traits ? (findMatchingPreset(traits)?.name ?? 'Custom') : null;

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
    // `null` until the answer is real. An in-flight list is an empty array, and
    // building a summary out of it made the row say "0 conversations" about an
    // agent with a hundred — the same invention `countValue` exists to prevent
    // (`profile-rows.ts`). A failed read is not "none" either.
    sessions:
      sessionsLoading || sessionsFailed
        ? null
        : {
            count: sessions.length,
            // The list arrives newest-first, so the head is the most recent —
            // and on an agent mid-turn, the live one.
            newestAt: sessions.at(0)?.updatedAt ?? null,
          },
    tasks: schedules ? { count: mine.length, nextRunAt: next ?? null } : null,
    // Both halves, because the list below draws both: the project's own skills
    // and the ones in packages installed for all projects. The schema states
    // that invariant — the two counts are disjoint and their sum is every skill
    // row the page draws — and a profile row saying 31 above a list of 35 is
    // exactly the drift it exists to prevent.
    skills:
      harnessStatus === undefined
        ? null
        : harnessStatus.counts.skills + harnessStatus.counts.globalSkills,
    tools: mcpServers ? mcpServers.filter((server) => server.enabled).length : null,
    personality,
    tasksAvailable: toolStatus.tasks !== 'disabled-by-server',
  };
}
