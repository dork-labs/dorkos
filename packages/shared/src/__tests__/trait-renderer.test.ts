import { describe, it, expect } from 'vitest';
import {
  renderTraits,
  TRAIT_LEVELS,
  TRAIT_ORDER,
  TRAIT_ENDPOINT_LABELS,
  DEFAULT_TRAITS,
  TRAIT_PREVIEWS,
  getPreviewText,
  hashPreviewText,
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

  describe('TRAIT_ENDPOINT_LABELS', () => {
    it('matches TRAIT_LEVELS level 1 and 5 labels for every trait', () => {
      for (const name of TRAIT_ORDER) {
        expect(TRAIT_ENDPOINT_LABELS[name].min).toBe(TRAIT_LEVELS[name][1].label);
        expect(TRAIT_ENDPOINT_LABELS[name].max).toBe(TRAIT_LEVELS[name][5].label);
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

  describe('TRAIT_PREVIEWS', () => {
    it('has all 5 traits x 5 levels = 25 preview entries', () => {
      for (const name of TRAIT_ORDER) {
        for (let level = 1; level <= 5; level++) {
          const preview = TRAIT_PREVIEWS[name][level];
          expect(preview).toBeDefined();
          expect(preview.length).toBeGreaterThan(0);
        }
      }
    });

    it('every preview ends with a period', () => {
      for (const name of TRAIT_ORDER) {
        for (let level = 1; level <= 5; level++) {
          expect(TRAIT_PREVIEWS[name][level]).toMatch(/\.$/);
        }
      }
    });
  });

  describe('getPreviewText', () => {
    it('returns a composed string from all traits', () => {
      const result = getPreviewText(DEFAULT_TRAITS);
      expect(result).toContain('Tone:');
      expect(result).toContain('Autonomy:');
      expect(result).toContain('Caution:');
      expect(result).toContain('Communication:');
      expect(result).toContain('Creativity:');
    });

    it('uses level-specific preview text', () => {
      const traits: Record<TraitName, number> = {
        tone: 1,
        autonomy: 5,
        caution: 3,
        communication: 2,
        creativity: 4,
      };
      const result = getPreviewText(traits);
      expect(result).toContain(TRAIT_PREVIEWS.tone[1]);
      expect(result).toContain(TRAIT_PREVIEWS.autonomy[5]);
      expect(result).toContain(TRAIT_PREVIEWS.communication[2]);
      expect(result).toContain(TRAIT_PREVIEWS.creativity[4]);
    });

    it('defaults missing traits to level 3', () => {
      const partial = { tone: 5 } as Record<TraitName, number>;
      const result = getPreviewText(partial);
      expect(result).toContain(TRAIT_PREVIEWS.tone[5]);
      expect(result).toContain(TRAIT_PREVIEWS.autonomy[3]);
    });
  });

  describe('hashPreviewText', () => {
    it('is deterministic — same input produces same output', () => {
      const text = 'some preview text';
      expect(hashPreviewText(text)).toBe(hashPreviewText(text));
    });

    it('produces different hashes for different input', () => {
      const hash1 = hashPreviewText('input one');
      const hash2 = hashPreviewText('input two');
      expect(hash1).not.toBe(hash2);
    });

    it('returns a hex string', () => {
      const hash = hashPreviewText('test');
      expect(hash).toMatch(/^[0-9a-f]+$/);
    });
  });
});
