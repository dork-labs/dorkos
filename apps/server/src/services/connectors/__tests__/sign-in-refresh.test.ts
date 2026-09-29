import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connections, createDb, eq, runMigrations, type Db } from '@dorkos/db';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import type {
  ConnectedAccount,
  ConnectorProviderInstanceId,
} from '@dorkos/shared/connector-provider';
import { ConnectorRegistry, type SignInRefreshResult } from '../registry.js';
import {
  SIGN_IN_REFRESH_INTERVAL_MS,
  SIGN_IN_REFRESH_MIN_GAP_MS,
  SignInRefresher,
} from '../resources/sign-in-refresh.js';

/** Connect one Gmail account on a fake provider. */
async function connectGmail(
  registry: ConnectorRegistry,
  provider: FakeConnectorProvider
): Promise<ConnectedAccount> {
  const { flowId } = await provider.startConnect('gmail', { label: 'work' });
  const { account } = await provider.pollConnect(flowId);
  return registry.recordConnect(provider, account!);
}

describe('SignInRefresher', () => {
  let db: Db;
  let registry: ConnectorRegistry;
  let provider: FakeConnectorProvider;
  let recheckWay: ReturnType<typeof vi.fn<(id: ConnectorProviderInstanceId) => Promise<void>>>;
  let refresher: SignInRefresher | undefined;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    registry = new ConnectorRegistry({ db, providerTimeoutMs: 100 });
    provider = new FakeConnectorProvider({ type: 'composio' });
    registry.register(provider);
    recheckWay = vi.fn(() => Promise.resolve());
  });

  afterEach(() => {
    refresher?.stop();
    refresher = undefined;
    vi.useRealTimers();
  });

  const statusOf = (id: string) =>
    db.select({ status: connections.status }).from(connections).where(eq(connections.id, id)).get()
      ?.status;

  it('notices a sign-in that expired at the service on its periodic run', async () => {
    vi.useFakeTimers();
    const gmail = await connectGmail(registry, provider);
    refresher = new SignInRefresher({ registry, ways: { recheckWay } });
    refresher.start();

    provider.setStatus(registry.accountBinding(gmail.id)!.externalAccountRef, 'expired');
    await vi.advanceTimersByTimeAsync(SIGN_IN_REFRESH_INTERVAL_MS - 1);
    expect(statusOf(gmail.id)).toBe('active');
    await vi.advanceTimersByTimeAsync(1);

    expect(statusOf(gmail.id)).toBe('expired');
    expect(recheckWay).not.toHaveBeenCalled();
  });

  it('leaves the sign-in alone and checks the way again when its listing fails', async () => {
    const gmail = await connectGmail(registry, provider);
    provider.setStatus(registry.accountBinding(gmail.id)!.externalAccountRef, 'expired');
    provider.listAccounts = () => Promise.reject(new Error('service unavailable'));
    refresher = new SignInRefresher({ registry, ways: { recheckWay } });

    await refresher.refresh();

    expect(statusOf(gmail.id)).toBe('active');
    expect(recheckWay).toHaveBeenCalledExactlyOnceWith(provider.instanceId);
  });

  it('refreshes when someone opens Connections, at most once a minute, joining one already running', async () => {
    let now = 1_000_000;
    const refreshSignIns = vi.fn((): Promise<SignInRefreshResult> =>
      Promise.resolve({ changes: [], failures: [] })
    );
    refresher = new SignInRefresher({
      registry: { refreshSignIns },
      ways: { recheckWay },
      now: () => now,
    });

    await Promise.all([refresher.refreshOnDemand(), refresher.refreshOnDemand()]);
    expect(refreshSignIns).toHaveBeenCalledTimes(1);

    now += SIGN_IN_REFRESH_MIN_GAP_MS - 1;
    await refresher.refreshOnDemand();
    expect(refreshSignIns).toHaveBeenCalledTimes(1);

    now += 1;
    await refresher.refreshOnDemand();
    expect(refreshSignIns).toHaveBeenCalledTimes(2);
  });

  it('answers a page read after a short wait even when the service is slow, and finishes the refresh after', async () => {
    vi.useFakeTimers();
    const gmail = await connectGmail(registry, provider);
    const ref = registry.accountBinding(gmail.id)!.externalAccountRef;
    let release!: () => void;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    provider.listAccounts = async () => {
      await slow;
      return [
        {
          externalAccountRef: ref,
          toolkit: 'gmail',
          label: 'work',
          status: 'expired',
          custody: 'managed',
        },
      ];
    };
    const slowRegistry = new ConnectorRegistry({ db, signInRefreshTimeoutMs: 60_000 });
    slowRegistry.register(provider);
    refresher = new SignInRefresher({ registry: slowRegistry, ways: { recheckWay } });

    let answered = false;
    const read = refresher.refreshOnDemand(1_500).then(() => {
      answered = true;
    });
    await vi.advanceTimersByTimeAsync(1_500);
    await read;
    expect(answered).toBe(true);
    expect(statusOf(gmail.id)).toBe('active');

    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(statusOf(gmail.id)).toBe('expired');
  });

  it('keeps going when the connection store cannot be read', async () => {
    refresher = new SignInRefresher({
      registry: { refreshSignIns: () => Promise.reject(new Error('store unavailable')) },
      ways: { recheckWay },
    });

    await expect(refresher.refresh()).resolves.toBeUndefined();
  });
});
