/** @vitest-environment jsdom */
/**
 * The switcher's connect dialog: the address form, the wait for approval, and
 * the disconnect a withdrawn connection needs before connecting again. These
 * were the Connections page's Communities section; every ability it had is
 * asserted here, against the real community entity and a mock Transport.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { Transport } from '@dorkos/shared/transport';
import { CommunityRefSchema } from '@dorkos/shared/community-adapter';
import type { CommunityConnectionDescriptor } from '@dorkos/shared/community-connections';
import { createMockTransport } from '@dorkos/test-utils';
import { invalidateCommunityAuthority } from '@/layers/shared/lib';
import { TransportProvider } from '@/layers/shared/model';
import {
  useCommunityApprovalStore,
  useCommunityApprovalWatcher,
} from '@/layers/entities/community';
import {
  ConnectCommunityDialog,
  type ConnectCommunityRequest,
} from '../ui/context/ConnectCommunityDialog';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

const connected: CommunityConnectionDescriptor = {
  ref: CommunityRefSchema.parse('ref-a'),
  remoteCommunityId: 'same-id',
  label: 'Community A',
  pinnedOrigin: 'https://a.example',
  connectedHumanMemberId: 'person',
  status: 'connected',
  expiresAt: null,
  access: {
    state: 'verified',
    effective: { read: true, post: true, enrollAgent: true, stream: true },
    lastKnown: {
      lifecycle: 'active',
      capabilities: { read: true, post: true, enrollAgent: true, stream: true },
      verifiedAt: '2026-09-21T12:00:00.000Z',
    },
  },
  attention: {
    state: 'verified',
    unreadCount: 0,
    mentionCount: 0,
    verifiedAt: '2026-09-21T12:00:00.000Z',
  },
};
const pending: CommunityConnectionDescriptor = {
  ...connected,
  status: 'pending',
  connectedHumanMemberId: null,
  access: null,
  attention: null,
};
const reconnectRequired: CommunityConnectionDescriptor = {
  ...connected,
  status: 'reconnect-required',
};

beforeAll(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
beforeEach(() => {
  vi.clearAllMocks();
  useCommunityApprovalStore.setState({ onScreen: null, ending: null, links: null });
});

/** The app shell's one watcher, which does the checking the dialog reads. */
function Watcher() {
  useCommunityApprovalWatcher();
  return null;
}
afterEach(() => {
  cleanup();
  invalidateCommunityAuthority();
});

interface Mounted {
  onOpenChange: ReturnType<typeof vi.fn>;
  onConnected: ReturnType<typeof vi.fn>;
  rerender: (request: ConnectCommunityRequest | null) => void;
}

function mount(transport: Transport, request: ConnectCommunityRequest | null): Mounted {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const onOpenChange = vi.fn();
  const onConnected = vi.fn();
  const tree = (next: ConnectCommunityRequest | null) => (
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>
        <Watcher />
        <ConnectCommunityDialog
          request={next}
          onOpenChange={onOpenChange}
          installName="Studio Mac"
          onConnected={onConnected}
        />
      </TransportProvider>
    </QueryClientProvider>
  );
  const view = render(tree(request));
  return { onOpenChange, onConnected, rerender: (next) => view.rerender(tree(next)) };
}

