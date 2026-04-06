import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { useAgentDialog } from '../../model/agent-dialog-context';
import { PersonalityTab } from '../PersonalityTab';

/** Server GET response augments manifest with convention file content. */
type AgentWithConventions = AgentManifest & {
  soulContent?: string | null;
  nopeContent?: string | null;
};

/** Context-bound wrapper around PersonalityTab for use in TabbedDialog. */
export function PersonalityTabConsumer() {
  const { agent, onPersonalityUpdate } = useAgentDialog();
  const augmented = agent as AgentWithConventions;
  return (
    <PersonalityTab
      agent={agent}
      soulContent={augmented.soulContent ?? null}
      nopeContent={augmented.nopeContent ?? null}
      onUpdate={onPersonalityUpdate}
    />
  );
}
