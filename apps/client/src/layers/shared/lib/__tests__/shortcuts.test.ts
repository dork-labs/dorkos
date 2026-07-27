import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('shortcuts registry', () => {
  describe('formatShortcutKey', () => {
    beforeEach(() => {
      vi.resetModules();
    });

    it('returns Mac symbols when isMac is true', async () => {
      vi.doMock('../platform', () => ({ isMac: true }));
      const { formatShortcutKey } = await import('../shortcuts');
      // mod+ replaced first → ⌘, then shift+ → ⇧, so order is ⌘⇧N
      expect(formatShortcutKey('mod+shift+n')).toBe('\u2318\u21e7N');
      expect(formatShortcutKey('mod+k')).toBe('\u2318K');
      expect(formatShortcutKey('?')).toBe('?');
    });

    it('returns Windows strings when isMac is false', async () => {
      vi.doMock('../platform', () => ({ isMac: false }));
      const { formatShortcutKey } = await import('../shortcuts');
      // toUpperCase() is applied, so Ctrl+Shift+N → CTRL+SHIFT+N
      expect(formatShortcutKey('mod+shift+n')).toBe('CTRL+SHIFT+N');
      expect(formatShortcutKey('mod+k')).toBe('CTRL+K');
    });

    it('accepts a ShortcutDef object', async () => {
      vi.doMock('../platform', () => ({ isMac: true }));
      const { formatShortcutKey, SHORTCUTS } = await import('../shortcuts');
      const result = formatShortcutKey(SHORTCUTS.AGENT_PROFILE);
      // mod+shift+a → ⌘⇧A (mod replaced first, then shift)
      expect(result).toBe('\u2318\u21e7A');
    });
  });

  describe('getShortcutsGrouped', () => {
    beforeEach(() => {
      vi.resetModules();
    });

    it('returns groups in the correct display order', async () => {
      vi.doMock('../platform', () => ({ isMac: true }));
      const { getShortcutsGrouped, SHORTCUT_GROUP_ORDER } = await import('../shortcuts');
      const groups = getShortcutsGrouped();
      const groupKeys = groups.map((g) => g.group);
      // Should follow SHORTCUT_GROUP_ORDER, filtered to groups that have entries
      expect(groupKeys).toEqual(SHORTCUT_GROUP_ORDER.filter((g) => groupKeys.includes(g)));
    });

    it('includes all shortcuts from the registry', async () => {
      vi.doMock('../platform', () => ({ isMac: true }));
      const { getShortcutsGrouped, SHORTCUTS } = await import('../shortcuts');
      const groups = getShortcutsGrouped();
      const allShortcuts = groups.flatMap((g) => g.shortcuts);
      expect(allShortcuts.length).toBe(Object.values(SHORTCUTS).length);
    });
  });

  describe('SHORTCUTS constant', () => {
    beforeEach(() => {
      vi.resetModules();
    });

    it('every shortcut has non-empty id, key, label, and group', async () => {
      vi.doMock('../platform', () => ({ isMac: true }));
      const { SHORTCUTS } = await import('../shortcuts');
      for (const [name, shortcut] of Object.entries(SHORTCUTS)) {
        expect(shortcut.id, `${name}.id`).toBeTruthy();
        expect(shortcut.key, `${name}.key`).toBeTruthy();
        expect(shortcut.label, `${name}.label`).toBeTruthy();
        expect(shortcut.group, `${name}.group`).toBeTruthy();
      }
    });
  });
});
