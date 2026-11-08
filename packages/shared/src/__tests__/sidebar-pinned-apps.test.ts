import { describe, expect, it } from 'vitest';
import { MAX_PINNED_APPS, SidebarPrefsSchema } from '../config-schema.js';

/** Whether these pins would be stored. */
function accepts(pinnedApps: unknown): boolean {
  return SidebarPrefsSchema.safeParse({ pinnedApps }).success;
}

describe('ui.sidebar.pinnedApps (DOR-3970)', () => {
  it('stores extension ids, and is absent until seeded', () => {
    expect(accepts(['board', 'meeting-notes', 'x1'])).toBe(true);
    expect(SidebarPrefsSchema.parse({}).pinnedApps).toBeUndefined();
  });

  it('refuses anything shaped unlike an extension id, since agents can write it', () => {
    for (const bad of ['', '../etc', 'Board', 'a/b', '-lead', 'a b', '<b>x</b>']) {
      expect(accepts([bad]), bad).toBe(false);
    }
  });

  it('caps an id at 128 characters and the list at 5', () => {
    expect(accepts(['a'.repeat(128)])).toBe(true);
    expect(accepts(['a'.repeat(129)])).toBe(false);
    expect(accepts(Array.from({ length: MAX_PINNED_APPS }, (_, i) => `app-${i}`))).toBe(true);
    expect(accepts(Array.from({ length: MAX_PINNED_APPS + 1 }, (_, i) => `app-${i}`))).toBe(false);
  });
});
