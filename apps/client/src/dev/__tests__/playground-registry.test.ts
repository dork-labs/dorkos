import { describe, it, expect } from 'vitest';
import {
  PLAYGROUND_REGISTRY,
  TOKENS_SECTIONS,
  FORMS_SECTIONS,
  COMPONENTS_SECTIONS,
  CHAT_SECTIONS,
  FEATURES_SECTIONS,
  PROMOS_SECTIONS,
  COMMAND_PALETTE_SECTIONS,
  SIMULATOR_SECTIONS,
  TOPOLOGY_SECTIONS,
  FILTER_BAR_SECTIONS,
  ERROR_STATES_SECTIONS,
  ONBOARDING_SECTIONS,
  TABLES_SECTIONS,
  SETTINGS_SECTIONS,
  MARKETPLACE_SECTIONS,
} from '../playground-registry';
import { slugify } from '../lib/slugify';
import { PAGE_CONFIGS, PAGE_ORDER, PAGE_LABELS } from '../playground-config';

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
    const validPages = new Set(['overview', ...PAGE_CONFIGS.map((c) => c.id)]);
    for (const section of PLAYGROUND_REGISTRY) {
      expect(validPages.has(section.page)).toBe(true);
    }
  });

  it('PLAYGROUND_REGISTRY equals the union of all page-level arrays', () => {
    const combined = [
      ...TOKENS_SECTIONS,
      ...FORMS_SECTIONS,
      ...COMPONENTS_SECTIONS,
      ...CHAT_SECTIONS,
      ...FEATURES_SECTIONS,
      ...PROMOS_SECTIONS,
      ...COMMAND_PALETTE_SECTIONS,
      ...SIMULATOR_SECTIONS,
      ...TOPOLOGY_SECTIONS,
      ...FILTER_BAR_SECTIONS,
      ...ERROR_STATES_SECTIONS,
      ...ONBOARDING_SECTIONS,
      ...TABLES_SECTIONS,
      ...SETTINGS_SECTIONS,
      ...MARKETPLACE_SECTIONS,
    ];
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

describe('playground-config', () => {
  it('every PAGE_CONFIG has a label and description', () => {
    for (const config of PAGE_CONFIGS) {
      expect(config.label).toBeTruthy();
      expect(config.description).toBeTruthy();
    }
  });

  it('PAGE_ORDER matches PAGE_CONFIGS ids', () => {
    expect(PAGE_ORDER).toEqual(PAGE_CONFIGS.map((c) => c.id));
  });

  it('PAGE_LABELS has an entry for every PAGE_CONFIG', () => {
    for (const config of PAGE_CONFIGS) {
      expect(PAGE_LABELS[config.id]).toBe(config.label);
    }
  });

  it('no duplicate page IDs in PAGE_CONFIGS', () => {
    const ids = PAGE_CONFIGS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every page with sections has those sections in PLAYGROUND_REGISTRY', () => {
    for (const config of PAGE_CONFIGS) {
      for (const section of config.sections) {
        expect(PLAYGROUND_REGISTRY).toContainEqual(section);
      }
    }
  });
});
