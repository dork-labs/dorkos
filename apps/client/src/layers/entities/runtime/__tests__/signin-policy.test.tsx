import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { AccountUsage } from '@dorkos/shared/account-usage';
import { TransportProvider } from '@/layers/shared/model';
import type { AccountSigninIdentityView } from '@dorkos/shared/runtime-connect';
import { AccountSigninIdentity } from '../ui/AccountSigninIdentity';
import { accountRowState } from '../lib/account-row-state';
afterEach(cleanup);
function mount(
  identity: AccountSigninIdentityView | null,
  signInState?: AccountUsage['signInState']
) {
  const transport = createMockTransport({
    getClaudeSigninPolicy: vi.fn().mockResolvedValue({
      deniedOrganizations: [],
      folders: [],
      accounts: identity
        ? [{ accountId: 'five', name: 'Claude5', path: '/fake/five', identity }]
        : [],
    }),
  });
  const view = render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <TransportProvider transport={transport}>
        <AccountSigninIdentity
          accountId="five"
          accountRoot="/fake/five"
          name="Claude5"
          signInState={signInState}
        />
      </TransportProvider>
    </QueryClientProvider>
  );
  return { transport, view };
}
/** Every row carries at most one status line and one button. */
function expectOneAction() {
  expect(screen.queryAllByRole('status').length).toBeLessThanOrEqual(1);
  expect(screen.queryAllByRole('button').length).toBeLessThanOrEqual(1);
}

describe('accountRowState', () => {
  it('ranks blocked over a signed-out reading', () => {
    expect(
      accountRowState({ identity: { state: 'never-use' }, signInState: 'signed-out' })
    ).toEqual({ kind: 'blocked' });
    expect(accountRowState({ identity: { state: 'blocked' } })).toEqual({ kind: 'blocked' });
  });
  it('ranks a changed login over everything but blocked', () => {
    expect(
      accountRowState({ identity: { state: 'changed', email: 'a', previousEmail: 'b' } }).kind
    ).toBe('changed');
  });
  it('an unconfirmed sign-in asks to be confirmed; an unreadable one says nothing new', () => {
    expect(accountRowState({ identity: { state: 'unconfirmed', email: 'x' } })).toEqual({
      kind: 'unconfirmed',
      email: 'x',
    });
    expect(accountRowState({ identity: { state: 'unreadable' } })).toEqual({ kind: 'healthy' });
    expect(accountRowState({ identity: { state: 'grandfathered' } })).toEqual({ kind: 'healthy' });
  });
  it('falls back to the signed-out reading, then to quiet', () => {
    expect(
      accountRowState({ identity: { state: 'confirmed' }, signInState: 'signed-out' })
    ).toEqual({ kind: 'signed-out' });
    expect(accountRowState({ signInState: 'signed-in' })).toEqual({ kind: 'healthy' });
    expect(accountRowState({ signInState: 'unknown' })).toEqual({ kind: 'healthy' });
  });
});

describe('account row sign-in status', () => {
  it('1. blocked: says it is on the Never use list, offers nothing, discloses no identity', async () => {
    mount({ state: 'blocked', email: 'should-never-render@example.com' }, 'signed-out');
    expect(await screen.findByText('Not used · on your Never use list')).toBeVisible();
    expect(screen.queryByText(/should-never-render/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('2. changed: names both masked logins, never says paused, and keeps it with no password', async () => {
    const { transport } = mount({
      state: 'changed',
      email: 'b…@example.com',
      previousEmail: 'd…@example.net',
    });
    expect(
      await screen.findByText('Now signed in as b…@example.com, not d…@example.net.')
    ).toBeVisible();
    expect(screen.queryByText(/paused/i)).not.toBeInTheDocument();
    expectOneAction();
    fireEvent.click(screen.getByRole('button', { name: 'Keep this sign-in' }));
    expect(transport.changeClaudeSigninPolicy).not.toHaveBeenCalled();
    expect(await screen.findByText('Use b…@example.com for Claude5?')).toBeVisible();
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Keep this sign-in' }).at(-1)!);
    await waitFor(() =>
      expect(transport.changeClaudeSigninPolicy).toHaveBeenCalledWith({
        action: 'accept',
        accountId: 'five',
      })
    );
  });

  it('3. unconfirmed: amber, says it still runs when named, confirmed with Use this account', async () => {
    mount({ state: 'unconfirmed', email: 'b…@example.com' });
    const line = await screen.findByText('New sign-in b…@example.com. Not confirmed yet.');
    expect(line).toHaveClass('text-status-warning-fg');
    expect(screen.getByText('DorkOS won’t pick it on its own until you do.')).toBeVisible();
    expectOneAction();
    expect(screen.getByRole('button', { name: 'Use this account' })).toBeVisible();
  });

  it('3. unreadable: nothing new, the row stays quiet', async () => {
    const { transport, view } = mount({ state: 'unreadable' }, 'signed-in');
    await waitFor(() => expect(transport.getClaudeSigninPolicy).toHaveBeenCalled());
    expect(view.container).toBeEmptyDOMElement();
  });

  it('4. signed out: shows the recovery status and one Sign in button', async () => {
    mount({ state: 'confirmed', email: 'b…@example.com' }, 'signed-out');
    expect(await screen.findByText('Signed out')).toBeVisible();
    expectOneAction();
    expect(screen.getByRole('button', { name: 'Sign in to Claude5' })).toHaveTextContent('Sign in');
  });

  it('5. healthy: the row stays quiet, with no "signed in as" line', async () => {
    const { transport, view } = mount({ state: 'confirmed', email: 'b…@example.com' }, 'signed-in');
    await waitFor(() => expect(transport.getClaudeSigninPolicy).toHaveBeenCalled());
    expect(screen.queryByText(/signed in as/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(view.container).toBeEmptyDOMElement();
  });
});
