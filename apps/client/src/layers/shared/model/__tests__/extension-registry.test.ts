import { describe, it, expect, beforeEach } from 'vitest';
import { useExtensionRegistry, createInitialSlots } from '../extension-registry';
import type { SidebarFooterContribution } from '../extension-registry';

// Test contributions via getState() without React rendering.
// Reset between tests per Zustand testing guide.

const makeSidebarFooter = (
  overrides: Partial<SidebarFooterContribution> = {}
): SidebarFooterContribution => ({
  id: 'test-button',
  icon: (() => null) as unknown as SidebarFooterContribution['icon'],
  label: 'Test',
  onClick: () => {},
  ...overrides,
});

describe('extension-registry', () => {
  beforeEach(() => {
    useExtensionRegistry.setState({ slots: createInitialSlots() });
  });

  it('registers and retrieves a contribution', () => {
    const { register, getContributions } = useExtensionRegistry.getState();
    const button = makeSidebarFooter({ id: 'btn-1' });

    register('sidebar.footer', button);

    const items = getContributions('sidebar.footer');
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('btn-1');
  });

  it('unregister removes the contribution', () => {
    const { register, getContributions } = useExtensionRegistry.getState();
    const unsubscribe = register('sidebar.footer', makeSidebarFooter({ id: 'btn-remove' }));

    expect(getContributions('sidebar.footer')).toHaveLength(1);

    unsubscribe();

    expect(useExtensionRegistry.getState().getContributions('sidebar.footer')).toHaveLength(0);
  });

  it('sorts contributions by priority (lower = first)', () => {
    const { register } = useExtensionRegistry.getState();
    register('sidebar.footer', makeSidebarFooter({ id: 'p3', priority: 3 }));
    register('sidebar.footer', makeSidebarFooter({ id: 'p1', priority: 1 }));
    register('sidebar.footer', makeSidebarFooter({ id: 'p2', priority: 2 }));

    // useSlotContributions is a React hook, so test sort logic directly
    const raw = useExtensionRegistry.getState().getContributions('sidebar.footer');
    const sorted = [...raw].sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50));
    expect(sorted.map((c) => c.id)).toEqual(['p1', 'p2', 'p3']);
  });

  it('does not affect other slots when registering', () => {
    const { register, getContributions } = useExtensionRegistry.getState();
    register('sidebar.footer', makeSidebarFooter({ id: 'btn-isolated' }));

    expect(getContributions('dialog')).toHaveLength(0);
    expect(getContributions('sidebar.tabs')).toHaveLength(0);
  });

  it('returns empty array for a slot with no registrations', () => {
    const { getContributions } = useExtensionRegistry.getState();
    expect(getContributions('session.canvas')).toEqual([]);
  });

  it('applies default priority of 50 when not specified', () => {
    const { register, getContributions } = useExtensionRegistry.getState();
    register('sidebar.footer', makeSidebarFooter({ id: 'no-priority' }));

    const items = getContributions('sidebar.footer');
    expect(items[0].priority).toBe(50);
  });

  it('preserves insertion order for contributions with equal priority (stable sort)', () => {
    const { register } = useExtensionRegistry.getState();
    register('sidebar.footer', makeSidebarFooter({ id: 'first', priority: 10 }));
    register('sidebar.footer', makeSidebarFooter({ id: 'second', priority: 10 }));
    register('sidebar.footer', makeSidebarFooter({ id: 'third', priority: 10 }));

    const raw = useExtensionRegistry.getState().getContributions('sidebar.footer');
    const sorted = [...raw].sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50));
    expect(sorted.map((c) => c.id)).toEqual(['first', 'second', 'third']);
  });

  it('is idempotent — re-registering the same ID replaces instead of duplicating', () => {
    const { register, getContributions } = useExtensionRegistry.getState();
    register('sidebar.footer', makeSidebarFooter({ id: 'dup', label: 'First' }));
    register('sidebar.footer', makeSidebarFooter({ id: 'dup', label: 'Second' }));

    const items = getContributions('sidebar.footer');
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe('Second');
  });

  it('idempotent register does not affect other contributions in the same slot', () => {
    const { register, getContributions } = useExtensionRegistry.getState();
    register('sidebar.footer', makeSidebarFooter({ id: 'keep-me', label: 'Keeper' }));
    register('sidebar.footer', makeSidebarFooter({ id: 'replace-me', label: 'V1' }));
    register('sidebar.footer', makeSidebarFooter({ id: 'replace-me', label: 'V2' }));

    const items = getContributions('sidebar.footer');
    expect(items).toHaveLength(2);
    expect(items.map((c) => c.id)).toEqual(['keep-me', 'replace-me']);
    expect(items.find((c) => c.id === 'replace-me')!.label).toBe('V2');
  });
});
