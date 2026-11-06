// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserProfiles } from '../ui/BrowserProfiles';

const transport = vi.hoisted(() => ({
  listLocalBrowserProfiles: vi.fn(),
  forgetLocalBrowserSignIns: vi.fn(),
  deleteLocalBrowserProfile: vi.fn(),
}));
vi.mock('@/layers/shared/model', async (original) => ({
  ...(await original<typeof import('@/layers/shared/model')>()),
  useTransport: () => transport,
}));
const profile = {
  id: '11111111-1111-4111-8111-111111111111',
  label: 'Example work',
  agentIds: ['example-agent'],
  createdAt: '2026-11-04T00:00:00Z',
};
function mount(enabled = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={client}>
      <BrowserProfiles enabled={enabled} />
    </QueryClientProvider>
  );
  return client;
}
beforeEach(() => {
  vi.resetAllMocks();
  transport.listLocalBrowserProfiles.mockResolvedValue({ profiles: [profile] });
  transport.forgetLocalBrowserSignIns.mockResolvedValue({ success: true });
  transport.deleteLocalBrowserProfile.mockResolvedValue({ success: true });
});
describe('Browser profile removal', () => {
  it('does not read or expose controls before browser authority is known', () => {
    mount(false);
    expect(transport.listLocalBrowserProfiles).not.toHaveBeenCalled();
    expect(screen.queryByRole('button')).toBeNull();
  });
  it('focuses Cancel and cancelling forget performs no mutation', async () => {
    mount();
    const row = await screen.findByRole('region', { name: 'Example work' });
    const trigger = within(row).getByRole('button', { name: 'Forget sign-ins' });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Forget every sign-in in Example work?',
    });
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    await waitFor(() => expect(cancel).toHaveFocus());
    expect(
      within(dialog).getByText('This removes every site’s sign-in in this profile.')
    ).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Forget sign-ins' })).toHaveAttribute(
      'data-variant',
      'destructive'
    );
    fireEvent.click(cancel);
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(transport.forgetLocalBrowserSignIns).not.toHaveBeenCalled();
  });
  it('forgets only the selected profile and refreshes state after success', async () => {
    const client = mount();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    fireEvent.click(
      within(await screen.findByRole('region', { name: 'Default profile' })).getByRole('button', {
        name: 'Forget sign-ins',
      })
    );
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Forget sign-ins',
      })
    );
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(transport.forgetLocalBrowserSignIns).toHaveBeenCalledExactlyOnceWith(null);
    expect(transport.deleteLocalBrowserProfile).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['local-browser', 'profiles'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['local-browser', 'state'] });
  });
  it('deletes the named profile with precise copy, removing its row after refresh', async () => {
    mount();
    const row = await screen.findByRole('region', { name: 'Example work' });
    expect(
      within(screen.getByRole('region', { name: 'Default profile' })).queryByRole('button', {
        name: 'Delete profile',
      })
    ).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: 'Delete profile' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete Example work?' });
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    );
    expect(within(dialog).getByText('Agents using it lose access to this profile.')).toBeVisible();
    transport.listLocalBrowserProfiles.mockResolvedValue({ profiles: [] });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete profile' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Example work' })).toBeNull());
    expect(transport.deleteLocalBrowserProfile).toHaveBeenCalledExactlyOnceWith(profile.id);
    expect(transport.forgetLocalBrowserSignIns).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'Browser profiles' })).toHaveFocus()
    );
  });
  it('keeps a busy refusal visible without closing the dialog or exposing raw details', async () => {
    mount();
    transport.deleteLocalBrowserProfile.mockRejectedValue(
      Object.assign(new Error('private path'), { code: 'profile_busy' })
    );
    fireEvent.click(
      within(await screen.findByRole('region', { name: 'Example work' })).getByRole('button', {
        name: 'Delete profile',
      })
    );
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete profile' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Close this profile’s windows and finish signing in, then try again.'
    );
    expect(within(dialog).getByRole('button', { name: 'Delete profile' })).toBeEnabled();
    expect(screen.queryByText('private path')).toBeNull();
  });
});
