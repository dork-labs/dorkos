/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ServerConfig } from '@dorkos/shared/types';
import type { NotificationPrefs } from '@dorkos/shared/config-schema';
import { NOTIFICATION_PREFS_DEFAULTS } from '@dorkos/shared/config-schema';
import { createMockTransport } from '@dorkos/test-utils';

/** The blocking queue the hook reads, swapped between renders. */
const world = {
  signals: [] as { id: string; kind: string; primary: string; deepLink: string }[],
};

vi.mock('@/layers/entities/attention', () => ({
  useAttentionSignals: () => world.signals,
  useAttentionSignalsLoading: () => false,
  usePendingScheduleApprovals: () => ({ schedules: [], isLoading: false }),
}));

/** No router in a bare `renderHook`, and the hook must not need one to be tested. */
const navigate = vi.fn();

/** The global stream's subscribers, by event name — the notable leg's input. */
const streamHandlers = new Map<string, (raw: unknown) => void>();

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useSafeNavigate: () => navigate,
    // The real one needs an `EventStreamProvider`, which is a whole SSE stack to
    // stand up for a hook whose input is one parsed event.
    useEventSubscription: (event: string, handler: (raw: unknown) => void) => {
      streamHandlers.set(event, handler);
    },
  };
});

/** Deliver one `notification` SSE event, as the server would. */
function emitNotification(notification: Record<string, unknown>): void {
  streamHandlers.get('notification')?.({ type: 'notification', notification });
}

const { TransportProvider, refreshNotificationPermissionForTests } =
  await import('@/layers/shared/model');
const { configKeys, resetLegacySoundImportForTests } = await import('@/layers/entities/config');
const { useBrowserNotifications } = await import('../model/use-browser-notifications');

/** One notification the page raised. */
interface ShownNotification {
  title: string;
  body: string;
  tag: string;
  close: ReturnType<typeof vi.fn>;
  /** The object itself, for the handlers the hook hangs on it. */
  instance: FakeNotification;
}

/** Every notification the page has raised, newest last. */
let shown: ShownNotification[] = [];

class FakeNotification {
  static permission: NotificationPermission = 'granted';
  static requestPermission = vi.fn();
  onclick: (() => void) | null = null;
  onclose: (() => void) | null = null;
  close = vi.fn();
  constructor(
    public title: string,
    public options: { body?: string; tag?: string } = {}
  ) {
    shown.push({
      title,
      body: options.body ?? '',
      tag: options.tag ?? '',
      close: this.close,
      instance: this,
    });
  }
}

function hideTab(hidden: boolean): void {
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
}

function harness(prefs: Partial<NotificationPrefs> = {}) {
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
  return renderHook(() => useBrowserNotifications(), { wrapper });
}

/** An agent parked on a permission prompt, with a command in its deep link. */
function ask(id: string, who = 'Meeting Notes') {
  return {
    id,
    kind: 'permission-prompt',
    primary: who,
    // Deliberately hostile: a real prompt is about a tool call, and this is the
    // shape of the thing that must never be copied into an OS banner.
    deepLink: `/session?session=${id}&cmd=${encodeURIComponent('rm -rf /Users/dorian/Keep')}`,
  };
}

