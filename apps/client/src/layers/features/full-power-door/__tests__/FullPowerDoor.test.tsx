/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { useUpdateConfig } from '@/layers/entities/config';
import { useSetOpenMesh } from '@/layers/entities/mesh';
import { useSetPermission } from '@/layers/entities/permissions';
import { Dialog, DialogContent } from '@/layers/shared/ui';

import { FullPowerDoor } from '../ui/FullPowerDoor';

// The door writes via `useUpdateConfig`, `useSetOpenMesh` and `useSetPermission`;
// mocking all three lets the payload shapes be asserted
// exactly and the two failure orderings be driven deterministically. `configKeys`
// is preserved (importOriginal) because the door invalidates the config prefix
// through the real query client.
vi.mock('@/layers/entities/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/config')>();
  return { ...actual, useUpdateConfig: vi.fn() };
});
vi.mock('@/layers/entities/mesh', () => ({ useSetOpenMesh: vi.fn() }));
vi.mock('@/layers/entities/permissions', () => ({ useSetPermission: vi.fn() }));

const configMutateAsync = vi.fn();
const meshMutateAsync = vi.fn();
const presetMutateAsync = vi.fn();
const onClose = vi.fn();
const onCustomize = vi.fn();

function setMutations({ configPending = false, meshPending = false } = {}) {
  vi.mocked(useUpdateConfig).mockReturnValue({
    mutate: vi.fn(),
    mutateAsync: configMutateAsync,
    isPending: configPending,
    isError: false,
    error: null,
    reset: vi.fn(),
  } as unknown as ReturnType<typeof useUpdateConfig>);
  vi.mocked(useSetOpenMesh).mockReturnValue({
    mutate: vi.fn(),
    mutateAsync: meshMutateAsync,
    isPending: meshPending,
    isError: false,
    error: null,
    reset: vi.fn(),
  } as unknown as ReturnType<typeof useSetOpenMesh>);
  vi.mocked(useSetPermission).mockReturnValue({
    mutate: vi.fn(),
    mutateAsync: presetMutateAsync,
    isPending: false,
    isError: false,
    error: null,
    reset: vi.fn(),
  } as unknown as ReturnType<typeof useSetPermission>);
}

/** The door as the host mounts it — inside the rail's dialog, with a live client. */
function renderDoor() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <Dialog open>
        <DialogContent>
          <FullPowerDoor
            heading="DorkOS runs at full power"
            onClose={onClose}
            onCustomize={onCustomize}
          />
        </DialogContent>
      </Dialog>
    </QueryClientProvider>
  );
}

const ACCEPT = /unlock full power/i;
const DECLINE = /keep asking me first/i;
const CUSTOMIZE = /pick the pieces yourself/i;

