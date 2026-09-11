/**
 * @vitest-environment jsdom
 *
 * Settings › Profile › "What kind of work you do" (DOR-1972).
 *
 * Before this field existed, the onboarding prompt that asks this question had
 * nowhere real to point a person back to: Settings › Profile edited photo,
 * name, handle and email, never `profile.roles`. These tests are the other
 * half of the fix — the destination itself, not just the copy that names it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { ProfileRolesField } from '../ui/fields/ProfileRolesField';

function renderField(transportOverrides: Partial<Transport> = {}): Transport {
  const transport = createMockTransport(transportOverrides);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <ProfileRolesField />
      </TransportProvider>
    </QueryClientProvider>
  );
  return transport;
}

afterEach(cleanup);

describe('ProfileRolesField', () => {
  it('starts with no chip selected and Save disabled when nothing is stored', async () => {
    renderField();
    const chip = await screen.findByRole('button', { name: 'Hiring people' });
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('confirm-profile')).toBeDisabled();
  });

  it('pre-selects the roles already on file', async () => {
    renderField({
      getConfig: vi.fn().mockResolvedValue({ profile: { roles: ['hiring'] } }),
    } as Partial<Transport>);
    const chip = await screen.findByRole('button', { name: 'Hiring people' });
    await waitFor(() => expect(chip).toHaveAttribute('aria-pressed', 'true'));
  });

  it('saves a picked role and says so', async () => {
    const updateConfig = vi.fn().mockResolvedValue(undefined);
    renderField({ updateConfig } as Partial<Transport>);

    await userEvent.click(await screen.findByRole('button', { name: 'Hiring people' }));
    await userEvent.click(screen.getByTestId('confirm-profile'));

    await waitFor(() =>
      expect(updateConfig).toHaveBeenCalledWith({ profile: { roles: ['hiring'] } })
    );
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
  });

  it('clears the confirmation once the selection changes again', async () => {
    const updateConfig = vi.fn().mockResolvedValue(undefined);
    renderField({ updateConfig } as Partial<Transport>);

    await userEvent.click(await screen.findByRole('button', { name: 'Hiring people' }));
    await userEvent.click(screen.getByTestId('confirm-profile'));
    await screen.findByText('Saved.');

    await userEvent.click(screen.getByRole('button', { name: 'Writing' }));
    expect(screen.queryByText('Saved.')).not.toBeInTheDocument();
  });

  it('shows a retry line when the save fails', async () => {
    const updateConfig = vi.fn().mockRejectedValue(new Error('nope'));
    renderField({ updateConfig } as Partial<Transport>);

    await userEvent.click(await screen.findByRole('button', { name: 'Hiring people' }));
    await userEvent.click(screen.getByTestId('confirm-profile'));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save that. Try again.');
  });
});
