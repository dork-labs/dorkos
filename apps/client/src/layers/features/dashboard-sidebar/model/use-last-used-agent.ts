/**
 * Which agent a new session starts with when you do not say.
 *
 * The New menu's Session item promises "↵ starts with <name> (last used)"
 * (BC-45), so the promise has to be answerable before the menu draws it — and
 * answerable honestly, which means degrading to "no name" rather than guessing
 * one. The ladder, in order:
 *
 * 1. **The agent you are looking at.** `useDirectoryState` is the open
 *    conversation's working directory, and starting the next session where the
 *    last one is happening is what "last used" means while you are in it.
 * 2. **The agent you opened most recently**, from `entities/interactions` —
 *    the same per-person record Today is ordered by. It survives a reload and
 *    is still right after you navigate away to Marketplace or Team.
 * 3. **Nobody.** The item still works: `useStartNewSession()` with no directory
 *    opens a conversation in the server's own root. The note line is simply not
 *    drawn, because a name we cannot resolve is worse than no name at all.
 *
 * @module features/dashboard-sidebar/model/use-last-used-agent
 */
import { useMemo } from 'react';
import { disambiguateDisplayNames, useResolvedAgents } from '@/layers/entities/agent';
import { useInteractionTimestamps } from '@/layers/entities/interactions';
import { useMeshAgentPaths } from '@/layers/entities/mesh';
import { useDirectoryState } from '@/layers/entities/session';

/** The agent a fresh session would start with, if there is one. */
export interface LastUsedAgent {
  /** Its working directory — what `useStartNewSession` takes. */
  path: string;
  /** What to call it, disambiguated against the rest of the fleet. */
  displayName: string;
}

/** The `agent:` half of the interaction store's one key space. */
const AGENT_KEY_PREFIX = 'agent:';

/**
 * The agent a fresh session starts with, or `null` when none is known.
 *
 * Every query it reads is one the sidebar already asked for, so the shared
 * cache answers and the net request count is unchanged — the same arrangement
 * `SidebarChrome` documents for its own reads.
 */
export function useLastUsedAgent(): LastUsedAgent | null {
  const [selectedCwd] = useDirectoryState();
  const interactions = useInteractionTimestamps();
  const { data: meshData } = useMeshAgentPaths();

  const paths = useMemo(
    () => (meshData?.agents ?? []).map((entry) => entry.projectPath),
    [meshData]
  );
  const { data: manifests } = useResolvedAgents(paths);
  const displayNames = useMemo(
    () => disambiguateDisplayNames(paths, manifests ?? {}),
    [paths, manifests]
  );

  return useMemo(() => {
    const known = new Set(paths);
    // Rung 2 first, because rung 1 is a single comparison against it.
    let mostRecentPath: string | null = null;
    let mostRecentAt = -Infinity;
    for (const [key, iso] of Object.entries(interactions)) {
      if (!key.startsWith(AGENT_KEY_PREFIX)) continue;
      const path = key.slice(AGENT_KEY_PREFIX.length);
      // A record can outlive the agent it names — the store keeps 500 of them
      // and the mesh is the only authority on who still exists.
      if (!known.has(path)) continue;
      const at = Date.parse(iso);
      if (Number.isNaN(at) || at <= mostRecentAt) continue;
      mostRecentAt = at;
      mostRecentPath = path;
    }

    const path = selectedCwd !== null && known.has(selectedCwd) ? selectedCwd : mostRecentPath;
    if (path === null) return null;
    return { path, displayName: displayNames[path] ?? path };
  }, [displayNames, interactions, paths, selectedCwd]);
}
