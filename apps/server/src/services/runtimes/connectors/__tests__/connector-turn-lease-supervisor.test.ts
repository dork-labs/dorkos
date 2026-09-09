import { describe, expect, it, vi } from 'vitest';
import type {
  ConnectorRuntimePrincipalPort,
  ConnectorTurnRenewalPermit,
} from '../../../connectors/runtime-principal-port.js';
import {
  ConnectorTurnLeaseSupervisor,
  type ConnectorLeaseScheduler,
  type ConnectorLeaseTimer,
} from '../connector-turn-lease-supervisor.js';

function principalPort(): ConnectorRuntimePrincipalPort {
  return {
    openTurn: vi.fn(),
    renew: vi.fn(),
    resolve: vi.fn(),
    revoke: vi.fn(),
  };
}

function fixture() {
  let nowMs = Date.parse('2026-09-08T00:00:00.000Z');
  const callbacks: Array<{ callback: () => void; delayMs: number; cleared: boolean }> = [];
  const scheduler: ConnectorLeaseScheduler = {
    set: vi.fn((callback, delayMs) => {
      const entry = { callback, delayMs, cleared: false };
      callbacks.push(entry);
      return { unref: vi.fn(), entry } as ConnectorLeaseTimer;
    }),
    clear: vi.fn((timer) => {
      (timer as ConnectorLeaseTimer & { entry: (typeof callbacks)[number] }).entry.cleared = true;
    }),
  };
  const principals = principalPort();
  const controller = new AbortController();
  const losses = vi.fn();
  const supervisor = new ConnectorTurnLeaseSupervisor({
    principals,
    bindingId: 'binding-a',
    permit: {} as ConnectorTurnRenewalPermit,
    runtime: 'codex',
    expiresAt: '2026-09-08T04:00:00.000Z',
    signal: controller.signal,
    now: () => new Date(nowMs),
    scheduler,
    onLost: losses,
  });
  return {
    callbacks,
    controller,
    losses,
    principals,
    scheduler,
    supervisor,
    setNow(value: string) {
      nowMs = Date.parse(value);
    },
  };
}

