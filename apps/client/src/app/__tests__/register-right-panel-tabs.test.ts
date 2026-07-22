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
    for (const id of ['pulse', 'agent-hub', 'files', 'canvas', 'terminal']) {
      expect(ids).toContain(id);
    }
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
