// @vitest-environment jsdom
/**
 * Chat from the web (DOR-2946): hidden with the experiment off or on a hub;
 * not linked, the consent and the link form; linked, the level (Full control
 * shown but not offered), Pause and an Unlink that asks first; anywhere but
 * this computer, every control disabled with a line saying where to go.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { SessionRelayStatus } from '@dorkos/shared/session-relay-link';
import { configKeys, TransportProvider } from '@/layers/shared/model';
import { WebAccessSection } from '../ui/WebAccessSection';

const NOT_LINKED: SessionRelayStatus = {
  linked: false,
  hubOrigin: null,
  computerName: null,
  level: 'chat',
  paused: false,
  connected: false,
  pinnedAt: null,
  suggestedName: 'Studio Mac',
};

const LINKED: SessionRelayStatus = {
  ...NOT_LINKED,
  linked: true,
  hubOrigin: 'https://me.dorkos.app',
  computerName: 'Studio Mac',
  connected: true,
  pinnedAt: '2026-10-16T12:00:00.000Z',
};

function configFor(options: { on?: boolean; hub?: boolean; local?: boolean }) {
  return {
    experiments: [
      {
        key: 'sessionRelay.enabled',
        title: 'Chat from the web',
        description: '',
        enabled: options.on ?? true,
        lockedByEnv: false,
      },
    ],
    serverRole: options.hub ? 'hub' : 'computer',
    isLocalCaller: options.local ?? true,
  };
}

function renderSection(
  overrides: Partial<Transport>,
  options: { on?: boolean; hub?: boolean; local?: boolean } = {}
) {
  const config = configFor(options);
  const transport = createMockTransport({
    getConfig: vi.fn().mockResolvedValue(config),
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
  return transport;
}

afterEach(() => cleanup());

describe('WebAccessSection', () => {
  it('draws nothing and asks nothing while the experiment is off', async () => {
    const getSessionRelayStatus = vi.fn().mockResolvedValue(NOT_LINKED);
    renderSection({ getSessionRelayStatus }, { on: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getSessionRelayStatus).not.toHaveBeenCalled();
    expect(screen.queryByText('Chat from the web')).not.toBeInTheDocument();
  });

  it('draws nothing on a hub', async () => {
    const getSessionRelayStatus = vi.fn().mockResolvedValue(NOT_LINKED);
    renderSection({ getSessionRelayStatus }, { hub: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(getSessionRelayStatus).not.toHaveBeenCalled();
    expect(screen.queryByText('Chat from the web')).not.toBeInTheDocument();
  });

  it('not linked: says what linking allows and links with the code and name', async () => {
    const linkSessionRelay = vi.fn().mockResolvedValue(LINKED);
    renderSection({
      getSessionRelayStatus: vi.fn().mockResolvedValue(NOT_LINKED),
      linkSessionRelay,
    });

    expect(await screen.findByText('Chat from the web')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Your DorkOS account, or DorkOS itself, can run commands here through your agents.'
      )
    ).toBeInTheDocument();
    await userEvent.click(screen.getByText('Learn more'));
    expect(
      await screen.findByText(
        'Chats pass through the hub that made this code. Turn this off here anytime.'
      )
    ).toBeInTheDocument();

    const name = screen.getByLabelText('Name for this computer');
    expect(name).toHaveValue('Studio Mac');
    await userEvent.type(screen.getByLabelText('Link code'), '7K3M-Q9TD-X2HV-8RNB@me.dorkos.app');
    // Link waits for the owner's password.
    expect(screen.getByRole('button', { name: 'Link' })).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Your password for this computer'), 'hunter22');
    await userEvent.click(screen.getByRole('button', { name: 'Link' }));
    expect(linkSessionRelay).toHaveBeenCalledWith({
      linkCode: '7K3M-Q9TD-X2HV-8RNB@me.dorkos.app',
      computerName: 'Studio Mac',
      password: 'hunter22',
    });
    expect(await screen.findByText('me.dorkos.app')).toBeInTheDocument();
  });

  it('shows the server’s sentence when linking is refused', async () => {
    const refusal = Object.assign(new Error('That hub belongs to a different DorkOS account.'), {
      status: 409,
    });
    renderSection({
      getSessionRelayStatus: vi.fn().mockResolvedValue(NOT_LINKED),
      linkSessionRelay: vi.fn().mockRejectedValue(refusal),
    });
    await userEvent.type(await screen.findByLabelText('Link code'), 'ABCD-EFGH-JKMN-PQRS@hub.test');
    await userEvent.type(screen.getByLabelText('Your password for this computer'), 'pw');
    await userEvent.click(screen.getByRole('button', { name: 'Link' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That hub belongs to a different DorkOS account.'
    );
  });

  it('linked: Chat is chosen, Full control is shown as Coming soon and not offered', async () => {
    renderSection({ getSessionRelayStatus: vi.fn().mockResolvedValue(LINKED) });
    expect(await screen.findByText('me.dorkos.app')).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Chat' })).toBeChecked();
    const full = screen.getByRole('radio', { name: /Full control/ });
    expect(full).toBeDisabled();
    expect(screen.getByText('Coming soon')).toBeInTheDocument();
  });

  it('pauses with no password, and resumes only with one', async () => {
    const pauseSessionRelay = vi.fn().mockResolvedValue({ ...LINKED, paused: true });
    const resumeSessionRelay = vi.fn().mockResolvedValue(LINKED);
    renderSection({
      getSessionRelayStatus: vi.fn().mockResolvedValue(LINKED),
      pauseSessionRelay,
      resumeSessionRelay,
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Pause' }));
    expect(pauseSessionRelay).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Paused')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Resume' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(resumeSessionRelay).not.toHaveBeenCalled();
    await userEvent.type(within(dialog).getByLabelText('Password'), 'hunter22');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Resume' }));
    expect(resumeSessionRelay).toHaveBeenCalledWith('hunter22');
    expect(await screen.findByText('Connected')).toBeInTheDocument();
  });

  it('asks before unlinking, and Cancel unlinks nothing', async () => {
    const unlinkSessionRelay = vi.fn().mockResolvedValue(NOT_LINKED);
    renderSection({ getSessionRelayStatus: vi.fn().mockResolvedValue(LINKED), unlinkSessionRelay });

    await userEvent.click(await screen.findByRole('button', { name: 'Unlink' }));
    expect(await screen.findByText('Unlink from your hub?')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(unlinkSessionRelay).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Unlink' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Unlink' }));
    await waitFor(() => expect(unlinkSessionRelay).toHaveBeenCalledTimes(1));
    expect(await screen.findByLabelText('Link code')).toBeInTheDocument();
  });

  it('anywhere but this computer: says where to go and disables every control', async () => {
    renderSection({ getSessionRelayStatus: vi.fn().mockResolvedValue(LINKED) }, { local: false });
    expect(
      await screen.findByText('Change this on the computer DorkOS runs on.')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Unlink' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Chat' })).toBeDisabled();
  });

  it('lists the browsers that used chat from the web here, once linked', async () => {
    const listSessionRelayDevices = vi.fn().mockResolvedValue({
      devices: [
        {
          label: 'Safari on iPhone',
          firstSeenAt: '2026-10-17T09:00:00.000Z',
          lastSeenAt: new Date().toISOString(),
        },
      ],
    });
    renderSection({
      getSessionRelayStatus: vi.fn().mockResolvedValue(LINKED),
      listSessionRelayDevices,
    });
    const list = await screen.findByTestId('web-access-devices');
    expect(within(list).getByText('Safari on iPhone')).toBeInTheDocument();
    expect(within(list).getByText('Just now')).toBeInTheDocument();
  });

  it('reads no devices before it is linked', async () => {
    const listSessionRelayDevices = vi.fn().mockResolvedValue({ devices: [] });
    renderSection({
      getSessionRelayStatus: vi.fn().mockResolvedValue(NOT_LINKED),
      listSessionRelayDevices,
    });
    await screen.findByText('Chat from the web');
    expect(listSessionRelayDevices).not.toHaveBeenCalled();
    expect(screen.queryByTestId('web-access-devices')).not.toBeInTheDocument();
  });
});
