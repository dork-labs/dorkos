import { useCallback } from 'react';
import { Slider, Label } from '@/layers/shared/ui';
import { TRAIT_ORDER, TRAIT_LEVELS, type TraitName } from '@dorkos/shared/trait-renderer';
import type { Traits } from '@dorkos/shared/mesh-schemas';

interface PersonalitySlidersProps {
  traits: Traits;
  onChange: (traits: Traits) => void;
}

/**
 * Five discrete personality trait sliders with level labels.
 * Each slider has 5 positions (min=1, max=5, step=1).
 */
export function PersonalitySliders({ traits, onChange }: PersonalitySlidersProps) {
  const handleTraitChange = useCallback(
    (name: TraitName, value: number) => {
      onChange({ ...traits, [name]: value });
    },
    [traits, onChange]
  );

  return (
    <div className="space-y-4">
      {TRAIT_ORDER.map((name) => {
        const level = traits[name] ?? 3;
        const entry = TRAIT_LEVELS[name][level];

        return (
          <div key={name} className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-medium capitalize">{name}</Label>
              <span className="text-muted-foreground text-xs">
                {level}/5 {entry.label}
              </span>
            </div>
            <Slider
              value={[level]}
              onValueChange={([v]) => handleTraitChange(name, v)}
              min={1}
              max={5}
              step={1}
              aria-label={`${name} trait level`}
            />
          </div>
        );
      })}
    </div>
  );
}
