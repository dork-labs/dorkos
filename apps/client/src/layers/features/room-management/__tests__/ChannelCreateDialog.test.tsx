// @vitest-environment jsdom
/**
 * Making a channel and filling it are one step (spec `rooms` §14.2).
 *
 * The defect these exist against is the one the operator found: a channel born
 * empty does nothing, and until this dialog there was no affordance anywhere in
 * the product to put an agent in one.
 */
import { StrictMode, useState, type ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import { REACTION_FREQUENTS_DEFAULT } from '@dorkos/shared/room-schemas';
import type { RoomWithRoster } from '@dorkos/shared/room-schemas';
import type { AgentPickerCandidate } from '@/layers/entities/agent';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { createQueryClientConfig } from '@/layers/shared/lib';
import { ChannelCreateDialog } from '../ui/ChannelCreateDialog';

/**
 * The fleet this surface reads for itself.
 *
 * Mocked at the hook rather than injected as a prop, because the component now
 * fetches it — which is the point of the slice owning it. Every test names the
 * state it is about; the hook's own three-state behaviour is asserted in
 * `use-agent-picker-candidates.test.tsx`, and the rendering of each state in
 * `AgentRosterPicker.test.tsx`.
 */
const { mockRosterRef } = vi.hoisted(() => ({
  mockRosterRef: { current: null as unknown },
}));
vi.mock('../model/use-agent-picker-candidates', () => ({
  useAgentPickerCandidates: () => mockRosterRef.current,
}));

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: toastError } }));

beforeEach(() => toastError.mockClear());
afterEach(cleanup);

const AGENTS = [
  { agentPath: '/w/ana', displayName: 'Ana', visual: null, description: null },
  { agentPath: '/w/bo', displayName: 'Bo', visual: null, description: null },
  { agentPath: '/w/kai', displayName: 'Kai', visual: null, description: null },
];

/**
 * A fleet that has been read successfully. Named for the state rather than
 * defaulted into one — the loading and failed rosters render something else
 * entirely, and this dialog is asserted against those too.
 */
function settled(candidates: AgentPickerCandidate[] = AGENTS) {
  return { candidates, isLoading: false, isError: false, retry: vi.fn() };
}

function made(): RoomWithRoster {
  return {
    id: 'room-new',
    kind: 'channel',
    slug: 'backend',
    title: 'Backend',
    topic: null,
    archived: false,
    ambientMaxEntries: 30,
    createdAt: '2026-07-27T10:00:00.000Z',
    lastActivityAt: '2026-07-27T10:00:00.000Z',
    members: [],
    viewerAuthorId: 'author-you',
    reactionFrequents: [...REACTION_FREQUENTS_DEFAULT],
  };
}

