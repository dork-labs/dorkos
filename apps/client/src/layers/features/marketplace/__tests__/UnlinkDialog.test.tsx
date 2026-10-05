/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { UnlinkDialog, type UnlinkTarget } from '../ui/UnlinkDialog';

const toastSuccess = vi.fn();
vi.mock('sonner', () => ({
  toast: { success: (...args: unknown[]) => toastSuccess(...args), error: vi.fn() },
}));

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

let transport: Transport;
const onClose = vi.fn();
const onUnlinked = vi.fn();

function renderDialog(target: UnlinkTarget) {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  return render(<UnlinkDialog target={target} onClose={onClose} onUnlinked={onUnlinked} />, {
    wrapper,
  });
}

const GLOBAL: UnlinkTarget = { name: 'flow', scope: 'global', parked: false };

beforeEach(() => {
  transport = createMockTransport();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('UnlinkDialog', () => {
  it('says the installed copy comes back when one is set aside', () => {
    // Purpose: the body promises only what unlink does for a parked link.
    renderDialog({ ...GLOBAL, parked: true });
    expect(screen.getByText('Unlink Flow?')).toBeVisible();
    expect(screen.getByText('Your installed copy comes back.')).toBeVisible();
  });

  it('says the package is removed and the folder untouched when nothing is set aside', () => {
    // Purpose: no parked copy means removal, and the folder is never touched.
    renderDialog(GLOBAL);
    expect(screen.getByText('Flow is removed. Your folder is not touched.')).toBeVisible();
  });

  it('unlinks the right dev link and says the installed copy runs again', async () => {
    // Purpose: restored "installed" is the only outcome that says the copy runs.
    vi.mocked(transport.unlinkDevLink).mockResolvedValue({ restored: 'installed' });
    const user = userEvent.setup();
    renderDialog({ name: 'flow', scope: 'project', projectPath: '/work/app', parked: true });

    await user.click(screen.getByRole('button', { name: 'Unlink' }));

    await waitFor(() =>
      expect(transport.unlinkDevLink).toHaveBeenCalledWith('flow', {
        scope: 'project',
        projectPath: '/work/app',
      })
    );
    expect(toastSuccess).toHaveBeenCalledWith('Flow runs from the installed copy.', undefined);
    expect(onUnlinked).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('says "removed" for a plain removal', async () => {
    // Purpose: the toast matches restored "removed" with nothing left behind.
    vi.mocked(transport.unlinkDevLink).mockResolvedValue({ restored: 'removed' });
    const user = userEvent.setup();
    renderDialog(GLOBAL);
    await user.click(screen.getByRole('button', { name: 'Unlink' }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Flow removed.', undefined));
  });

  it('never claims the installed copy came back when it was left set aside', async () => {
    // Purpose: parkedLeftAt means the copy is still set aside; say where.
    vi.mocked(transport.unlinkDevLink).mockResolvedValue({
      restored: 'removed',
      parkedLeftAt: '/home/me/.dork/plugins/flow.dorkos-devlink-parked',
    });
    const user = userEvent.setup();
    renderDialog({ ...GLOBAL, parked: true });
    await user.click(screen.getByRole('button', { name: 'Unlink' }));
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith(
        'Flow unlinked. Its installed copy couldn’t come back.',
        {
          description: 'It’s still set aside at /home/me/.dork/plugins/flow.dorkos-devlink-parked.',
        }
      )
    );
  });

  it('says what was left in place when something else had taken the link’s spot', async () => {
    // Purpose: leftInPlace is reported, not passed off as a removal.
    vi.mocked(transport.unlinkDevLink).mockResolvedValue({
      restored: 'removed',
      leftInPlace: true,
    });
    const user = userEvent.setup();
    renderDialog(GLOBAL);
    await user.click(screen.getByRole('button', { name: 'Unlink' }));
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith('Flow unlinked.', {
        description: 'Something else was in its place. It was left as it is.',
      })
    );
  });

  it('keeps the left-in-place line when unlinking to install the published version', async () => {
    // Purpose: the install that follows lands in that slot, so say what is there.
    vi.mocked(transport.unlinkDevLink).mockResolvedValue({
      restored: 'removed',
      leftInPlace: true,
    });
    const user = userEvent.setup();
    renderDialog({ ...GLOBAL, then: 'install' });
    await user.click(screen.getByRole('button', { name: 'Unlink and install' }));
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith('Flow unlinked.', {
        description: 'Something else was in its place. It was left as it is.',
      })
    );
  });

  it('asks to unlink first when it is the start of installing the published version', async () => {
    // Purpose: "Install published version" names both steps before the click.
    vi.mocked(transport.unlinkDevLink).mockResolvedValue({ restored: 'removed' });
    const user = userEvent.setup();
    renderDialog({ ...GLOBAL, then: 'install' });
    expect(screen.getByText('Install the published Flow?')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Unlink and install' }));
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith('Flow unlinked.', {
        description: 'It’s not installed until you finish the install.',
      })
    );
  });
});
