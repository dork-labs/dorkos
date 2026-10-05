/**
 * @vitest-environment jsdom
 */
/**
 * The keep-awake entity: the words every surface shares, and the freshness
 * contract (one fetch, then the `keep_awake_status` event writes the cache).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { KeepAwakeStatus } from '@dorkos/shared/schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';

const handlers = new Map<string, (data: unknown) => void>();

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useEventSubscription: (name: string, handler: (data: unknown) => void) => {
      handlers.set(name, handler);
    },
  };
});

import { describeKeepAwakeWork, isKeepingAwake, useKeepAwake, useKeepAwakeSync } from '../index';

afterEach(() => {
  cleanup();
  handlers.clear();
});

const IDLE: KeepAwakeStatus = {
  enabled: true,
  supported: true,
  reason: null,
  asserted: false,
  working: { chats: 0, rooms: 0, tasks: 0, waking: false },
  wake: { enabled: false, setup: 'unsupported', nextWakeAt: null, setupCommand: null },
};

const work = (chats: number, rooms: number, tasks: number) => ({
  chats,
  rooms,
  tasks,
  waking: false,
});

describe('describeKeepAwakeWork', () => {
  it('names one kind with "running", pluralized', () => {
    expect(describeKeepAwakeWork(work(1, 0, 0))).toBe('1 chat running');
    expect(describeKeepAwakeWork(work(2, 0, 0))).toBe('2 chats running');
    expect(describeKeepAwakeWork(work(0, 0, 3))).toBe('3 tasks running');
  });

  it('lists a mix and leaves out kinds with nothing running', () => {
    expect(describeKeepAwakeWork(work(1, 1, 1))).toBe('1 chat, 1 room, 1 task');
    expect(describeKeepAwakeWork(work(2, 0, 1))).toBe('2 chats, 1 task');
  });

  it('says nothing when nothing runs', () => {
    expect(describeKeepAwakeWork(work(0, 0, 0))).toBeNull();
  });
});

describe('isKeepingAwake', () => {
  it('is true only while the computer is held for named work', () => {
    expect(isKeepingAwake(undefined)).toBe(false);
    expect(isKeepingAwake({ ...IDLE, working: work(1, 0, 0) })).toBe(false);
    expect(isKeepingAwake({ ...IDLE, asserted: true })).toBe(false);
    expect(isKeepingAwake({ ...IDLE, asserted: true, working: work(1, 0, 0) })).toBe(true);
  });
});

describe('useKeepAwake + useKeepAwakeSync', () => {
  function harness(transport: ReturnType<typeof createMockTransport>) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  }

  it('fetches once, then takes each keep_awake_status event straight into the cache', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getKeepAwake).mockResolvedValue(IDLE);
    const { result } = renderHook(
      () => {
        useKeepAwakeSync();
        return useKeepAwake();
      },
      { wrapper: harness(transport) }
    );
    await waitFor(() => expect(result.current).toEqual(IDLE));

    const holding = { ...IDLE, asserted: true, working: work(2, 0, 0) };
    act(() => handlers.get('keep_awake_status')!(holding));
    await waitFor(() => expect(result.current).toEqual(holding));
    expect(vi.mocked(transport.getKeepAwake)).toHaveBeenCalledTimes(1);
  });

  it('drops a payload of the wrong shape', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.getKeepAwake).mockResolvedValue(IDLE);
    const { result } = renderHook(
      () => {
        useKeepAwakeSync();
        return useKeepAwake();
      },
      { wrapper: harness(transport) }
    );
    await waitFor(() => expect(result.current).toEqual(IDLE));

    act(() => handlers.get('keep_awake_status')!({ asserted: 'yes' }));
    expect(result.current).toEqual(IDLE);
  });
});
