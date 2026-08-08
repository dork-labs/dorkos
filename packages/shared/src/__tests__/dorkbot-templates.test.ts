import { describe, it, expect } from 'vitest';
import {
  DORKBOT_ONBOARDING_LINES,
  DORKBOT_TOUR_LINES,
  dorkbotClaudeMdTemplate,
  dorkbotDiscoveryFoundLine,
  dorkbotProfileSuggestionLine,
  generateVoiceSample,
} from '../dorkbot-templates.js';
import { recommendForRoles } from '../profile-recommendations.js';
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
        DORKBOT_ONBOARDING_LINES.personalitySkip,
        ...DORKBOT_ONBOARDING_LINES.profilePrompt,
        DORKBOT_ONBOARDING_LINES.profileSkip,
        DORKBOT_ONBOARDING_LINES.profileSaved,
        DORKBOT_ONBOARDING_LINES.profileCardPrompt,
        DORKBOT_ONBOARDING_LINES.discoveryPrompt,
        DORKBOT_ONBOARDING_LINES.scanning,
        DORKBOT_ONBOARDING_LINES.discoveryZero,
        DORKBOT_ONBOARDING_LINES.discoveryTimeout,
        DORKBOT_ONBOARDING_LINES.discoveryDecline,
        DORKBOT_ONBOARDING_LINES.handoffPrompt,
        DORKBOT_ONBOARDING_LINES.composerHandoffPlaceholder,
        dorkbotDiscoveryFoundLine(3),
        dorkbotProfileSuggestionLine(recommendForRoles(['hiring'])),
        ...(['terse', 'balanced', 'warm', 'playful', 'bold', 'inventive'] as const).map(() =>
          generateVoiceSample(makeTraits())
        ),
      ].join(' ');
      expect(allCopy).not.toContain('—');
    });

    it('asks the role question and says the privacy fact in the same beat', () => {
      expect(DORKBOT_ONBOARDING_LINES.profilePrompt).toHaveLength(2);
      expect(DORKBOT_ONBOARDING_LINES.profilePrompt[0]).toContain('what kind of work');
      expect(DORKBOT_ONBOARDING_LINES.profilePrompt[1]).toContain('stays on this machine');
      expect(DORKBOT_ONBOARDING_LINES.profileSkip.length).toBeGreaterThan(0);
      expect(DORKBOT_ONBOARDING_LINES.profileSaved.length).toBeGreaterThan(0);
      expect(DORKBOT_ONBOARDING_LINES.profileCardPrompt).toContain('stays on this machine');
    });
  });

  describe('dorkbotProfileSuggestionLine', () => {
    it('speaks the authored hiring line from the spec', () => {
      expect(dorkbotProfileSuggestionLine(recommendForRoles(['hiring']))).toBe(
        'People who hire usually connect Gmail and Greenhouse, so their agents can work the inbox and the pipeline. You can set those up any time.'
      );
    });

    it('returns the empty string for no recommendations (beat advances silently)', () => {
      expect(dorkbotProfileSuggestionLine([])).toBe('');
    });

    it('names at most three services', () => {
      const recs = recommendForRoles(['hiring', 'design', 'software-development']);
      const line = dorkbotProfileSuggestionLine(recs);
      const named = Object.values({
        gmail: 'Gmail',
        greenhouse: 'Greenhouse',
        figma: 'Figma',
        slack: 'Slack',
        github: 'GitHub',
        linear: 'Linear',
      }).filter((name) => line.includes(name));
      expect(named.length).toBeLessThanOrEqual(3);
      expect(named.length).toBeGreaterThan(0);
    });

    it('never claims anything is set up or configured (demo-claim gate)', () => {
      for (const roles of [['hiring'], ['design'], ['writing', 'sales']]) {
        const line = dorkbotProfileSuggestionLine(recommendForRoles(roles)).toLowerCase();
        expect(line).not.toContain('set up for you');
        expect(line).not.toContain('configured');
        expect(line).not.toContain('connections page');
        expect(line.endsWith('any time.')).toBe(true);
      }
    });
  });

  describe('DORKBOT_TOUR_LINES', () => {
    it('has an offer and a caption for every tour', () => {
      expect(DORKBOT_TOUR_LINES.offers.tasks).toContain('schedule');
      expect(DORKBOT_TOUR_LINES.offers.relay).toContain('integration');
      expect(DORKBOT_TOUR_LINES.offers.mesh).toContain('agents');
      expect(DORKBOT_TOUR_LINES.general.composer.length).toBeGreaterThan(0);
      expect(DORKBOT_TOUR_LINES.general.homeTabs.length).toBeGreaterThan(0);
      expect(DORKBOT_TOUR_LINES.tasks.tasksList.length).toBeGreaterThan(0);
      expect(DORKBOT_TOUR_LINES.relay.relayIntegrations.length).toBeGreaterThan(0);
      expect(DORKBOT_TOUR_LINES.mesh.teamRoster.length).toBeGreaterThan(0);
    });

    it('never uses an em dash (writing-for-humans)', () => {
      const allCopy = [
        ...Object.values(DORKBOT_TOUR_LINES.offers),
        ...Object.values(DORKBOT_TOUR_LINES.general),
        ...Object.values(DORKBOT_TOUR_LINES.tasks),
        ...Object.values(DORKBOT_TOUR_LINES.relay),
        ...Object.values(DORKBOT_TOUR_LINES.mesh),
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
