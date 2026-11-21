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
let mockDesktop: {
  isDesktop: boolean;
  status: {
    state: string;
    version?: string;
    attempts?: number;
    percent?: number;
    message?: string;
  } | null;
  retryingVersion?: string | null;
} = {
  isDesktop: false,
  status: null,
};
const mockRestart = vi.fn();
const mockRetry = vi.fn();
vi.mock('@/layers/features/session-list', () => ({
  useDesktopUpdater: () => ({
    retryingVersion: null,
    ...mockDesktop,
    restart: mockRestart,
    retry: mockRetry,
  }),
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

afterEach(() => {
  cleanup();
  delete window.electronAPI;
});

/**
 * Put the app inside the desktop shell on `platform`, and hand back the spy the
 * "Download fresh copy" button ends up calling.
 *
 * The real seam: `openExternalLink` prefers the preload bridge over
 * `window.open`, because at the app's own origin the shell would turn
 * `window.open` into a second cockpit window rather than leaving for a browser.
 */
function stubDesktopShell(platform: NodeJS.Platform): ReturnType<typeof vi.fn> {
  const openExternal = vi.fn().mockResolvedValue(undefined);
  window.electronAPI = {
    platform,
    openExternal,
    getServerPort: () => 4242,
  } as unknown as ElectronAPI;
  return openExternal;
}

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

    expect(screen.getByText('Update ready: v1.4.0')).toBeInTheDocument();
  });

  it('offers no update command on a hub, which is updated for its owner', () => {
    mockConfigData = {
      version: '1.2.3',
      latestVersion: '1.4.0',
      isDevMode: false,
      dismissedUpgradeVersions: [],
      serverRole: 'hub',
    };
    const { container } = render(<PillHost />);

    expect(container).toBeEmptyDOMElement();
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

    fireEvent.click(screen.getByText('Update ready: v1.4.0'));

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

    fireEvent.click(screen.getByText('Update ready: v1.4.0'));

    await waitFor(() => expect(screen.getByText('Couldn’t copy')).toBeInTheDocument());
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
    mockDesktop = {
      isDesktop: true,
      status: { state: 'downloading', percent: 50, version: '2.0.0' },
    };
    const { unmount } = render(<PillHost />);
    expect(screen.queryByText('Restart to update')).toBeNull();
    unmount();

    mockDesktop = { isDesktop: true, status: { state: 'downloaded', version: '2.0.0' } };
    render(<PillHost />);
    fireEvent.click(screen.getByText('Restart to update'));
    expect(mockRestart).toHaveBeenCalled();
  });

  describe('while a desktop update downloads (DOR-4846)', () => {
    it('names the real version as soon as the update is found, before any progress', () => {
      mockDesktop = { isDesktop: true, status: { state: 'available', version: '0.139.0' } };
      render(<PillHost />);

      expect(screen.getByText('Downloading 0.139.0…')).toBeInTheDocument();
      // No numbers yet, so no bar pretending to know.
      expect(screen.queryByRole('progressbar')).toBeNull();
      expect(screen.queryByText('Restart to update')).toBeNull();
    });

    it('shows how far the download has got', () => {
      mockDesktop = {
        isDesktop: true,
        status: { state: 'downloading', percent: 42.7, version: '0.139.0' },
      };
      render(<PillHost />);

      expect(screen.getByText('Downloading 0.139.0…')).toBeInTheDocument();
      expect(screen.getByText('42%')).toBeInTheDocument();
      const bar = screen.getByRole('progressbar', { name: 'Downloading 0.139.0…' });
      expect(bar).toHaveAttribute('aria-valuenow', '42.7');
    });

    it('still says it is downloading when an older shell sends no version', () => {
      mockDesktop = { isDesktop: true, status: { state: 'downloading', percent: 5 } };
      render(<PillHost />);

      expect(screen.getByText('Downloading the update…')).toBeInTheDocument();
    });

    it('says the download failed, plainly, and retries on the button', () => {
      mockDesktop = {
        isDesktop: true,
        status: { state: 'error', message: 'net::ERR_CONNECTION_RESET', version: '0.139.0' },
      };
      render(<PillHost />);

      expect(
        screen.getByText('Couldn’t download 0.139.0. Check your connection and try again.')
      ).toBeInTheDocument();
      // The machine's own words never reach the card.
      expect(screen.queryByText(/ERR_CONNECTION_RESET/)).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Try downloading 0.139.0 again' }));
      expect(mockRetry).toHaveBeenCalledTimes(1);
    });

    it('goes back to downloading the moment retry is pressed', () => {
      mockDesktop = {
        isDesktop: true,
        status: { state: 'error', message: 'net::ERR_CONNECTION_RESET', version: '0.139.0' },
        retryingVersion: '0.139.0',
      };
      render(<PillHost />);

      expect(screen.getByText('Downloading 0.139.0…')).toBeInTheDocument();
      expect(screen.queryByText('Try again')).toBeNull();
    });

    it('stays quiet when a background check fails with nothing downloading', () => {
      mockDesktop = {
        isDesktop: true,
        status: { state: 'error', message: 'getaddrinfo ENOTFOUND' },
      };
      const { container } = render(<PillHost />);

      expect(container).toBeEmptyDOMElement();
    });

    it('lets a failed install outrank a retry in flight', () => {
      stubDesktopShell('darwin');
      mockDesktop = {
        isDesktop: true,
        status: { state: 'install-failed', version: '0.63.0', attempts: 1 },
        retryingVersion: '0.63.0',
      };
      render(<PillHost />);

      expect(screen.getByText('Download fresh copy')).toBeInTheDocument();
      expect(screen.queryByText(/Downloading/)).toBeNull();
    });
  });

  it('stops offering a restart once the install has failed, and offers a fresh copy instead', () => {
    // Restarting is precisely the thing that did not work — this is the state
    // where the card used to keep saying "Restart to update" forever.
    stubDesktopShell('darwin');
    mockDesktop = {
      isDesktop: true,
      status: { state: 'install-failed', version: '0.63.0', attempts: 1 },
    };
    render(<PillHost />);

    expect(
      screen.getByText(
        'The update couldn’t install itself. Download a fresh copy. Your settings and agents stay put.'
      )
    ).toBeInTheDocument();
    expect(screen.getByText('Download fresh copy')).toBeInTheDocument();
    expect(screen.queryByText('Restart to update')).toBeNull();
  });

  it('never re-offers a plain restart past two failed attempts', () => {
    stubDesktopShell('darwin');
    mockDesktop = {
      isDesktop: true,
      status: { state: 'install-failed', version: '0.63.0', attempts: 2 },
    };
    render(<PillHost />);

    expect(screen.queryByText('Restart to update')).toBeNull();
    expect(screen.queryByLabelText('Restart to install the update')).toBeNull();
    fireEvent.click(screen.getByText('Download fresh copy'));
    expect(mockRestart).not.toHaveBeenCalled();
  });

  it('sends a Mac to the Mac download', () => {
    const openExternal = stubDesktopShell('darwin');
    mockDesktop = {
      isDesktop: true,
      status: { state: 'install-failed', version: '0.63.0', attempts: 2 },
    };
    render(<PillHost />);

    fireEvent.click(screen.getByText('Download fresh copy'));

    expect(openExternal).toHaveBeenCalledWith('https://dorkos.ai/download/mac');
  });

  it('sends Windows to the Windows download', () => {
    // Handing someone the wrong installer is worse than handing them nothing.
    const openExternal = stubDesktopShell('win32');
    mockDesktop = {
      isDesktop: true,
      status: { state: 'install-failed', version: '0.63.0', attempts: 2 },
    };
    render(<PillHost />);

    fireEvent.click(screen.getByText('Download fresh copy'));

    expect(openExternal).toHaveBeenCalledWith('https://dorkos.ai/download/windows');
  });

  it('falls back to the front door on a platform with no installer route', () => {
    // No Linux desktop build exists, so nothing reaches this today — but a Mac
    // disk image would be the wrong answer if one ever did.
    const openExternal = stubDesktopShell('linux');
    mockDesktop = {
      isDesktop: true,
      status: { state: 'install-failed', version: '0.63.0', attempts: 2 },
    };
    render(<PillHost />);

    fireEvent.click(screen.getByText('Download fresh copy'));

    // Normalized by the link seam, which hands the browser a parsed URL.
    expect(openExternal).toHaveBeenCalledWith('https://dorkos.ai/');
  });

  it('never puts an update in the list', () => {
    mockConfigData = {
      version: '1.2.3',
      latestVersion: '1.4.0',
      isDevMode: false,
      dismissedUpgradeVersions: [],
    };
    render(<PillHost />);

    // Observable: the pill IS on screen for this state.
    expect(screen.getByText('Update ready: v1.4.0')).toBeInTheDocument();

    // And the list built from the same moment carries nothing about it: an
    // update is a card in the bottom slot, never a row.
    const rows = buildSidebarModel(busyFixture).sections.flatMap((section) => section.rows);
    expect(rows.length).toBeGreaterThan(0);
    const text = rows.map((r) => `${r.primary} ${r.reason}`);
    expect(text.filter((line) => /update|version|restart/i.test(line))).toEqual([]);
  });
});
