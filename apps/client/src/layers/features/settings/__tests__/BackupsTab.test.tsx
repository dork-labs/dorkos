// @vitest-environment jsdom
/**
 * Settings → Backups (DOR-4253): the total and every copy, Move and Remove
 * only on older copies, a confirm before Remove, and the server's own sentence
 * when it refuses. The real folder picker; only the transport is a fake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { BackupCopiesResponse } from '@dorkos/shared/transport-backups';
import { createMockTransport } from '@dorkos/test-utils/mock-factories';
import { TransportProvider } from '@/layers/shared/model';
import { STORAGE_KEYS } from '@/layers/shared/lib';
import { BackupsTab } from '../ui/backups/BackupsTab';

const LIST: BackupCopiesResponse = {
  folder: '/home/demo/.dork/backups',
  totalBytes: 3 * 1024 * 1024,
  copies: [
    {
      name: 'dork-auto-20261119-daily.db',
      kind: 'daily',
      managed: true,
      sizeBytes: 1024 * 1024,
      createdAt: '2026-11-19T00:00:00.000Z',
      busy: false,
    },
    {
      name: 'dork-20260901-daily.db',
      kind: 'daily',
      managed: false,
      sizeBytes: 2 * 1024 * 1024,
      createdAt: '2026-09-01T00:00:00.000Z',
      busy: false,
    },
  ],
};

let transport: Transport;

function renderTab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <BackupsTab />
      </TransportProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  transport = createMockTransport({
    listBackups: vi.fn().mockResolvedValue(LIST),
    browseDirectory: vi
      .fn()
      .mockResolvedValue({ path: '/home/demo/archive', entries: [], parent: '/home/demo' }),
  });
  // A remembered "Recent" view must not decide where a backup goes.
  localStorage.setItem(
    STORAGE_KEYS.PICKER_VIEW,
    JSON.stringify({ view: 'recent', timestamp: new Date().toISOString() })
  );
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('BackupsTab', () => {
  it('shows the total and every copy, with who keeps it', async () => {
    renderTab();
    expect(await screen.findByTestId('backups-total')).toHaveTextContent(
      'Backups use 3.0 MB on this computer.'
    );
    const rows = within(screen.getByRole('list', { name: 'Backups' })).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Kept by DorkOS');
    expect(rows[1]).toHaveTextContent('Older copy');
    expect(rows[1]).toHaveTextContent('2.0 MB');
  });

  it('offers Move and Remove only on an older copy', async () => {
    renderTab();
    await screen.findByTestId('backups-total');
    expect(screen.getByRole('button', { name: 'Remove dork-20260901-daily.db' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Move dork-20260901-daily.db' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /dork-auto-20261119-daily\.db/ })).toBeNull();
  });

  it('removes only after the confirm', async () => {
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove dork-20260901-daily.db' }));
    expect(transport.removeBackup).not.toHaveBeenCalled();
    expect(await screen.findByText('Remove this backup?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove backup' }));
    await waitFor(() =>
      expect(transport.removeBackup).toHaveBeenCalledWith('dork-20260901-daily.db')
    );
    await waitFor(() => expect(transport.listBackups).toHaveBeenCalledTimes(2));
  });

  it('cancelling the confirm removes nothing', async () => {
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove dork-20260901-daily.db' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByText('Remove this backup?')).toBeNull());
    expect(transport.removeBackup).not.toHaveBeenCalled();
  });

  it('moves into the folder the person picks', async () => {
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Move dork-20260901-daily.db' }));
    expect(await screen.findByText('Move backup to…')).toBeInTheDocument();
    expect(
      screen.getByText('Older copies can include past chats. A folder that syncs will upload them.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Recent folders' })).toBeNull();
    const use = await screen.findByRole('button', { name: 'Use this folder' });
    await waitFor(() => expect(use).toBeEnabled());
    fireEvent.click(use);
    await waitFor(() =>
      expect(transport.moveBackup).toHaveBeenCalledWith(
        'dork-20260901-daily.db',
        '/home/demo/archive'
      )
    );
  });

  it('moves to a typed folder path, like an external drive', async () => {
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Move dork-20260901-daily.db' }));
    const field = await screen.findByLabelText('Or type a folder path');
    expect(field).toHaveAttribute('placeholder', '/Volumes/…');
    fireEvent.change(field, { target: { value: '  /Volumes/Backup Drive/dorkos  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move here' }));
    await waitFor(() =>
      expect(transport.moveBackup).toHaveBeenCalledWith(
        'dork-20260901-daily.db',
        '/Volumes/Backup Drive/dorkos'
      )
    );
    await waitFor(() => expect(screen.queryByLabelText('Or type a folder path')).toBeNull());
  });

  it('shows the server’s refusal for a typed path in place, and keeps the dialog open', async () => {
    transport.moveBackup = vi
      .fn()
      .mockRejectedValue(new Error('Pick a folder DorkOS can reach, or one on an external drive.'));
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Move dork-20260901-daily.db' }));
    fireEvent.change(await screen.findByLabelText('Or type a folder path'), {
      target: { value: '/etc' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Move here' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Pick a folder DorkOS can reach, or one on an external drive.'
    );
    expect(screen.getByLabelText('Or type a folder path')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Move backup to…')).toBeInTheDocument();
  });

  it('says which row is moving while a Move runs', async () => {
    let finish: (value: { destinationPath: string }) => void = () => {};
    transport.moveBackup = vi.fn(
      () => new Promise<{ destinationPath: string }>((resolve) => (finish = resolve))
    );
    renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Move dork-20260901-daily.db' }));
    const use = await screen.findByRole('button', { name: 'Use this folder' });
    await waitFor(() => expect(use).toBeEnabled());
    fireEvent.click(use);
    const rows = within(screen.getByRole('list', { name: 'Backups' })).getAllByRole('listitem');
    await waitFor(() => expect(rows[1]).toHaveTextContent('Moving…'));
    expect(rows[0]).not.toHaveTextContent('Moving…');
    finish({ destinationPath: '/home/demo/archive/dork-20260901-daily.db' });
  });

  it('a busy copy waits', async () => {
    transport.listBackups = vi.fn().mockResolvedValue({
      ...LIST,
      copies: [{ ...LIST.copies[1]!, busy: true }],
    });
    renderTab();
    expect(
      await screen.findByRole('button', { name: 'Remove dork-20260901-daily.db' })
    ).toBeDisabled();
    expect(screen.getByText(/In use/)).toBeInTheDocument();
  });

  it('says so when there are no backups', async () => {
    transport.listBackups = vi
      .fn()
      .mockResolvedValue({ folder: LIST.folder, copies: [], totalBytes: 0 });
    renderTab();
    expect(await screen.findByTestId('backups-total')).toHaveTextContent(
      'No backups on this computer yet.'
    );
    expect(screen.queryByRole('list', { name: 'Backups' })).toBeNull();
  });

  it('shows the server’s sentence when the list is refused, with a retry', async () => {
    transport.listBackups = vi
      .fn()
      .mockRejectedValue(new Error('Only you can do this, from DorkOS.'));
    renderTab();
    expect(await screen.findByText('Only you can do this, from DorkOS.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
