import { describe, it, expect } from 'vitest';
import {
  PLAYGROUND_REGISTRY,
  TOKENS_SECTIONS,
  FORMS_SECTIONS,
  COMPONENTS_SECTIONS,
  CHAT_SECTIONS,
  FEATURES_SECTIONS,
  SIMULATOR_SECTIONS,
} from '../playground-registry';
import { slugify } from '../lib/slugify';

describe('playground-registry', () => {
  it('has no duplicate section IDs across the full registry', () => {
    const ids = PLAYGROUND_REGISTRY.map((s) => s.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('all IDs have no spaces (matching anchor generation pattern)', () => {
    for (const section of PLAYGROUND_REGISTRY) {
      expect(section.id).not.toMatch(/\s/);
    }
  });

  it('all sections have a valid page assignment', () => {
    const validPages = new Set(['overview', 'tokens', 'forms', 'components', 'chat', 'features', 'simulator']);
    for (const section of PLAYGROUND_REGISTRY) {
      expect(validPages.has(section.page)).toBe(true);
    }
  });

  it('PLAYGROUND_REGISTRY equals the union of all page-level arrays', () => {
    const combined = [...TOKENS_SECTIONS, ...FORMS_SECTIONS, ...COMPONENTS_SECTIONS, ...CHAT_SECTIONS, ...FEATURES_SECTIONS, ...SIMULATOR_SECTIONS];
    expect(PLAYGROUND_REGISTRY).toEqual(combined);
  });

  it('every section has at least one keyword', () => {
    for (const section of PLAYGROUND_REGISTRY) {
      expect(section.keywords.length).toBeGreaterThan(0);
    }
  });

  it('every section ID matches slugify(title)', () => {
    for (const section of PLAYGROUND_REGISTRY) {
      expect(section.id).toBe(slugify(section.title));
    }
  });
});
