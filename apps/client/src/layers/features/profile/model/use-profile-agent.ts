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
 * The route appends the convention files to the manifest it read
 * (`routes/agents.ts`), but the transport is typed to the schema, which has no
 * room for them. Named here so the Instructions, Boundaries and Memory pages
 * can read what the server sends without each inventing its own cast.
 */
export type ProfileAgentManifest = AgentManifest & {
  /** SOUL.md as it is on disk, or `null` when the file does not exist. */
  soulContent?: string | null;
  /** NOPE.md as it is on disk, or `null` when the file does not exist. */
  nopeContent?: string | null;
  /** MEMORY.md as it is on disk, or `null` when the file does not exist. */
  memoryContent?: string | null;
};

/**
 * What one profile edit may carry: manifest fields, convention files, or both.
 *
 * `PATCH /api/agents/current` takes them together — it writes SOUL.md/NOPE.md
 * and merges the rest in one call (`services/core/operator/agent-updater.ts`) —
 * so the profile sends them together too.
 */
export type ProfileAgentUpdate = AgentManifestUpdate & Partial<UpdateAgentConventions>;

/** What every profile edit is called when it fails, unless the page renames it. */
const DEFAULT_ERROR_LABEL = 'Couldn’t save that change';

/** The agent behind a profile, and the one way to change it. */
export interface ProfileAgent {
  /** The manifest, or `null` when this identity has none to read. */
  agent: ProfileAgentManifest | null;
  /** Where the agent lives, or `null` when the roster does not say. */
  projectPath: string | null;
  /** True while the first read is in flight. */
  isPending: boolean;
  /** True while a save is in flight. */
  isSaving: boolean;
  /**
   * Save a change. Invalidates the manifest AND the roster (§4).
   *
   * `onSaved` runs only once the server has stored it. **There is no failure
   * callback**: a refusal is announced by the app-wide mutation handler, which
   * runs even when this component has unmounted or a second save superseded
   * this one — the case a call-site handler silently skips
   * (`shared/lib/query-client`).
   */
  update: (updates: ProfileAgentUpdate, onSaved?: () => void) => void;
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
 * @param options - Per-page options.
 * @param options.errorLabel - What THIS page's save is called in a failure
 *   toast, composed with the server's own sentence. Pages that edit one named
 *   thing say so ("Couldn't save your instructions"); the rest inherit
 *   {@link DEFAULT_ERROR_LABEL}.
 */
export function useProfileAgent(
  member: TeamMember,
  options?: { errorLabel?: string }
): ProfileAgent {
  const projectPath = member.agent?.projectPath ?? null;
  const query = useCurrentAgent(projectPath);
  // The label is the profile's whole failure story: no editor here toasts for
  // itself, because a toast fired from a `mutate` callback is skipped exactly
  // when it matters most — the panel closed, or the operator hit Save twice —
  // and it double-reported with the app-wide handler when it did fire.
  const updateAgent = useUpdateAgent({ errorLabel: options?.errorLabel ?? DEFAULT_ERROR_LABEL });
  const queryClient = useQueryClient();

  const update = useCallback(
    (updates: ProfileAgentUpdate, onSaved?: () => void) => {
      if (projectPath === null) return;
      updateAgent.mutate(
        // The convention keys ride the same PATCH body the manifest fields do
        // and are validated by their own schema server-side, but
        // `AgentManifestUpdate` describes only the manifest half. One cast
        // here, at the single seam, rather than at every editor: the retired panel
        // took the other road and dropped them at the callback instead, which
        // is why typing into its SOUL.md editor saved nothing.
        { path: projectPath, updates: updates as AgentManifestUpdate },
        {
          // Only on a stored save — the editors hang "Saved" on this, and a
          // 400 used to look exactly like a save that worked (DOR-1253).
          // Deliberately a `mutate` callback rather than `meta`: what it does is
          // set state on THIS component, which a closed panel no longer wants.
          onSuccess: () => onSaved?.(),
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
    isSaving: updateAgent.isPending,
    update,
  };
}