beforeEach(() => {
  shown = [];
  world.signals = [];
  navigate.mockClear();
  resetLegacySoundImportForTests();
  localStorage.clear();
  delete window.electronAPI;
  vi.stubGlobal('Notification', FakeNotification);
  FakeNotification.permission = 'granted';
  refreshNotificationPermissionForTests();
  hideTab(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useBrowserNotifications', () => {
  it('raises a banner when something starts waiting and the tab is hidden', () => {
    const { rerender } = harness();
    world.signals = [ask('a')];
    rerender();

    expect(shown).toHaveLength(1);
    expect(shown[0]!.title).toBe('Meeting Notes needs you');
  });

  it('never puts a tool input in the banner', () => {
    // An OS notification is drawn outside DorkOS and is often visible on a
    // locked screen. The cockpit's own cards are where the detail belongs.
    const { rerender } = harness();
    world.signals = [ask('a')];
    rerender();

    const banner = shown[0]!;
    expect(banner.title).not.toContain('rm -rf');
    expect(banner.body).not.toContain('rm -rf');
    expect(banner.body).toBe('Waiting for your OK before it goes on.');
  });

  it('says nothing while the person is looking at the tab', () => {
    hideTab(false);
    const { rerender } = harness();
    world.signals = [ask('a')];
    rerender();

    // A banner over the very screen somebody is reading is the interruption
    // everybody hates — the cockpit is already showing them the card.
    expect(shown).toHaveLength(0);
  });

  it('says nothing without permission', () => {
    FakeNotification.permission = 'default';
    refreshNotificationPermissionForTests();
    const { rerender } = harness();
    world.signals = [ask('a')];
    rerender();

    expect(shown).toHaveLength(0);
  });

  it('does nothing at all inside the desktop app', () => {
    // The Electron shell raises its own native notification with Allow/Deny on
    // it. A second, worse banner for the same event is the thing to avoid.
    window.electronAPI = { getServerPort: () => 4242 } as unknown as ElectronAPI;

    const { rerender } = harness();
    world.signals = [ask('a')];
    rerender();

    expect(shown).toHaveLength(0);
  });

  it('says nothing about what was already waiting when the page loaded', () => {
    world.signals = [ask('a'), ask('b')];
    harness();
    expect(shown).toHaveLength(0);
  });

  it('closes the banner when the thing it is about is answered', () => {
    const { rerender } = harness();
    world.signals = [ask('a')];
    rerender();
    expect(shown).toHaveLength(1);

    world.signals = [];
    rerender();

    // A notification that outlives the thing it is about sends somebody to an
    // empty screen.
    expect(shown[0]!.close).toHaveBeenCalled();
  });
});

describe('useBrowserNotifications — news that is not blocking anything', () => {
  /** One notable row off the stream: a turn that finished. */
  const finishedTurn = {
    id: 'n1',
    kind: 'turn.completed',
    tier: 'notable',
    subject: { type: 'session', id: 's1' },
    sessionId: 's1',
    title: 'Meeting Notes finished',
    body: 'Wrote three files.',
    createdAt: '2026-08-20T04:00:00.000Z',
  };

  it('raises a banner for a notable arrival while the tab is hidden', () => {
    harness();
    emitNotification(finishedTurn);

    expect(shown).toHaveLength(1);
    expect(shown[0]!.title).toBe('Meeting Notes finished');
  });

  it('stays quiet when the person has turned while-away news off', () => {
    harness({ notifyOnTurnCompleteWhileAway: false });
    emitNotification(finishedTurn);

    expect(shown).toHaveLength(0);
  });

  it('ignores quiet rows entirely, however the switch is set', () => {
    // `quiet` means "worth recording, not worth interrupting for" — an update
    // record, a daily report. A banner for one would make the tier meaningless.
    harness();
    emitNotification({
      ...finishedTurn,
      id: 'n2',
      kind: 'update.installed',
      tier: 'quiet',
      subject: { type: 'agent', id: 'a1' },
    });

    expect(shown).toHaveLength(0);
  });

  it('does not double-announce a blocking row that the queue already covers', () => {
    // Blocking rows reach the queue through the attention store, which is the
    // only thing that knows about capability approvals. Reading them off the
    // stream too would put two banners on screen for one Ask.
    harness();
    emitNotification({
      ...finishedTurn,
      id: 'n3',
      kind: 'ask.pending',
      tier: 'blocking',
    });

    expect(shown).toHaveLength(0);
  });

  it('focuses the window and follows the deep link when clicked', () => {
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});
    const { rerender } = harness();
    world.signals = [ask('a')];
    rerender();

    shown[0]!.instance.onclick?.();

    expect(focus).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith({ href: world.signals[0]!.deepLink });
    // …and it takes itself away, rather than sitting there pointing at
    // something the person is now looking at.
    expect(shown[0]!.close).toHaveBeenCalled();
  });
});
