// @vitest-environment jsdom
/**
 * The Control Center's keep-awake line: present while DorkOS is keeping this
 * computer awake for work, saying the same thing the top-bar cup says, and
 * absent otherwise. The dial, switches and ledger have their own tests and are
 * stubbed here.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { KeepAwakeStatus } from '@dorkos/shared/schemas';

vi.mock('../ui/ControlCenterDial', () => ({ ControlCenterDial: () => null }));
vi.mock('../ui/ControlCenterSwitches', () => ({ ControlCenterSwitches: () => null }));
vi.mock('../ui/OverridesLedger', () => ({ OverridesLedger: () => null }));
vi.mock('@/layers/entities/unattended-autonomy', () => ({
  useUnattendedAutonomy: () => undefined,
}));

const keepAwake = vi.hoisted(() => ({ status: undefined as KeepAwakeStatus | undefined }));
vi.mock('@/layers/entities/keep-awake', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/keep-awake')>()),
  useKeepAwake: () => keepAwake.status,
}));

import { ControlCenterBody } from '../ui/ControlCenterBody';

afterEach(() => {
  cleanup();
  keepAwake.status = undefined;
});

const status = (overrides: Partial<KeepAwakeStatus>): KeepAwakeStatus => ({
  enabled: true,
  supported: true,
  reason: null,
  asserted: true,
  working: { chats: 2, rooms: 0, tasks: 0, waking: false },
  wake: { enabled: false, setup: 'unsupported', nextWakeAt: null, setupCommand: null },
  ...overrides,
});

describe('ControlCenterBody keep-awake line', () => {
  it('says what the computer is being kept awake for', () => {
    keepAwake.status = status({});
    render(<ControlCenterBody />);
    expect(screen.getByTestId('control-center-keep-awake')).toHaveTextContent(
      'Keeping this computer awake: 2 chats running.'
    );
  });

  it('is absent when nothing holds the computer awake', () => {
    keepAwake.status = status({ asserted: false });
    render(<ControlCenterBody />);
    expect(screen.queryByTestId('control-center-keep-awake')).not.toBeInTheDocument();
  });
});
