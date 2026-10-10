import { describe, it, expect } from 'vitest';
import {
  DORKBOT_ONBOARDING_LINES,
  DORKBOT_TOUR_LINES,
  dorkbotClaudeMdTemplate,
  dorkbotWelcomeText,
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

    it('describes running a business and building mini apps, never a retired line', () => {
      const result = dorkbotClaudeMdTemplate();
      expect(result).toContain('run their business');
      expect(result).toContain('mini apps');
      for (const retired of [
        'operating system for autonomous AI agents',
        'mission control',
        'cockpit',
        'open source',
        'own computer',
      ]) {
        expect(result.toLowerCase()).not.toContain(retired);
      }
    });
  });

  describe('dorkbotWelcomeText', () => {
    it('says each path’s welcome, with the name', () => {
      expect(dorkbotWelcomeText('dorkos', 'Dorian')).toBe(
        'Hi Dorian. Your agents run on DorkOS. Usage is in Settings.\n\n' +
          'Want a first tool? Pick one below, or tell me what you need.'
      );
      expect(dorkbotWelcomeText('own', 'Dorian')).toBe(
        'Hi Dorian. Your agents are ready.\n\n' +
          'Want a first tool? Pick one below, or tell me what you need.'
      );
      expect(dorkbotWelcomeText('none', 'Dorian')).toBe(
        'Hi Dorian. Agents need AI to reply. Connect DorkOS or your own.'
      );
    });

    it('asks for an AI app sign-in on Own AI until one is ready', () => {
      expect(dorkbotWelcomeText('own', 'Dorian', { aiReady: false })).toBe(
        'Hi Dorian. Sign in to an AI app to start.'
      );
    });

    it('falls back to "there", and reads no path as no AI', () => {
      expect(dorkbotWelcomeText(null, null)).toBe(
        'Hi there. Agents need AI to reply. Connect DorkOS or your own.'
      );
      expect(dorkbotWelcomeText('own', '   ')).toBe(
        'Hi there. Your agents are ready.\n\n' +
          'Want a first tool? Pick one below, or tell me what you need.'
      );
    });
  });

  describe('DORKBOT_ONBOARDING_LINES', () => {
    it('never uses an em dash (writing-for-humans)', () => {
      const allCopy = [
        ...DORKBOT_ONBOARDING_LINES.identityCardPrompt,
        DORKBOT_ONBOARDING_LINES.identityCardSaved,
        DORKBOT_ONBOARDING_LINES.saveError,
        DORKBOT_ONBOARDING_LINES.profileSaved,
        ...DORKBOT_ONBOARDING_LINES.profileCardPrompt,
        ...(['terse', 'balanced', 'warm', 'playful', 'bold', 'inventive'] as const).map(() =>
          generateVoiceSample(makeTraits())
        ),
      ].join(' ');
      expect(allCopy).not.toContain('—');
    });

    // FB-11 / DOR-1972: the reporter answered this prompt with no idea where the
    // answer went, how it was used, or how to change it. Both lines have to
    // survive together — the ask, and the fact right behind it.
    it('names the storage fact for the existing-user card prompt (DOR-1972)', () => {
      expect(DORKBOT_ONBOARDING_LINES.profileCardPrompt).toHaveLength(2);
      expect(DORKBOT_ONBOARDING_LINES.profileCardPrompt[0]).toContain('What kind of work');
      expect(DORKBOT_ONBOARDING_LINES.profileCardPrompt[1]).toContain('Stored on this machine');
    });
  });

  describe('DORKBOT_TOUR_LINES', () => {
    it('has an offer and a caption for every tour', () => {
      expect(DORKBOT_TOUR_LINES.offers.tasks).toContain('schedule');
      expect(DORKBOT_TOUR_LINES.offers.relay).toContain('chat app');
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
