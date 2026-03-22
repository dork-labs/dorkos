import { describe, it, expect } from 'vitest';
import {
  renderTraits,
  TRAIT_LEVELS,
  TRAIT_ORDER,
  DEFAULT_TRAITS,
  type TraitName,
} from '../trait-renderer.js';

describe('trait-renderer', () => {
  describe('TRAIT_LEVELS', () => {
    it('has entries for all 5 traits x 5 levels = 25 entries', () => {
      for (const name of TRAIT_ORDER) {
        for (let level = 1; level <= 5; level++) {
          const entry = TRAIT_LEVELS[name][level];
          expect(entry).toBeDefined();
          expect(entry.label).toBeTruthy();
          expect(entry.directive).toBeTruthy();
        }
      }
    });
  });

  describe('TRAIT_ORDER', () => {
    it('contains all 5 trait names', () => {
      expect(TRAIT_ORDER).toHaveLength(5);
      expect(TRAIT_ORDER).toEqual(['tone', 'autonomy', 'caution', 'communication', 'creativity']);
    });
  });

  describe('DEFAULT_TRAITS', () => {
    it('sets all traits to level 3', () => {
      for (const name of TRAIT_ORDER) {
        expect(DEFAULT_TRAITS[name]).toBe(3);
      }
    });
  });

  describe('renderTraits', () => {
    it('renders all-balanced traits correctly', () => {
      const result = renderTraits(DEFAULT_TRAITS);
      expect(result).toContain('**Tone** (Balanced)');
      expect(result).toContain('**Autonomy** (Balanced)');
      expect(result).toContain('**Caution** (Balanced)');
      expect(result).toContain('**Communication** (Balanced)');
      expect(result).toContain('**Creativity** (Balanced)');
    });

    it('renders extreme trait values', () => {
      const extremeTraits: Record<TraitName, number> = {
        tone: 1,
        autonomy: 5,
        caution: 1,
        communication: 5,
        creativity: 1,
      };
      const result = renderTraits(extremeTraits);
      expect(result).toContain('**Tone** (Silent)');
      expect(result).toContain('**Autonomy** (Full Auto)');
      expect(result).toContain('**Caution** (YOLO)');
      expect(result).toContain('**Communication** (Narrator)');
      expect(result).toContain('**Creativity** (By the Book)');
    });

    it('falls back to level 3 for missing trait values', () => {
      const partial = { tone: 1 } as Record<TraitName, number>;
      const result = renderTraits(partial);
      expect(result).toContain('**Tone** (Silent)');
      // All others should default to Balanced (level 3)
      expect(result).toContain('**Autonomy** (Balanced)');
    });

    it('produces one line per trait in TRAIT_ORDER order', () => {
      const result = renderTraits(DEFAULT_TRAITS);
      const lines = result.split('\n');
      expect(lines).toHaveLength(5);
      expect(lines[0]).toMatch(/^- \*\*Tone\*\*/);
      expect(lines[4]).toMatch(/^- \*\*Creativity\*\*/);
    });
  });
});
