import { describe, it, expect } from 'vitest';
import {
  DORKBOT_ONBOARDING_LINES,
  dorkbotClaudeMdTemplate,
  dorkbotDiscoveryFoundLine,
  generateVoiceSample,
} from '../dorkbot-templates.js';
import type { Traits } from '../mesh-schemas.js';

function makeTraits(overrides: Partial<Traits> = {}): Traits {
  return {
    verbosity: 3,
    autonomy: 3,
    chaos: 3,
    creativity: 3,
    humor: 3,
    spice: 3,
    ...overrides,
  };
}

describe('dorkbot-templates', () => {
  describe('dorkbotClaudeMdTemplate', () => {
    it('returns a non-empty string with DorkBot header', () => {
      const result = dorkbotClaudeMdTemplate();
      expect(result).toContain('# DorkBot');
      expect(result).toContain('DorkOS');
    });
  });

  describe('DORKBOT_ONBOARDING_LINES', () => {
    it('provides two arrival lines and every scripted prompt', () => {
      expect(DORKBOT_ONBOARDING_LINES.arrival).toHaveLength(2);
      expect(DORKBOT_ONBOARDING_LINES.personalityPrompt).toContain('personality');
      expect(DORKBOT_ONBOARDING_LINES.discoveryPrompt).toContain('look around');
      expect(DORKBOT_ONBOARDING_LINES.handoffPrompt).toContain('building today');
    });

    it('never uses an em dash (writing-for-humans)', () => {
      const allCopy = [
        ...DORKBOT_ONBOARDING_LINES.arrival,
        DORKBOT_ONBOARDING_LINES.wakingUp,
        DORKBOT_ONBOARDING_LINES.composerSetupPlaceholder,
        DORKBOT_ONBOARDING_LINES.personalityPrompt,
        DORKBOT_ONBOARDING_LINES.saveError,
        DORKBOT_ONBOARDING_LINES.discoveryPrompt,
        DORKBOT_ONBOARDING_LINES.scanning,
        DORKBOT_ONBOARDING_LINES.discoveryZero,
        DORKBOT_ONBOARDING_LINES.discoveryTimeout,
        DORKBOT_ONBOARDING_LINES.discoveryDecline,
        DORKBOT_ONBOARDING_LINES.handoffPrompt,
        DORKBOT_ONBOARDING_LINES.composerHandoffPlaceholder,
        dorkbotDiscoveryFoundLine(3),
        ...(['terse', 'balanced', 'warm', 'playful', 'bold', 'inventive'] as const).map(() =>
          generateVoiceSample(makeTraits())
        ),
      ].join(' ');
      expect(allCopy).not.toContain('—');
    });
  });

  describe('dorkbotDiscoveryFoundLine', () => {
    it('spells out a single result as "one"', () => {
      expect(dorkbotDiscoveryFoundLine(1)).toBe('Found one. Want them in your fleet?');
    });

    it('uses the numeral for multiple results', () => {
      expect(dorkbotDiscoveryFoundLine(4)).toBe('Found 4. Want them in your fleet?');
    });
  });

  describe('generateVoiceSample', () => {
    it('returns a non-empty single-sentence line', () => {
      const sample = generateVoiceSample(makeTraits());
      expect(sample.length).toBeGreaterThan(0);
      expect(sample).not.toContain('\n');
    });

    it('is deterministic for the same traits', () => {
      const traits = makeTraits({ humor: 5 });
      expect(generateVoiceSample(traits)).toBe(generateVoiceSample(traits));
    });

    it('audibly changes across personality presets', () => {
      const balanced = generateVoiceSample(makeTraits());
      const terse = generateVoiceSample(makeTraits({ verbosity: 1, humor: 1, spice: 1 }));
      const playful = generateVoiceSample(makeTraits({ humor: 5 }));
      const bold = generateVoiceSample(makeTraits({ spice: 5 }));
      const inventive = generateVoiceSample(
        makeTraits({ creativity: 5, chaos: 5, humor: 2, spice: 2 })
      );
      const warm = generateVoiceSample(makeTraits({ verbosity: 5, humor: 3, spice: 2 }));

      const samples = [balanced, terse, playful, bold, inventive, warm];
      expect(new Set(samples).size).toBe(samples.length);
    });

    it('prioritizes edge (spice) over humor when both are high', () => {
      const bold = generateVoiceSample(makeTraits({ spice: 5, humor: 5 }));
      const playful = generateVoiceSample(makeTraits({ spice: 2, humor: 5 }));
      expect(bold).not.toBe(playful);
    });

    it('returns a distinct line for every named preset (no adjacent collisions)', () => {
      const presetIds = [
        'balanced',
        'hotshot',
        'sage',
        'sentinel',
        'phantom',
        'mad-scientist',
        'the-bro',
        'drill-sergeant',
      ];
      // Same traits, different preset id — the id drives the line, so all 8 differ.
      const samples = presetIds.map((id) => generateVoiceSample(makeTraits(), id));
      expect(new Set(samples).size).toBe(presetIds.length);
    });

    it('falls back to the trait classifier for a Custom blend (no preset id)', () => {
      const custom = generateVoiceSample(makeTraits({ spice: 5 }));
      expect(custom).toBe(generateVoiceSample(makeTraits({ spice: 5 }), undefined));
    });
  });
});