describe('ConnectorTurnLeaseSupervisor', () => {
  it('renews hourly with one-shot unref timers and keeps the same permit', async () => {
    const f = fixture();
    expect(f.callbacks[0]?.delayMs).toBe(60 * 60 * 1_000);
    vi.mocked(f.principals.renew).mockResolvedValue({
      status: 'renewed',
      expiresAt: '2026-09-08T05:00:00.000Z',
    });
    f.setNow('2026-09-08T01:00:00.000Z');
    f.callbacks[0]!.callback();
    await vi.waitFor(() => expect(f.principals.renew).toHaveBeenCalledTimes(1));
    expect(f.callbacks[1]?.delayMs).toBe(60 * 60 * 1_000);
    expect(f.principals.renew).toHaveBeenCalledWith({
      bindingId: 'binding-a',
      permit: expect.any(Object),
    });
    expect(f.losses).not.toHaveBeenCalled();
  });

  it('retries storage failures at one, five, then capped fifteen minutes', async () => {
    const f = fixture();
    vi.mocked(f.principals.renew).mockRejectedValue(new Error('storage unavailable'));
    f.setNow('2026-09-08T01:00:00.000Z');
    f.callbacks[0]!.callback();
    await vi.waitFor(() => expect(f.callbacks).toHaveLength(2));
    expect(f.callbacks[1]?.delayMs).toBe(60_000);
    f.callbacks[1]!.callback();
    await vi.waitFor(() => expect(f.callbacks).toHaveLength(3));
    expect(f.callbacks[2]?.delayMs).toBe(5 * 60_000);
    f.callbacks[2]!.callback();
    await vi.waitFor(() => expect(f.callbacks).toHaveLength(4));
    expect(f.callbacks[3]?.delayMs).toBe(15 * 60_000);
  });

  it('keeps one unchanged bearer permit renewed across a deterministic 72-hour turn', async () => {
    const f = fixture();
    vi.mocked(f.principals.renew).mockImplementation(async ({ permit }) => {
      expect(permit).toBe(vi.mocked(f.principals.renew).mock.calls[0]?.[0].permit);
      const latestHour = vi.mocked(f.principals.renew).mock.calls.length;
      return {
        status: 'renewed',
        expiresAt: new Date(
          Date.parse('2026-09-08T00:00:00.000Z') + (latestHour + 4) * 60 * 60 * 1_000
        ).toISOString(),
      };
    });

    for (let hour = 1; hour <= 72; hour += 1) {
      f.setNow(new Date(Date.parse('2026-09-08T00:00:00.000Z') + hour * 3_600_000).toISOString());
      f.callbacks[hour - 1]!.callback();
      await vi.waitFor(() => expect(f.principals.renew).toHaveBeenCalledTimes(hour));
    }

    expect(f.supervisor.state).toBe('active');
    expect(f.losses).not.toHaveBeenCalled();
    expect(f.callbacks).toHaveLength(73);
  });

  it('never renews at expiry and reports one terminal safe loss', async () => {
    const f = fixture();
    f.setNow('2026-09-08T04:00:00.000Z');
    f.callbacks[0]!.callback();
    await vi.waitFor(() => expect(f.supervisor.state).toBe('lost'));
    expect(f.principals.renew).not.toHaveBeenCalled();
    expect(f.losses).toHaveBeenCalledOnce();
    expect(f.losses).toHaveBeenCalledWith({
      bindingId: 'binding-a',
      runtime: 'codex',
      reason: 'expired',
      expiresAt: '2026-09-08T04:00:00.000Z',
      at: '2026-09-08T04:00:00.000Z',
    });
    expect(() => f.supervisor.assertUsable()).toThrow('Start a new turn');
  });

  it('clears the timer on cancellation and ignores an already queued callback', async () => {
    const f = fixture();
    f.controller.abort();
    expect(f.supervisor.state).toBe('stopped');
    expect(f.scheduler.clear).toHaveBeenCalledTimes(1);
    f.callbacks[0]!.callback();
    await Promise.resolve();
    expect(f.principals.renew).not.toHaveBeenCalled();
  });

  it('stops cleanly while a renewal is awaiting storage and schedules nothing afterward', async () => {
    const f = fixture();
    let finishRenewal!: (value: { status: 'renewed'; expiresAt: string }) => void;
    vi.mocked(f.principals.renew).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRenewal = resolve;
        })
    );
    f.setNow('2026-09-08T01:00:00.000Z');
    f.callbacks[0]!.callback();
    await vi.waitFor(() => expect(f.principals.renew).toHaveBeenCalledOnce());

    f.supervisor.stop();
    finishRenewal({ status: 'renewed', expiresAt: '2026-09-08T05:00:00.000Z' });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(f.supervisor.state).toBe('stopped');
    expect(f.callbacks).toHaveLength(1);
    expect(f.losses).not.toHaveBeenCalled();
  });

  it('lets a transient retry reach expiry without another renewal attempt', async () => {
    const f = fixture();
    vi.mocked(f.principals.renew).mockRejectedValueOnce(new Error('storage unavailable'));
    f.setNow('2026-09-08T03:59:30.000Z');
    f.callbacks[0]!.callback();
    await vi.waitFor(() => expect(f.callbacks).toHaveLength(2));
    expect(f.callbacks[1]?.delayMs).toBe(30_000);

    f.setNow('2026-09-08T04:00:00.000Z');
    f.callbacks[1]!.callback();
    await vi.waitFor(() => expect(f.supervisor.state).toBe('lost'));
    expect(f.principals.renew).toHaveBeenCalledOnce();
    expect(f.losses).toHaveBeenCalledOnce();
  });
});
