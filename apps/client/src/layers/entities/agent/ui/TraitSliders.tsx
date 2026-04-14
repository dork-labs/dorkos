import { useCallback } from 'react';
import { Slider } from '@/layers/shared/ui';
import { TRAIT_ORDER, TRAIT_LEVELS, type TraitName } from '@dorkos/shared/trait-renderer';
import type { Traits } from '@dorkos/shared/mesh-schemas';

export interface TraitSlidersProps {
  traits: Traits;
  onChange: (traits: Traits) => void;
  /** Side-effect callback per slider tick (e.g. sound, animation) */
  onSliderChange?: (name: TraitName, value: number) => void;
}

/**
 * Five discrete personality trait sliders with optional endpoint labels and
 * preview text. Reusable across onboarding, agent creation, and agent settings.
 */
export function TraitSliders({ traits, onChange, onSliderChange }: TraitSlidersProps) {
  const handleChange = useCallback(
    (name: TraitName, value: number) => {
      onSliderChange?.(name, value);
      onChange({ ...traits, [name]: value });
    },
    [traits, onChange, onSliderChange]
  );

  return (
    <div className="space-y-4">
      {TRAIT_ORDER.map((name) => (
        <TraitSliderRow key={name} name={name} level={traits[name] ?? 3} onChange={handleChange} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Private sub-component — keeps each function under 50 lines
// ---------------------------------------------------------------------------

interface TraitSliderRowProps {
  name: TraitName;
  level: number;
  onChange: (name: TraitName, value: number) => void;
}

function TraitSliderRow({ name, level, onChange }: TraitSliderRowProps) {
  const entry = TRAIT_LEVELS[name][level];

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium capitalize">{name}</span>
        <span className="text-muted-foreground">
          {level}/5 {entry.label}
        </span>
      </div>
      <Slider
        value={[level]}
        onValueChange={([v]) => onChange(name, v)}
        min={1}
        max={5}
        step={1}
        aria-label={`${name} trait level`}
      />
    </div>
  );
}
