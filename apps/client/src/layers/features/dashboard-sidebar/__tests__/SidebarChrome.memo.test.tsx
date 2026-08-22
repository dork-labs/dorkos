// @vitest-environment jsdom
/**
 * The seam the memoized room row rests on (`specs/sidebar-simplification` D8).
 *
 * `RoomRow` is `React.memo`, and every prop it takes comes from here. Three of
 * them are derived from preferences — the muted set, the section a room is filed
 * into, and the sections it may be moved to — and preferences are ONE object
 * that gets replaced on every write. So a memo keyed on the whole of it hands
 * sixty rows a fresh `moveTargetGroups` array when the operator folds a section,
 * and the row memo can never hold.
 *
 * **This is the assertion `RoomRow.render-count.test.tsx` cannot make.** That
 * file builds its own panel, so it pins the memo but not the keys the real
 * provider uses. This mounts the real `SidebarChrome` and reads its context.
 *
 * **What fails it.** Re-key any of the three memos in `SidebarChrome` on `prefs`
 * instead of on the list it reads, and the first case reds — the write it makes
 * touches none of the three.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { SIDEBAR_PREFS_DEFAULTS } from '@dorkos/shared/config-schema';
import { TooltipProvider } from '@/layers/shared/ui';
import { TransportProvider } from '@/layers/shared/model';
import {
  configKeys,
  muteItem,
  setSectionCollapsed,
  useSidebarPrefs,
  useUpdateSidebarPrefs,
} from '@/layers/entities/config';
import { SidebarChrome, useSidebarChrome } from '../ui/SidebarChrome';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { mockNavigate } = vi.hoisted(() => ({ mockNavigate: vi.fn() }));
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => mockNavigate,
  useRouter: () => ({ state: { location: { href: '/' } }, navigate: mockNavigate }),
}));

// The profile opener reads route state this file does not mount. Where it sends
// you has its own suite (`ProfileDock.test.tsx`); nothing here reads it.
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useProfileDeepLink: () => ({ isOpen: false, memberId: null, open: vi.fn(), close: vi.fn() }),
  };
});

/** One reading of everything this test watches for identity. */
interface Snapshot {
  /** The preferences object the provider derived from — the control. */
  prefs: unknown;
  /** `chrome.mutedRoomIds`. */
  muted: unknown;
  /** `chrome.roomSectionIds`. */
  sections: unknown;
  /** `chrome.moveTargetGroups`. */
  targets: unknown;
}

const readings: Snapshot[] = [];

/**
 * Records the three derived identities and the preferences they came from.
 *
 * `prefs` is the control: without it, "the identities held" is also true when
 * the write never reached the provider, and the test would pass with the memo
 * keys reverted.
 */
function Probe() {
  const chrome = useSidebarChrome();
  const prefs = useSidebarPrefs();
  readings.push({
    prefs,
    muted: chrome.mutedRoomIds,
    sections: chrome.roomSectionIds,
    targets: chrome.moveTargetGroups,
  });
  return null;
}

/** The two writes this test makes, as buttons. */
function Writers() {
  const { update } = useUpdateSidebarPrefs();
  return (
    <>
      <button
        type="button"
        onClick={() => update((prev) => setSectionCollapsed(prev, 'channels', true))}
      >
        fold channels
      </button>
      <button
        type="button"
        onClick={() => update((prev) => muteItem(prev, { kind: 'room', roomId: 'r1' }))}
      >
        mute r1
      </button>
    </>
  );
}

function renderChrome() {
  const transport = createMockTransport();
  transport.getConfig = vi.fn().mockResolvedValue({ ui: { sidebar: SIDEBAR_PREFS_DEFAULTS } });
  // Never settles, so the optimistic write stands: a settle would invalidate the
  // config query and the refetch would put the defaults back.
  transport.updateConfig = vi.fn().mockReturnValue(new Promise<void>(() => {}));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClient.setQueryData(configKeys.current(), { ui: { sidebar: SIDEBAR_PREFS_DEFAULTS } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <TooltipProvider>{children}</TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
  return render(
    <SidebarChrome activeTarget={null}>
      <Writers />
      <Probe />
    </SidebarChrome>,
    { wrapper }
  );
}

/** The most recent reading. */
function latest(): Snapshot {
  const last = readings.at(-1);
  if (last === undefined) throw new Error('the probe never rendered');
  return last;
}

/** Click, then wait for a reading whose preferences are a different object. */
async function write(label: string): Promise<Snapshot> {
  const before = latest();
  fireEvent.click(screen.getByText(label));
  await waitFor(() => expect(latest().prefs).not.toBe(before.prefs));
  return before;
}

describe('SidebarChrome — what a preferences write may move', () => {
  beforeEach(() => {
    readings.length = 0;
  });
  afterEach(() => cleanup());

  it('leaves the three row-facing derivations alone when the write touched none of them', async () => {
    renderChrome();
    await waitFor(() => expect(readings.length).toBeGreaterThan(0));

    // Folding a section writes `ui.sidebar.sections` and nothing else.
    const before = await write('fold channels');

    expect(latest().muted).toBe(before.muted);
    expect(latest().sections).toBe(before.sections);
    expect(latest().targets).toBe(before.targets);
  });

  it('DOES move the muted set when the write is about mute', async () => {
    // The other half of the guard, and the half that proves the first is not
    // simply reporting three frozen objects.
    renderChrome();
    await waitFor(() => expect(readings.length).toBeGreaterThan(0));

    const before = await write('mute r1');

    expect(latest().muted).not.toBe(before.muted);
    expect([...(latest().muted as ReadonlySet<string>)]).toEqual(['r1']);
    // …and the two that are about sections still did not move.
    expect(latest().sections).toBe(before.sections);
    expect(latest().targets).toBe(before.targets);
  });
});