describe('FullPowerDoor', () => {
  beforeEach(() => {
    configMutateAsync.mockReset().mockResolvedValue(undefined);
    meshMutateAsync.mockReset().mockResolvedValue(undefined);
    presetMutateAsync.mockReset().mockResolvedValue(undefined);
    onClose.mockReset();
    onCustomize.mockReset();
    setMutations();
  });

  afterEach(cleanup);

  it('renders the heading, the four-line promise, and the honest scope note', () => {
    renderDoor();

    expect(screen.getByText('DorkOS runs at full power')).toBeInTheDocument();
    expect(screen.getByText(/no approval prompts/i)).toBeInTheDocument();
    // The nuance the reword exists to protect: full power turns off the approval
    // gate, it does not stop the agent asking or override your instructions.
    expect(
      screen.getByText(/still ask when something genuinely needs your call/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/agents reach across projects/i)).toBeInTheDocument();
    expect(screen.getByText(/approvals can stick/i)).toBeInTheDocument();
    // Standing permissions are retired: the promise names Always allow, which
    // is per agent and per action (spec `agent-permissions` D7).
    expect(screen.getByText(/Always allow remembers your yes/i)).toBeInTheDocument();
    expect(screen.getByText(/scheduled runs use your power level/i)).toBeInTheDocument();
    // The scope note is reused, not rewritten — the same sentence every mode
    // picker shows about DorkOS-level approvals.
    expect(screen.getByText(/what an agent does in a session/i)).toBeInTheDocument();
    // A host that provides `onCustomize` gets the "Pick the pieces yourself" link.
    expect(screen.getByRole('button', { name: CUSTOMIZE })).toBeInTheDocument();
  });

  it('lets the "Pick the pieces yourself" sentence wrap, so it cannot set the dialog’s width', () => {
    renderDoor();

    // `Button` is `whitespace-nowrap`, which is right for "Save" and wrong for
    // a sentence: an unbreakable label sets the dialog's minimum width, and on
    // a phone this one measured 424px inside a 390px window — the heading, the
    // description and every bullet stretched with it and painted off the
    // screen (DOR-1747).
    const customize = screen.getByRole('button', { name: CUSTOMIZE });
    expect(customize.className).toContain('whitespace-normal');
  });

  it('omits the "Pick the pieces yourself" link when the host provides no onCustomize', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <Dialog open>
          <DialogContent>
            <FullPowerDoor heading="Choose your power level" onClose={onClose} />
          </DialogContent>
        </Dialog>
      </QueryClientProvider>
    );

    // Both answers are always on offer...
    expect(screen.getByRole('button', { name: ACCEPT })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: DECLINE })).toBeInTheDocument();
    // ...but "Pick the pieces yourself" is not, because a host without `onCustomize` (the
    // onboarding stage) has nowhere to send it — the Control Center is unmounted
    // during setup.
    expect(screen.queryByRole('button', { name: CUSTOMIZE })).not.toBeInTheDocument();
  });

  it('accept sends ONE config PATCH carrying the acknowledgement WITH the stop, then opens the mesh', async () => {
    const user = userEvent.setup();
    renderDoor();

    await user.click(screen.getByRole('button', { name: ACCEPT }));

    // A1: the whole body, including `ui.autonomyAcknowledgedAt` — the ack the
    // 428 gate demands rides in the SAME request as the autonomy stop. Standing
    // permissions are retired (spec `agent-permissions` phase 2), so nothing
    // under `approvals` rides it.
    expect(configMutateAsync).toHaveBeenCalledTimes(1);
    expect(configMutateAsync).toHaveBeenCalledWith({
      ui: {
        autonomyAcknowledgedAt: expect.any(String),
        fullPowerDecidedAt: expect.any(String),
        fullPowerChoice: 'full',
      },
      runtimes: { defaultTrustStop: 'autonomy' },
    });
    const body = configMutateAsync.mock.calls[0][0] as {
      ui: { autonomyAcknowledgedAt: string | null };
      approvals?: unknown;
    };
    expect(body.ui.autonomyAcknowledgedAt).not.toBeNull();
    expect(body).not.toHaveProperty('approvals');

    // Step 2 — the mesh opens `* -> *` only after the config write lands.
    expect(meshMutateAsync).toHaveBeenCalledWith(true);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('reports a partial mesh failure honestly — config write not re-issued, not rolled back', async () => {
    const user = userEvent.setup();
    meshMutateAsync.mockRejectedValue(new Error('mesh refused'));
    renderDoor();

    await user.click(screen.getByRole('button', { name: ACCEPT }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/can.t message each other|full power stays on/i);
    // The config write is neither repeated nor reversed: one call, forward only.
    expect(configMutateAsync).toHaveBeenCalledTimes(1);
    expect(meshMutateAsync).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('never opens the mesh when the config write fails', async () => {
    const user = userEvent.setup();
    configMutateAsync.mockRejectedValue(new Error('Request failed with status 500'));
    renderDoor();

    await user.click(screen.getByRole('button', { name: ACCEPT }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/500/i);
    expect(meshMutateAsync).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a retry after a partial failure re-opens the mesh ONLY — the config write is never repeated', async () => {
    const user = userEvent.setup();
    meshMutateAsync
      .mockRejectedValueOnce(new Error('mesh refused'))
      .mockResolvedValueOnce(undefined);
    renderDoor();

    await user.click(screen.getByRole('button', { name: ACCEPT }));
    await screen.findByRole('alert');
    expect(configMutateAsync).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: /try again/i }));

    expect(meshMutateAsync).toHaveBeenCalledTimes(2);
    expect(configMutateAsync).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('accept also chooses the Full power permission preset, before the mesh opens', async () => {
    // So DorkBot's create_room runs on a fresh install that answered the door,
    // not only on an upgraded one the config migration mapped (spec
    // `agent-permissions` D5).
    const user = userEvent.setup();
    renderDoor();

    await user.click(screen.getByRole('button', { name: ACCEPT }));

    await waitFor(() =>
      expect(presetMutateAsync).toHaveBeenCalledWith({
        kind: 'preset',
        preset: 'full',
        surface: 'first-run',
      })
    );
    expect(presetMutateAsync.mock.invocationCallOrder[0]).toBeLessThan(
      meshMutateAsync.mock.invocationCallOrder[0]!
    );
  });

  it('reports a preset write failure like a config failure, and never opens the mesh', async () => {
    presetMutateAsync.mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();
    renderDoor();

    await user.click(screen.getByRole('button', { name: ACCEPT }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(meshMutateAsync).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('decline chooses the Careful permission preset', async () => {
    const user = userEvent.setup();
    renderDoor();

    await user.click(screen.getByRole('button', { name: DECLINE }));

    await waitFor(() =>
      expect(presetMutateAsync).toHaveBeenCalledWith({
        kind: 'preset',
        preset: 'careful',
        surface: 'first-run',
      })
    );
  });

  it('decline records supervised and writes NOTHING else', async () => {
    const user = userEvent.setup();
    renderDoor();

    await user.click(screen.getByRole('button', { name: DECLINE }));

    expect(configMutateAsync).toHaveBeenCalledTimes(1);
    // Exact body: no ack, no stop — the consent-gated values
    // are untouched by "keep asking me first".
    expect(configMutateAsync).toHaveBeenCalledWith({
      ui: { fullPowerDecidedAt: expect.any(String), fullPowerChoice: 'supervised' },
    });
    expect(meshMutateAsync).not.toHaveBeenCalled();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('customize records supervised, opens the customize surface, and closes', async () => {
    const user = userEvent.setup();
    renderDoor();

    await user.click(screen.getByRole('button', { name: CUSTOMIZE }));

    expect(configMutateAsync).toHaveBeenCalledWith({
      ui: { fullPowerDecidedAt: expect.any(String), fullPowerChoice: 'supervised' },
    });
    expect(meshMutateAsync).not.toHaveBeenCalled();
    await waitFor(() => expect(onCustomize).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('writes nothing until an action is chosen — dismissing the dialog is a defer', () => {
    renderDoor();

    expect(configMutateAsync).not.toHaveBeenCalled();
    expect(meshMutateAsync).not.toHaveBeenCalled();
    expect(presetMutateAsync).not.toHaveBeenCalled();
  });

  it('disables every action while a write is in flight', () => {
    setMutations({ configPending: true });
    renderDoor();

    expect(screen.getByRole('button', { name: ACCEPT })).toBeDisabled();
    expect(screen.getByRole('button', { name: DECLINE })).toBeDisabled();
    expect(screen.getByRole('button', { name: CUSTOMIZE })).toBeDisabled();
  });

  it('surfaces a config-write failure inline and leaves the choice on offer', async () => {
    const user = userEvent.setup();
    configMutateAsync.mockRejectedValue(new Error('Couldn’t save that. Try again.'));
    renderDoor();

    await user.click(screen.getByRole('button', { name: ACCEPT }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn’t save that/i);
    // Still answerable — the failure is a prompt to retry, not a dead end.
    expect(screen.getByRole('button', { name: ACCEPT })).toBeEnabled();
    expect(screen.getByRole('button', { name: DECLINE })).toBeEnabled();
  });
});
