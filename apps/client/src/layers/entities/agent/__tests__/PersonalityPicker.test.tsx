/**
 * @vitest-environment jsdom
 */
import { useState } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { generateVoiceSample } from '@dorkos/shared/dorkbot-templates';
import { DEFAULT_TRAITS } from '@dorkos/shared/trait-renderer';
import type { Traits } from '@dorkos/shared/mesh-schemas';
import {
  PersonalityPicker,
  type PersonalityPickerLayout,
  findMatchingPreset,
  PERSONALITY_PRESETS,
} from '..';

/** A controlled harness so preset clicks flow back into the picker. */
function Harness({ layout }: { layout?: PersonalityPickerLayout }) {
  const [traits, setTraits] = useState<Traits>({ ...DEFAULT_TRAITS });
  return (
    <PersonalityPicker
      traits={traits}
      onTraitsChange={setTraits}
      layout={layout}
      sampleLabel="How DorkBot talks"
    />
  );
}

beforeEach(() => {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
});

afterEach(() => cleanup());

describe('PersonalityPicker', () => {
  it('stacked layout shows the sample voice and updates it when a preset changes', () => {
    render(<Harness layout="stacked" />);

    const defaultSample = generateVoiceSample(
      DEFAULT_TRAITS,
      findMatchingPreset(DEFAULT_TRAITS)?.id
    );
    expect(screen.getByTestId('personality-sample').textContent).toContain(defaultSample);

    const hotshot = PERSONALITY_PRESETS.find((p) => p.id === 'hotshot')!;
    fireEvent.click(screen.getByRole('button', { name: new RegExp(hotshot.name) }));

    const hotshotSample = generateVoiceSample(hotshot.traits as Traits, hotshot.id);
    expect(screen.getByTestId('personality-sample').textContent).toContain(hotshotSample);
  });

  it('inline layout keeps the sample voice hidden (settings popover is unchanged)', () => {
    render(<Harness />);
    // The stacked sample slot is never rendered in the inline layout.
    expect(screen.queryByTestId('personality-sample')).toBeNull();
    // Presets still render, so the control itself is intact.
    expect(screen.getByTestId('preset-pills')).toBeInTheDocument();
  });
});
