/**
 * The agent behind a roster row — its manifest, and the one way to change it
 * (spec `profile-unification` §4).
 *
 * Every page and popover that edits an agent goes through here rather than
 * through `useUpdateAgent` directly, because a profile edit has a second
 * consequence the manifest cache knows nothing about: the header, the property
 * rows and the `/team` roster all read `['team']`, so a rename or a new face
 * that only invalidated `['agents','byPath']` left the portrait saying one thing
 * and the roster behind it saying another.
 *
 * @module features/profile/model/use-profile-agent
 */
import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { TeamMember } from '@dorkos/shared/team-schemas';
import type {
  AgentManifest,
  AgentManifestUpdate,
  UpdateAgentConventions,
} from '@dorkos/shared/mesh-schemas';
import { agentKeys, useCurrentAgent, useUpdateAgent } from '@/layers/entities/agent';
import { TEAM_ROSTER_KEY } from '@/layers/entities/team';

/**
 * The manifest as `GET /api/agents/current` actually answers it.
 *
 * The route appends the two convention files to the manifest it read
 * (`routes/agents.ts`), but the transport is typed to the schema, which has no
 * room for them. Named here so the Instructions and Boundaries pages can read
 * what the server sends without each inventing its own cast.
 */
export type ProfileAgentManifest = AgentManifest & {
  /** SOUL.md as it is on disk, or `null` when the file does not exist. */
  soulContent?: string | null;
  /** NOPE.md as it is on disk, or `null` when the file does not exist. */
  nopeContent?: string | null;
};

/**
 * What one profile edit may carry: manifest fields, convention files, or both.
 *
 * `PATCH /api/agents/current` takes them together — it writes SOUL.md/NOPE.md
 * and merges the rest in one call (`services/core/operator/agent-updater.ts`) —
 * so the profile sends them together too.
 */
export type ProfileAgentUpdate = AgentManifestUpdate & Partial<UpdateAgentConventions>;

/** The agent behind a profile, and the one way to change it. */
export interface ProfileAgent {
  /** The manifest, or `null` when this identity has none to read. */
  agent: ProfileAgentManifest | null;
  /** Where the agent lives, or `null` when the roster does not say. */
  projectPath: string | null;
  /** True while the first read is in flight. */
  isPending: boolean;
  /** Save a change. Invalidates the manifest AND the roster (§4). */
  update: (updates: ProfileAgentUpdate) => void;
}

/**
 * Read and write the agent a profile is about.
 *
 * Asks for nothing on a person's profile, or on an agent whose folder the
 * roster does not carry: `useCurrentAgent(null)` is a disabled query, and
 * `update` on a member with no path is a no-op rather than a request to a route
 * that would 400.
 *
 * @param member - The roster row the profile is drawn from.
 */
export function useProfileAgent(member: TeamMember): ProfileAgent {
  const projectPath = member.agent?.projectPath ?? null;
  const query = useCurrentAgent(projectPath);
  const updateAgent = useUpdateAgent();
  const queryClient = useQueryClient();

  const update = useCallback(
    (updates: ProfileAgentUpdate) => {
      if (projectPath === null) return;
      updateAgent.mutate(
        // The convention keys ride the same PATCH body the manifest fields do
        // and are validated by their own schema server-side, but
        // `AgentManifestUpdate` describes only the manifest half. One cast
        // here, at the single seam, rather than at every editor: the Agent Hub
        // took the other road and dropped them at the callback instead, which
        // is why typing into its SOUL.md editor saved nothing.
        { path: projectPath, updates: updates as AgentManifestUpdate },
        {
          onSettled: () => {
            // The roster the portrait and the rows are drawn from…
            void queryClient.invalidateQueries({ queryKey: TEAM_ROSTER_KEY });
            // …and every OTHER cache entry about this agent. `useUpdateAgent`
            // already refreshes `byPath`, but the sidebar's fleet reads
            // `agentKeys.resolved`, so a rename left the panel saying one name
            // and the list beside it saying the old one. The prefix covers both.
            void queryClient.invalidateQueries({ queryKey: agentKeys.all });
          },
        }
      );
    },
    [projectPath, queryClient, updateAgent]
  );

  return {
    agent: (query.data as ProfileAgentManifest | null | undefined) ?? null,
    projectPath,
    isPending: projectPath !== null && query.isPending,
    update,
  };
}
