import { useState, useCallback } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { DEFAULT_TRAITS } from '@dorkos/shared/trait-renderer';
import type { Traits } from '@dorkos/shared/mesh-schemas';
import { generateFirstMessage } from '@dorkos/shared/dorkbot-templates';
import { playSliderTick, playCelebration, cn } from '@/layers/shared/lib';
import { useAppStore } from '@/layers/shared/model';
import { Button } from '@/layers/shared/ui';
import { TraitSliders, useUpdateAgent } from '@/layers/entities/agent';
import { PersonalityRadar } from '@/layers/features/agent-hub/ui/PersonalityRadar';
import { useNebulaAlpha } from '@/layers/features/agent-hub/lib/nebula-theme';
import {
  PERSONALITY_PRESETS,
  DEFAULT_PRESET_COLORS,
  findMatchingPreset,
} from '@/layers/features/agent-hub';
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
  const [showSliders, setShowSliders] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const na = useNebulaAlpha();

  const updateAgent = useUpdateAgent();
  const { config } = useOnboarding();
  const setDorkbotFirstMessage = useAppStore((s) => s.setDorkbotFirstMessage);

  const activePreset = findMatchingPreset(traits);
  const presetColors = activePreset?.colors ?? DEFAULT_PRESET_COLORS;

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
          Your permanent system agent. Choose a personality that matches how you like to work.
        </p>
      </div>

      {/* Cosmic Nebula radar */}
      <div data-testid="personality-radar">
        <PersonalityRadar traits={traits} colors={presetColors} size={200} />
      </div>

      {/* Archetype name + tagline */}
      <div className="text-center">
        <h3
          className="bg-clip-text text-sm font-bold text-transparent"
          style={{
            backgroundImage: `linear-gradient(135deg, ${presetColors.stroke}, ${presetColors.strokeEnd})`,
          }}
        >
          {activePreset?.name ?? 'Custom'}
        </h3>
        <p className="text-muted-foreground mt-0.5 text-[11px]">
          {activePreset?.tagline ?? 'A custom blend of personality traits.'}
        </p>
      </div>

      {/* Preset pills */}
      <div className="flex max-w-sm flex-wrap justify-center gap-1.5" data-testid="preset-pills">
        {PERSONALITY_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            onClick={() => {
              setTraits(preset.traits as Traits);
              setShowSliders(false);
              playSliderTick();
            }}
            className={cn(
              'shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition-all',
              activePreset?.id === preset.id
                ? 'text-foreground'
                : 'bg-accent text-muted-foreground hover:text-foreground border-transparent'
            )}
            style={
              activePreset?.id === preset.id
                ? {
                    borderColor: preset.colors.stroke,
                    background: `linear-gradient(135deg, ${preset.colors.nebula}${na.pillBgStart}, ${preset.colors.wisp}${na.pillBgEnd})`,
                    boxShadow: `0 0 12px ${preset.colors.nebula}${na.pillGlow}`,
                  }
                : undefined
            }
          >
            {preset.emoji} {preset.name}
          </button>
        ))}
      </div>

      {/* Custom controls toggle */}
      <button
        type="button"
        onClick={() => setShowSliders(!showSliders)}
        className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs transition-colors"
        data-testid="custom-toggle"
      >
        {showSliders ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        Custom controls
      </button>

      {/* Trait sliders (hidden by default) */}
      {showSliders && (
        <div className="w-full max-w-md" onPointerDown={() => playSliderTick()}>
          <TraitSliders
            traits={traits}
            onChange={setTraits}
            onSliderChange={() => playSliderTick()}
            showEndpoints
          />
        </div>
      )}

      {/* Response preview */}
      {activePreset && (
        <div className="w-full max-w-sm px-4">
          <span className="text-muted-foreground text-[9px] font-medium tracking-wider uppercase">
            How DorkBot will talk
          </span>
          <div className="bg-accent/50 mt-1 rounded-lg p-3">
            <p className="text-muted-foreground text-xs leading-relaxed italic">
              {activePreset.sampleResponse}
            </p>
          </div>
        </div>
      )}

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
