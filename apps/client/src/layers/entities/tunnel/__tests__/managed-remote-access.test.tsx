// @vitest-environment jsdom
/**
 * Managed remote access in the shared model (DOR-2086): which reports drive
 * the surfaces, what each report state becomes, and which request a switch
 * sends for the mode the person selected.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { Transport } from '@dorkos/shared/transport';
import type { RemoteAccessReport } from '@dorkos/shared/types';
import {
  HIDDEN_REMOTE_ACCESS_REPORT,
  createMockTransport,
  createRemoteAccessReport,
} from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';

const requestOwnerSetup = vi.hoisted(() => vi.fn());
vi.mock('@/layers/shared/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/lib')>()),
  requestOwnerSetup,
}));

import {
  resetRemoteAccessStore,
  useRemoteAccessActions,
  useRemoteAccessSnapshot,
  useRemoteAccessStore,
} from '../index';
import { stateFromReport, urlFromReport, usableReport } from '../model/remote-access-report';

let fetchedAt = 1;

/** Reduce a report into the store, as the shared query would. */
function apply(report: RemoteAccessReport | null) {
  act(() => useRemoteAccessStore.getState().applyRemoteReport(report, fetchedAt++));
}

function mount(transport: Transport) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  }
  return renderHook(
    () => ({ actions: useRemoteAccessActions(), snapshot: useRemoteAccessSnapshot() }),
    { wrapper: Wrapper }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  resetRemoteAccessStore();
});

afterEach(() => cleanup());

describe('which reports drive the surfaces', () => {
  it('ignores a hidden report, so the app is the ngrok one it always was', () => {
    expect(usableReport(HIDDEN_REMOTE_ACCESS_REPORT)).toBeNull();
  });

  it('ignores an unavailable report on a computer that never chose DorkOS', () => {
    expect(
      usableReport(createRemoteAccessReport({ availability: 'unavailable', mode: 'off' }))
    ).toBeNull();
  });

  it('keeps an unavailable report while DorkOS is selected, so stale truth still shows', () => {
    const report = createRemoteAccessReport({ availability: 'unavailable', cloudStale: true });
    expect(usableReport(report)).toBe(report);
  });

  it('keeps every available report', () => {
    const report = createRemoteAccessReport({ mode: 'off', state: 'off' });
    expect(usableReport(report)).toBe(report);
  });
});

describe('what each report state becomes', () => {
  it.each([
    ['off', 'off'],
    ['opening', 'starting'],
    ['open', 'connected'],
    ['draining', 'draining'],
    ['blocked', 'blocked'],
    ['reconnecting', 'reconnecting'],
    ['asleep', 'asleep'],
  ] as const)('%s reads as %s', (reported, state) => {
    expect(stateFromReport(reported)).toBe(state);
  });

  it('offers the address only while open or asleep', () => {
    const url = 'https://calm-otter.example.com';
    expect(urlFromReport(createRemoteAccessReport({ state: 'open', url }))).toBe(url);
    expect(urlFromReport(createRemoteAccessReport({ state: 'asleep', url }))).toBe(url);
    for (const state of ['opening', 'draining', 'blocked', 'reconnecting', 'off'] as const) {
      expect(urlFromReport(createRemoteAccessReport({ state, url }))).toBeNull();
    }
  });

  it('puts an asleep managed address on the shared snapshot, neutral and still on', () => {
    const { result } = mount(createMockTransport());
    apply(createRemoteAccessReport({ state: 'asleep' }));
    expect(result.current.snapshot.state).toBe('asleep');
    expect(result.current.snapshot.url).toBe('https://calm-otter.example.com');
    expect(result.current.snapshot.mode).toBe('managed');
    expect(result.current.snapshot.isLive).toBe(true);
    expect(result.current.snapshot.error).toBeNull();
  });

  it('carries the blocked reason and Cloud staleness', () => {
    const { result } = mount(createMockTransport());
    apply(
      createRemoteAccessReport({
        state: 'blocked',
        url: undefined,
        reason: 'Setup did not finish. Start it again.',
        cloudStale: true,
      })
    );
    expect(result.current.snapshot.state).toBe('blocked');
    expect(result.current.snapshot.managed?.reason).toBe('Setup did not finish. Start it again.');
    expect(result.current.snapshot.managed?.cloudStale).toBe(true);
    expect(result.current.snapshot.isChecked).toBe(true);
  });

  it('hands the state back to the ngrok block when DorkOS stops being selected', () => {
    const { result } = mount(createMockTransport());
    apply(createRemoteAccessReport({ state: 'open' }));
    expect(result.current.snapshot.state).toBe('connected');
    apply(createRemoteAccessReport({ mode: 'byo', state: 'off', url: undefined }));
    expect(result.current.snapshot.state).toBe('off');
    expect(result.current.snapshot.mode).toBe('byo');
  });
});

