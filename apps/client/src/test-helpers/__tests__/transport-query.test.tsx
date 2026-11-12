/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ServerConfig } from '@dorkos/shared/types';
import { useConfig } from '@/layers/entities/config';
import { buildTransportQueryHarness } from '../transport-query';

/** A config the mock transport would never answer on its own. */
const config = (version: string) => ({ version }) as unknown as ServerConfig;

describe('buildTransportQueryHarness', () => {
  it('serves a real entity hook from the overridden transport read', async () => {
    const getConfig = vi.fn().mockResolvedValue(config('9.9.9-harness'));
    const { Wrapper, transport } = buildTransportQueryHarness({ getConfig });

    const { result } = renderHook(() => useConfig(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.data).toEqual(config('9.9.9-harness')));
    expect(transport.getConfig).toBe(getConfig);
    expect(getConfig).toHaveBeenCalledTimes(1);
  });

  it('gives each harness its own cache, so one case cannot answer for the next', async () => {
    const first = buildTransportQueryHarness({
      getConfig: vi.fn().mockResolvedValue(config('first')),
    });
    const { result: a } = renderHook(() => useConfig(), { wrapper: first.Wrapper });
    await waitFor(() => expect(a.current.data).toEqual(config('first')));

    const second = buildTransportQueryHarness({
      getConfig: vi.fn().mockResolvedValue(config('second')),
    });
    const { result: b } = renderHook(() => useConfig(), { wrapper: second.Wrapper });
    await waitFor(() => expect(b.current.data).toEqual(config('second')));

    expect(first.queryClient).not.toBe(second.queryClient);
  });
});
