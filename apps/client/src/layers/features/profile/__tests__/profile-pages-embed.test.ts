/**
 * The Obsidian embed cannot serve the Permissions page (its transport refuses
 * permissions, which are managed in the DorkOS app), so the page is not
 * available there and its row is not drawn.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { setPlatformAdapter } from '@/layers/shared/lib';

import { isProfilePageAvailable, profilePage } from '../ui/pages/registry';

afterEach(() => setPlatformAdapter({ isEmbedded: false, openFile: async () => {} }));

describe('profile pages in the Obsidian embed', () => {
  it('offers the Permissions page in the app', () => {
    expect(isProfilePageAvailable('permissions')).toBe(true);
    expect(profilePage('permissions')?.title).toBe('Permissions');
  });

  it('leaves the Permissions page out of the embed, and nothing else', () => {
    setPlatformAdapter({ isEmbedded: true, openFile: async () => {} });
    expect(isProfilePageAvailable('permissions')).toBe(false);
    expect(profilePage('permissions')).toBeNull();
    expect(isProfilePageAvailable('tools')).toBe(true);
  });
});

describe('the Permissions row', () => {
  it('reads as "Agent permissions", distinct from the status bar’s Permissions control', async () => {
    const { rowsFor } = await import('../lib/profile-rows');
    const agent = {
      id: 'a1',
      kind: 'agent',
      name: 'ana',
      displayName: 'Ana',
    } as unknown as Parameters<typeof rowsFor>[0];
    const rows = rowsFor(agent, { relationship: 'managed', manages: [] }).flatMap((g) => g.rows);
    const row = rows.find((r) => r.id === 'permissions');
    expect(row).toMatchObject({ label: 'Permissions', accessibleLabel: 'Agent permissions' });
  });
});
