// @vitest-environment jsdom
/**
 * Deleting a section keeps its promise — "its members move back where they
 * came from" — for an agent too (DOR-3092). An agent with no direct message is
 * pinned on the way out, through the one helper every ungroup path shares.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import {
  SIDEBAR_PREFS_DEFAULTS,
  type SidebarGroup,
  type SidebarPrefs,
} from '@dorkos/shared/config-schema';
import type { SidebarMenuNode } from '@/layers/shared/ui';
import type { SidebarSectionModel } from '../model/build-sidebar-model';

const ANA = { kind: 'agent' as const, path: '/agents/ana' };
const BO = { kind: 'agent' as const, path: '/agents/bo' };

const GROUP: SidebarGroup = {
  id: 'g1',
  name: 'Clients',
  kind: 'manual',
  items: [ANA, BO],
  collapsed: false,
  sortMode: 'manual',
  displayFilter: 'all',
  muted: false,
};
const PREFS: SidebarPrefs = { ...SIDEBAR_PREFS_DEFAULTS, groups: [GROUP] };

const updates = vi.hoisted(() => ({ calls: [] as Array<(prev: SidebarPrefs) => SidebarPrefs> }));

vi.mock('@/layers/entities/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/config')>()),
  useSidebarPrefs: () => PREFS,
  useUpdateSidebarPrefs: () => ({
    update: (updater: (prev: SidebarPrefs) => SidebarPrefs) => updates.calls.push(updater),
  }),
}));
// Bo has a direct message, so only Ana needs a pin.
vi.mock('../model/has-direct-message', () => ({
  useHasDirectMessage: () => (path: string) => path === BO.path,
}));
vi.mock('../model/use-mark-rooms-read', () => ({ useMarkRoomsRead: () => () => {} }));
vi.mock('../ui/SidebarChrome', () => ({
  useSidebarChrome: () => ({ requestNewGroup: () => {}, manifests: {} }),
}));

const { useSectionChrome } = await import('../ui/useSectionChrome');

/** The section as the model would emit it, with `rows` members on screen. */
function section(rows: number): SidebarSectionModel {
  return {
    id: 'group:g1',
    label: 'Clients',
    collapsible: true,
    collapsed: false,
    rows: Array.from({ length: rows }, (_, index) => ({
      key: `agent:${index}`,
      target: { kind: 'agent', path: `/agents/${index}` },
      glyph: { kind: 'agent-avatar', agentPath: `/agents/${index}` },
      primary: `agent ${index}`,
      reservesVerbLine: false,
      unread: { tier: 'none' },
      muted: false,
      draggable: true,
      reason: 'group:member',
    })),
    reason: 'section:group',
  };
}

/** The "Delete section" item in a section's menu. */
function deleteItem(nodes: SidebarMenuNode[]): () => void {
  const node = nodes.find((entry) => entry.kind === 'action' && entry.id === 'delete');
  if (node?.kind !== 'action') throw new Error('no Delete section item');
  return node.run;
}

afterEach(() => {
  cleanup();
  updates.calls = [];
});

describe('deleting a section', () => {
  it('pins an agent with no direct message, once the dialog is confirmed', async () => {
    const { result } = renderHook(() => useSectionChrome(section(2)));
    act(() => deleteItem(result.current.menuNodes)());
    render(<>{result.current.dialogs}</>);
    await userEvent.click(screen.getByRole('button', { name: 'Delete section' }));

    expect(updates.calls).toHaveLength(1);
    const next = updates.calls[0]!(PREFS);
    expect(next.groups).toEqual([]);
    expect(next.pinned).toEqual([ANA]);
  });

  it('pins the same way when the section shows no rows and needs no dialog', () => {
    // Its members can be hidden by its own filter and still be in it.
    const { result } = renderHook(() => useSectionChrome(section(0)));
    act(() => deleteItem(result.current.menuNodes)());

    expect(updates.calls).toHaveLength(1);
    expect(updates.calls[0]!(PREFS).pinned).toEqual([ANA]);
  });
});
