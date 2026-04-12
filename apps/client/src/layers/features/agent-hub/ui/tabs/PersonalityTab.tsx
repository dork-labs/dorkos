import { PersonalityTab as AgentPersonalityTab } from '@/layers/features/agent-settings';
import { useAgentHubContext } from '../../model/agent-hub-context';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

/** Server GET response augments manifest with convention file content. */
type AgentWithConventions = AgentManifest & {
  soulContent?: string | null;
  nopeContent?: string | null;
};

/**
 * Personality tab wrapper for the Agent Hub panel.
 *
 * Reads the active agent from `AgentHubProvider` and delegates to the
 * shared `PersonalityTab` from agent-settings.
 */
export function PersonalityTab() {
  const { agent, onPersonalityUpdate } = useAgentHubContext();
  const augmented = agent as AgentWithConventions;

  return (
    <AgentPersonalityTab
      agent={agent}
      soulContent={augmented.soulContent ?? null}
      nopeContent={augmented.nopeContent ?? null}
      onUpdate={onPersonalityUpdate}
    />
  );
}
