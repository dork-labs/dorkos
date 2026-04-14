import { describe, it, expect } from 'vitest';
import { dorkbotClaudeMdTemplate, generateFirstMessage } from '../dorkbot-templates.js';
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

  describe('generateFirstMessage', () => {
    it('returns playful message for verbosity >= 4', () => {
      const msg4 = generateFirstMessage(makeTraits({ verbosity: 4 }));
      expect(msg4).toContain("Hey! I'm DorkBot");
      expect(msg4).toContain('What are we building today?');

      const msg5 = generateFirstMessage(makeTraits({ verbosity: 5 }));
      expect(msg5).toContain("Hey! I'm DorkBot");
    });

    it('returns terse message for verbosity <= 2', () => {
      const msg2 = generateFirstMessage(makeTraits({ verbosity: 2 }));
      expect(msg2).toContain('DorkBot online');
      expect(msg2).toContain('Ready for instructions');

      const msg1 = generateFirstMessage(makeTraits({ verbosity: 1 }));
      expect(msg1).toContain('DorkBot online');
    });

    it('returns balanced message for verbosity = 3', () => {
      const msg = generateFirstMessage(makeTraits({ verbosity: 3 }));
      expect(msg).toContain("Hi, I'm DorkBot");
      expect(msg).toContain('How can I help?');
    });

    it('mentions Tasks, Relay, and Mesh in all variants', () => {
      for (const verbosity of [1, 3, 5]) {
        const msg = generateFirstMessage(makeTraits({ verbosity }));
        expect(msg).toContain('Tasks');
        expect(msg).toContain('Relay');
        expect(msg).toContain('Mesh');
      }
    });
  });
});