describe('a switch dispatches by the selected mode', () => {
  it('turns DorkOS access on and off through the mode, never the ngrok routes', async () => {
    const transport = createMockTransport({
      setRemoteAccessMode: vi.fn().mockResolvedValue(createRemoteAccessReport()),
    });
    const { result } = mount(transport);
    apply(createRemoteAccessReport({ state: 'asleep' }));

    await act(() => result.current.actions.toggle(false));
    await act(() => result.current.actions.toggle(true));

    expect(transport.setRemoteAccessMode).toHaveBeenNthCalledWith(1, 'off');
    expect(transport.setRemoteAccessMode).toHaveBeenNthCalledWith(2, 'managed');
    expect(transport.startTunnel).not.toHaveBeenCalled();
    expect(transport.stopTunnel).not.toHaveBeenCalled();
  });

  it('turns DorkOS on from off once this computer is set up for it, with no ngrok token', async () => {
    const transport = createMockTransport({
      setRemoteAccessMode: vi.fn().mockResolvedValue(createRemoteAccessReport()),
    });
    const { result } = mount(transport);
    apply(createRemoteAccessReport({ mode: 'off', state: 'off', url: undefined }));
    expect(result.current.snapshot.isSetUp).toBe(true);

    await act(() => result.current.actions.toggle(true));

    expect(transport.setRemoteAccessMode).toHaveBeenCalledWith('managed');
    expect(transport.startTunnel).not.toHaveBeenCalled();
  });

  it('starts the person’s own ngrok when that is the selected mode', async () => {
    const transport = createMockTransport();
    const { result } = mount(transport);
    apply(createRemoteAccessReport({ mode: 'byo', state: 'off', url: undefined }));

    await act(() => result.current.actions.toggle(true));

    expect(transport.startTunnel).toHaveBeenCalledTimes(1);
    expect(transport.setRemoteAccessMode).not.toHaveBeenCalled();
  });

  it('starts ngrok as before while managed access is hidden', async () => {
    const transport = createMockTransport();
    const { result } = mount(transport);
    apply(HIDDEN_REMOTE_ACCESS_REPORT);

    await act(() => result.current.actions.toggle(true));

    expect(transport.startTunnel).toHaveBeenCalledTimes(1);
    expect(transport.setRemoteAccessMode).not.toHaveBeenCalled();
  });
});

describe('the managed-only writes', () => {
  it('routes a setup refused for want of a login into owner setup, then retries', async () => {
    const refusal = Object.assign(new Error('Remote access needs a login.'), {
      code: 'AUTH_REQUIRED_FOR_EXPOSURE',
      status: 409,
    });
    const transport = createMockTransport({
      startRemoteEnrolment: vi
        .fn()
        .mockRejectedValueOnce(refusal)
        .mockResolvedValue(createRemoteAccessReport()),
    });
    const { result } = mount(transport);

    await act(() => result.current.actions.enrol());

    expect(requestOwnerSetup).toHaveBeenCalledWith(expect.objectContaining({ reason: 'exposure' }));
    const { onComplete } = requestOwnerSetup.mock.calls[0][0] as { onComplete: () => void };
    await act(async () => onComplete());
    expect(transport.startRemoteEnrolment).toHaveBeenCalledTimes(2);
  });

  it('rejects any other refusal with the server’s sentence', async () => {
    const transport = createMockTransport({
      withdrawRemoteAccess: vi
        .fn()
        .mockRejectedValue(new Error('Remote access can only be changed on this computer.')),
    });
    const { result } = mount(transport);

    await expect(result.current.actions.withdraw()).rejects.toThrow(
      'Remote access can only be changed on this computer.'
    );
  });

  it('applies the report a write answers with to every reader at once', async () => {
    const transport = createMockTransport({
      closeRemoteAccess: vi
        .fn()
        .mockResolvedValue(createRemoteAccessReport({ state: 'draining', url: undefined })),
    });
    const { result } = mount(transport);
    apply(createRemoteAccessReport());

    await act(() => result.current.actions.closeNow());

    expect(result.current.snapshot.state).toBe('draining');
    expect(result.current.snapshot.url).toBeNull();
  });
});
