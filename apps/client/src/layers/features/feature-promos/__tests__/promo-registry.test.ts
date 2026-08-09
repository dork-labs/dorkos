import { describe, it, expect } from 'vitest';
import { PROMO_REGISTRY } from '../model/promo-registry';
import type { PromoPlacement } from '../model/promo-types';
import * as fs from 'node:fs';

const VALID_PLACEMENTS: PromoPlacement[] = ['dashboard-sidebar', 'agent-sidebar'];
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

  it('every quiet-state suggestion is a question with something to press beside it', () => {
    // The suggestion line reads "<question> <action>", so a suggestion that is
    // not phrased as a question, or has no verb to press, is not the sentence
    // this format was designed around.
    for (const promo of PROMO_REGISTRY) {
      const { suggestion } = promo.content;
      if (!suggestion) continue;
      expect(suggestion.question.trim().endsWith('?')).toBe(true);
      expect(suggestion.action.trim()).toBeTruthy();
      expect(suggestion.action.trim().endsWith('.')).toBe(false);
    }
  });

  it('no suggestion speaks to a blank install — every one of them is earned', () => {
    // The real shape of a machine somebody just installed DorkOS on, not an
    // all-false stub: Relay, the scheduler and the mesh all ship ON, DorkBot is
    // already registered, and nothing has been run or connected yet. A
    // suggestion that qualifies HERE is qualifying on a default rather than on
    // anything the person did, and it would print the same sentence under
    // "All quiet." every morning until it was dismissed.
    const blankInstallCtx = {
      hasAdapter: () => false,
      isTasksEnabled: true,
      isMeshEnabled: true,
      isRelayEnabled: true,
      sessionCount: 0,
      agentCount: 1,
      taskCount: 0,
      daysSinceFirstUse: 0,
    };
    for (const promo of PROMO_REGISTRY) {
      if (!promo.content.suggestion) continue;
      expect({ id: promo.id, speaks: promo.shouldShow(blankInstallCtx) }).toEqual({
        id: promo.id,
        speaks: false,
      });
    }
  });

  it("the spec's worked example is reachable: schedules speaks on a used install", () => {
    // Priority is shared with the cards, so a higher-priority suggestion would
    // quietly monopolise the one slot. This pins the arrangement the spec
    // describes — somebody who has run agents and has no schedules yet gets
    // "want your agents working while you sleep?".
    const usedInstallCtx = {
      hasAdapter: () => false,
      isTasksEnabled: true,
      isMeshEnabled: true,
      isRelayEnabled: true,
      sessionCount: 4,
      agentCount: 1,
      taskCount: 0,
      daysSinceFirstUse: 6,
    };
    const speaking = PROMO_REGISTRY.filter(
      (p) => p.content.suggestion && p.shouldShow(usedInstallCtx)
    ).sort((a, b) => b.priority - a.priority);

    expect(speaking[0]?.id).toBe('schedules');
  });

  it('the schedules suggestion stops once there are schedules', () => {
    // Otherwise it prints under a forward look that names a run already on the
    // books — "want your agents working while you sleep?" beneath "Morning
    // standup runs tomorrow at 9:00 AM".
    const withSchedules = {
      hasAdapter: () => false,
      isTasksEnabled: true,
      isMeshEnabled: true,
      isRelayEnabled: true,
      sessionCount: 4,
      agentCount: 1,
      taskCount: 1,
      daysSinceFirstUse: 6,
    };
    const schedules = PROMO_REGISTRY.find((p) => p.id === 'schedules');
    expect(schedules?.shouldShow(withSchedules)).toBe(false);
  });

  it('every suggestion opens a dialog, so nothing it draws lands inline', () => {
    // The suggestion lives inside the quiet state's own bordered strip, above a
    // feed. `dialog` is the one action type whose UI is guaranteed to portal out
    // of that strip instead of unfolding inside it and shoving the room down.
    for (const promo of PROMO_REGISTRY) {
      if (!promo.content.suggestion) continue;
      expect({ id: promo.id, action: promo.action.type }).toEqual({
        id: promo.id,
        action: 'dialog',
      });
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
      taskCount: 0,
      daysSinceFirstUse: 0,
    };
    for (const promo of PROMO_REGISTRY) {
      expect(() => promo.shouldShow(mockCtx)).not.toThrow();
      expect(typeof promo.shouldShow(mockCtx)).toBe('boolean');
    }
  });
});
