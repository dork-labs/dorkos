// @vitest-environment jsdom
/**
 * Making a channel and filling it are one step (spec `rooms` §14.2).
 *
 * The defect these exist against is the one the operator found: a channel born
 * empty does nothing, and until this dialog there was no affordance anywhere in
 * the product to put an agent in one.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { RoomWithRoster } from '@dorkos/shared/room-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { ChannelCreateDialog } from '../ui/ChannelCreateDialog';

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: toastError } }));

beforeEach(() => toastError.mockClear());
afterEach(cleanup);

const FLEET = [
  { agentPath: '/w/ana', displayName: 'Ana' },
  { agentPath: '/w/bo', displayName: 'Bo' },
  { agentPath: '/w/kai', displayName: 'Kai' },
];

function made(): RoomWithRoster {
  return {
    id: 'room-new',
    kind: 'channel',
    parentId: null,
    slug: 'backend',
    title: 'Backend',
    topic: null,
    workspaceId: null,
    rootEntryId: null,
    archived: false,
    createdAt: '2026-07-27T10:00:00.000Z',
    lastActivityAt: '2026-07-27T10:00:00.000Z',
    members: [],
    viewerAuthorId: 'author-you',
  };
}

function renderDialog(
  overrides: {
    transport?: Partial<Transport>;
    agents?: typeof FLEET;
    onCreated?: () => void;
    onOpenChange?: (open: boolean) => void;
  } = {}
) {
  const transport = createMockTransport({
    createRoom: vi.fn().mockResolvedValue(made()),
    ...overrides.transport,
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <TooltipProvider>{children}</TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
  render(
    <ChannelCreateDialog
      open
      onOpenChange={overrides.onOpenChange ?? vi.fn()}
      agents={overrides.agents ?? FLEET}
      onCreated={overrides.onCreated ?? vi.fn()}
    />,
    { wrapper }
  );
  return { transport };
}

/** Type a channel name into the field the dialog opens on. */
function nameIt(value: string) {
  fireEvent.change(screen.getByLabelText('Channel name'), { target: { value } });
}

/** Put one agent in the selection by name, through the typeahead. */
function pick(displayName: string) {
  const search = screen.getByLabelText('Search agents');
  fireEvent.change(search, { target: { value: displayName } });
  fireEvent.click(screen.getByRole('option', { name: displayName }));
}

describe('ChannelCreateDialog', () => {
  it('creates the channel and its roster in ONE call', async () => {
    const onCreated = vi.fn();
    const { transport } = renderDialog({ onCreated });

    nameIt('Backend');
    pick('Ana');
    pick('Kai');
    fireEvent.click(screen.getByRole('button', { name: 'Create channel with 2 agents' }));

    await waitFor(() => expect(transport.createRoom).toHaveBeenCalledTimes(1));
    // The subject, not a bound: THESE two agents, in the order they were picked.
    expect(transport.createRoom).toHaveBeenCalledWith({
      kind: 'channel',
      title: 'Backend',
      members: [],
      agentPaths: ['/w/ana', '/w/kai'],
    });
    // Nothing is added afterwards, so there is no half-made channel to be in.
    expect(transport.addRoomMember).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'room-new' }))
    );
  });

  it('trims the name it sends and never sends a blank one', async () => {
    const { transport } = renderDialog();

    nameIt('   ');
    // Both routes out of the dialog are shut while the name is blank — the
    // primary one and the deliberate empty one.
    expect(screen.getByRole('button', { name: 'Create it without agents' })).toBeDisabled();
    pick('Ana');
    expect(screen.getByRole('button', { name: 'Create channel with 1 agent' })).toBeDisabled();

    nameIt('  Backend  ');
    fireEvent.click(screen.getByRole('button', { name: 'Create channel with 1 agent' }));
    await waitFor(() =>
      expect(transport.createRoom).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Backend' })
      )
    );
  });

  it('will not let Enter walk past the blank-name rule the button is stopped by', () => {
    const { transport } = renderDialog();

    nameIt('   ');
    pick('Ana');
    // Enter on an empty query with nobody aimed at is the picker's commit
    // gesture. It must answer to the same rule the pointer does.
    fireEvent.keyDown(screen.getByLabelText('Search agents'), { key: 'Enter' });

    expect(transport.createRoom).not.toHaveBeenCalled();
  });

  it('sends Enter in the name field to the agent search, not to Create', () => {
    const { transport } = renderDialog();

    nameIt('Backend');
    fireEvent.keyDown(screen.getByLabelText('Channel name'), { key: 'Enter' });

    // The fast keyboard path fills the channel. An Enter that submitted here
    // would make the EMPTY channel the quickest thing to make, which is the
    // behaviour this dialog replaced.
    expect(transport.createRoom).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Search agents')).toHaveFocus();
  });

  it('still lets you make an empty channel, deliberately', async () => {
    const { transport } = renderDialog();

    nameIt('Backend');
    fireEvent.click(screen.getByRole('button', { name: 'Create it without agents' }));

    await waitFor(() =>
      expect(transport.createRoom).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Backend', agentPaths: [] })
      )
    );
  });

  it('offers the empty path — and only that — to someone with no agents at all', () => {
    renderDialog({ agents: [] });

    nameIt('Backend');
    expect(screen.getByText(/You have not added any agents yet/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create it without agents' })).toBeEnabled();
  });

  it('keeps the name and the selection when the server refuses', async () => {
    const onOpenChange = vi.fn();
    renderDialog({
      transport: {
        createRoom: vi
          .fn()
          .mockRejectedValue(new Error('A channel called #backend already exists')),
      },
      onOpenChange,
    });

    nameIt('Backend');
    pick('Ana');
    fireEvent.click(screen.getByRole('button', { name: 'Create channel with 1 agent' }));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith('A channel called #backend already exists')
    );
    // The retry is the same request, so nothing typed is thrown away.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByLabelText('Channel name')).toHaveValue('Backend');
    expect(screen.getByRole('button', { name: 'Remove Ana' })).toBeInTheDocument();
  });
});
