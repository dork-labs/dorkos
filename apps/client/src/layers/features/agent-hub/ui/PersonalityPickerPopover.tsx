import { useState, useCallback } from 'react';
import { ChevronDown, ChevronRight, X } from 'lucide-react';
import { cn, playSliderTick } from '@/layers/shared/lib';
import { Button } from '@/layers/shared/ui';
import { TraitSliders } from '@/layers/entities/agent';
import { useAgentHubContext } from '../model/agent-hub-context';
import { PersonalityRadar } from './PersonalityRadar';
import { useNebulaAlpha } from '../lib/nebula-theme';
import {
  PERSONALITY_PRESETS,
  DEFAULT_PRESET_COLORS,
  findMatchingPreset,
} from '../model/personality-presets';
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
  const [showSliders, setShowSliders] = useState(false);

  const na = useNebulaAlpha();

  const traits = agent.traits ?? {
    tone: 3,
    autonomy: 3,
    caution: 3,
    communication: 3,
    creativity: 3,
  };
  const activePreset = findMatchingPreset(traits);
  const presetColors = activePreset?.colors ?? DEFAULT_PRESET_COLORS;

  const handlePresetSelect = useCallback(
    (preset: (typeof PERSONALITY_PRESETS)[number]) => {
      onPersonalityUpdate({ traits: preset.traits as Traits });
      setShowSliders(false);
      playSliderTick();
    },
    [onPersonalityUpdate]
  );

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

      <div className="flex flex-col items-center gap-3 p-4">
        {/* Preset pills */}
        <div
          className="flex max-w-sm flex-wrap justify-center gap-1.5"
          data-testid="personality-presets"
        >
          {PERSONALITY_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => handlePresetSelect(preset)}
              className={cn(
                'shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-all',
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

        {/* Cosmic Nebula radar */}
        <PersonalityRadar traits={traits} colors={presetColors} size={180} />

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

        {/* Custom controls toggle */}
        <button
          type="button"
          onClick={() => setShowSliders(!showSliders)}
          className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-[10px] transition-colors"
          data-testid="custom-controls-toggle"
        >
          {showSliders ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          Custom controls
        </button>

        {/* Trait sliders */}
        {showSliders && (
          <div className="w-full max-w-sm" onPointerDown={() => playSliderTick()}>
            <TraitSliders
              traits={traits}
              onChange={handleTraitsChange}
              onSliderChange={() => playSliderTick()}
              showEndpoints
            />
          </div>
        )}

        {/* Sample response preview */}
        <div className="w-full max-w-sm">
          <span className="text-muted-foreground text-[9px] font-medium tracking-wider uppercase">
            How this agent talks
          </span>
          <div className="bg-accent/50 mt-1.5 rounded-lg p-3">
            <p className="text-muted-foreground text-xs leading-relaxed italic">
              {activePreset?.sampleResponse ??
                'This agent uses a custom personality blend. Select a preset to see a sample response.'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
