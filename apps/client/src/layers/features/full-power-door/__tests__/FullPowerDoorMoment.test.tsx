/**
 * @vitest-environment jsdom
 *
 * The moments-rail host for existing users. Unlike the onboarding stage, the
 * Control Center IS mounted for them, so this host DOES offer "Customize…" and
 * wires it to the flyout. This pins that seam so the two hosts can't quietly
 * converge (onboarding must stay Customize-less; the moment must keep it).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { useConfig, useUpdateConfig } from '@/layers/entities/config';
import { useSetOpenMesh } from '@/layers/entities/mesh';
import { useAppStore } from '@/layers/shared/model';
import { Dialog, DialogContent } from '@/layers/shared/ui';

import { FullPowerDoorMoment } from '../ui/FullPowerDoorMoment';

vi.mock('@/layers/entities/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/config')>();
  return { ...actual, useConfig: vi.fn(), useUpdateConfig: vi.fn() };
});
vi.mock('@/layers/entities/mesh', () => ({ useSetOpenMesh: vi.fn() }));

const configMutateAsync = vi.fn();
const onClose = vi.fn();

function setMutations() {
  vi.mocked(useConfig).mockReturnValue({
    data: { auth: { enabled: false } },
    isFetchedAfterMount: true,
  } as unknown as ReturnType<typeof useConfig>);
  vi.mocked(useUpdateConfig).mockReturnValue({
    mutate: vi.fn(),
    mutateAsync: configMutateAsync,
    isPending: false,
    isError: false,
    error: null,
    reset: vi.fn(),
  } as unknown as ReturnType<typeof useUpdateConfig>);
  vi.mocked(useSetOpenMesh).mockReturnValue({
    mutate: vi.fn(),
    mutateAsync: vi.fn().mockResolvedValue(undefined),
    isPending: false,
    isError: false,
    error: null,
    reset: vi.fn(),
  } as unknown as ReturnType<typeof useSetOpenMesh>);
}

function renderMoment() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <Dialog open>
        <DialogContent>
          <FullPowerDoorMoment onClose={onClose} />
        </DialogContent>
      </Dialog>
    </QueryClientProvider>
  );
}

describe('FullPowerDoorMoment', () => {
  beforeEach(() => {
    configMutateAsync.mockReset().mockResolvedValue(undefined);
    onClose.mockReset();
    useAppStore.setState({ controlCenterOpen: false });
    setMutations();
  });

  afterEach(cleanup);

  it('offers Customize… and opens the Control Center for existing users', async () => {
    const user = userEvent.setup();
    renderMoment();

    // Existing users get the link — the Control Center is mounted for them.
    const customize = screen.getByRole('button', { name: /customize/i });
    expect(customize).toBeInTheDocument();

    await user.click(customize);

    // It records the supervised decision, opens the Control Center, and closes.
    expect(configMutateAsync).toHaveBeenCalledWith({
      ui: { fullPowerDecidedAt: expect.any(String), fullPowerChoice: 'supervised' },
    });
    await waitFor(() => expect(useAppStore.getState().controlCenterOpen).toBe(true));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
