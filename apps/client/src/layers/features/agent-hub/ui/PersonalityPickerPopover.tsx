import { useCallback } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/layers/shared/ui';
import { useAgentHubContext } from '../model/agent-hub-context';
import { PersonalityPicker } from './PersonalityPicker';
import { DEFAULT_TRAITS } from '@dorkos/shared/trait-renderer';
import type { Traits } from '@dorkos/shared/mesh-schemas';

interface PersonalityPickerPanelProps {
  onClose: () => void;
}

/**
 * Full-width inline panel for picking personality preset and tuning traits.
 * Rendered in the tab content area when the personality badge is clicked.
 */
export function PersonalityPickerPanel({ onClose }: PersonalityPickerPanelProps) {
  const { agent, onPersonalityUpdate } = useAgentHubContext();

  const traits = agent.traits ?? DEFAULT_TRAITS;

  const handleTraitsChange = useCallback(
    (newTraits: Traits) => {
      onPersonalityUpdate({ traits: newTraits });
    },
    [onPersonalityUpdate]
  );

  return (
    <div className="flex flex-1 flex-col overflow-auto" data-testid="personality-picker-panel">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-2">
        <span className="text-xs font-semibold">Personality</span>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={onClose}
          aria-label="Close personality picker"
        >
          <X className="size-3.5" />
        </Button>
      </div>

      <PersonalityPicker
        traits={traits}
        onTraitsChange={handleTraitsChange}
        compact
        className="p-4"
      />
    </div>
  );
}
