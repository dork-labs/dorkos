/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { useConfig, useUpdateConfig } from '@/layers/entities/config';
import { useSetOpenMesh } from '@/layers/entities/mesh';
import { Dialog, DialogContent } from '@/layers/shared/ui';

import { FullPowerDoor } from '../ui/FullPowerDoor';

// The door reads `useConfig` (for `auth.enabled`) and writes via `useUpdateConfig`
// and `useSetOpenMesh`; mocking all three lets the payload shapes be asserted
// exactly and the two failure orderings be driven deterministically. `configKeys`
// is preserved (importOriginal) because the door invalidates the config prefix
// through the real query client.
vi.mock('@/layers/entities/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/config')>();
  return { ...actual, useConfig: vi.fn(), useUpdateConfig: vi.fn() };
});
vi.mock('@/layers/entities/mesh', () => ({ useSetOpenMesh: vi.fn() }));

const configMutateAsync = vi.fn();
const meshMutateAsync = vi.fn();
const onClose = vi.fn();
const onCustomize = vi.fn();

/** Drive `auth.enabled` — the one config field the door reads. */
function setLogin(enabled: boolean) {
  vi.mocked(useConfig).mockReturnValue({
    data: { auth: { enabled } },
    isFetchedAfterMount: true,
  } as unknown as ReturnType<typeof useConfig>);
}

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
const CUSTOMIZE = /customize/i;

describe('FullPowerDoor', () => {
  beforeEach(() => {
    configMutateAsync.mockReset().mockResolvedValue(undefined);
    meshMutateAsync.mockReset().mockResolvedValue(undefined);
    onClose.mockReset();
    onCustomize.mockReset();
    setLogin(false); // Require login off — the default install
    setMutations();
  });

  afterEach(cleanup);

  it('renders the heading, the four-line promise, and the honest scope note', () => {
    renderDoor();

    expect(screen.getByText('DorkOS runs at full power')).toBeInTheDocument();
    expect(screen.getByText(/runs without asking/i)).toBeInTheDocument();
    expect(screen.getByText(/agents talk to each other/i)).toBeInTheDocument();
    expect(screen.getByText(/approvals stick/i)).toBeInTheDocument();
    expect(screen.getByText(/scheduled runs use your power level/i)).toBeInTheDocument();
    // The scope note is reused, not rewritten — the same sentence every mode
    // picker shows about DorkOS-level approvals.
    expect(screen.getByText(/tools inside the session/i)).toBeInTheDocument();
  });

  it('accept sends ONE config PATCH carrying the acknowledgement WITH the stop, then opens the mesh', async () => {
    const user = userEvent.setup();
    renderDoor();

    await user.click(screen.getByRole('button', { name: ACCEPT }));

    // A1: the whole body, including `ui.autonomyAcknowledgedAt` — the ack the
    // 428 gate demands rides in the SAME request as the autonomy stop. With
    // Require login off (the default) `approvals.standingGrants` is a
    // login-gated path the server would 403, so it is deliberately absent.
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

  it('appends standing grants to the SAME atomic PATCH when Require login is on', async () => {
    const user = userEvent.setup();
    setLogin(true);
    renderDoor();

    await user.click(screen.getByRole('button', { name: ACCEPT }));

    // Login on satisfies the server's LOGIN BAR, so standing grants ride the
    // one atomic write alongside the ack and the stop — never a second request.
    expect(configMutateAsync).toHaveBeenCalledTimes(1);
    expect(configMutateAsync).toHaveBeenCalledWith({
      ui: {
        autonomyAcknowledgedAt: expect.any(String),
        fullPowerDecidedAt: expect.any(String),
        fullPowerChoice: 'full',
      },
      runtimes: { defaultTrustStop: 'autonomy' },
      approvals: { standingGrants: true },
    });
    expect(meshMutateAsync).toHaveBeenCalledWith(true);
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

  it('decline records supervised and writes NOTHING else', async () => {
    const user = userEvent.setup();
    renderDoor();

    await user.click(screen.getByRole('button', { name: DECLINE }));

    expect(configMutateAsync).toHaveBeenCalledTimes(1);
    // Exact body: no ack, no stop, no standing grants — the consent-gated values
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
    configMutateAsync.mockRejectedValue(new Error('Could not save that. Try again.'));
    renderDoor();

    await user.click(screen.getByRole('button', { name: ACCEPT }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not save that/i);
    // Still answerable — the failure is a prompt to retry, not a dead end.
    expect(screen.getByRole('button', { name: ACCEPT })).toBeEnabled();
    expect(screen.getByRole('button', { name: DECLINE })).toBeEnabled();
  });
});
