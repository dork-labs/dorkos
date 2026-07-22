import { useState } from 'react';
import { DEFAULT_TRAITS } from '@dorkos/shared/trait-renderer';
import type { Traits } from '@dorkos/shared/mesh-schemas';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { PersonalityPicker } from '@/layers/features/agent-hub';

function DefaultPickerDemo() {
  const [traits, setTraits] = useState<Traits>({ ...DEFAULT_TRAITS });
  return <PersonalityPicker traits={traits} onTraitsChange={setTraits} />;
}

function CompactPickerDemo() {
  const [traits, setTraits] = useState<Traits>({ ...DEFAULT_TRAITS });
  return <PersonalityPicker traits={traits} onTraitsChange={setTraits} compact />;
}

/** Personality picker showcases: default and compact variants. */
export function PersonalityPickerShowcases() {
  return (
    <PlaygroundSection
      title="PersonalityPicker"
      description="Shared personality picker body — radar, archetype label, preset pills, custom sliders, sample response. Used by the onboarding conversation and PersonalityPickerPanel (agent hub)."
    >
      <ShowcaseLabel>Default</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <div className="mx-auto max-w-2xl px-4 py-4">
          <DefaultPickerDemo />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Compact (for inline panels)</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <div className="mx-auto max-w-sm px-4 py-4">
          <CompactPickerDemo />
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