function renderDialog(
  overrides: {
    transport?: Partial<Transport>;
    agents?:
      | ReturnType<typeof settled>
      | { candidates: []; isLoading: boolean; isError: boolean; retry: () => void };
    onCreated?: () => void;
    onOpenChange?: (open: boolean) => void;
  } = {}
) {
  const transport = createMockTransport({
    createRoom: vi.fn().mockResolvedValue(made()),
    ...overrides.transport,
  });
  // The real error policy (`createQueryClientConfig`), not a hand-rolled one —
  // the failure toast below is the shared mutation cache's, not the dialog's
  // own, and a re-declared config would quietly stop asserting that.
  const queryClient = new QueryClient({
    ...createQueryClientConfig(),
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <TooltipProvider>{children}</TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
  // Set before render: the picker reads the roster on its first pass.
  mockRosterRef.current = overrides.agents ?? settled();
  render(
    <ChannelCreateDialog
      open
      onOpenChange={overrides.onOpenChange ?? vi.fn()}
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
  it('does not claim an agent is picked before one is', () => {
    // The button renders before anything is chosen, so its label is the FIRST
    // thing a reader sees. A `count > 1 ? … : '…1 agent'` ternary reads
    // "Create channel with 1 agent" over an empty selection, which states
    // something false about the room they are about to make. The zero case is
    // its own branch precisely because nothing navigates you past it.
    renderDialog();

    expect(screen.getByRole('button', { name: 'Create channel' })).toBeDisabled();
    expect(
      screen.queryByRole('button', { name: /Create channel with 1 agent/ })
    ).not.toBeInTheDocument();
  });

  it('counts the agents it actually has, in singular and plural', () => {
    renderDialog();
    nameIt('Backend');

    pick('Ana');
    expect(screen.getByRole('button', { name: 'Create channel with 1 agent' })).toBeEnabled();
    pick('Kai');
    expect(screen.getByRole('button', { name: 'Create channel with 2 agents' })).toBeEnabled();
  });

  it('never tells someone with agents that they have none', () => {
    // The roster could not be read. That is not the same claim as an empty
    // account, and this dialog must not make the wrong one.
    const retry = vi.fn();
    renderDialog({ agents: { candidates: [], isLoading: false, isError: true, retry } });

    expect(screen.queryByText(/You have not added any agents yet/i)).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/Couldn't read your agents/i);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('still lets you make the channel while the fleet is unreadable', () => {
    // The deliberate empty path does not depend on the roster, so a failed read
    // must not take the whole dialog down with it.
    const { transport } = renderDialog({
      agents: { candidates: [], isLoading: false, isError: true, retry: vi.fn() },
    });
    nameIt('Backend');

    expect(screen.getByRole('button', { name: 'Create it without agents' })).toBeEnabled();
    expect(transport.createRoom).not.toHaveBeenCalled();
  });

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
    renderDialog({ agents: settled([]) });

    nameIt('Backend');
    expect(screen.getByText(/You have not added any agents yet/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create it without agents' })).toBeEnabled();
  });

  it('keeps the name and the selection when the server refuses (non-conflict error)', async () => {
    const onOpenChange = vi.fn();
    renderDialog({
      transport: {
        createRoom: vi.fn().mockRejectedValue(new Error('Something went wrong')),
      },
      onOpenChange,
    });

    nameIt('Backend');
    pick('Ana');
    fireEvent.click(screen.getByRole('button', { name: 'Create channel with 1 agent' }));

    // `useCreateChannel` reports every failure itself now: it opts out of the
    // shared mutation toast entirely (`meta.suppressErrorToast`) because a
    // name conflict needs to render inline and there is no per-error way to
    // suppress just that one. Anything that is NOT a name conflict still
    // toasts, in the same voice the shared handler used.
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Couldn't create that channel — Something went wrong")
    );
    // The retry is the same request, so nothing typed is thrown away.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByLabelText('Channel name')).toHaveValue('Backend');
    expect(screen.getByRole('button', { name: 'Remove Ana' })).toBeInTheDocument();
  });

  /** A `SLUG_TAKEN` refusal, shaped the way `HttpTransport` throws it. */
  function slugTakenError(message: string): Error & { code: string } {
    return Object.assign(new Error(message), { code: 'SLUG_TAKEN' });
  }

  it('renders a name conflict inline at the field, with no toast', async () => {
    const onOpenChange = vi.fn();
    renderDialog({
      transport: {
        createRoom: vi
          .fn()
          .mockRejectedValue(slugTakenError('A channel called #backend already exists')),
      },
      onOpenChange,
    });

    nameIt('Backend');
    pick('Ana');
    fireEvent.click(screen.getByRole('button', { name: 'Create channel with 1 agent' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A channel called #backend already exists'
    );
    expect(toastError).not.toHaveBeenCalled();
    // Same "nothing typed is thrown away" contract as any other refusal.
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByLabelText('Channel name')).toHaveValue('Backend');
  });

  it('clears the inline conflict once you start editing the name', async () => {
    renderDialog({
      transport: {
        createRoom: vi
          .fn()
          .mockRejectedValue(slugTakenError('A channel called #backend already exists')),
      },
    });

    nameIt('Backend');
    pick('Ana');
    fireEvent.click(screen.getByRole('button', { name: 'Create channel with 1 agent' }));
    await screen.findByRole('alert');

    nameIt('Backend Team');

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('survives StrictMode double-invoke: still inline, still no toast', async () => {
    // The regression this guards: the mount effect had a cleanup half but no
    // setup half. StrictMode's dev-only setup→cleanup→setup double-invoke ran
    // that cleanup once before the dialog ever mounted for real, and with
    // nothing to set `mountedRef.current` back to `true`, it stayed `false`
    // for the dialog's whole life — every conflict read as "nobody left to
    // show this inline" and toasted on top of the alert that was on screen.
    //
    // Wrapping the render call's `wrapper` OPTION in StrictMode does NOT
    // reproduce this. It takes StrictMode wrapping the `ui` argument
    // directly, with the dialog mounted for the first time by a state change
    // inside an already-mounted host — `NewMenu.tsx`'s own shape
    // (`{channelDialogOpen && <ChannelCreateDialog open ... />}`) — not
    // present from the very first render.
    const transport = createMockTransport({
      createRoom: vi
        .fn()
        .mockRejectedValue(slugTakenError('A channel called #backend already exists')),
    });
    const queryClient = new QueryClient({
      ...createQueryClientConfig(),
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
    });
    mockRosterRef.current = settled();

    function Host() {
      const [dialogOpen, setDialogOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setDialogOpen(true)}>
            New channel
          </button>
          {dialogOpen && (
            <ChannelCreateDialog
              open
              onOpenChange={(next) => !next && setDialogOpen(false)}
              onCreated={vi.fn()}
            />
          )}
        </>
      );
    }

    render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <TransportProvider transport={transport}>
            <TooltipProvider>
              <Host />
            </TooltipProvider>
          </TransportProvider>
        </QueryClientProvider>
      </StrictMode>
    );

    fireEvent.click(screen.getByRole('button', { name: 'New channel' }));
    nameIt('Backend');
    pick('Ana');
    fireEvent.click(screen.getByRole('button', { name: 'Create channel with 1 agent' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A channel called #backend already exists'
    );
    expect(toastError).not.toHaveBeenCalled();
  });
});
