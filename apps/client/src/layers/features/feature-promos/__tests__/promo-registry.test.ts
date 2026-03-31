import { describe, it, expect } from 'vitest';
import { PROMO_REGISTRY } from '../model/promo-registry';
import type { PromoPlacement } from '../model/promo-types';
import * as fs from 'node:fs';

const VALID_PLACEMENTS: PromoPlacement[] = ['dashboard-main', 'dashboard-sidebar', 'agent-sidebar'];
const KEBAB_CASE_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;

describe('promo-registry', () => {
  it('all promo IDs are unique', () => {
    const ids = PROMO_REGISTRY.map((p) => p.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
    // Show which ID is duplicated if test fails
    const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(duplicates).toEqual([]);
  });

  it('all promo IDs are kebab-case', () => {
    for (const promo of PROMO_REGISTRY) {
      expect(promo.id).toMatch(KEBAB_CASE_REGEX);
    }
  });

  it('all placements are valid PromoPlacement values', () => {
    for (const promo of PROMO_REGISTRY) {
      for (const placement of promo.placements) {
        expect(VALID_PLACEMENTS).toContain(placement);
      }
    }
  });

  it('all priorities are within 0-100 range', () => {
    for (const promo of PROMO_REGISTRY) {
      expect(promo.priority).toBeGreaterThanOrEqual(0);
      expect(promo.priority).toBeLessThanOrEqual(100);
    }
  });

  it('all dialog actions have a component defined', () => {
    for (const promo of PROMO_REGISTRY) {
      if (promo.action.type === 'dialog' || promo.action.type === 'open-dialog') {
        expect(promo.action.component).toBeDefined();
        expect(typeof promo.action.component).toBe('function');
      }
    }
  });

  it('all navigate actions have a non-empty to string', () => {
    for (const promo of PROMO_REGISTRY) {
      if (promo.action.type === 'navigate') {
        expect(promo.action.to).toBeTruthy();
        expect(typeof promo.action.to).toBe('string');
      }
    }
  });

  it('no orphaned dialog component files in dialogs/', () => {
    // Skip when Node.js fs/path modules are externalized (Vite browser-compat)
    if (typeof fs.existsSync !== 'function') return;

    // Read the dialogs directory and verify every file is referenced by a registry entry
    const dialogsDir = new URL('../ui/dialogs', import.meta.url).pathname;
    if (!fs.existsSync(dialogsDir)) return; // Skip if directory doesn't exist yet

    const dialogFiles = fs
      .readdirSync(dialogsDir)
      .filter((f) => f.endsWith('.tsx') && !f.startsWith('_'))
      .map((f) => f.replace('.tsx', ''));

    const referencedComponents = PROMO_REGISTRY.filter((p) => p.action.type === 'dialog')
      .map((p) => {
        if (p.action.type === 'dialog') {
          return p.action.component.name || p.action.component.displayName;
        }
        return null;
      })
      .filter(Boolean);

    for (const file of dialogFiles) {
      // Check if the file name matches any referenced component
      const isReferenced = referencedComponents.some(
        (name) => name === file || name === file.replace(/-/g, '')
      );
      expect(isReferenced).toBe(true);
    }
  });

  it('all promos have non-empty content fields', () => {
    for (const promo of PROMO_REGISTRY) {
      expect(promo.content.title).toBeTruthy();
      expect(promo.content.shortDescription).toBeTruthy();
      expect(promo.content.ctaLabel).toBeTruthy();
      expect(promo.content.icon).toBeDefined();
    }
  });

  it('all shouldShow functions are callable with a mock context', () => {
    const mockCtx = {
      hasAdapter: () => false,
      isTasksEnabled: false,
      isMeshEnabled: false,
      isRelayEnabled: false,
      sessionCount: 0,
      agentCount: 0,
      daysSinceFirstUse: 0,
    };
    for (const promo of PROMO_REGISTRY) {
      expect(() => promo.shouldShow(mockCtx)).not.toThrow();
      expect(typeof promo.shouldShow(mockCtx)).toBe('boolean');
    }
  });
});
