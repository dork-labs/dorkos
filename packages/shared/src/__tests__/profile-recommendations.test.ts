import { describe, it, expect } from 'vitest';
import {
  ROLE_CANON,
  ROLE_ALIASES,
  ROLE_RECOMMENDATIONS,
  CONNECTOR_DISPLAY_NAMES,
  MAX_RECOMMENDATIONS,
  ONBOARDING_ROLE_CHIP_COUNT,
  normalizeRole,
  recommendForRoles,
} from '../profile-recommendations.js';

describe('profile-recommendations', () => {
  describe('ROLE_CANON', () => {
    it('carries the eight canon roles, each with a chip label', () => {
      expect(ROLE_CANON.map((r) => r.id)).toEqual([
        'software-development',
        'hiring',
        'marketing',
        'writing',
        'research',
        'business-ops',
        'design',
        'sales',
      ]);
      for (const role of ROLE_CANON) {
        expect(role.label.length).toBeGreaterThan(0);
      }
      expect(ROLE_CANON.length).toBeGreaterThanOrEqual(ONBOARDING_ROLE_CHIP_COUNT);
    });
  });

  describe('table shape', () => {
    it('every canon role has non-empty lowercase-slug connectors and search terms', () => {
      for (const role of ROLE_CANON) {
        const entry = ROLE_RECOMMENDATIONS[role.id];
        expect(entry.connectors.length).toBeGreaterThan(0);
        expect(entry.marketplaceSearch.length).toBeGreaterThan(0);
        for (const slug of entry.connectors) {
          expect(slug).toMatch(/^[a-z0-9-]+$/);
        }
      }
    });

    it('every suggested connector slug has a display name', () => {
      for (const role of ROLE_CANON) {
        for (const slug of ROLE_RECOMMENDATIONS[role.id].connectors) {
          expect(CONNECTOR_DISPLAY_NAMES[slug]).toBeTruthy();
        }
      }
    });

    it('every alias points at a canon role id', () => {
      const canonIds = new Set<string>(ROLE_CANON.map((r) => r.id));
      for (const target of Object.values(ROLE_ALIASES)) {
        expect(canonIds.has(target)).toBe(true);
      }
    });
  });

  describe('normalizeRole', () => {
    it('passes canon ids through', () => {
      expect(normalizeRole('hiring')).toBe('hiring');
    });

    it('normalizes aliases with lowercase-trim', () => {
      expect(normalizeRole('  Recruiter ')).toBe('hiring');
      expect(normalizeRole('ENGINEER')).toBe('software-development');
      expect(normalizeRole('founder')).toBe('business-ops');
    });

    it('normalizes the chip labels onboarding shows', () => {
      expect(normalizeRole('Building software')).toBe('software-development');
      expect(normalizeRole('running a business')).toBe('business-ops');
    });

    it('returns undefined for unknown or empty input', () => {
      expect(normalizeRole('beekeeper')).toBeUndefined();
      expect(normalizeRole('   ')).toBeUndefined();
    });
  });

  describe('recommendForRoles', () => {
    it('returns [] for empty input', () => {
      expect(recommendForRoles([])).toEqual([]);
    });

    it('returns [] when no role matches', () => {
      expect(recommendForRoles(['beekeeper', 'astronaut'])).toEqual([]);
    });

    it('suggests a role’s connectors with display names', () => {
      expect(recommendForRoles(['hiring'])).toEqual([
        { slug: 'gmail', name: 'Gmail', role: 'hiring' },
        { slug: 'greenhouse', name: 'Greenhouse', role: 'hiring' },
      ]);
    });

    it('merges first-role-first, so the first role’s suggestions lead', () => {
      const recs = recommendForRoles(['design', 'hiring']);
      expect(recs[0]).toMatchObject({ slug: 'figma', role: 'design' });
      expect(recs[1]).toMatchObject({ slug: 'slack', role: 'design' });
    });

    it('dedupes a connector shared by two roles (first contributor wins)', () => {
      // business-ops and hiring both suggest gmail.
      const recs = recommendForRoles(['business-ops', 'hiring']);
      const gmail = recs.filter((r) => r.slug === 'gmail');
      expect(gmail).toHaveLength(1);
      expect(gmail[0].role).toBe('business-ops');
    });

    it('caps at three suggestions total', () => {
      const recs = recommendForRoles(['hiring', 'design', 'software-development']);
      expect(recs).toHaveLength(MAX_RECOMMENDATIONS);
    });

    it('is deterministic', () => {
      const roles = ['recruiter', 'designer'];
      expect(recommendForRoles(roles)).toEqual(recommendForRoles(roles));
    });

    it('unmatched roles contribute nothing but do not block matched ones', () => {
      const recs = recommendForRoles(['beekeeper', 'hiring']);
      expect(recs.map((r) => r.slug)).toEqual(['gmail', 'greenhouse']);
    });
  });
});
