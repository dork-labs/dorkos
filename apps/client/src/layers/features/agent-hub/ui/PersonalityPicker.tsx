import { useState, useCallback } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import { playSliderTick } from '@/layers/shared/lib';
import { TraitSliders, PresetPill } from '@/layers/entities/agent';
import { PersonalityRadar } from './PersonalityRadar';
import {
  PERSONALITY_PRESETS,
  DEFAULT_PRESET_COLORS,
  findMatchingPreset,
} from '../model/personality-presets';
import type { Traits } from '@dorkos/shared/mesh-schemas';

export interface PersonalityPickerProps {
  /** Current personality traits (controlled). */
  traits: Traits;
  /** Callback when traits change via preset selection or slider. */
  onTraitsChange: (traits: Traits) => void;
  /** Use compact sizing for inline panels. @default false */
  compact?: boolean;
  /** Label above the sample response preview. @default 'How this agent talks' */
  sampleLabel?: string;
  /** Container className. */
  className?: string;
}

/**
 * Personality picker body — radar, archetype label, preset pills,
 * custom sliders toggle, and sample response preview.
 *
 * Controlled component: consumers own the traits state and provide
 * their own chrome (headers, action buttons, error displays).
 */
export function PersonalityPicker({
  traits,
  onTraitsChange,
  compact = false,
  sampleLabel = 'How this agent talks',
  className,
}: PersonalityPickerProps) {
  const [showSliders, setShowSliders] = useState(false);

  const activePreset = findMatchingPreset(traits);
  const presetColors = activePreset?.colors ?? DEFAULT_PRESET_COLORS;

  const handlePresetSelect = useCallback(
    (preset: (typeof PERSONALITY_PRESETS)[number]) => {
      onTraitsChange(preset.traits as Traits);
      setShowSliders(false);
      playSliderTick();
    },
    [onTraitsChange]
  );

  return (
    <div className={cn('flex flex-col items-center gap-3', className)}>
      {/* Cosmic Nebula radar */}
      <div data-testid="personality-radar">
        <PersonalityRadar
          traits={traits}
          colors={presetColors}
          size={compact ? 180 : 200}
          className={compact ? 'w-[90%] max-w-[240px]' : 'w-full max-w-[200px]'}
        />
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
          <PresetPill
            key={preset.id}
            emoji={preset.emoji}
            name={preset.name}
            colors={preset.colors}
            active={activePreset?.id === preset.id}
            size={compact ? 'sm' : 'default'}
            glow
            onClick={() => handlePresetSelect(preset)}
          />
        ))}
      </div>

      {/* Custom controls toggle */}
      <button
        type="button"
        onClick={() => setShowSliders(!showSliders)}
        className={cn(
          'text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors',
          compact ? 'text-[10px]' : 'text-xs'
        )}
        data-testid="custom-toggle"
      >
        {showSliders ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        Custom controls
      </button>

      {/* Trait sliders (hidden by default) */}
      {showSliders && (
        <div
          className={cn('w-full', compact ? 'max-w-sm' : 'max-w-md')}
          onPointerDown={() => playSliderTick()}
        >
          <TraitSliders
            traits={traits}
            onChange={onTraitsChange}
            onSliderChange={() => playSliderTick()}
          />
        </div>
      )}

      {/* Sample response preview */}
      <div className="w-full max-w-sm">
        <span className="text-muted-foreground text-[9px] font-medium tracking-wider uppercase">
          {sampleLabel}
        </span>
        <div className="bg-accent/50 mt-1 rounded-lg p-3">
          <p className="text-muted-foreground text-xs leading-relaxed italic">
            {activePreset?.sampleResponse ??
              'This agent uses a custom personality blend. Select a preset to see a sample response.'}
          </p>
        </div>
      </div>
    </div>
  );
}
