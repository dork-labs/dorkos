// @vitest-environment jsdom
/**
 * Approvals from the web (B4c): on a linked computer, the pinned passkeys with
 * Remove (which asks for the password), and "Add a passkey" (label and
 * password, then the approve page opens in the browser). Over Wi-Fi, or
 * anywhere but this computer, only a line saying where to manage them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { SessionRelayStatus } from '@dorkos/shared/session-relay-link';
import { configKeys, TransportProvider } from '@/layers/shared/model';

const pending = vi.hoisted(() => ({
  go: vi.fn(() => true),
  close: vi.fn(),
  open: vi.fn(),
}));
vi.mock('@/layers/shared/lib', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/lib')>()),
  openExternalWindowLater: () => {
    pending.open();
    return { go: pending.go, close: pending.close };
  },
}));

import { WebAccessSection } from '../ui/WebAccessSection';

const LINKED: SessionRelayStatus = {
  linked: true,
  hubOrigin: 'https://me.dorkos.app',
  computerName: 'Studio Mac',
  level: 'chat',
  paused: false,
  connected: true,
  pinnedAt: '2026-10-16T12:00:00.000Z',
  suggestedName: 'Studio Mac',
};

const KEYS = {
  rpId: 'approve.dorkos.ai',
  origin: 'https://approve.dorkos.ai',
  keys: [
    {
      credentialId: 'cred-1',
      label: 'MacBook passkey',
      addedAt: new Date().toISOString(),
      alg: -7,
    },
  ],
};

function renderSection(
  overrides: Partial<Transport>,
  options: { wifi?: boolean; local?: boolean } = {}
) {
  const config = {
    experiments: [
      {
        key: 'sessionRelay.enabled',
        title: 'Chat from the web',
        description: '',
        enabled: true,
        lockedByEnv: false,
      },
    ],
    serverRole: 'computer',
    isLocalCaller: options.local ?? true,
    ...(options.wifi ? { callerRoute: 'wifi' } : {}),
  };
  const transport = createMockTransport({
    getConfig: vi.fn().mockResolvedValue(config),
    getSessionRelayStatus: vi.fn().mockResolvedValue(LINKED),
    listSessionRelayPasskeys: vi.fn().mockResolvedValue(KEYS),
    ...overrides,
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(configKeys.current(), config);
  render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <WebAccessSection />
      </TransportProvider>
    </QueryClientProvider>
  );
  return { transport, queryClient };
}

beforeEach(() => {
  pending.go.mockClear();
  pending.close.mockClear();
  pending.open.mockClear();
});
afterEach(() => cleanup());

describe('Approvals from the web', () => {
  it('lists the pinned passkeys by label and when they were added', async () => {
    renderSection({});
    const list = await screen.findByTestId('approval-passkeys');
    expect(within(list).getByText('MacBook passkey')).toBeInTheDocument();
    expect(within(list).getByText('Added Just now')).toBeInTheDocument();
    // The id's last six characters tell two passkeys with one name apart.
    expect(within(list).getByText('…cred-1')).toBeInTheDocument();
  });

  it('adds one: asks a name and the password, then opens the approve page', async () => {
    const startSessionRelayPasskey = vi.fn().mockResolvedValue({
      statement: 'c3RhdGVtZW50',
      challenge: 'Y2hhbGxlbmdl',
      approveUrl: 'https://approve.dorkos.ai/enrol#c3RhdGVtZW50',
      expiresAt: '2026-10-19T12:02:00.000Z',
    });
    const listSessionRelayPasskeys = vi.fn().mockResolvedValue(KEYS);
    const { queryClient } = renderSection({ startSessionRelayPasskey, listSessionRelayPasskeys });
    await userEvent.click(await screen.findByRole('button', { name: 'Add a passkey' }));
    const dialog = await screen.findByRole('alertdialog');
    const go = within(dialog).getByRole('button', { name: 'Continue' });
    expect(go).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText('Name'), 'MacBook passkey');
    await userEvent.type(within(dialog).getByLabelText('Your password for this computer'), 'pw');
    await userEvent.click(go);
    expect(pending.open).toHaveBeenCalledTimes(1);
    expect(startSessionRelayPasskey).toHaveBeenCalledWith({
      label: 'MacBook passkey',
      password: 'pw',
    });
    await waitFor(() =>
      expect(pending.go).toHaveBeenCalledWith('https://approve.dorkos.ai/enrol#c3RhdGVtZW50')
    );
    expect(
      await screen.findByText('Finish in your browser. This list updates when you return.')
    ).toBeInTheDocument();
    // The request's variables, password and all, leave the mutation cache once it settled.
    await waitFor(() => expect(queryClient.getMutationCache().getAll()).toHaveLength(0));
    // The new passkey shows up: the line goes.
    listSessionRelayPasskeys.mockResolvedValue({
      ...KEYS,
      keys: [...KEYS.keys, { ...KEYS.keys[0]!, credentialId: 'cred-2', label: 'Phone' }],
    });
    await queryClient.invalidateQueries();
    expect(await screen.findByText('Phone')).toBeInTheDocument();
    expect(
      screen.queryByText('Finish in your browser. This list updates when you return.')
    ).not.toBeInTheDocument();
  });

  it('closes the opened window and shows the server’s sentence when adding is refused', async () => {
    const refusal = Object.assign(new Error('That password didn’t match. Try again.'), {
      status: 403,
    });
    renderSection({ startSessionRelayPasskey: vi.fn().mockRejectedValue(refusal) });
    await userEvent.click(await screen.findByRole('button', { name: 'Add a passkey' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Phone');
    await userEvent.type(within(dialog).getByLabelText('Your password for this computer'), 'no');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That password didn’t match. Try again.'
    );
    expect(pending.close).toHaveBeenCalledTimes(1);
    expect(pending.go).not.toHaveBeenCalled();
  });

  it('removes one only with the password', async () => {
    const removeSessionRelayPasskey = vi
      .fn()
      .mockResolvedValue({ rpId: null, origin: null, keys: [] });
    renderSection({ removeSessionRelayPasskey });
    await userEvent.click(await screen.findByRole('button', { name: 'Remove MacBook passkey' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Remove this passkey?')).toBeInTheDocument();
    expect(removeSessionRelayPasskey).not.toHaveBeenCalled();
    await userEvent.type(within(dialog).getByLabelText('Password'), 'hunter22');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(removeSessionRelayPasskey).toHaveBeenCalledWith('cred-1', 'hunter22');
    expect(await screen.findByText('No passkeys yet.')).toBeInTheDocument();
  });

  it('offers to remove a damaged passkeys file, with the password', async () => {
    const removeDamagedSessionRelayPasskeys = vi
      .fn()
      .mockResolvedValue({ rpId: null, origin: null, keys: [] });
    renderSection({
      listSessionRelayPasskeys: vi
        .fn()
        .mockResolvedValue({ damaged: true, rpId: null, origin: null, keys: [] }),
      removeDamagedSessionRelayPasskeys,
    });
    expect(
      await screen.findByText('Passkey file is damaged. Remove it to start again.')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add a passkey' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.type(within(dialog).getByLabelText('Password'), 'hunter22');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(removeDamagedSessionRelayPasskeys).toHaveBeenCalledWith('hunter22');
    expect(await screen.findByText('No passkeys yet.')).toBeInTheDocument();
  });

  it.each([
    ['over Wi-Fi', { wifi: true }],
    ['anywhere but this computer', { local: false }],
  ])('%s: says to manage them at this computer, and reads nothing', async (_, options) => {
    const listSessionRelayPasskeys = vi.fn().mockResolvedValue(KEYS);
    renderSection({ listSessionRelayPasskeys }, options);
    expect(await screen.findByText('Manage passkeys at this computer.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add a passkey' })).not.toBeInTheDocument();
    expect(listSessionRelayPasskeys).not.toHaveBeenCalled();
  });
});
