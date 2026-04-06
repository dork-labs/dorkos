import { useState, useCallback } from 'react';
import { Bot } from 'lucide-react';
import { DEFAULT_TRAITS } from '@dorkos/shared/trait-renderer';
import type { Traits } from '@dorkos/shared/mesh-schemas';
import { generateFirstMessage } from '@dorkos/shared/dorkbot-templates';
import { playSliderTick, playCelebration, cn } from '@/layers/shared/lib';
import { useAppStore } from '@/layers/shared/model';
import { Button } from '@/layers/shared/ui';
import { TraitSliders, useUpdateAgent } from '@/layers/entities/agent';
import { useOnboarding } from '../model/use-onboarding';

interface MeetDorkBotStepProps {
  onStepComplete: () => void;
}

/**
 * Meet DorkBot onboarding step — personality trait sliders with avatar
 * breathing animation. Updates the existing DorkBot agent's traits.
 */
export function MeetDorkBotStep({ onStepComplete }: MeetDorkBotStepProps) {
  const [traits, setTraits] = useState<Traits>({ ...DEFAULT_TRAITS });
  const [isReacting, setIsReacting] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);

  const updateAgent = useUpdateAgent();
  const { config } = useOnboarding();
  const setDorkbotFirstMessage = useAppStore((s) => s.setDorkbotFirstMessage);

  const handleSliderPointerDown = useCallback(() => {
    setIsReacting(true);
  }, []);

  const handleSliderPointerUp = useCallback(() => {
    setTimeout(() => setIsReacting(false), 600);
  }, []);

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
    <div className="flex flex-1 flex-col items-center gap-6 overflow-y-auto py-4">
      {/* Avatar with breathing animation */}
      <div
        className={cn(
          'dorkbot-avatar bg-muted flex size-16 items-center justify-center rounded-2xl',
          isReacting && 'reacting'
        )}
        data-testid="dorkbot-avatar"
      >
        <Bot className="text-muted-foreground size-8" />
      </div>

      <div className="space-y-3 text-center">
        <h2 className="text-2xl font-semibold tracking-tight">Meet DorkBot</h2>
        <p className="text-muted-foreground max-w-sm text-sm">
          Your permanent system agent. Handles background jobs, manages other agents, and knows
          DorkOS end to end.
        </p>
        <p className="text-foreground max-w-sm text-sm font-medium">
          Tune how it operates before you continue.
        </p>
      </div>

      {/* Trait sliders */}
      <div
        className="w-full max-w-md"
        data-testid="personality-sliders"
        onPointerDown={handleSliderPointerDown}
        onPointerUp={handleSliderPointerUp}
      >
        <TraitSliders
          traits={traits}
          onChange={setTraits}
          onSliderChange={() => playSliderTick()}
          showEndpoints
        />
      </div>

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
