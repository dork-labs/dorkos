/**
 * What to call the agent behind each waiting prompt.
 *
 * The wire carries ids and a working directory on purpose — a name copied onto
 * a hot event goes stale the moment an agent is renamed — so every surface that
 * draws a card joins the roster itself. This is that join, done once: the same
 * `cwd → display name` map `deriveAttentionSignals` already builds, re-keyed by
 * the session each prompt came from, which is how `AskList` addresses it.
 *
 * @module entities/attention/model/use-ask-agent-names
 */
import { useMemo } from 'react';
import type { InteractionPendingEvent } from '@dorkos/shared/interaction-events';
import { disambiguateDisplayNames, useResolvedAgents } from '@/layers/entities/agent';
import { useMeshAgentPaths } from '@/layers/entities/mesh';

/** Shared empty, so a cockpit with no roster never mints a fresh identity. */
const NO_NAMES: Readonly<Record<string, string>> = {};

/**
 * Session id → what to call its agent, for the prompts given.
 *
 * Both queries are ones the cockpit already holds, so this is a cache read and
 * the net request count is unchanged. A session whose directory the roster does
 * not know is simply absent from the map, and the card falls back to the
 * directory's own name.
 *
 * @param asks - The prompts about to be drawn.
 */
export function useAskAgentNames(
  asks: readonly InteractionPendingEvent[]
): Readonly<Record<string, string>> {
  const { data: meshData } = useMeshAgentPaths();
  const rawPaths = useMemo(
    () => (meshData?.agents ?? []).map((entry) => entry.projectPath),
    [meshData]
  );
  const { data: manifests } = useResolvedAgents(rawPaths);
  const byPath = useMemo(
    () => disambiguateDisplayNames(rawPaths, manifests ?? {}),
    [rawPaths, manifests]
  );

  return useMemo(() => {
    if (asks.length === 0) return NO_NAMES;
    const out: Record<string, string> = {};
    for (const ask of asks) {
      const name = byPath[ask.cwd];
      if (name !== undefined) out[ask.sessionId] = name;
    }
    return out;
  }, [asks, byPath]);
}
