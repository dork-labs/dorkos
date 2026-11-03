/* @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { YourBrowserPicker } from '../ui/YourBrowserPicker';

afterEach(cleanup);

const result = {
  supported: true,
  unreadable: [],
  profiles: [
    {
      browser: 'chrome',
      directory: 'Default',
      displayName: '<img src=x>',
      email: 'work@example.test',
    },
    {
      browser: 'edge',
      directory: 'Profile 1',
      displayName: 'Personal',
      email: 'personal@example.test',
    },
  ],
};

function setup(scan = vi.fn().mockResolvedValue(result)) {
  const queryClient = new QueryClient();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={createMockTransport({ scanYourBrowsers: scan })}>
        <YourBrowserPicker />
      </TransportProvider>
    </QueryClientProvider>
  );
  return { ...view, scan, queryClient };
}

describe('Your browser picker', () => {
  it('scans only on tap, renders untrusted text, and drops every email on pick', async () => {
    const t = setup();
    expect(t.scan).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Find my browsers' }));
    await screen.findByText('work@example.test');
    expect(screen.getByText('Chrome · <img src=x>')).toBeTruthy();
    expect(t.container.querySelector('img')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Use Chrome · <img src=x>' }));
    expect(screen.queryByText('work@example.test')).toBeNull();
    expect(screen.queryByText('personal@example.test')).toBeNull();
    expect(screen.getByText('Selected · Off')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Chrome · <img src=x>' })).toBe(
      document.activeElement
    );
    expect(t.queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(t.queryClient.getMutationCache().getAll()).toHaveLength(0);
    expect(t.scan).toHaveBeenCalledOnce();
  });

  it('drops picker metadata on close and starts fresh after remount', async () => {
    const t = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Find my browsers' }));
    await screen.findByText('work@example.test');
    fireEvent.click(screen.getByRole('button', { name: 'Close list' }));
    expect(screen.queryByText('work@example.test')).toBeNull();
    t.unmount();
    const next = setup();
    expect(next.scan).not.toHaveBeenCalled();
    expect(screen.queryByText('work@example.test')).toBeNull();
  });

  it('keeps errors plain and retries only on another tap', async () => {
    const scan = vi
      .fn()
      .mockRejectedValueOnce(new Error('/private/home/Local State'))
      .mockResolvedValueOnce({ supported: true, profiles: [], unreadable: [] });
    setup(scan);
    fireEvent.click(screen.getByRole('button', { name: 'Find my browsers' }));
    await screen.findByRole('alert');
    expect(screen.queryByText(/private\/home/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Find my browsers' }));
    await screen.findByText(/No profiles found/);
    await waitFor(() => expect(scan).toHaveBeenCalledTimes(2));
  });

  it('does not revive metadata when a scan finishes after leaving the picker', async () => {
    let finish!: (value: typeof result) => void;
    const pending = new Promise<typeof result>((resolve) => {
      finish = resolve;
    });
    const first = setup(vi.fn().mockReturnValue(pending));
    fireEvent.click(screen.getByRole('button', { name: 'Find my browsers' }));
    first.unmount();
    const next = setup();
    await act(async () => {
      finish(result);
      await pending;
    });
    expect(screen.queryByText('work@example.test')).toBeNull();
    expect(next.scan).not.toHaveBeenCalled();
  });
});
