/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { ServerConfig } from '@dorkos/shared/types';
import type { NotificationPrefs } from '@dorkos/shared/config-schema';
import { NOTIFICATION_PREFS_DEFAULTS } from '@dorkos/shared/config-schema';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { configKeys } from '../api/query-keys';
import {
  useNotificationPrefs,
  resetLegacySoundImportForTests,
} from '../model/use-notification-prefs';

const LEGACY_KEY = 'dorkos-enable-notification-sound';

function makeServerConfig(overrides: Partial<NotificationPrefs> = {}): ServerConfig {
  return {
    notifications: { ...NOTIFICATION_PREFS_DEFAULTS, ...overrides },
  } as unknown as ServerConfig;
}

/**
 * A harness whose SEEDED cache and whose `getConfig` agree.
 *
 * Both, not just the cache: `useConfig` refetches on mount, and the mock
 * transport's stock config carries no `notifications` at all — so seeding alone
 * leaves the section present for one render and gone the next, which reads in a
 * failing test exactly like the hook not reading config.
 */
function createHarness(
  config: ServerConfig | undefined,
  overrides: Partial<Transport> = {}
): {
  queryClient: QueryClient;
  transport: Transport;
  wrapper: (p: { children: ReactNode }) => ReactNode;
} {
  const transport = createMockTransport({
    getConfig: vi.fn().mockResolvedValue(config ?? {}),
    updateConfig: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  if (config !== undefined) queryClient.setQueryData(configKeys.current(), config);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  return { queryClient, transport, wrapper };
}

beforeEach(() => {
  resetLegacySoundImportForTests();
  localStorage.clear();
});

describe('useNotificationPrefs', () => {
  it('reads the shipped defaults while config has not loaded', () => {
    const { wrapper } = createHarness(undefined);
    const { result } = renderHook(() => useNotificationPrefs(), { wrapper });
    expect(result.current.prefs).toEqual(NOTIFICATION_PREFS_DEFAULTS);
  });

  it('ships with the knock and the all-clear on, and the every-turn chime off', () => {
    // What the defaults ARE, so flipping one is a deliberate edit here rather
    // than a silent pass.
    expect(NOTIFICATION_PREFS_DEFAULTS.sounds).toEqual({
      knock: true,
      allClear: true,
      turnEnd: false,
    });
    expect(NOTIFICATION_PREFS_DEFAULTS.escalation.phoneAfterMinutes).toBe(2);
    expect(NOTIFICATION_PREFS_DEFAULTS.notifyOnTurnCompleteWhileAway).toBe(true);
    expect(NOTIFICATION_PREFS_DEFAULTS.browserPermissionPrimerDismissed).toBe(false);
  });

  it('reads the stored settings once config resolves', () => {
    const { wrapper } = createHarness(
      makeServerConfig({ sounds: { knock: false, allClear: false, turnEnd: true } })
    );
    const { result } = renderHook(() => useNotificationPrefs(), { wrapper });
    expect(result.current.prefs.sounds).toEqual({ knock: false, allClear: false, turnEnd: true });
  });

  it('patches one switch without disturbing the others', async () => {
    // The write never settles, deliberately: `onSettled` invalidates, and the
    // mock server does not persist, so a resolved write would refetch the
    // pre-mutation config over the optimistic state this asserts.
    const { queryClient, transport, wrapper } = createHarness(makeServerConfig(), {
      updateConfig: vi.fn(() => new Promise<void>(() => {})),
    });

    const { result } = renderHook(() => useNotificationPrefs(), { wrapper });

    act(() => {
      result.current.setPrefs({ sounds: { turnEnd: true } });
    });

    await waitFor(() => expect(transport.updateConfig).toHaveBeenCalledTimes(1));
    // Only the leaf travels; the server deep-merges the rest.
    expect(transport.updateConfig).toHaveBeenCalledWith({
      notifications: { sounds: { turnEnd: true } },
    });

    // Optimistically, the OTHER two switches survive — this is what a shallow
    // spread of `sounds` would have destroyed.
    await waitFor(() =>
      expect(
        queryClient.getQueryData<ServerConfig>(configKeys.current())!.notifications.sounds
      ).toEqual({ knock: true, allClear: true, turnEnd: true })
    );
  });

  it('rolls back when the write fails', async () => {
    let rejectWrite!: (err: Error) => void;
    const pending = new Promise<void>((_resolve, reject) => {
      rejectWrite = reject;
    });
    const { queryClient, wrapper } = createHarness(makeServerConfig(), {
      updateConfig: vi.fn().mockReturnValue(pending),
    });

    const { result } = renderHook(() => useNotificationPrefs(), { wrapper });

    act(() => {
      result.current.setPrefs({ notifyOnTurnCompleteWhileAway: false });
    });

    await waitFor(() =>
      expect(
        queryClient.getQueryData<ServerConfig>(configKeys.current())!.notifications
          .notifyOnTurnCompleteWhileAway
      ).toBe(false)
    );

    await act(async () => {
      rejectWrite(new Error('boom'));
      await pending.catch(() => {});
    });

    await waitFor(() =>
      expect(
        queryClient.getQueryData<ServerConfig>(configKeys.current())!.notifications
          .notifyOnTurnCompleteWhileAway
      ).toBe(true)
    );
  });
});

describe('useNotificationPrefs — the retired browser key', () => {
  it('carries a chime somebody had left ON into config, then deletes the key', async () => {
    // The whole point of the migration: the setting used to default ON and now
    // defaults OFF. Somebody who never touched it loses nothing; somebody who
    // deliberately kept it must not have it taken away.
    localStorage.setItem(LEGACY_KEY, 'true');
    const { transport, wrapper } = createHarness(makeServerConfig());

    renderHook(() => useNotificationPrefs(), { wrapper });

    await waitFor(() =>
      expect(transport.updateConfig).toHaveBeenCalledWith({
        notifications: { sounds: { turnEnd: true } },
      })
    );
    await waitFor(() => expect(localStorage.getItem(LEGACY_KEY)).toBeNull());
  });

  it('writes nothing when the browser key agrees with config, and still drops it', async () => {
    localStorage.setItem(LEGACY_KEY, 'false');
    const { transport, wrapper } = createHarness(makeServerConfig());

    renderHook(() => useNotificationPrefs(), { wrapper });

    await waitFor(() => expect(localStorage.getItem(LEGACY_KEY)).toBeNull());
    expect(transport.updateConfig).not.toHaveBeenCalled();
  });

  it('runs once per page load, not once per consumer', async () => {
    localStorage.setItem(LEGACY_KEY, 'true');
    const { transport, wrapper } = createHarness(makeServerConfig());

    // Three readers, as the real app has: the cue hook, the settings tab, and
    // the primer. One import between them.
    renderHook(
      () => {
        useNotificationPrefs();
        useNotificationPrefs();
        useNotificationPrefs();
      },
      { wrapper }
    );

    await waitFor(() => expect(transport.updateConfig).toHaveBeenCalledTimes(1));
  });

  it('does nothing at all when the browser never held the key', async () => {
    const { transport, wrapper } = createHarness(makeServerConfig());

    renderHook(() => useNotificationPrefs(), { wrapper });

    // Nothing to import, so nothing is written — an unconditional patch here
    // would overwrite a choice made on another device with this browser's
    // silence.
    await waitFor(() => expect(transport.updateConfig).not.toHaveBeenCalled());
  });

  it('waits for config before importing, so it can compare rather than clobber', async () => {
    localStorage.setItem(LEGACY_KEY, 'true');
    const { transport, wrapper } = createHarness(undefined, {
      getConfig: vi.fn(() => new Promise<never>(() => {})),
    });

    renderHook(() => useNotificationPrefs(), { wrapper });

    await Promise.resolve();
    expect(transport.updateConfig).not.toHaveBeenCalled();
    expect(localStorage.getItem(LEGACY_KEY)).toBe('true');
  });
});
