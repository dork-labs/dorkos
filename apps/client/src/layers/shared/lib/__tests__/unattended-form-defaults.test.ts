import { describe, it, expect } from 'vitest';
import type { PermissionModeDescriptor } from '@dorkos/shared/agent-runtime';
import { operatorStopForRuntime, resolveConfiguredStopMode } from '../unattended-form-defaults';

/** Claude-Code-shaped descriptors: one mode per stop. */
const DESCRIPTORS: PermissionModeDescriptor[] = [
  { id: 'default', label: 'Ask', stop: 'ask', asks: 'always', reach: 'edit', promise: 'Asks.' },
  {
    id: 'acceptEdits',
    label: 'Accept edits',
    stop: 'act',
    asks: 'when-risky',
    reach: 'edit',
    promise: 'Acts.',
  },
  {
    id: 'bypassPermissions',
    label: 'Full autonomy',
    stop: 'autonomy',
    asks: 'never',
    reach: 'everything',
    promise: 'Runs everything.',
  },
];

describe('operatorStopForRuntime', () => {
  it('returns null when execution defaults have not loaded', () => {
    expect(operatorStopForRuntime(undefined, 'claude-code')).toBeNull();
  });

  it('returns the global stop when no per-runtime override exists', () => {
    expect(operatorStopForRuntime({ trustStop: 'autonomy', perRuntime: [] }, 'claude-code')).toBe(
      'autonomy'
    );
  });

  it('lets a per-runtime override win over the global stop', () => {
    expect(
      operatorStopForRuntime(
        {
          trustStop: 'ask',
          perRuntime: [{ runtime: 'claude-code', trustStop: 'autonomy' } as never],
        },
        'claude-code'
      )
    ).toBe('autonomy');
  });

  it('falls through a null per-runtime override to the global stop', () => {
    expect(
      operatorStopForRuntime(
        {
          trustStop: 'act',
          perRuntime: [{ runtime: 'claude-code', trustStop: null } as never],
        },
        'claude-code'
      )
    ).toBe('act');
  });

  it('returns null when neither the runtime nor the global stop is set', () => {
    expect(operatorStopForRuntime({ trustStop: null, perRuntime: [] }, 'claude-code')).toBeNull();
  });
});

describe('resolveConfiguredStopMode', () => {
  it('falls back to acceptEdits when no stop is configured — byte-for-byte the old default', () => {
    expect(resolveConfiguredStopMode(null, DESCRIPTORS)).toBe('acceptEdits');
    expect(resolveConfiguredStopMode(undefined, DESCRIPTORS)).toBe('acceptEdits');
  });

  it('maps a configured stop to that runtime’s mode id', () => {
    expect(resolveConfiguredStopMode('autonomy', DESCRIPTORS)).toBe('bypassPermissions');
    expect(resolveConfiguredStopMode('act', DESCRIPTORS)).toBe('acceptEdits');
    expect(resolveConfiguredStopMode('ask', DESCRIPTORS)).toBe('default');
  });

  it('falls back to acceptEdits before the runtime profile has loaded', () => {
    expect(resolveConfiguredStopMode('autonomy', [])).toBe('acceptEdits');
  });
});
