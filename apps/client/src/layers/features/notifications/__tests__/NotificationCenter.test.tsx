/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ServerConfig } from '@dorkos/shared/types';
import type { NotificationPrefs } from '@dorkos/shared/config-schema';
import { NOTIFICATION_PREFS_DEFAULTS } from '@dorkos/shared/config-schema';
import { createMockTransport } from '@dorkos/test-utils';
import { setPrefersReducedMotion } from '@/test-setup';

/** The blocking queue the watcher reads, swapped between renders. */
const world = {
  signals: [] as { id: string; kind: string; primary: string; deepLink: string }[],
};

vi.mock('@/layers/entities/attention', () => ({
  useAttentionSignals: () => world.signals,
  useAttentionSignalsLoading: () => false,
  usePendingScheduleApprovals: () => ({ schedules: [], isLoading: false }),
}));

/** No router and no SSE provider in a bare render. */
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useSafeNavigate: () => vi.fn(),
    useEventSubscription: () => {},
  };
});

const { TransportProvider } = await import('@/layers/shared/model');
const { configKeys, resetLegacySoundImportForTests } = await import('@/layers/entities/config');
const { resetPermissionPrimerForTests } = await import('../model/primer-trigger');
const { NotificationCenter } = await import('../ui/NotificationCenter');

/** Which cue assets have been played, in order. */
let played: string[] = [];

vi.stubGlobal(
  'Audio',
  vi.fn(function (src: string) {
    return {
      set currentTime(_value: number) {},
      get currentTime() {
        return 0;
      },
      play: () => {
        played.push(src);
        return Promise.resolve();
      },
    };
  })
);

function renderCenter(prefs: Partial<NotificationPrefs> = {}) {
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
  return render(<NotificationCenter />, { wrapper });
}

/** An agent parked on a permission prompt. */
function ask(id: string) {
  return { id, kind: 'permission-prompt', primary: 'Meeting Notes', deepLink: `/session?s=${id}` };
}

beforeEach(() => {
  played = [];
  world.signals = [];
  resetPermissionPrimerForTests();
  resetLegacySoundImportForTests();
  localStorage.clear();
  delete window.electronAPI;
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
});

afterEach(() => cleanup());

describe('NotificationCenter — the knock', () => {
  it('knocks when something starts waiting', () => {
    const { rerender } = renderCenter();
    world.signals = [ask('a')];
    rerender(<NotificationCenter />);
    expect(played).toEqual(['/knock.wav']);
  });

  it('knocks once for a batch, not once per item', () => {
    // Three agents that stop inside one tick are one interruption. Three
    // overlapping knocks is a sound nobody can count.
    const { rerender } = renderCenter();
    world.signals = [ask('a'), ask('b'), ask('c')];
    rerender(<NotificationCenter />);
    expect(played).toEqual(['/knock.wav']);
  });

  it('stays silent when the knock is switched off', () => {
    const { rerender } = renderCenter({
      sounds: { knock: false, allClear: true, turnEnd: false },
    });
    world.signals = [ask('a')];
    rerender(<NotificationCenter />);
    expect(played).toEqual([]);
  });
});

describe('NotificationCenter — the all-clear chime', () => {
  it('chimes when the LAST thing waiting is answered, with no popover open anywhere', () => {
    // The finding this covers. The chime used to hang off the Inbox popover's
    // drain beat, which only fires while the popover is open — wrong for a
    // sound, whose whole point is that the person is not looking. Nothing here
    // mounts the bell at all.
    const { rerender } = renderCenter();
    world.signals = [ask('a')];
    rerender(<NotificationCenter />);
    played = [];

    world.signals = [];
    rerender(<NotificationCenter />);

    expect(played).toEqual(['/settle.wav']);
  });

  it('says nothing while anything is still waiting', () => {
    const { rerender } = renderCenter();
    world.signals = [ask('a'), ask('b')];
    rerender(<NotificationCenter />);
    played = [];

    world.signals = [ask('b')];
    rerender(<NotificationCenter />);

    // A chime every time one of five is answered is the every-turn chime all
    // over again, which is the sound this release turned off.
    expect(played).toEqual([]);
  });

  it('still chimes under prefers-reduced-motion — a sound is not motion', () => {
    // The visible beat in the bell IS suppressed under reduced motion. This one
    // must not be: somebody who asked for less movement, or who cannot see the
    // check mark at all, should still hear the queue empty.
    setPrefersReducedMotion(true);
    const { rerender } = renderCenter();
    world.signals = [ask('a')];
    rerender(<NotificationCenter />);
    played = [];

    world.signals = [];
    rerender(<NotificationCenter />);

    expect(played).toEqual(['/settle.wav']);
  });

  it('stays silent when the all-clear is switched off', () => {
    const { rerender } = renderCenter({
      sounds: { knock: true, allClear: false, turnEnd: false },
    });
    world.signals = [ask('a')];
    rerender(<NotificationCenter />);
    played = [];

    world.signals = [];
    rerender(<NotificationCenter />);

    expect(played).toEqual([]);
  });

  it('says nothing about a queue that was empty when the page loaded', () => {
    renderCenter();
    expect(played).toEqual([]);
  });
});
