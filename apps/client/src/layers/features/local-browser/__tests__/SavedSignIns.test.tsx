// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SavedSignIns } from '../ui/SavedSignIns';

const transport = vi.hoisted(() => ({
  forgetLocalBrowserSignIns: vi.fn(),
}));
vi.mock('@/layers/shared/model', async (original) => ({
  ...(await original<typeof import('@/layers/shared/model')>()),
  useTransport: () => transport,
}));
function mount(enabled = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const view = render(
    <QueryClientProvider client={client}>
      <SavedSignIns enabled={enabled} />
    </QueryClientProvider>
  );
  return { ...view, client };
}
beforeEach(() => {
  vi.resetAllMocks();
  transport.forgetLocalBrowserSignIns.mockResolvedValue({ success: true });
});
describe('Saved sign-ins (DOR-4105)', () => {
  it('shows nothing before browser authority is known', () => {
    mount(false);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('is one row that says where sign-ins live, and never says profile', () => {
    const { container } = mount();
    const row = screen.getByRole('region', { name: 'Saved sign-ins' });
    expect(
      within(row).getByText('Kept apart from your own browser. Every agent here shares them.')
    ).toBeInTheDocument();
    expect(
      within(row)
        .getAllByRole('button')
        .map((button) => button.textContent)
    ).toEqual(['Forget…']);
    expect(container.textContent?.toLowerCase()).not.toContain('profile');
  });

  it('asks first, and Cancel forgets nothing and returns focus', async () => {
    mount();
    const trigger = screen.getByRole('button', { name: 'Forget…' });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Forget saved sign-ins?',
      description: 'This signs every agent here out of every site. It can’t be undone.',
    });
    expect(dialog.textContent?.toLowerCase()).not.toContain('profile');
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    await waitFor(() => expect(cancel).toHaveFocus());
    expect(within(dialog).getByRole('button', { name: 'Forget sign-ins' })).toHaveAttribute(
      'data-variant',
      'destructive'
    );
    fireEvent.click(cancel);
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(transport.forgetLocalBrowserSignIns).not.toHaveBeenCalled();
  });

  it('forgets the shared sign-ins once confirmed and refreshes the browser state', async () => {
    const { client } = mount();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    fireEvent.click(screen.getByRole('button', { name: 'Forget…' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Forget sign-ins',
      })
    );
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(transport.forgetLocalBrowserSignIns).toHaveBeenCalledExactlyOnceWith(null);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['local-browser', 'state'] });
  });

  it('keeps a busy refusal visible in plain words, without raw details', async () => {
    transport.forgetLocalBrowserSignIns.mockRejectedValue(
      Object.assign(new Error('private path'), { code: 'profile_busy' })
    );
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Forget…' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Forget sign-ins' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Close the Agent browser and finish signing in, then try again.'
    );
    expect(within(dialog).getByRole('button', { name: 'Forget sign-ins' })).toBeEnabled();
    expect(screen.queryByText('private path')).toBeNull();
    // Nothing was cleared, so nothing may say it was.
    expect(screen.queryByText('Sign-ins forgotten.')).toBeNull();
    expect(screen.queryByText(/signed out of every site/)).toBeNull();
  });
});
