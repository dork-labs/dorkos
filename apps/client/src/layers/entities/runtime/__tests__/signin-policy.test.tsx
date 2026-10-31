import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import type {
  AccountSigninIdentityView,
  ClaudeSigninPolicyView,
} from '@dorkos/shared/runtime-connect';
import { AccountSigninIdentity } from '../ui/AccountSigninIdentity';
afterEach(cleanup);
function mount(identity: AccountSigninIdentityView, stepUp?: ClaudeSigninPolicyView['stepUp']) {
  const transport = createMockTransport({
    getClaudeSigninPolicy: vi.fn().mockResolvedValue({
      stepUp,
      deniedOrganizations: [],
      folders: [],
      accounts: [{ accountId: 'five', name: 'Claude5', path: '/fake/five', identity }],
    }),
  });
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <TransportProvider transport={transport}>
        <AccountSigninIdentity accountId="five" name="Claude5" />
      </TransportProvider>
    </QueryClientProvider>
  );
  return transport;
}
describe('account identity review', () => {
  it('names both masked logins and requires fresh step-up to accept', async () => {
    const transport = mount({
      state: 'changed',
      email: 'b…@example.com',
      previousEmail: 'd…@example.net',
    });
    expect(
      await screen.findByText(
        'Claude5 is now signed in as b…@example.com, not d…@example.net as before.'
      )
    ).toBeVisible();
    expect(screen.getByText('Paused · new login not confirmed')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Use this account' }));
    expect(transport.changeClaudeSigninPolicy).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Owner password'), {
      target: { value: 'fake-owner-step-up' },
    });
    fireEvent.submit(screen.getByLabelText('Owner password').closest('form')!);
    await waitFor(() =>
      expect(transport.changeClaudeSigninPolicy).toHaveBeenCalledWith({
        action: 'accept',
        accountId: 'five',
        password: 'fake-owner-step-up',
      })
    );
  });
  it('offers explicit local confirmation without asking for a password when login is off', async () => {
    const transport = mount({ state: 'unconfirmed', email: 'f…@example.test' }, 'this-computer');
    fireEvent.click(await screen.findByRole('button', { name: 'Use this account' }));
    expect(screen.queryByLabelText('Owner password')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm on the Mac' }));
    await waitFor(() =>
      expect(transport.changeClaudeSigninPolicy).toHaveBeenCalledWith({
        action: 'accept',
        accountId: 'five',
        password: '',
        confirmOnThisComputer: true,
      })
    );
  });
  it('keeps a sign-in action on the confirmed account row', async () => {
    const transport = mount({ state: 'confirmed', email: 'f…@example.test' });
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in to Claude5' }));
    await waitFor(() =>
      expect(transport.delegateRuntimeLogin).toHaveBeenCalledWith('claude-code', {
        accountId: 'five',
        sessionId: undefined,
      })
    );
  });
  it('never exposes a blocked identity or offers acceptance', async () => {
    mount({ state: 'blocked', email: 'should-never-render@example.com' });
    expect(
      await screen.findByText('Claude5 is signed in to an account DorkOS doesn’t use.')
    ).toBeVisible();
    expect(screen.queryByText(/should-never-render/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use this account' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in again' })).toBeVisible();
  });
  it('never offers acceptance for unreadable identity metadata', async () => {
    mount({ state: 'unreadable' });
    expect(
      await screen.findByText('This sign-in needs your review. Its agents stay paused.')
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Use this account' })).not.toBeInTheDocument();
  });
});
