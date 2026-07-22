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

function StackedPickerDemo() {
  const [traits, setTraits] = useState<Traits>({ ...DEFAULT_TRAITS });
  return (
    <PersonalityPicker
      traits={traits}
      onTraitsChange={setTraits}
      layout="stacked"
      sampleLabel="How DorkBot talks"
    />
  );
}

/** Personality picker showcases: inline (default/compact) and stacked variants. */
export function PersonalityPickerShowcases() {
  return (
    <PlaygroundSection
      title="PersonalityPicker"
      description="Shared personality picker body — radar, archetype label, preset pills, custom sliders, sample voice. The inline layout is used by PersonalityPickerPanel (agent hub); the stacked layout (large centered radar + a distinct sample-voice block) is used by the onboarding conversation."
    >
      <ShowcaseLabel>Default (inline)</ShowcaseLabel>
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

      <ShowcaseLabel>Stacked (onboarding card)</ShowcaseLabel>
      <ShowcaseDemo responsive>
        <div className="mx-auto max-w-sm px-4 py-4">
          <div className="bg-card/50 shadow-soft rounded-lg border p-4">
            <StackedPickerDemo />
          </div>
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
