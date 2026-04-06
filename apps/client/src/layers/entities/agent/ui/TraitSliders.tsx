import { useCallback } from 'react';
import { Slider, Label } from '@/layers/shared/ui';
import {
  TRAIT_ORDER,
  TRAIT_LEVELS,
  TRAIT_ENDPOINT_LABELS,
  TRAIT_PREVIEWS,
  type TraitName,
} from '@dorkos/shared/trait-renderer';
import type { Traits } from '@dorkos/shared/mesh-schemas';

export interface TraitSlidersProps {
  traits: Traits;
  onChange: (traits: Traits) => void;
  /** Side-effect callback per slider tick (e.g. sound, animation) */
  onSliderChange?: (name: TraitName, value: number) => void;
  /** Show min/max endpoint labels on each slider */
  showEndpoints?: boolean;
  /** Show human-readable preview sentence below each slider */
  showPreviews?: boolean;
}

/**
 * Five discrete personality trait sliders with optional endpoint labels and
 * preview text. Reusable across onboarding, agent creation, and agent settings.
 */
export function TraitSliders({
  traits,
  onChange,
  onSliderChange,
  showEndpoints = false,
  showPreviews = false,
}: TraitSlidersProps) {
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
        <TraitSliderRow
          key={name}
          name={name}
          level={traits[name] ?? 3}
          showEndpoints={showEndpoints}
          showPreviews={showPreviews}
          onChange={handleChange}
        />
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
  showEndpoints: boolean;
  showPreviews: boolean;
  onChange: (name: TraitName, value: number) => void;
}

function TraitSliderRow({
  name,
  level,
  showEndpoints,
  showPreviews,
  onChange,
}: TraitSliderRowProps) {
  const entry = TRAIT_LEVELS[name][level];
  const endpoints = TRAIT_ENDPOINT_LABELS[name];

  return (
    <div className="space-y-2">
      {showEndpoints ? (
        <div className="grid grid-cols-3 text-sm">
          <span className="text-muted-foreground">{endpoints.min}</span>
          <span className="text-center font-medium capitalize">{name}</span>
          <span className="text-muted-foreground text-right">{endpoints.max}</span>
        </div>
      ) : (
        <div className="flex items-center justify-between">
          <Label className="text-sm font-medium capitalize">{name}</Label>
        </div>
      )}
      <Slider
        value={[level]}
        onValueChange={([v]) => onChange(name, v)}
        min={1}
        max={5}
        step={1}
        aria-label={`${name} trait level`}
      />
      <div className="flex items-center justify-between">
        <span className="text-muted-foreground text-xs">
          {level}/5 {entry.label}
        </span>
        {showPreviews && (
          <span className="text-muted-foreground text-xs italic">
            {TRAIT_PREVIEWS[name][level]}
          </span>
        )}
      </div>
    </div>
  );
}
