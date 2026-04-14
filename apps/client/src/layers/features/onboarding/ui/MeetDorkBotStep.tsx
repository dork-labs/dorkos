import { useState, useCallback } from 'react';
import { DEFAULT_TRAITS } from '@dorkos/shared/trait-renderer';
import type { Traits } from '@dorkos/shared/mesh-schemas';
import { generateFirstMessage } from '@dorkos/shared/dorkbot-templates';
import { playCelebration } from '@/layers/shared/lib';
import { useAppStore } from '@/layers/shared/model';
import { Button } from '@/layers/shared/ui';
import { useUpdateAgent } from '@/layers/entities/agent';
import { PersonalityPicker } from '@/layers/features/agent-hub';
import { useOnboarding } from '../model/use-onboarding';

interface MeetDorkBotStepProps {
  onStepComplete: () => void;
}

/**
 * Meet DorkBot onboarding step — Cosmic Nebula personality picker with
 * preset archetypes as the primary interaction and trait sliders available
 * behind a "Custom" toggle for fine-tuning.
 */
export function MeetDorkBotStep({ onStepComplete }: MeetDorkBotStepProps) {
  const [traits, setTraits] = useState<Traits>({ ...DEFAULT_TRAITS });
  const [updateError, setUpdateError] = useState<string | null>(null);

  const updateAgent = useUpdateAgent();
  const { config } = useOnboarding();
  const setDorkbotFirstMessage = useAppStore((s) => s.setDorkbotFirstMessage);

  const handleContinue = useCallback(() => {
    setUpdateError(null);

    const defaultDir = config?.agents?.defaultDirectory || '~/.dork/agents';
    const agentPath = `${defaultDir}/dorkbot`;

    updateAgent.mutate(
      { path: agentPath, updates: { traits } },
      {
        onSuccess: () => {
          setDorkbotFirstMessage(generateFirstMessage(traits));
          playCelebration();
          onStepComplete();
        },
        onError: (error) => {
          setUpdateError(error instanceof Error ? error.message : 'Failed to update personality');
        },
      }
    );
  }, [traits, config, updateAgent, onStepComplete, setDorkbotFirstMessage]);

  return (
    <div className="flex flex-1 flex-col items-center gap-4 overflow-y-auto py-4">
      <div className="space-y-2 text-center">
        <h2 className="text-2xl font-semibold tracking-tight">Meet DorkBot</h2>
        <p className="text-muted-foreground max-w-sm text-sm">
          Your first agent and DorkOS expert.
          <br />
          Choose DorkBot&apos;s personality.
        </p>
      </div>

      <PersonalityPicker
        traits={traits}
        onTraitsChange={setTraits}
        sampleLabel="How DorkBot will talk"
      />

      {/* Error message */}
      {updateError && (
        <p className="text-destructive text-sm" role="alert" data-testid="update-error">
          {updateError}
        </p>
      )}

      {/* Continue button */}
      <div className="mt-2 flex flex-col items-center gap-2">
        <Button
          onClick={handleContinue}
          disabled={updateAgent.isPending}
          data-testid="continue-dorkbot"
        >
          {updateAgent.isPending ? 'Saving...' : 'Continue'}
        </Button>
        <p className="text-muted-foreground text-xs">Adjustable anytime in settings.</p>
      </div>
    </div>
  );
}