describe('ConnectCommunityDialog', () => {
  it('connects through Transport, then offers the approval page and focuses it', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport({
      listCommunityConnections: vi.fn().mockResolvedValueOnce([]).mockResolvedValue([pending]),
      startCommunityConnection: vi.fn().mockResolvedValue({
        connection: pending,
        approvalUrl: 'https://a.example/pair?code=public',
      }),
      pollCommunityConnection: vi
        .fn()
        .mockResolvedValue({ status: 'pending', connection: pending }),
    });
    mount(transport, { ref: null });
    // The installation's own name is offered, and the form waits for the owner.
    expect(screen.getByLabelText('Name for this installation')).toHaveValue('Studio Mac');
    const address = screen.getByLabelText('Community address');
    await waitFor(() => expect(address).toBeEnabled());
    await user.type(address, 'https://a.example');
    await user.click(screen.getByRole('button', { name: 'Connect community' }));
    expect(transport.startCommunityConnection).toHaveBeenCalledWith({
      url: 'https://a.example',
      installName: 'Studio Mac',
    });
    const link = await screen.findByRole('link', { name: 'Open Community A to approve' });
    expect(link).toHaveAttribute('href', 'https://a.example/pair?code=public');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await waitFor(() => expect(link).toHaveFocus());
    expect(screen.getByRole('status')).toHaveTextContent(
      'Next, approve this DorkOS on Community A.'
    );
    expect(screen.getByText('Waiting for your approval')).toBeInTheDocument();
  });

  it('says so when the address does not lead to a community', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport({
      listCommunityConnections: vi.fn().mockResolvedValue([]),
      startCommunityConnection: vi.fn().mockRejectedValue(new Error('not a community')),
    });
    mount(transport, { ref: null });
    const address = screen.getByLabelText('Community address');
    await waitFor(() => expect(address).toBeEnabled());
    await user.type(address, 'https://nowhere.example');
    await user.click(screen.getByRole('button', { name: 'Connect community' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Couldn’t connect. Check the community address and try again.'
    );
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('closes and hands over the Community once it is approved', async () => {
    const transport = createMockTransport({
      listCommunityConnections: vi
        .fn()
        .mockResolvedValueOnce([pending])
        .mockResolvedValue([connected]),
      pollCommunityConnection: vi
        .fn()
        .mockResolvedValue({ status: 'connected', connection: connected }),
    });
    const view = mount(transport, { ref: pending.ref });
    await waitFor(() => expect(view.onConnected).toHaveBeenCalledWith(pending.ref));
    expect(view.onOpenChange).toHaveBeenCalledWith(false);
    expect(toast.success).toHaveBeenCalledWith('Community A is connected.', expect.anything());
  });

  it('returns to the form, saying why, when the approval expires', async () => {
    const transport = createMockTransport({
      listCommunityConnections: vi.fn().mockResolvedValueOnce([pending]).mockResolvedValue([]),
      pollCommunityConnection: vi.fn().mockResolvedValue({ status: 'expired', connection: null }),
    });
    mount(transport, { ref: pending.ref });
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'Approval for Community A expired. Connect again to continue.'
      )
    );
    expect(screen.getByLabelText('Community address')).toHaveFocus();
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('returns to the form when the wait is gone from the re-read list', async () => {
    const user = userEvent.setup();
    // Another window's check found it expired, or it was cancelled elsewhere:
    // the list the start re-reads no longer has it.
    const transport = createMockTransport({
      listCommunityConnections: vi.fn().mockResolvedValue([]),
      startCommunityConnection: vi.fn().mockResolvedValue({
        connection: pending,
        approvalUrl: 'https://a.example/pair?code=public',
      }),
    });
    mount(transport, { ref: null });
    const address = screen.getByLabelText('Community address');
    await waitFor(() => expect(address).toBeEnabled());
    await user.type(address, 'https://a.example');
    await user.click(screen.getByRole('button', { name: 'Connect community' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'Approval for Community A ended somewhere else. Connect again to continue.'
      )
    );
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByText('Waiting for your approval')).not.toBeInTheDocument();
  });

  it('hides the approval link and notice once the owner changes', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport({
      listCommunityConnections: vi.fn().mockResolvedValueOnce([]).mockResolvedValue([pending]),
      startCommunityConnection: vi.fn().mockResolvedValue({
        connection: pending,
        approvalUrl: 'https://a.example/pair?code=public',
      }),
      pollCommunityConnection: vi
        .fn()
        .mockResolvedValue({ status: 'pending', connection: pending }),
    });
    mount(transport, { ref: null });
    const address = screen.getByLabelText('Community address');
    await waitFor(() => expect(address).toBeEnabled());
    await user.type(address, 'https://a.example');
    await user.click(screen.getByRole('button', { name: 'Connect community' }));
    expect(await screen.findByRole('link', { name: 'Open Community A to approve' })).toBeVisible();

    // A new authority epoch, even for the same owner, is a new owner as far as
    // anything held for the old one goes.
    act(() => {
      invalidateCommunityAuthority();
    });
    await waitFor(() =>
      expect(screen.getByText(/Approve in the community tab you opened/)).toBeInTheDocument()
    );
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByText('Next, approve this DorkOS on Community A.')).not.toBeInTheDocument();
  });

  it('shows nothing of the old owner’s wait once another owner takes over', async () => {
    const navigation = vi
      .fn()
      .mockResolvedValue({ ownerKey: 'owner-a', order: [], destinations: [] });
    const list = vi.fn().mockResolvedValue([pending]);
    const transport = createMockTransport({
      getCommunityNavigation: navigation,
      listCommunityConnections: list,
      pollCommunityConnection: vi
        .fn()
        .mockResolvedValue({ status: 'pending', connection: pending }),
    });
    mount(transport, { ref: pending.ref });
    expect(await screen.findByRole('dialog', { name: 'Approve on Community A' })).toBeVisible();

    // The local server now answers for a different owner, who has no communities.
    navigation.mockResolvedValue({ ownerKey: 'owner-b', order: [], destinations: [] });
    list.mockResolvedValue([]);
    act(() => {
      invalidateCommunityAuthority();
    });
    await waitFor(() => expect(navigation).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('dialog', { name: 'Connect a community' })).toBeVisible();
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/Community A/)).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('');
  });

  it('never shows an approval link held for another owner', async () => {
    // What the store holds between an owner change and the watcher clearing it.
    useCommunityApprovalStore.setState({
      links: {
        address: JSON.stringify(['someone-else', 0]),
        urls: { [pending.ref]: 'https://a.example/pair?code=theirs' },
      },
    });
    const transport = createMockTransport({
      listCommunityConnections: vi.fn().mockResolvedValue([pending]),
      pollCommunityConnection: vi
        .fn()
        .mockResolvedValue({ status: 'pending', connection: pending }),
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // No watcher here, so nothing clears the store: the dialog's own check is all there is.
    render(
      <QueryClientProvider client={client}>
        <TransportProvider transport={transport}>
          <ConnectCommunityDialog
            request={{ ref: pending.ref }}
            onOpenChange={vi.fn()}
            installName="Studio Mac"
            onConnected={vi.fn()}
          />
        </TransportProvider>
      </QueryClientProvider>
    );
    expect(await screen.findByRole('dialog', { name: 'Approve on Community A' })).toBeVisible();
    expect(screen.getByText(/Approve in the community tab you opened/)).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('discards a start that finished after the owner changed', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport({
      listCommunityConnections: vi.fn().mockResolvedValue([]),
      startCommunityConnection: vi.fn().mockImplementation(async () => {
        invalidateCommunityAuthority();
        return { connection: pending, approvalUrl: 'https://a.example/pair?code=public' };
      }),
    });
    mount(transport, { ref: null });
    const address = screen.getByLabelText('Community address');
    await waitFor(() => expect(address).toBeEnabled());
    await user.type(address, 'https://a.example');
    await user.click(screen.getByRole('button', { name: 'Connect community' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t connect.');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(useCommunityApprovalStore.getState().links).toBeNull();
  });

  it('keeps waiting, without an error, when another window is checking the same wait', async () => {
    const busy = Object.assign(new Error('This pairing is still finishing.'), {
      status: 409,
      code: 'PAIRING_BUSY',
    });
    const poll = vi
      .fn()
      .mockRejectedValueOnce(busy)
      .mockResolvedValue({ status: 'pending', connection: pending });
    const transport = createMockTransport({
      listCommunityConnections: vi.fn().mockResolvedValue([pending]),
      pollCommunityConnection: poll,
    });
    mount(transport, { ref: pending.ref });
    await waitFor(() => expect(poll).toHaveBeenCalledTimes(2), { timeout: 5_000 });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('Waiting for your approval')).toBeInTheDocument();
  });

  it('opened on a wait from an earlier visit, says where to approve without a link', async () => {
    const transport = createMockTransport({
      listCommunityConnections: vi.fn().mockResolvedValue([pending]),
      pollCommunityConnection: vi
        .fn()
        .mockResolvedValue({ status: 'pending', connection: pending }),
    });
    mount(transport, { ref: pending.ref });
    expect(await screen.findByRole('dialog', { name: 'Approve on Community A' })).toBeVisible();
    expect(screen.getByText('https://a.example')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Approve in the community tab you opened. If you closed it, cancel and connect again.'
      )
    ).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('cancels a wait, and closes', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport({
      listCommunityConnections: vi.fn().mockResolvedValueOnce([pending]).mockResolvedValue([]),
      pollCommunityConnection: vi
        .fn()
        .mockResolvedValue({ status: 'pending', connection: pending }),
    });
    const view = mount(transport, { ref: pending.ref });
    await user.click(await screen.findByRole('button', { name: 'Cancel approval' }));
    await waitFor(() =>
      expect(transport.cancelCommunityConnection).toHaveBeenCalledWith(pending.ref)
    );
    expect(transport.disconnectCommunity).not.toHaveBeenCalled();
    await waitFor(() => expect(view.onOpenChange).toHaveBeenCalledWith(false));
    expect(toast.success).toHaveBeenCalledWith('Approval for Community A was cancelled.');
  });

  it('offers a working retry when checking approval fails', async () => {
    const user = userEvent.setup();
    const poll = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ status: 'pending', connection: pending });
    const transport = createMockTransport({
      listCommunityConnections: vi.fn().mockResolvedValue([pending]),
      pollCommunityConnection: poll,
    });
    mount(transport, { ref: pending.ref });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Couldn’t check approval. Try again.'
    );
    await user.click(screen.getByRole('button', { name: 'Check approval' }));
    await waitFor(() => expect(poll).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('removes a withdrawn connection, then offers the form to connect again', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport({
      listCommunityConnections: vi
        .fn()
        .mockResolvedValueOnce([reconnectRequired])
        .mockResolvedValue([]),
    });
    mount(transport, { ref: reconnectRequired.ref });
    expect(await screen.findByRole('dialog', { name: 'Reconnect Community A' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() =>
      expect(transport.disconnectCommunity).toHaveBeenCalledWith(reconnectRequired.ref)
    );
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'Community A is disconnected. Connect again to continue.'
      )
    );
    expect(screen.getByLabelText('Community address')).toHaveFocus();
  });

  it('says so when this DorkOS disconnected but the Community could not be told', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport({
      listCommunityConnections: vi
        .fn()
        .mockResolvedValueOnce([reconnectRequired])
        .mockResolvedValue([]),
      disconnectCommunity: vi.fn().mockResolvedValue({ remoteRevoked: false }),
    });
    mount(transport, { ref: reconnectRequired.ref });
    await user.click(await screen.findByRole('button', { name: 'Disconnect' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'Community A is disconnected here, but it couldn’t be reached. To finish, disconnect this DorkOS under Connected installations on Community A.'
      )
    );
  });

  it('keeps a withdrawn connection on screen when disconnecting fails', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport({
      listCommunityConnections: vi.fn().mockResolvedValue([reconnectRequired]),
      disconnectCommunity: vi.fn().mockRejectedValue(new Error('offline')),
    });
    mount(transport, { ref: reconnectRequired.ref });
    await user.click(await screen.findByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t disconnect.');
    expect(screen.getByRole('dialog', { name: 'Reconnect Community A' })).toBeVisible();
  });

  it('starts every opening fresh, on what it was opened for', async () => {
    const user = userEvent.setup();
    const transport = createMockTransport({
      listCommunityConnections: vi.fn().mockResolvedValue([reconnectRequired]),
    });
    const view = mount(transport, { ref: null });
    const address = screen.getByLabelText('Community address');
    await waitFor(() => expect(address).toBeEnabled());
    await user.type(address, 'https://half-typed.example');
    view.rerender(null);
    view.rerender({ ref: reconnectRequired.ref });
    expect(await screen.findByRole('dialog', { name: 'Reconnect Community A' })).toBeVisible();
    view.rerender(null);
    view.rerender({ ref: null });
    expect(await screen.findByLabelText('Community address')).toHaveValue('');
  });
});
