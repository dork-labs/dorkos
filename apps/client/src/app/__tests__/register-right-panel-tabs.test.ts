/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { Transport } from '@dorkos/shared/transport';
import { useExtensionRegistry } from '@/layers/shared/model';
import { registerRightPanelTabs } from '../init-extensions';

/** A `visibleWhen` context stub — the embed's `/session` surface. */
function ctx(supportsTerminal: boolean) {
  return {
    pathname: '/session',
    transport: { supportsTerminal } as Transport,
    agentId: null,
    cwd: null,
    explicitAgentPath: null,
  };
}

describe('registerRightPanelTabs', () => {
  beforeEach(() => {
    // Reset the shared registry's right-panel slot so each test sees only what
    // it registers (the registry is a module singleton).
    useExtensionRegistry.setState((s) => ({ slots: { ...s.slots, 'right-panel': [] } }));
  });

  it('registers the built-in Inspector tabs (one shared set across shells)', () => {
    const { register } = useExtensionRegistry.getState();
    registerRightPanelTabs(register);

    const ids = useExtensionRegistry
      .getState()
      .getContributions('right-panel')
      .map((c) => c.id);
    for (const id of ['pulse', 'profile', 'session', 'files', 'canvas', 'terminal']) {
      expect(ids).toContain(id);
    }
  });

  it('puts the Session readout beside Profile, and only where a session exists', () => {
    // Priority 12 sits it between Profile (10) and Files (15) — the two
    // session-scoped tabs read left to right as "who" then "what it is doing".
    const { register } = useExtensionRegistry.getState();
    registerRightPanelTabs(register);

    const contributions = useExtensionRegistry.getState().getContributions('right-panel');
    const session = contributions.find((c) => c.id === 'session');
    expect(session?.title).toBe('Session');
    expect(session?.isGlobal).toBeUndefined();
    expect(session?.visibleWhen?.(ctx(true))).toBe(true);
    expect(session?.visibleWhen?.({ ...ctx(true), pathname: '/team' })).toBe(false);

    const order = contributions.map((c) => c.id);
    expect(order.indexOf('session')).toBeGreaterThan(order.indexOf('profile'));
    expect(order.indexOf('session')).toBeLessThan(order.indexOf('files'));
  });

  it('is idempotent — re-registering does not duplicate a tab', () => {
    const { register } = useExtensionRegistry.getState();
    registerRightPanelTabs(register);
    registerRightPanelTabs(register);

    const pulses = useExtensionRegistry
      .getState()
      .getContributions('right-panel')
      .filter((c) => c.id === 'pulse');
    expect(pulses).toHaveLength(1);
  });

  it('gates the terminal tab on transport.supportsTerminal (hidden under the embed transport)', () => {
    const { register } = useExtensionRegistry.getState();
    registerRightPanelTabs(register);

    const terminal = useExtensionRegistry
      .getState()
      .getContributions('right-panel')
      .find((c) => c.id === 'terminal');
    expect(terminal?.visibleWhen?.(ctx(false))).toBe(false); // in-process (Obsidian) transport
    expect(terminal?.visibleWhen?.(ctx(true))).toBe(true); // web transport with a PTY
  });

  it('offers the Room tab on the two routes that show a room, and nowhere else', () => {
    const { register } = useExtensionRegistry.getState();
    registerRightPanelTabs(register);

    const room = useExtensionRegistry
      .getState()
      .getContributions('right-panel')
      .find((c) => c.id === 'room');
    expect(room?.title).toBe('Room');
    // Contextual, not global: it is the panel's default WHERE it applies, and
    // absent everywhere else — which is what `isGlobal` would break.
    expect(room?.isGlobal).toBeUndefined();
    expect(room?.visibleWhen?.({ ...ctx(true), pathname: '/channels' })).toBe(true);
    expect(room?.visibleWhen?.({ ...ctx(true), pathname: '/' })).toBe(true);
    expect(room?.visibleWhen?.(ctx(true))).toBe(false); // /session
    expect(room?.visibleWhen?.({ ...ctx(true), pathname: '/team' })).toBe(false);
  });

  it('sorts the Room tab after Pulse but ahead of Profile', () => {
    // Auto-select takes the first CONTEXTUAL tab in strip order, and Profile is
    // visible off `/session` as soon as anybody has opened one this session —
    // so a Room tab sorted after it would lose the room routes to a profile the
    // reader opened an hour ago. Pulse stays leftmost either way (spec §5 case
    // 9: its tab is still one press away).
    const { register } = useExtensionRegistry.getState();
    registerRightPanelTabs(register);

    // Priority, not registration order: the strip and the auto-select both sort
    // by it, and `getContributions` hands back the raw list — so an assertion
    // about the array's order would stay green with the priority wrong.
    const byId = new Map(
      useExtensionRegistry
        .getState()
        .getContributions('right-panel')
        .map((c) => [c.id, c.priority])
    );
    expect(byId.get('room')).toBeGreaterThan(byId.get('pulse')!);
    expect(byId.get('room')).toBeLessThan(byId.get('profile')!);
  });

  it('keeps Pulse global and always visible (no visibleWhen)', () => {
    const { register } = useExtensionRegistry.getState();
    registerRightPanelTabs(register);

    const pulse = useExtensionRegistry
      .getState()
      .getContributions('right-panel')
      .find((c) => c.id === 'pulse');
    expect(pulse?.isGlobal).toBe(true);
    expect(pulse?.visibleWhen).toBeUndefined();
  });
});
