/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ServerConfig } from '@dorkos/shared/types';
import type { NotificationPrefs } from '@dorkos/shared/config-schema';
import { NOTIFICATION_PREFS_DEFAULTS } from '@dorkos/shared/config-schema';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { configKeys } from '@/layers/entities/config';
import { resetLegacySoundImportForTests } from '@/layers/entities/config';
import { useNotificationCues } from '../model/use-notification-cues';

/**
 * Every `Audio` the player builds, by source, with its `play` spy.
 *
 * Driving the real player rather than mocking it: the question this file
 * settles is "does the switch reach the sound", and a mocked player would let a
 * broken wiring pass.
 */
const audioBySrc = new Map<string, { play: ReturnType<typeof vi.fn>; currentTime: number }>();

vi.stubGlobal(
  'Audio',
  vi.fn(function (src: string) {
    const existing = audioBySrc.get(src);
    if (existing) return existing;
    const instance = { play: vi.fn().mockResolvedValue(undefined), currentTime: 0 };
    audioBySrc.set(src, instance);
    return instance;
  })
);

/** How many times a given cue's asset has been played, ever, in this file. */
function playCount(src: string): number {
  return audioBySrc.get(src)?.play.mock.calls.length ?? 0;
}

function harness(prefs: Partial<NotificationPrefs>) {
  const config = {
    notifications: { ...NOTIFICATION_PREFS_DEFAULTS, ...prefs },
  } as unknown as ServerConfig;
  const transport = createMockTransport({
    getConfig: vi.fn().mockResolvedValue(config),
    updateConfig: vi.fn().mockResolvedValue(undefined),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(configKeys.current(), config);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  return renderHook(() => useNotificationCues(), { wrapper });
}

beforeEach(() => {
  resetLegacySoundImportForTests();
  localStorage.clear();
  for (const instance of audioBySrc.values()) instance.play.mockClear();
});

describe('useNotificationCues', () => {
  it('plays the knock when the knock is on', () => {
    const { result } = harness({ sounds: { knock: true, allClear: true, turnEnd: true } });
    act(() => result.current.play('knock'));
    expect(playCount('/knock.wav')).toBe(1);
  });

  it('stays silent when the knock is off', () => {
    const { result } = harness({ sounds: { knock: false, allClear: true, turnEnd: true } });
    act(() => result.current.play('knock'));
    expect(playCount('/knock.wav')).toBe(0);
  });

  it('plays the all-clear when it is on, and not when it is off', () => {
    const on = harness({ sounds: { knock: true, allClear: true, turnEnd: true } });
    act(() => on.result.current.play('settle'));
    expect(playCount('/settle.wav')).toBe(1);

    const off = harness({ sounds: { knock: true, allClear: false, turnEnd: true } });
    act(() => off.result.current.play('settle'));
    expect(playCount('/settle.wav')).toBe(1);
  });

  it('plays the turn-end chime only when it is on', () => {
    const off = harness({ sounds: { knock: true, allClear: true, turnEnd: false } });
    act(() => off.result.current.play('turn-end'));
    expect(playCount('/notification.wav')).toBe(0);

    const on = harness({ sounds: { knock: true, allClear: true, turnEnd: true } });
    act(() => on.result.current.play('turn-end'));
    expect(playCount('/notification.wav')).toBe(1);
  });

  it('silencing one cue leaves the others alone', () => {
    // The reason there are three switches rather than one: wanting to know when
    // an agent is blocked, and not wanting a noise every time one finishes
    // typing, is the common case.
    const { result } = harness({ sounds: { knock: true, allClear: false, turnEnd: false } });
    act(() => {
      result.current.play('knock');
      result.current.play('settle');
      result.current.play('turn-end');
    });
    expect(playCount('/knock.wav')).toBe(1);
    expect(playCount('/settle.wav')).toBe(0);
    expect(playCount('/notification.wav')).toBe(0);
  });

  it('falls back to the shipped defaults before config arrives', () => {
    // The knock is on out of the box, so an arrival in the first frame is still
    // heard; the every-turn chime is off, so nobody gets one they never asked
    // for while the query is in flight.
    const transport = createMockTransport({
      getConfig: vi.fn(() => new Promise<never>(() => {})),
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useNotificationCues(), { wrapper });

    act(() => {
      result.current.play('knock');
      result.current.play('turn-end');
    });
    expect(playCount('/knock.wav')).toBe(1);
    expect(playCount('/notification.wav')).toBe(0);
  });
});
