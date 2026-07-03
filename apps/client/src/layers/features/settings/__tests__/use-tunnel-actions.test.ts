/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { getOwnerSetupRequest, clearOwnerSetupRequest } from '@/layers/shared/lib';
import { useTunnelActions } from '../model/use-tunnel-actions';
import type { TunnelMachine } from '../model/use-tunnel-machine';

/** Minimal fake machine — only the setters `handleToggle`/`startTunnel` touch. */
function fakeMachine(): TunnelMachine {
  return {
    setState: vi.fn(),
    setError: vi.fn(),
    setUrl: vi.fn(),
  } as unknown as TunnelMachine;
}

describe('useTunnelActions — exposure guard', () => {
  afterEach(() => {
    clearOwnerSetupRequest();
    vi.clearAllMocks();
  });

  it('routes a AUTH_REQUIRED_FOR_EXPOSURE tunnel-start rejection into owner setup', async () => {
    const transport = createMockTransport();
    const exposureError = Object.assign(
      new Error('Exposing DorkOS requires a login. Create an owner account first.'),
      { code: 'AUTH_REQUIRED_FOR_EXPOSURE', status: 409 }
    );
    vi.mocked(transport.startTunnel).mockRejectedValue(exposureError);

    const machine = fakeMachine();
    const queryClient = new QueryClient();
    const { result } = renderHook(() => useTunnelActions({ machine, transport, queryClient }));

    await act(async () => {
      await result.current.handleToggle(true);
    });

    const request = getOwnerSetupRequest();
    expect(request).not.toBeNull();
    expect(request?.reason).toBe('exposure');
    expect(request?.message).toBe('Exposing DorkOS requires a login.');
    // The dialog is opened, not an inline tunnel error.
    expect(machine.setState).toHaveBeenCalledWith('off');
  });

  it('surfaces a normal tunnel-start failure as an error (no owner setup)', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.startTunnel).mockRejectedValue(new Error('ngrok exploded'));

    const machine = fakeMachine();
    const queryClient = new QueryClient();
    const { result } = renderHook(() => useTunnelActions({ machine, transport, queryClient }));

    await act(async () => {
      await result.current.handleToggle(true);
    });

    expect(getOwnerSetupRequest()).toBeNull();
    expect(machine.setState).toHaveBeenCalledWith('error');
    expect(machine.setError).toHaveBeenCalledWith('ngrok exploded');
  });
});
