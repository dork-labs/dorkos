// @vitest-environment jsdom
/**
 * The update pill (BC-44), on its new surface.
 *
 * These cases came from `SidebarFooterStrip.test.tsx` with the pill itself: it
 * used to be a private component stacked on top of the footer row, and it is a
 * candidate in the sidebar's bottom slot now (spec `sidebar-simplification`
 * D4). They are unchanged in substance — same states, same assertions — but
 * they drive the pair the split created: `useUpdateReady` decides whether an
 * update is waiting (the slot needs that BEFORE it draws anything) and
 * `UpdatePill` draws whatever it decided.
 *
 * Mounting them together, through a host that mirrors what the slot does, keeps
 * the tests about the behaviour a person sees rather than about either half.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { buildSidebarModel } from '../model/build-sidebar-model';
import { busyFixture } from '../model/fixtures';

// ── Server config: the version, the published latest, and the dismissals ──
let mockConfigData: Record<string, unknown> | undefined;
const mockUpdateConfigMutate = vi.fn();
vi.mock('@/layers/entities/config', () => ({
  useConfig: () => ({ data: mockConfigData }),
  useUpdateConfig: () => ({ mutate: mockUpdateConfigMutate, isPending: false }),
}));

// ── The desktop native updater. Off by default: these run in a browser ──
let mockDesktop: { isDesktop: boolean; status: { state: string; version?: string } | null } = {
  isDesktop: false,
  status: null,
};
const mockRestart = vi.fn();
vi.mock('@/layers/features/session-list', () => ({
  useDesktopUpdater: () => ({ ...mockDesktop, restart: mockRestart }),
}));

import { useUpdateReady } from '../ui/bottom-slot/use-update-ready';
import { UpdatePill } from '../ui/bottom-slot/UpdatePill';

/** The pill mounted exactly as the bottom slot mounts it. */
function PillHost() {
  const update = useUpdateReady();
  if (update.kind === 'none') return null;
  return <UpdatePill update={update} />;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConfigData = { version: '1.2.3', latestVersion: null, isDevMode: false };
  mockDesktop = { isDesktop: false, status: null };
});

afterEach(() => cleanup());

describe('UpdatePill', () => {
  it('renders zero DOM when no update is ready', () => {
    const { container } = render(<PillHost />);

    expect(screen.queryByText(/Update ready/)).toBeNull();
    // Nothing is reserved for it — the slot can offer its turn to another card.
    expect(container.innerHTML).toBe('');
  });

  it('announces a newer published version and hands over the command', () => {
    mockConfigData = {
      version: '1.2.3',
      latestVersion: '1.4.0',
      isDevMode: false,
      dismissedUpgradeVersions: [],
    };
    render(<PillHost />);

    expect(screen.getByText('Update ready — v1.4.0')).toBeInTheDocument();
  });

  it('stays quiet about a version the operator already dismissed', () => {
    mockConfigData = {
      version: '1.2.3',
      latestVersion: '1.4.0',
      isDevMode: false,
      dismissedUpgradeVersions: ['1.4.0'],
    };
    render(<PillHost />);

    expect(screen.queryByText(/Update ready/)).toBeNull();
  });

  it('says it copied the command only when the clipboard took it (DOR-1391)', async () => {
    // It used to say "Command copied" without awaiting the write at all, so a
    // browser that refused the clipboard still reported success and the person
    // pasted whatever was there before. The shared `useCopyFeedback` awaits it.
    mockConfigData = {
      version: '1.2.3',
      latestVersion: '1.4.0',
      isDevMode: false,
      dismissedUpgradeVersions: [],
    };
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<PillHost />);

    fireEvent.click(screen.getByText('Update ready — v1.4.0'));

    expect(writeText).toHaveBeenCalledWith('npm update -g dorkos');
    await waitFor(() => expect(screen.getByText('Command copied')).toBeInTheDocument());
  });

  it('says so when the clipboard refuses, rather than claiming success', async () => {
    mockConfigData = {
      version: '1.2.3',
      latestVersion: '1.4.0',
      isDevMode: false,
      dismissedUpgradeVersions: [],
    };
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    render(<PillHost />);

    fireEvent.click(screen.getByText('Update ready — v1.4.0'));

    await waitFor(() => expect(screen.getByText("Couldn't copy")).toBeInTheDocument());
    expect(screen.queryByText('Command copied')).toBeNull();
  });

  it('remembers a dismissal', () => {
    mockConfigData = {
      version: '1.2.3',
      latestVersion: '1.4.0',
      isDevMode: false,
      dismissedUpgradeVersions: ['1.0.0'],
    };
    render(<PillHost />);

    fireEvent.click(screen.getByLabelText('Dismiss update notification'));
    expect(mockUpdateConfigMutate).toHaveBeenCalledWith({
      ui: { dismissedUpgradeVersions: ['1.0.0', '1.4.0'] },
    });
  });

  it('offers a restart on the desktop app, and only once the download has landed', () => {
    mockDesktop = { isDesktop: true, status: { state: 'downloading' } };
    const { unmount } = render(<PillHost />);
    expect(screen.queryByText(/Update ready/)).toBeNull();
    unmount();

    mockDesktop = { isDesktop: true, status: { state: 'downloaded', version: '2.0.0' } };
    render(<PillHost />);
    fireEvent.click(screen.getByText('Update ready — Restart'));
    expect(mockRestart).toHaveBeenCalled();
  });

  it('never puts an update in Heads up', () => {
    mockConfigData = {
      version: '1.2.3',
      latestVersion: '1.4.0',
      isDevMode: false,
      dismissedUpgradeVersions: [],
    };
    render(<PillHost />);

    // Observable: the pill IS on screen for this state.
    expect(screen.getByText('Update ready — v1.4.0')).toBeInTheDocument();

    // And the zone model built from the same moment — a fleet that genuinely
    // has things waiting, so the Heads up zone is populated and the query below
    // can fail — carries nothing about it.
    const model = buildSidebarModel(busyFixture);
    const now = model.zones.find((zone) => zone.id === 'now');
    const nowRows = now?.sections.flatMap((section) => section.rows) ?? [];
    expect(nowRows.length).toBeGreaterThan(0);
    const nowText = nowRows.map((r) => `${r.primary} ${r.secondary ?? ''} ${r.reason}`);
    expect(nowText).not.toContain('Update ready — v1.4.0');
    expect(nowText.filter((text) => /update|version|restart/i.test(text))).toEqual([]);
    // Every Heads up row is an agent that needs you or a rollup of them, and
    // nothing else can be (BC-5).
    expect(nowRows.every((r) => /^(now:|rollup:)/.test(r.reason))).toBe(true);
  });
});
